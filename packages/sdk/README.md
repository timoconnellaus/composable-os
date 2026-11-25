# @composable-os/sdk

The extension contract (ADR 0005, ADR 0023). Shipped extensions (packs, `packs/<id>/`) and runtime
extensions (written by AI into the extension workspace) are written against it and run the same
way: in a sandboxed Dynamic Worker with only the host modules they declare (ADR 0025).

```ts
import { defineExtension, defineTool, z } from "@composable-os/sdk";

export default defineExtension({
  id: "example",              // 2–30 lowercase letters/digits, starting with a letter
  version: "1.0.0",           // semver
  contractVersion: 1,         // the host runs the current and previous contract versions
  label: "Example",
  permissions: { read: ["organisation"], write: ["organisation"], modules: ["ops", "log"] },
  objects: {
    project: {
      label: "Project", plural: "Projects", icon: "folder-kanban", titleField: "name",
      fields: {
        name: { type: "text", label: "Name", required: true },
        budget: { type: "currency", label: "Budget", currency: "USD" },
        spent: { type: "currency", label: "Spent" },
        organisation: { type: "relation", label: "Organisation", to: "organisation" },
        remaining: { type: "formula", label: "Remaining", expression: "coalesce(budget, 0) - coalesce(spent, 0)" },
      },
    },
  },
  fields: { organisation: { tier: { type: "select", label: "Tier", options: ["gold", "silver"] } } },
  views: { big: { label: "Big projects", object: "example.project", filter: { field: "budget", op: "gt", value: 10000 } } },
  tools: {
    setTier: defineTool({
      description: "Set an organisation's tier. Writes the organisation.",
      input: z.object({ organisationId: z.string(), tier: z.enum(["gold", "silver"]) }),
      output: z.object({ ok: z.boolean() }),
      risk: "write",
      async handler({ organisationId, tier }, ctx) {
        await ctx.ops.call("record.update", { object: "organisation", id: organisationId, values: { "example.tier": tier } });
        ctx.log.info("tier set", { organisationId, tier });
        return { ok: true };
      },
    }),
  },
});
```

The entry file is `index.ts`; it may import its own files (`./tools.ts`) and `@composable-os/sdk`, nothing
else (no `node:*`, other packages, `import()` or `require`). It never imports host modules: tools
get them as `ctx`.

## Writing one over MCP (stage 3b)

An MCP client model with the `admin` scope authors runtime extensions with these tools (ADR 0041):

1. `extension_list` shows what is installed, what is in the workspace and the shipped ids;
   `extension_read { id: "deals" }` shows a complete, working extension to copy from.
2. `extension_write { id, files: { "index.ts": "…" } }` writes the **working copy**. Nothing is live.
3. `extension_check { id }` runs every check and returns `{ ok, issues, manifest, plan }`. Each
   issue has a `stage` (`typecheck`, `contract`, `formula`, `reconcile`), a `code`, a `path` (a
   file for source issues, a manifest path such as `objects.project.titleField` otherwise), a
   `message` and often a `suggestion`. Fix them all; check again until `ok` is true.
4. `extension_propose { id, reason }` commits and queues it for a person to approve, with the
   diff and the impact the CRM computes. It returns `pending_approval` (tell the user) or
   `check_failed` with the issues. Bump `version` for every change you propose.

Rules worth knowing before the first check:

- **TypeScript is checked strictly** against this package's types (ES2022, no DOM). `ctx.ops.call`
  returns `unknown` unless you type it: `ctx.ops.call<{ name: string }>("organisation.get", { id })`.
  `catch (error)` binds `unknown`: narrow it (`const e = error as { code?: string }`). There is no
  `fetch`, `Buffer` or Node API.
- **Ids and names**: the extension id is 2–30 lowercase letters or digits (`projects`, not
  `my-projects`); objects lowercase (`project`); fields, tools and views camelCase (`renewalDate`).
- **Fields on people and organisations** go in `fields: { organisation: { renewalDate: { … } } }`,
  not in `objects`. Their registry name is `<ext>.<field>` (`renewals.renewalDate`), which is what
  `record.update`, filters and views use.
- **Permissions**: declaring `read`, `write` or `operations` needs `"ops"` in `modules`. Your own
  objects need no permission. Asking for more than the installed version is shown to the reviewer
  as a widening.
- **Formulas** see only the same record's fields, by name, and must type-check (see below):
  join text with `&`, move dates with `dateAdd`, compare with null via `isBlank`.
- **Shipped extensions** (`deals`) can be extended from your own extension (fields on
  `deals.deal`, views over it, tools that write it with `permissions.write`), but not edited in
  place unless an admin's `extension_eject` hands it over (it then stops receiving upstream
  updates).
- Removing a field hides it (data kept 30 days); renaming needs `renamedFrom`.

## Contract

