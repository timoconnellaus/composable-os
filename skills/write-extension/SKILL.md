---
name: write-extension
description: Write a new Composable OS extension from a request, the way Deals is written - choosing an id, objects, fields and formulas, relations to base records and other extensions' objects, permissions, indexes, seeds, views, record tabs and panels, navigation, settings and behaviours (stages, states). Use when asked for a new extension, a new kind of record, or new fields on people, organisations or another extension's objects. For tools, automations and dashboards, continue with add-automations-tools-dashboards.
---

# Write an extension

Describes extension contract version 1 (`CONTRACT_VERSION` in `packages/sdk/src/contract.ts`).

## When to use it

Someone asks for a new kind of record (renewals, tickets, assets), or for fields on people,
organisations, tasks, activities or another extension's objects. This skill covers the data and
how it is shown. Tools, automations and dashboards are in `add-automations-tools-dashboards`;
do this skill first, then that one.

It is for a shipped extension in a checkout of the Composable OS repository, a pack
(`packs/<id>/`). A runtime extension written over MCP uses the same contract and the MCP
server's own instructions (`packages/sdk/README.md`, "Writing one over MCP").

## The steps

Read these before writing. They are the source of truth; this skill only gives the order.

- `packages/sdk/README.md`: the contract table, object behaviour, field types, the formula language.
- `packages/sdk/src/contract.ts`: `ExtensionSpec`, `ObjectSpec`, `FieldSpec`, `StagesSpec`,
  `ViewSpec`, `RecordViewSpec`, `SettingSpec`, `PermissionsSpec`. `field-types.ts` lists the field
  types.
- `packs/deals/index.ts`: the worked example. `packs/lifecycle/index.ts` is the smallest
  one (fields on person, a view). `packs/leads/index.ts` builds on another extension.

1. **Look at what exists.** Read the other extensions' `index.ts` and README. If one already
   models the request (Deals seeds a Renewals pipeline), extend it with fields or say why it does
   not fit, before adding a new object.
2. **Choose the id.** 2 to 30 lowercase letters or digits, starting with a letter; usually the
   plural of the main record (`deals`, `leads`, `renewals`). The directory is `packs/<id>/`
   and its name must equal the id. An object may not take a core name (`person`, `task`, ...).
3. **Create the package.** Copy `package.json`, `tsconfig.json` and `vitest.config.ts` from
   `packs/lifecycle/`, rename the package `@composable-os/pack-<id>`, then run `pnpm install`.
   Add the id to `packs` in the product's definition (`products/<product>/product.ts`): only the
   packs a product lists are bundled into its release, and each is installed in every deployment
   of that product at boot. Keep `composableOs.optional: true` in `package.json` unless the
   request says everyone gets it: an optional extension does nothing until an admin installs it,
   so say that when you report the work.