| Key | What |
| --- | --- |
| `objects` | New record types. Stored in `x_<ext>_<object>`, read through `rec_x_<ext>_<object>`. Registry name `<ext>.<object>`. They get list and record pages, timelines, history, search, saved views, CSV export and Trash. |
| `fields` | Fields on other objects, keyed by target (`person`, `organisation`, `activity`, `task`, `<otherext>.<object>`). Stored in a 1:1 side table `x_<ext>_<target>`, joined into the target's `rec_*` view as `<ext>__<column>`. Registry name `<ext>.<field>`; write them with `record.update`. |
| `views` | Saved views shipped with the extension, shared and read-only (ADR 0103): `{ label, object, type?: "table" \| "board" \| "calendar" \| "gallery", filter?, sort?, columns?, groupBy?, sumField?, dateField?, mode?, imageField?, cardFields? }`. A board may group by a select or by a relation to one of your objects (a deal's stage). Filter values may be relative: `{ $relative: "me" \| "today" \| "startOfMonth" \| "startOfNextMonth" \| "startOfQuarter" \| "startOfNextQuarter" \| … }`. |
| `dashboards` | Dashboards shipped with the extension (ADR 0103): `{ title, description?, home?, filters, widgets }` in the dashboard spec's shape (ADR 0057: widgets with read-only SQL over `rec_*` views, named params, a chart mapping and a click-through). Read-only, copyable; `home: true` makes it the default Home. |
| `recordTabs` | Tabs on another object's record page (ADR 0058): `{ label, on, view, order? }`. `on` is the page's object; `view` is `{ type: "table" \| "board" \| "calendar" \| "gallery", object, relation, filter?, sort?, columns?, groupBy?, sumField?, dateField?, mode?, imageField?, cardFields? }`, listing `object` records whose `relation` field equals the shown record's id. The host renders it; extensions ship no UI. |
| `recordPanels` | The same shape, shown as a card in the record page's side panel. |
| `settings` | Typed settings, edited by admins in Settings → Extensions: `{ type: "text" \| "number" \| "boolean" \| "select", label, description?, required?, default?, min?, max?, options? }`. Read them with `extensionSettings.list`. |
| `tools` | Operations named `x.<ext>.<tool>` (zod input/output, description, risk `read`/`write`/`bulk-write`/`destructive`). They run in the sandbox. `permission: "<ext>:<word>"` names the tool for a role (below); `humanOnly: true` lets only a person call it (ADR 0512); `redact` lists input fields the audit log never keeps (ADR 0626); `ctx.caller` says who started it (ADR 0436). |
| `public` | On an object (ADR 0438): `{ read, when? }`, the fields the public may read, of the records whose state (`when: { field, in }`, or `{ via, field, in }` through one relation) is one of `in`; no `when`, every live record. Nothing is public by default. A customer reads it too. The public reaches it only through a tool calling `public.list` / `public.get`. Not with `customer` on the same object. Only a pack or the org's own extension may declare it. |
| `roles` | Fixed staff roles (ADR 0436): `{ label, description, permissions, read }`, the permissions of your own tools and your own objects a holder may read with `record.get` and `record.list`. A human admin gives one to a staff account (`user.setPackRole`); while held it is all the account may do. Only a pack or the org's own extension may declare one. |
| `deviceRoles` | Device roles (ADR 0781): `{ label, description, permissions, screen: { block, export } }`, for the business's own enrolled device (a check-in tablet), signed in as nobody. Its `permissions` are those of your own tools declared `audiences: ["device"]` (open to nobody else, risk `read` or `write`); an admin enrols a device for the role (`device.enrol { use: "role" }`), and its credential calls exactly those tools and `device.heartbeat`, on the desk origin only. `ctx.caller` is then `{ kind: "device", deviceId, name }`, and the tool's own calls run as the extension. `screen` is a web block of your pack. Only a shipped pack may declare one. |
| `restricted` | Tool permissions held by admins and by a grant only (ADR 0625): a member or viewer does not hold a tool naming one through their role, no role holds one, and no automation or other extension's code calls it. Declare it `grantable` too so an admin can give it. Only a pack or the org's own extension may declare it. |
| `staffing` | The roster's rules for the host (ADR 0626): `{ rosters, settings?: { offerCutoffMinutes?, uncoveredDays? } }`, the restricted permission whose holders (and admins) roster, and the number settings the host reads. Rostering's. Only a pack or the org's own extension may declare it. |
| `automations` | `defineAutomation({ label, description, trigger, conditions?, steps, onRejected?, rails?, connections?, enabled?, run })`: see Automations below. |
| `permissions` | `read` / `write` (objects; write implies read), `operations` (exact names, e.g. `task.create`, `search.global`), `modules` (`ops`, `storage`, `log`, `ai`, and gatekeepers by name, e.g. `email-send`). Own objects are always allowed. `extension.*`, `policy.*`, `user.*` and `audit.*` can never be granted. Destructive operations must be listed in `operations`. |

### Object behaviour (ADR 0100)

On `objects.<name>`, next to `fields`:

| Key | What |
| --- | --- |
| `stages` | A stage behaviour, enforced by the host in `record.create`, `record.update` and CSV import for every actor. `field` (a relation to your stage object), `stage: { type, order, requiredFields?, probability?, group? }` (fields of the stage object: a select with `open`/`won`/`lost`, a number, a multiSelect of this object's field names, a number/percent, a relation to the group object), and optionally `group`, `probability: { field, overridden }`, `closedDate` and `status` (read-only fields) and `requiredByType: { lost: ["lostReason"] }`. A stage's required fields and `requiredByType` may name a read-only field (not one the behaviour keeps: `status`, `closedDate`, the probability fields), a host fact such as `acceptedAt`: no caller can enter the stage until it is set, only the host or your tool that only a person may call or approve (`humanOnly`, `personApproves`) sets it, and your stage records are then changed only by an admin in person (ADR 0750). Entering a stage with a required field empty fails with `invalid_input` and `details: { rule, field, fields, labels, stage }`, plus `setByHost` (named first in `fields`) for missing read-only fields. Moves are kept in `rec_stage_history` and, with `track: "timeline"` on the stage field, posted as "Moved to <stage>". See `packs/deals/index.ts`. |
| `capacity` | A limited number of places the host never gives out twice, for every actor (ADRs 0430 to 0433). `places` (a number field; empty is unlimited), optionally `pool` (a relation to another of your objects that declares a capacity and no pool: its places are drawn on too), `show` (`exact`, `low` with `lowAt`, or `availability`, the default: what customers and the public are told) and `releaseOnRefund` (default true). Lowering places below what is held and taken fails with `invalid_input` and `details: { rule: "capacity", object, record, places, held, taken }`. Records get read-only `held`, `taken` and `available`. Claims are made by the host in the write that needs them (an order), never by a tool. See `CapacitySpec` in `capacity.ts`. |
| `sellable` | Records that can be put on an order (ADR 0435); only an object that declares it can be bought. `price` (a currency or number field, in the major unit), optionally `currency` (ISO 4217; default the price field's, then the deployment's), `saleWindow: { from?, until? }` (date or datetime fields), `maxPerOrder` (a number field), `deposit: { amount, balanceDue }` (both: a currency or number field and a date field) and `grants: { object, set, void }`. The host reads all of them from the record when an order starts: a line outside the window fails with `details: { rule: "sale_window", line, from, until }`, over the limit with `{ rule: "max_per_order", line, max, asked }`, and no order exists. `grants` creates one record of another of your objects (which declares `states`) per unit bought, as the host, in the batch that marks the order paid (or part paid, for a deposit): `set` maps its fields to `item`, `item.<field>`, `order`, `order.person`, `order.email`, `line`, `line.title`, `line.unitPrice` or `code` (the host's unguessable code, in a read-only text field). Refunded in full, or cancelled after a deposit, the order's grants move to `void`, which every state but the final ones must reach by a `host` move. The granted object has no `owner`, and no `requireOneOf` or choice `requires` the grant does not always fill. A granting line holds at most the record's `maxPerOrder` (10 when unset), and an order at most 100 grants. `goods: { soldIn? }` marks goods (sold `online`, `in_person` or `both`, from a select, through relations allowed; ADR 0682): an order with goods needs exactly one `delivery` and each goods line must be sold in the order's channel (`rule: "not_sold_here"`). `delivery: { kind, freeOver?, countries?, active? }` marks delivery options (`post`, `collect`, `here`), chosen in `order.start`'s `delivery` and priced by the host (ADR 0685). Only a pack or the org's own extension may declare `sellable`; a runtime extension is refused (`outside_audience`). See `SellableSpec` in `sellable.ts`. |
| `states` | A fixed state machine (ADR 0425), for a lifecycle whose states are set in code and not edited by admins; an object has `stages` or `states`, not both. `field` (a select whose options are the states; not read-only, no `editableOptions`), `initial`, and `moves: [{ from, to, by, requires?, final? }]`. `from` is one state or a list; `by` lists who may make the move: `staff` (people, MCP clients, automations and extensions, your own code included), `customer`, or `host` (platform code only: no caller can make it); `requires` names fields that must have a value; `final` ends the lifecycle in `to`. A record starts in `initial`. A write that makes an undeclared move, a move its caller is not listed for, or a move with a required field empty fails with `invalid_input` and `details: { rule, field, fields, labels, state, from }` (`rule` is `state_move_not_declared`, `state_move_not_permitted`, `state_final`, `state_required_fields` or `no_state`). Moves are kept in `rec_state_history` (`state`, `is_final`, `entered_at`, `left_at`, `is_current`, `days_in_state`, `entered_by`, `entered_as`) and, with `track: "timeline"` on the state field, posted as "Moved to <state>". |
| `publishable` | A working copy and published versions (ADR 0446): `content` names the fields a version keeps. `record.publish` (a person with `records:publish`; never an AI actor or extension code) makes the next version current; `record.version` reads one (default the current), `record.versions` lists them, `record.restoreVersion` copies one into the working copy. Records get read-only `publishedVersion` and `publishedAt`. |
| `signedIn` | What every signed-in customer may read (ADR 0447): `{ read, when? }`, the shape of `public`, never read by the public. Beside `customer` it shares the records meeting `when` next to each customer's own (`read` a subset of `customer.read`); alone it opens records to read. Read with `my.list` and `my.get`. Only a pack or the org's own extension may declare it. |
| `claims` | A capacity claimant (ADR 0501): `{ on, held?, confirmed? }`. Its records' states hold (`held`), take (`confirmed`) and give back one place on the record the relation `on` points to, which declares a `capacity`, in the write's batch; the database refuses one past the places (`rule: "capacity"`). Needs `states`; no move from a confirmed state back to a held one. See `ClaimsSpec` in `capacity.ts`. |
| `stock` | Things counted on a shelf, kept by the host from an append-only ledger (ADR 0680); a sold one declares `sellable.goods`: `{ reorderAt?, reorderQty? }` (number fields: the reorder level and how many to order), `show` and `lowAt` as `capacity`'s. Not beside a `capacity`; no `sellable.deposit`, `recurring` or `moves`. An order's line holds while unpaid and sells when paid, refused by the database past what is available (`rule: "stock"`); a refund changes nothing in stock. Records get read-only `onHand`, `held` and `available`. Opening stock and corrections are `stock.opening` and `stock.adjust`, never a field. A runtime extension cannot declare it. See `StockSpec` in `stock.ts`. |
| `stockMoves` | A record's state moves stock (ADR 0681): `{ move: "add" \| "remove" \| "set", on, quantity, when, through?, kind?, unitCost?, note? }`. Entering `when` (a state no move leaves, entered only by the host through the pack's person tools, never created in) writes a movement of `quantity` on the stock record `on` points to, in the move's batch; with `through`, another record's state moves all its lines (a count applied). `set` makes on hand the number counted. What moved stock cannot change afterwards. `stock.notify` names the tool permission whose holders are told of low stock. A runtime extension cannot declare it. See `StockMovesSpec` in `stock.ts`. |
| `unique` | `[{ fields, states? }]` (ADR 0502): no two live records in `states` share `fields`, refused by a partial unique index (`conflict`, `rule: "unique"`). See `UniqueSpec` in `unique.ts`. |
| `recurring` | A schedule in local time that makes another object's records ahead (ADR 0500): `{ generates, link, rule: { weekdays?, time, length?, from, until?, zone?, unit?, every?, day?, month?, lengthDays? }, into: { starts, ends?, zone?, changed? }, copy?, cancel, ended?, closures?, horizonDays?, horizonAtLeast?, horizonSetting? }` (`horizonSetting`: a number setting, in days, that sets the horizon when it holds a value, ADR 0626). Weekly without `unit`; with it (a select of `week`, `month`, `year`, ADR 0860), every `every` weeks on the weekdays, months on `day` (the last day when shorter) or years on `month` and `day`, fixed on the calendar from `from`; `lengthDays` is a length in days instead of minutes. Made by the host from the minute cron, keyed on the series and local date; a record staff edited is left alone. See `RecurringScheduleSpec` in `recurring.ts`. Not `sellable.recurring` (a plan paid every period) or its `grants` (what its subscription gives, ADR 0510). On `states`, a move's `window` and `staffOnly`, and `states.create` and `states.requests`, are ADR 0503's (see `StatesSpec` in `states.ts`). |
| `timelineLinks` | Relation fields whose records also get this object's timeline posts (`["organisation"]`). |
| `indexes` | `[["stage"], ["owner", "status"]]`: indexes on own single-valued fields (or `createdAt`/`updatedAt`), live rows only. Declare one for each field your lists filter or sort by. |
| `seed` | `{ key: { field: value } }`: records created once when the object is installed; `{ seed: "key" }` points a relation at another seed record. |
| `navigation` | `main` (sidebar, default), `settings` (Settings → set-up) or `none`. |

A field may be `readOnly: true`: set only by the host (a stage behaviour's status or closed date),
refused by record operations.

Names: objects `[a-z][a-z0-9]*` (not `person`, `organisation`, `activity`, `task`, …), fields and
tools camelCase. `id`, `createdAt`, `updatedAt`, `createdBy`, `deletedAt`, `deletedBy` and `tags`
are reserved. Rename with `renamedFrom: "<old name>"`; without it a missing field is removed
(hidden, its data kept 30 days).

## Field types

| Type | Stored as | Value | Filter operators | CSV |
| --- | --- | --- | --- | --- |
| `text` | TEXT | string ≤ 1000 | text ops (eq, contains, starts_with, …) | as is |
| `longText` | TEXT | string (Markdown) | text ops | as is |
| `email`, `phone`, `url` | TEXT | validated string | text ops | as is |
| `number`, `currency`, `percent` | REAL | number | eq … between, in | `1,200.50`, `$5`, `12%` parse |
| `date` | TEXT | `YYYY-MM-DD` | comparisons | `YYYY-MM-DD` |
| `datetime` | TEXT | ISO-8601 with zone | comparisons | any parseable timestamp |
| `boolean` | INTEGER 0/1 | boolean | eq, neq | true/false/yes/no/1/0 |
| `select` | TEXT | one option value | eq, neq, in, not_in | the value |
| `multiSelect` | TEXT (JSON array) | option values | has a value (eq, in, …) | `a; b` |
| `relation` | TEXT id, or JSON array with `many: true` | record id(s) of `to` | id ops / has a value | ids, `; `-separated |
| `user` | TEXT | a user id | eq, neq, in | the id |
| `formula` | none (computed in the view) | its result type | its result type's ops | the value |
| `document` | TEXT (JSON) | one JSON value checked against the field's `schema` | none: declare `paths` | the JSON |

A `number`, `currency` or `percent` field may declare `min`, `max` and `step` (a multiple of
`step` from `min`, or from 0): a value outside them is refused with `invalid_input`, the message
naming the bound (`rpe: At most 10`), for every actor, in imports and in the dry run.

A `document` field (ADR 0445) declares `schema: { root, defs? }`, a tree of nodes (`object`,
`array` with a `max`, `text`, `number`, `boolean`, `choice`, `ref` to a record of an object,
`union` with a `tag`, `use` of a named definition; see `document.ts`), and optionally `maxBytes`
(default 65,536, at most 524,288) and `paths: { <name>: { label, path, count? } }`: read-only
columns of the `rec_*` view at a path of keys (`title`, `meta.level`), or a list's length with
`count`. A value that breaks the schema is refused with `invalid_input`, the message naming the
path of the first fault and `details.issues` listing each (`path`, `message`); a `ref` must name a
live record. An `object` node with `private: true` (or `{ unless: "<boolean key>" }`) is removed
from what customers and the public read. No default, no timeline, no formula reads it.

A `select` option may list `requires: ["field"]` (a stage rule, ADR 0058): `record.create` and
`record.update` refuse a record holding that choice without a value in each field, with an
`invalid_input` error whose `details` are `{ field, fields, reason: "required_by_choice",
choiceField, choice }`. A board view drag reads `details.field` to ask for the missing value and
retry.

```ts
recordTabs: {
  projects: {
    label: "Projects",
    on: "organisation",
    view: { type: "table", object: "example.project", relation: "organisation" },
  },
},
recordPanels: {
  projectBoard: {
    label: "Projects by status",
    on: "organisation",
    view: { type: "board", object: "example.project", relation: "organisation", groupBy: "status", sumField: "budget" },
  },
},
settings: {
  defaultStatus: { type: "select", label: "Status of new projects", options: ["planned", "active"], default: "planned" },
},
```

Lossless type changes only: `text → longText`, `number ↔ currency/percent`, `date → datetime`,
`select/email/phone/url → text/longText`. Anything else is refused by `check` with a suggestion
(add a new field, copy values with a tool, remove the old one).

## Formula language

A formula is an expression over fields of the **same record** (no cross-record rollups). It is
parsed and type-checked by `extension.check`, compiled to a SQLite expression and computed in the
object's `rec_*` view, so formula fields can be filtered and sorted like any other field. They are
read-only.

```
expr       := or
or         := and ( ("or" | "||") and )*
and        := not ( ("and" | "&&") not )*
not        := ("not" | "!") not | comparison
comparison := concat ( ("=" | "==" | "!=" | "<>" | "<" | "<=" | ">" | ">=") concat )?   -- no chaining
concat     := additive ( "&" additive )*
additive   := term ( ("+" | "-") term )*
term       := unary ( ("*" | "/" | "%") unary )*
unary      := ("-" | "+") unary | primary
primary    := number | string | true | false | null | field | function "(" args? ")" | "(" expr ")"
string     := '…' or "…"   (escapes: \' \" \\ \n)
field      := a field name of the record, case-sensitive (e.g. budget, dueDate, name)
```

Types: `number`, `text`, `boolean`, `date`, `datetime` (and the literal `null`). Fields read as:
text/longText/select/email/phone/url/user/relation (one) → `text`; number/currency/percent →
`number`; boolean → `boolean`; date → `date`; datetime → `datetime`. Other formula fields can be
used (cycles are reported); multiSelect and many-relations cannot. On core objects, core fields can
be read too (e.g. `name`, `currentPeopleCount` on organisation; `displayName`, `jobTitle` on person).

| Function | Result |
| --- | --- |
| `if(condition, then, else)` | type of the branches (must match; `null` fits either) |
| `coalesce(a, b, …)` | first non-null; arguments share a type |
| `isBlank(x)` | boolean; empty or whitespace text counts as blank |
| `concat(a, …)`, `a & b` | text; null joins as empty, numbers without `.0` |
| `length(t)`, `lower(t)`, `upper(t)`, `trim(t)` | number / text |
| `round(n, digits?)` (digits a literal 0–10), `floor(n)`, `ceil(n)`, `abs(n)`, `min(a, b, …)`, `max(a, b, …)` | number |
| `today()`, `now()` | date / datetime (evaluated when read) |
| `dateAdd(date, amount, "day" \| "week" \| "month" \| "year")` | date (or datetime) |
| `dateDiff(start, end, "day" \| "week" \| "month" \| "year")` | number: end − start, whole units |

Rules worth knowing: `+` is for numbers only (join text with `&`); move dates with `dateAdd`, not
`+`; `/` by zero gives null; compare with null using `isBlank(x)`; a date argument may be a literal
like `"2026-03-01"`; units are quoted literals. Examples:

```
coalesce(budget, 0) - coalesce(spent, 0)
if(remaining < 0, "over budget", "ok")
dateDiff(today(), renewalDate, "day")
name & " (" & coalesce(tier, "untiered") & ")"
round(spent / budget * 100, 1)
```

Errors come back from `check` as `{ stage: "formula", code, path, message, span }` with codes
`formula_syntax`, `formula_type`, `formula_unknown_field`, `formula_unknown_function`,
`formula_cycle` and `formula_too_complex`; `span` is the character range in the expression.
Safety: the lexer refuses any character outside the grammar, field names must exist, functions
come from a fixed table, numbers are re-printed and strings are quoted with `''` escaping, so
nothing from a formula reaches SQL verbatim.

## Host modules (`ctx`)

| `ctx.` | Module | |
| --- | --- | --- |
| `ops.call(operation, input)` | `ops` | Any operation the extension's permissions allow, as principal `extension:<id>`, actor `extension`, through the approval gate (like an automation). Failures throw `OpsCallError` with the pipeline's `code`; a call the gate sends to review is queued for approval and throws code `pending_approval` (`details.actionId`). |
| `storage.get/set/delete/list` | `storage` | Per-extension key-value storage (JSON values ≤ 128 KB). |
| `log.info/warn/error(message, data?)` | `log` | Shown in the extension's run history. |
| `ai.summarise/extract/classify` | `ai` | Model roles (ADR 0009); Workers AI by default, through AI Gateway when configured. Fails with a clear error when the deployment has no AI binding. |
| `gatekeeper(name).connections/call/types` | a gatekeeper (`GATEKEEPER_MODULES`: `google`, `microsoft`, `slack`, `slack-post`, `mcp`, `email`, `email-send`, `zoominfo`, `websearch`, `webhook`) | The only way out to an external service (ADR 0050). `call(connectionId, resource, method, ...args)` goes through the integration host as the connection's owner; reads are observations, and side effects come back in `pending` as outbound actions until a person approves them. Declare the gatekeeper's name in `permissions.modules`. |

There is no network: `fetch` fails (`globalOutbound: null`). An external service is reached only
through a gatekeeper. A module the extension did not declare is absent from `ctx`, and
`ctx.gatekeeper(name)` of an undeclared gatekeeper fails.

One version of an extension may serve many runs from the same warm sandbox (ADR 0043), so
module-scope variables can outlive a run. Keep per-call state inside the handler, and persist
anything that must last in `ctx.storage`.

## Checking an extension in a checkout

A shipped extension (a pack, `packs/<id>/`) is checked without a deployment by the `cos` command
(ADR 0405): `pnpm cos ext check packs/<id>` runs the checks `extension.check` runs (imports,
types, contract, formulas, automations, a dry-run reconcile on an empty local database) and
prints each issue with a file, the manifest path, the message and the fix where there is one;
`pnpm cos ext test packs/<id>` runs its tests and refuses a tool or automation that no test
names. The skills in `skills/` give the order of work.

## Testing an extension

`@composable-os/sdk/testing` runs tools with in-memory host modules and the host's permission rules:

```ts
import { createTestHost } from "@composable-os/sdk/testing";
import extension from "../index.ts";

const host = createTestHost(extension, {
  records: { organisation: [{ id: "org_1", name: "Acme" }] },
});
expect(host.issues).toEqual([]);                       // contract + formula checks
await host.runTool("setTier", { organisationId: "org_1", tier: "gold" });
expect(host.calls).toContainEqual(expect.objectContaining({ operation: "record.update", allowed: true }));
```

It fakes `record.create/get/update/delete/list` (every filter op), `<core>.get`,
`task.create/get/update/complete/list` and `notification.send`; pass `operations: { "query.sql":
(input) => … }` for anything else, `users` for who `notification.send` resolves, and `ai` to
replace the stand-in AI.

### Testing an automation

`host.runAutomation(name, options)` runs an automation in memory, start to finish:

```ts
const host = createTestHost(extension, {
  records: { "deals.deal": [{ id: "d1", name: "Acme", status: "won", owner: "usr_sarah" }] },
  users: [{ id: "usr_sarah", role: "member" }, { id: "usr_admin", role: "admin" }],
});
const run = await host.runAutomation("wonOnboarding", { record: { object: "deals.deal", id: "d1" } });
expect(run.error).toBeNull();
expect(run.undeclared).toEqual([]);                          // every effect was declared
expect(run.steps.map((s) => s.name)).toEqual(["createTasks", "notifyOwner", "wait", "notifyManager"]);
expect(run.steps[2]?.skippedMs).toBe(3 * 86_400_000);       // waits are skipped, and recorded
expect(run.notifications[0]?.userIds).toEqual(["usr_sarah"]);
```

Declared `conditions` are checked on the trigger record first (`matched: false` and nothing runs
when they fail). `step.do` runs its function; `step.sleep` and `step.waitForEvent` return at once
(pass `events: { <step>: payload }` for a wait's payload; default `null`, a timeout). A step name
that is not declared with the matching kind, or that runs twice, fails the run with
`undeclared_step`, as on the host. Options: `record`, `change`, `period`, `manual`, `approval`,
`events`, `runId`, `test`. The result lists `steps`, `writes`, `notifications`, `undeclared` and
`value`.

## Automations (`defineAutomation`, ADR 0028, ADR 0131)

An automation lives in `automations` of `defineExtension`. It declares what starts it, what it
checks, and every step it may take; the host renders the plain-English summary and step diagram
from those declarations (never from the code) and runs `run` durably on Cloudflare Workflows,
each `step.do` in the sandbox as actor `automation` under `extension:<id>`.

```ts
import { defineAutomation, defineExtension } from "@composable-os/sdk";

const wonOnboarding = defineAutomation({
  label: "Won deal → onboarding",
  description: "Creates onboarding tasks for the owner of a won deal and tells them.",
  trigger: { type: "fieldChanged", object: "deals.deal", field: "stage", to: { stageType: "won" } },
  steps: [
    {
      name: "createTasks",
      label: "Create onboarding tasks",
      writes: [{ object: "task", count: 2, titles: ["Kick-off call", "Set up account"],
                 assignTo: { field: "owner" }, linkedToTrigger: true }],
    },
    { name: "notifyOwner", notifies: [{ to: { field: "owner" }, message: "Deal won 🎉" }] },
    { name: "wait", kind: "sleep", duration: "3 days" },
    { name: "anyOpen", kind: "condition", label: "Any task still open?",
      clause: "any of those tasks are still open" },
    { name: "notifyManager", reads: ["task"],
      notifies: [{ to: { managerOf: "owner" }, message: "Onboarding not started for {record}" }] },
  ],
  async run(event, step, ctx) {
    const deal = event.record!;
    const ids = await step.do("createTasks", async () => { /* ctx.ops.call("task.create", …) */ });
    await step.do("notifyOwner", () => ctx.notify({ field: "owner" }, { title: "Deal won 🎉" }));
    await step.sleep("wait", "3 days");
    await step.do("notifyManager", async () => { /* check the tasks, then ctx.notify(...) */ });
  },
});

export default defineExtension({
  id: "acme", version: "1.0.0", contractVersion: 1,
  permissions: { write: ["task"], operations: ["notification.send"], modules: ["ops"] },
  automations: { wonOnboarding },
});
```

**Triggers.**

| `type` | Fields | Fires |
|---|---|---|
| `record` | `object`, `on: ["created" \| "updated" \| "deleted" \| "restored"]`, `includeBulk?` | after a record change commits (bulk changes only with `includeBulk`) |
| `fieldChanged` | `object`, `field`, `from?`, `to?`, `includeBulk?` | when the field changes; `from`/`to` are a value, `{ in: [...] }` or, on the object's stage field, `{ stageType: "open" \| "won" \| "lost" }` |
| `schedule` | `cron` (5 fields) | in the automation timezone (Settings → Automations) |
| `dateRelative` | `object`, `field` (date/datetime), `offsetDays` (−365…365) | once a day for each record, `offsetDays` days after its date (positive) or before it (negative: `-30` is 30 days before); 0 is the day itself |
| `dateRelative` in minutes | `object`, `field` (datetime), `minutesBefore` or `minutesAfter`: a number (0…10,080) or `{ field?, setting? }` (a number field of the record or one relation away, else a number setting; each with a `max` of at most 10,080) | within about a minute of that moment, once per record and value of the field; a moment missed by more than 15 minutes is not run (ADR 0570) |
| `manual` | `object`, `label`, `bulk?` | a button on the record page (and a bulk action on lists) |
| `approvalDecided` | `decision?`, `operation?`, `object?` | when a pending action is approved or rejected |
| `webhook` | `endpoint` (the id an admin set up), `events?` | on a verified delivery to that inbound webhook endpoint (the `webhook` gatekeeper, ADR 0113); the typed event is in `event.integration` |
| `syncEvent` | `event` (`SyncEventType`), `from?: "person" \| "organisation" \| "either"` | when email or calendar sync writes, changes or removes an activity (ADR 0112); the trigger record is that activity, and the extension needs `"activity"` in `permissions.read` |

**Connections.** An automation that reaches an external service declares `connections: [{ id,
gatekeeper, purpose }]` (`AutomationConnection`) and the gatekeeper in `permissions.modules`. A
person binds each one when the automation is approved or installed; until all are bound it does
not run. Steps call `ctx.gatekeeper(gatekeeper).call(id, resource, method, ...args)`.

**On or off.** `enabled: false` installs the automation turned off, for a person to turn on under
Automations. Only the first install reads it.

**Conditions.** `conditions` is a view filter (`{ field, op, value }`, `and`, `or`) on the
trigger record, checked before a run starts and shown in the summary ("if its status is Open").

**Steps and intents.** Each step has a camelCase `name` (unique) and an optional `label`:
- `do` (default): `reads`, `writes` (`{ object, action?, count?, titles?, assignTo?,
  linkedToTrigger? }`), `notifies` (`{ to, message, body? }`: the title and body as written, `{record}` = the trigger record's title; the host summary quotes them),
  `calls` (other operations);
- `sleep`: `duration` (`"3 days"`, `"90 minutes"`, ms);
- `waitForEvent`: `event` (letters, digits, `-`, `_`), `timeout?` (default 7 days);
- `condition`: `label` (the question on the diagram) and `clause?` (how the summary says it).

Recipients: `{ field }` (a `user` field of the trigger record), `{ managerOf }` (that user's
manager: the admins while users have no manager field), `{ userId }`, `"admins"`, `"actor"` (who
started a manual run).

**`run(event, step, ctx)`.** `event` has `automation`, `runId`, `trigger`, `record` (`object`,
`id`, `data`, `title`), `change` (`action`, `diff`), `period`, `manual`, `approval` and `test`.
`step.do(name, fn)` runs `fn` once and stores its result (a resumed run gets the stored value; a
throw is retried with backoff); `step.sleep(name, duration)` and `step.waitForEvent(name)` are
durable waits. Only declared names of the matching kind are allowed. Keep side effects inside
`step.do`: `run` itself is replayed from the start on every resume. `ctx` is the tool `ctx` plus
`ctx.notify(to, { title, body?, link?: "record" | "run" })`, which calls `notification.send`
(needs it in `permissions.operations`) with a per-step dedupe key, so a retried step notifies once.

**`onRejected`.** When a write in a run needs approval the run pauses; if a person rejects it the
run follows `onRejected`: `"stop"` (default, run cancelled), `"continue"`, or `{ notify, message? }`.

**Rails.** Host maxima: 60 runs/minute and 500 writes/hour per automation. Runs over the minute's
rail wait their turn and start on the next ticks, never dropped (ADR 0573); more writes in an hour
pause the automation and notify admins (the runs it held back start once it is resumed). Cascade
depth 3, no self-retrigger on the same record in one cascade,
updates to one record debounced. `rails` may only be stricter (`maxRunsPerMinute`,
`maxWritesPerHour`, `debounceSeconds`).

**Test mode.** `automation.test { id, record }` (also an MCP tool) dry-runs the automation against
a real record through the simulation overlay: nothing is written, waits are skipped and shown, and
the report lists the writes, notifications and approvals the real run would make.

**Checks.** `extension.check` reports, among others: unknown objects or fields, a `dateRelative`
field that is not a date, `{ stageType }` off the stage field, an invalid cron, repeated or
non-camelCase step names, recipients that are not user fields, writes without write permission,
notifying without `notification.send`, and waits adding up to more than 365 days.

## Exports

- `@composable-os/sdk`: `defineExtension`, `defineTool`, `defineAutomation`, `z`, field types
  (`FIELD_TYPES`, `LOSSLESS_TYPE_CHANGES`), the manifest (`toManifest`, `validateManifest`,
  `manifestSchema`), permissions (`checkGrant`) and the sandbox dispatcher (`runExtension`).
- `@composable-os/sdk/formula`: `parseFormula`, `compileFormula`, `checkFormula`, `FORMULA_FUNCTIONS`.
- `@composable-os/sdk/testing`: `createTestHost` (`runTool`, `runAutomation`).