4. **Declare the objects** in `index.ts` with `defineExtension`. For each: `label`, `plural`,
   `icon`, `titleField`, `description`, `fields`. Use the field type that says what the value is
   (`currency`, `date`, `user`, `select` with options), not `text` for everything. A `formula`
   reads only the same record's fields. See Deals: `objects.deal.fields`, `weightedValue`.
   `ObjectSpec` has more than the examples use; read it for `owner` (the record's user field),
   `titleDefault` (a title taken from a relation) and `requireOneOf` (Leads uses all three).
   A number a person or a device records has bounds: `min`, `max` and `step` on a `number`,
   `currency` or `percent` field (an RPE `{ min: 1, max: 10, step: 0.5 }`, a count `{ min: 0,
   step: 1 }`); the host refuses a value outside them for every actor. Never bound it only in a
   tool's input.
   Something whole and nested that is edited, versioned or copied as one (a program's layout of
   weeks, sessions and items) is one **`document`** field with a `schema`, not records per level:
   `{ type: "document", schema: { root, defs? }, maxBytes?, paths? }` (`DocumentSchema` in
   `packages/sdk/src/document.ts`, ADR 0445). The host refuses a value that breaks it, with the
   path of the fault, for every actor. Give every list a `max`; use `union` with a tag for "one of
   these shapes", `ref` for a record id the host checks exists, `private` (or `{ unless:
   "<boolean key>" }`) on an object customers must not read, and `paths` for values a list,
   filter or dashboard needs as columns. See Programs: `packs/programs/layout.ts`. What people
   record (one row per set) stays records.
5. **Relate records.** `{ type: "relation", to: "organisation" }` for a base record,
   `to: "<id>.<object>"` for your own, `to: "deals.deal"` for another extension's. To add fields
   to an object you do not own, use top-level `fields: { organisation: { ... } }` or
   `fields: { "deals.deal": { ... } }`; never edit the other extension. There is no `dependsOn`
   key: naming another extension's object is the dependency, and that extension must be installed
   first. See Leads: `fields["deals.deal"]`, and `@composable-os/pack-deals` in its
   `devDependencies` for tests.
6. **Declare permissions**, the least that works. Your own objects need none. `read` and `write`
   name other objects, `operations` names operations exactly, and any of them needs `"ops"` in
   `modules`. Views, tabs and panels over other objects need no permission; only code does.
7. **Add indexes and seeds.** One index for each field a list filters or sorts by. `seed` for
   set-up records people will then edit (Deals: `objects.pipeline.seed`, `objects.stage.seed`).
8. **Show it.** `navigation` (`main`, `settings` for set-up records, `none`), `navigationOrder`,
   `owner`; `views` for saved lists and boards; `recordTabs` and `recordPanels` to show your
   records on another record's page; `settings` for what an admin chooses. See Deals from
   `views:` down. The host renders all of it.
9. **Add behaviours** the request needs (below).
10. **Write a README and a first test**: `test/<id>.test.ts` with `createTestHost(extension)` and
   `expect(host.issues).toEqual([])` (Deals: `test/deals.test.ts`, first test).
11. **Check, fix, repeat** (last section), then run `pnpm lint`, `pnpm typecheck` and `pnpm test`
    at the repository root: a shipped extension is part of the runner's bundle and its tests.

### Behaviours

A behaviour is a rule the host enforces for every actor (UI, MCP, imports, other extensions). An
extension declares it; it never implements it. Each behaviour the platform has is listed here.

- **`stages`** on an object: records move through ordered stages of type open, won or lost,
  kept in a stage object of the same extension. The host enforces the fields a stage requires,
  keeps probability, status and the closed date, records stage history and posts moves on the
  timeline. Declare the stage object (a `select` with the options `open`, `won` and `lost`, a number for the
  order), a relation to it, then `stages: { field, stage: { type, order, ... } }`. See
  `StagesSpec` in `contract.ts`, the README's "Object behaviour", and Deals: `objects.stage` and
  `objects.deal.stages`. A smaller rule on one choice is `requires` on a select option
  (Leads: `status`).
- **`states`** on an object: a fixed state machine, for a lifecycle whose states you set in code
  (a request is submitted, approved or rejected) where `stages` is for ones admins edit. Declare
  a `select` field whose options are the states, then
  `states: { field, initial, moves: [{ from, to, by, requires?, final? }] }`. `by` lists who may
  make each move: `staff` (people, MCP clients, automations and extension code, yours included),
  `customer`, or `host` (only the platform; your tools cannot make it). The host refuses any
  move you did not declare, records state history (`rec_state_history`) and posts moves on the
  timeline when the field is tracked. An object has `stages` or `states`, not both. See
  `StatesSpec` in `states.ts` and the README's "Object behaviour". Do not guard a status field
  in a tool instead: a rule in a tool does not hold for the UI, MCP or an import. A move is made
  from a current read or not at all (ADR 0437): when two people may make the same move at once
  (checking a ticket in), the tool passes `from` to `record.update` and the host lets exactly one
  through; never read the state and then write it.
- **`capacity`** on an object: its records have a limited number of places that the host never
  gives out twice (ticket types, classes, slots). Declare a number field and
  `capacity: { places: "<field>" }`; add `pool: "<relation>"` to draw on a parent's places too (a
  ticket type within its event; the parent object must declare a capacity and no pool), and
  `show: "exact" | "low" | "availability"` (with `lowAt` for `low`) for what customers and the
  public are told. Records get read-only `held`, `taken` and `available`, so don't declare fields
  with those names. Never count places in a tool: claims are made by the host in the write that
  needs them (an order). See `CapacitySpec` in `packages/sdk/src/capacity.ts` and ADR 0431.
- **`sellable`** on an object: its records can be bought (ticket types, passes, products). Only
  an object that declares it can go on an order, and the host reads its price and rules from the
  record: `sellable: { price: "<currency field>", saleWindow?: { from?, until? }, maxPerOrder?,
  deposit?: { amount, balanceDue }, grants? }`. For what a paid line gives the buyer (a ticket
  per place), declare `grants: { object: "<another of your objects>", set: { <field>: "item" |
  "item.<field>" | "order" | "order.person" | "order.email" | "line" | "line.title" |
  "line.unitPrice" | "code" }, void: "<state>" }`: the host creates them when the order is paid,
  in the same batch, and voids them on a full refund. The granted object declares `states` with a
  `host` move into `void` from every state that is not final; a `code` goes in a `readOnly` text
  field; every required field must be set, and the granted object has no `owner`, and no
  `requireOneOf` or choice `requires` the grant does not always fill. A line that grants holds at
  most the record's `maxPerOrder` (10 when unset) and an order at most 100 grants. Only a pack or
  the org's own extension (its client repo) may declare `sellable`: one written in the workspace
  is refused, since selling to the public is a reviewed change. Never create tickets or check a
  sale window in a tool or an automation. See `SellableSpec` in `packages/sdk/src/sellable.ts`
  and ADR 0435.

- **`public`** on an object: what the public may read (ADR 0438), `public: { read: [fields],
  when?: { field, in } | { via, field, in } }`: the fields, of the records whose state (a select
  field of the record, or of the one its `via` relation points to) is one of `in`. Left without
  `when`, every live record. Nothing is public by default, and an object declares `customer` or
  `public`, not both. A customer reads it too. The public reaches it only through your tool, which
  calls `public.list` or `public.get` (add them to `permissions.operations`); never filter by state
  in the tool, the seam does. Anything you sell to customers or guests must declare it: they buy
  only what they may read. See Ticketing: `objects.event.public`, `objects.tickettype.public`.

- **`signedIn`** on an object: what every signed-in customer may read, whoever's record it is
  (ADR 0447), `signedIn: { read: [fields], when?: { field, in } | { via, field, in } }`, the
  shape of `public` and never read by the public. Beside a `customer` declaration it shares the
  records meeting `when` (a class type's sessions) next to each customer's own; `read` must then
  be a subset of `customer.read`, and a customer still changes only their own. Alone, it opens
  every live record (or those meeting `when`) to read (an exercise bank). An object declares
  `public` or `signedIn`, not both. Customers read it with `my.list` and `my.get`. A relation a
  customer's write sets (through your tool) must point at a record they can see: the host
  refuses another customer's as not found, so never check it in a tool. See Programs:
  `objects.session`, `objects.exercise`.
- **`customerVia`** on an object: what a customer reads of a record one of their own records
  points to (ADR 0439), `customerVia: { from: "<id>.<object>", field, read: [fields] }`. `from` is
  another of your objects that declares a `customer` (a ticket), `field` its relation to this one
  (the ticket's `event`), which its `customer.read` must list, and `read` the fields of this object
  they may see. A ticket's holder then reads its event's name, dates and venue whatever state the
  event is in, live, and nothing of an event they hold no ticket for. It can sit beside `public`
  or `signedIn` (an event is public while on sale): the customer then reads both, each
  declaration's fields on the records it covers. Read it with `my.list` and `my.get` (an
  `id in [...]` filter of the ids your customer's records hold); never read the record as the
  extension to fill in names, and never copy its fields onto the customer's record. Reading is
  not buying: a customer buys only what they may read as their own or as the public. Only a pack
  or the org's own extension may declare it. See Ticketing: `objects.event.customerVia`,
  `objects.tickettype.customerVia`, and the `myTickets` tool.
- **A `timezone` field** (ADR 0450) for a record whose days belong to a place (an event in
  another country): an IANA name (`Asia/Bangkok`), refused when it is not one; left empty on a
  new record it is the deployment's zone. Keep instants in `datetime` fields (UTC) and the zone
  beside them, return both from your tools, and show times in the record's zone. See Ticketing:
  `objects.event.fields.timezone`.
- **`publishable`** on an object: a working copy staff edit and published versions (ADR 0446),
  `publishable: { content: [fields] }`. `record.publish` (a person with `records:publish`, never
  an AI actor or your code) snapshots the content fields as the next version; `record.version`
  reads one (the current by default), `record.versions` lists them, `record.restoreVersion`
  copies one back. Records get read-only `publishedVersion` and `publishedAt`, so don't declare
  fields with those names. What follows a version (an assignment) stores its number and reads
  `record.version`, never the working copy. Public reads of a version are stage 28's. See
  Programs: `objects.program`.

### Roles

A pack may declare **fixed staff roles** (`roles`, `RoleSpec` in `contract.ts`, ADR 0436) for
staff who should do one job and nothing else (Ticketing's door role: check tickets in, read
events, ticket types and tickets). A role lists `permissions`, which are permissions its own
tools declare (`permission: "<id>:<word>"` on the tool, see `add-automations-tools-dashboards`),
and `read`, objects of its own (`<id>.<object>`) the holder may open and list. A human admin gives
it to a staff account; while it is held it is all that account may do, on every operation. Use a
role only for that; ordinary staff need none. Only a pack or the org's own extension may declare
one. See Ticketing: `roles` in `packs/ticketing/index.ts`.

To let some staff call one tool their role does not reach (a viewer at the door), declare its
permission **grantable** instead (`grantable: ["<id>:<word>"]`, ADR 0449): a human admin grants it
to an account with `user.setPermissions`, on top of its role. The platform's own grantable
permissions are `records:publish` (a coach who is a member publishing programs) and
`orders:refund`.

## The rules

- **No writes to the database.** An extension reaches data only through operations
  (`ctx.ops.call`), so permissions, approval and audit apply to everything it does.
- **No outside access except through a gatekeeper.** The sandbox has no network; a gatekeeper is
  where credentials, limits and review of outbound traffic live.
- **No change to identity or approval policy.** `extension.*`, `policy.*`, `user.*` and `audit.*`
  can never be granted: code that an AI may write must not be able to widen its own authority.
- **No hook on a write.** A rule on writes is a behaviour in the host, so it holds for every
  actor and cannot be bypassed by another path. An extension reacts after a change, with an
  automation.
- **No UI.** An extension declares views, tabs, panels and dashboards and the host renders them,
  so every product screen keeps working when the host changes.
- **Imports:** only `@composable-os/sdk` and the extension's own files. No `node:*`, no other
  package, no `fetch`.
- **Tests are required.** The first test above, then one for every tool and every automation.

<!-- platform-repo -->
**When something is missing.** If the work needs something the platform, the contract or this
skill does not have, changing them is part of the work, done properly: a behaviour in the host, a
gatekeeper, a core operation, an ADR where `AGENTS.md` asks for one, and this skill updated to
match. Never fake it in extension code with a shortcut or a workaround (a rule enforced in a tool,
a write past an operation, a call past a gatekeeper). If the change is too large for the request,
say so and stop; do not ship the workaround.
<!-- /platform-repo -->
<!-- client-repo
**When something is missing.** In a client repo you cannot change the platform. When the work
needs something the platform, the contract or this skill does not have (a behaviour, an
operation, a gatekeeper, a trigger), stop that part and say exactly what the platform needs and
why, then build the rest. Never work around it in the extension or in an app (a rule enforced in
a tool or a screen, a write past an operation, a call past a gatekeeper, a database opened).

In a client repo the worked examples are the packs as installed:
`node_modules/@composable-os/pack-deals/` and its siblings. Your extension lives in
`extensions/<id>/`; check it with `pnpm cos ext check extensions/<id>` and test it with
`pnpm cos ext test extensions/<id>`. `cos deploy` installs it.
-->

## The check command

```bash
pnpm cos ext check packs/<id>
```

```bash
pnpm cos ext test packs/<id>
```

`check` runs what the host's `extension.check` runs when the extension is installed: allowed
imports, types against the SDK, the contract, formulas, automations, and a dry-run of the schema
changes on an empty database (extensions yours builds on are read from the directories beside
it). It exits 0 only with no issues. Each issue reads:

```
packs/renewals/index.ts:18  objects.renewal.fields.total.expression
  formula/formula_unknown_field: renewals.renewal.total: Unknown field "amout". Fields on this record: ...
  fix: ...
```

- First line: the file and line to open (a best guess for manifest issues) and the path into the
  manifest, which is exact.
- Second line: `stage/code` and the message. Stages run in order and a failing stage hides the
  later ones: `typecheck` (imports, syntax, types; the message starts with `line:column`), then
  `contract`, `formula` and `reconcile` (the schema change is refused, for example a lossy type
  change).
- `fix:` appears when the check knows the fix. Most messages already say what to add or rename.

Fix every issue and run it again until it prints `ok:`. `--json` gives the same issues as JSON.
`test` runs the extension's Vitest tests and fails first if a tool or automation is named in no
test. Do not finish with either command failing.
