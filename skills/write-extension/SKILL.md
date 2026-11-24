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
   Never list `record.*`, `my.*` or `state.resolve` in `operations`: they are granted by object,
   and a listed one reaches every object. A field or setting only a person should change (a
   gym's booking rules) is `personApproves: true`: anyone else's write of it waits for a person's
   approval (not a tool's `humanOnly`, which refuses everyone else). A
   customer field set only when the record is made (a booking's class) goes in
   `customer.createOnly` (ADR 0507). A record its customer may take back (a logged set ticked by
   mistake) declares `customer.delete: true`, and the tool puts it in the Trash with `my.delete`
   (ADR 0414, amended); without it a customer deletes nothing.
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
- **`claims`** on an object with `states`: its records hold a place on the record a relation
  points to, by their state (a booking on its class). Declare
  `claims: { on: "<relation>", held?: [<states>], confirmed?: [<states>] }`; `on`'s object
  declares a `capacity`. Entering a held state holds a place, a confirmed state takes one,
  leaving both gives it back, in the write's batch, and the database refuses one past the places.
  No move may go from a confirmed state back to a held one; while a record holds a place its
  `on` cannot change (a move to another class is a new record) and it cannot go to Trash. Never
  count places or claim them in a tool. See `ClaimsSpec` in `packages/sdk/src/capacity.ts` and
  ADR 0501.
- **`stock`** on a sellable object: its records are things counted on a shelf (a variant of an
  item), and the host keeps how many there are from a ledger nobody edits. Declare
  `stock: { reorderAt?: "<number field>", reorderQty?: "<number field>", show?, lowAt? }`; not
  beside a `capacity`, and with no `sellable.deposit`, `recurring` or `moves`. Records get
  read-only `onHand`, `held` and `available`, so don't declare fields with those names, and never
  write a count field of your own: an order's line holds and sells in its batch, and staff record
  opening stock and corrections with `stock.opening` and `stock.adjust`. A shipped pack only. See
  `StockSpec` in `packages/sdk/src/stock.ts` and ADR 0680. `stock.notify: "<ext>:<word>"` (a
  permission of one of your tools, with `reorderAt`) names who the host tells when a record falls
  to its reorder level, once per crossing; without it the admins are told. Never send that notice
  from a tool or an automation. The object must be sellable, or moved by a `stockMoves`.
- **`stockMoves`** on an object whose records move stock (a receipt, a write-off, a count line):
  `stockMoves: { move: "add" | "remove" | "set", on: "<relation to a stock object>", quantity:
  "<number field>", when: "<state>", through?: "<relation to the record whose state it is>",
  kind?, unitCost?, note? }`. Entering `when` (a state no move leaves) writes the movement in that
  write's batch; with `through`, a count's `applied` moves all its lines at once (`set`: on hand
  becomes the number counted). Declare every move into `when` as `by: ["host"], tools: [...]`
  with the pack's `humanOnly` or `personApproves` tools carrying its stock permission, and never
  `create.in` the state (make the record, then move it through the tool): moving stock is a
  person's act, and an AI's waits for one. Never change stock from a tool otherwise: move the
  record. What moved stock cannot be edited afterwards. A shipped pack only. See
  `StockMovesSpec` and ADR 0681.
- **`unique`** on an object: `unique: [{ fields: [<up to 4 fields>], states?: [<states>] }]`, no
  two live records in those states share the fields (one active booking per Person per class).
  The database refuses the second, however many write at once (`conflict`, `rule: "unique"`).
  Never check for a duplicate in a tool instead. See `UniqueSpec` in `packages/sdk/src/unique.ts`
  and ADR 0502.
- **Windows and staff-only rules** on `states`: a move's `window: { from?, until? }` and
  `staffOnly: "<boolean field>"`, and the same on `states.create` for every create, bind
  customers (staff and the host are not bound). A move only a person should make (voiding a pass)
  is `by: ["host"], tools: ["<tool>"]`: only the host and that tool make it, and the tool is
  `humanOnly` with a `permission` (ADR 0513). An end is `"<datetime field>"` or
  `{ at, daysBefore?, minutesBefore?, zone? }`, each a field of the record or
  `<relation>.<field>` (`klass.startsAt`), up to two relations away (`class.classType.lateMinutes`,
  every field on the way your own, including fields you add to another pack's object), or a
  number: "opens 7 local days before, closes 30 minutes before". A number may also be `{ field,
  setting }`: the field, else your extension's number setting of that name (a class type's own
  rule over the organisation's default, read in the write, never copied). `staffOnly` may list
  several booleans, a boolean formula among them (a class that is not scheduled).
  `states.requests: { cancel: ["cancelled", "late_cancelled"] }` lets a caller write `cancel`
  and the host pick the state by the clock, and a tool shows the member which first with
  `state.resolve { object, id, request }`; `states.create.in: { waiting: ["staff", "customer"] }`
  lists states a record may be created in besides `initial`, and who may (a customer never
  creates in any other). `states.create.closed: "<boolean path>"` closes creates to everyone but
  the host (a class that is cancelled). `states.follows: { relation, when: { <parent state>:
  <state> }, from }` moves your live records when the record they point to moves (a class
  cancelled cancels its bookings, in its batch; ADR 0507). The parent may be an object of an
  extension you `requires`, named in full; an object drawing places from a pool cannot follow it,
  and one call moves at most 80 records (ADR 0841). A request is resolved by the clock for
  every caller but a person. Never decide "late" or
  "too early" in a tool. See `StateMove` and `StatesSpec` in `packages/sdk/src/states.ts`, ADRs
  0503 and 0505, and Bookings: `packs/bookings/index.ts`.
- **`recurring`** on a series object: a rule in local time that makes records of another
  of your objects ahead (a timetable line makes its classes). Declare the rule's fields (a
  `multiSelect` of `mon`…`sun`, an `HH:MM` text field, a length in minutes, from and until
  dates, a `timezone`), then `recurring: { generates: "<object>", link: "<read-only relation on
  it back to the series>", rule: { weekdays?, time, length?, from, until?, zone?, unit?, every?,
  day?, month?, lengthDays? }, into: {
  starts, ends?, zone?, changed? }, copy?: { <generated field>: "<series field>" }, cancel:
  "<a state of the generated object with a host move into it>", ended?: { field, in },
  closures?: { object, from, until }, horizonDays?, horizonAtLeast?: { object, field },
  horizonSetting? }`
  (`horizonAtLeast`: a number field in days, a booking window, the horizon never falls short of;
  `horizonSetting`: your number setting, in days, that sets the horizon when it holds a value,
  Rostering's duty horizon). Without `unit` the rule is weekly. For every N weeks, months or
  years (a quarterly service, a yearly test) add the interval rule (ADR 0860): `unit` (a
  `select` whose options are some of `week`, `month`, `year`), `every` (a number, empty is 1),
  `day` (day of the month, 1 to 31: a shorter month uses its last day) and `month` (1 to 12, for
  years), both empty meaning the `from` date's, and `lengthDays` (a number of days) instead of
  `length` for a window that stays open for days. Dates are fixed on the calendar from `from`,
  never counted from when the last one was done. The host makes the records from the minute
  cron, keeps 06:00 at 06:00 across a clock change, never overwrites one staff edited, applies a
  series change to the rest, and cancels what a closure covers. Never create the dated records
  in a tool or an automation. See `RecurringScheduleSpec` in `packages/sdk/src/recurring.ts` and
  ADR 0500.
- **`staffed`** on an object whose records are shifts someone works (a class its coach teaches, a
  duty shift): `staffed: { who: { field: "<user field>" } | { field: "<relation to another of
  your objects>", account: "<its user field>" }, starts, ends, zone?, kind: "<relation: what
  qualifications are for>", live: [<states in which it is a shift>], place?, pattern?: { link,
  who }, claimBefore?, claimAfter?, account?: "required", private? }`. `claimBefore`/`claimAfter`
  (`{ field: "<kind>.<number field>" }`, minutes; the kind one of your objects) are a buffer the
  claim keeps free around the shift (ADR 0760); `account: "required"` refuses a shift whose profile
  holds no account; `private: true` when the title can name a client: the roster shows the kind
  instead to other staff, and it is never offered (ADR 0761). The host refuses one staff account on two overlapping shifts in the database, across
  every staffed object, for every writer (`conflict`, `rule: "double_booked"`), and answers each
  write with its warnings (away, not qualified, nobody on it). Shipped packs and the org's own
  extensions only. Never check for a clash, or work out who may take a shift, in a tool. See
  `StaffedSpec` in `packages/sdk/src/staffed.ts` and ADRs 0621 and 0622. The roster's tools are
  Rostering's (`packs/rostering`): they call the host's tool-only `staffing.*` operations, which act
  for the tool's verified caller; the pack declaring `staffing: { rosters, settings? }` (a
  restricted permission, and its number settings for the offer cut-off and the uncovered window)
  sets who rosters and the numbers (ADR 0626), each number setting `personApproves`. With such
  a pack installed, only a rosterer writes who works a shift (its person, a series' regular person,
  a profile's account), by any path; never set one in a tool or an automation.
- **`occupies`** on an object whose records take a room, chair or hall for their time (a class in
  a private room): `occupies: { thing: "<relation to another of your objects, one or many>",
  starts, ends (both required datetime fields), live: [<states in which it takes it>], before?: { field }, after?: { field },
  only?: "<a boolean field of the thing>" }`. The host refuses, in the database, two live records
  on one thing at an overlapping time, across every object that declares it, for every writer
  (`conflict`, `rule: "room_taken"`, naming no other record). `before` and `after` are minutes
  kept free (a number field, or `relation.field`: a service's buffer). With `only`, just the
  things with that flag set are claimed (a room marked "one booking at a time"; a shared floor
  never). Never check whether a room is free in a tool. For the room calendar (`rooms.week`,
  `rooms.check`, read by a shipped pack's tool), `provisional: [<live states shown as held>]` and
  `title: "<a text or select field, or relation.field of one of your objects>"` (never the
  client's name; left out, the object's label). See `OccupiesSpec` in
  `packages/sdk/src/occupies.ts` and ADRs 0765 and 0844.
- **`calendarEntry`** (shipped packs only) on an object with a `customer` whose records are a
  customer's appointments (a booking, a ticket): `calendarEntry: { starts, ends: "<datetime
  paths>", title, place?: "<text paths>", live: [<states in which it shows>] }`. A path is a
  field, or up to two relations and a field (`klass.startsAt`, `klass.room.name`). Its first field
  and the states field must be in `customer.read`. Further on, a `title` or `place` field must be
  one that object makes `public` or `signedIn` (never a class's own title, which may name a
  member); a `starts` or `ends` field may also be, one relation away, its `customerVia` from this
  object. The host then shows the records, read as the customer, in their private calendar feed
  (and a live dependant's in their guardian's). Never put a name, note or price there that the
  customer cannot already read. See `CalendarEntrySpec` in `packages/sdk/src/calendar-entry.ts`
  and ADR 0891.
- **`intake`** when the public or customers send answers (a form, its submissions, a record a
  form may also make): `intake: { role: "form", questions: "<document field with
  QUESTIONS_SCHEMA, in publishable.content>", answeredBy: "<select: public, customers, links,
  staff>", openIn: [<states>], anonymous?, destination?, opensAt?, closesAt?, dailyCap?, notify?,
  hourlyCap?: "<a number setting of yours, personApproves>" }`
  on a publishable form object, with `answeredBy`, `anonymous` and `destination` in its
  `publishable.content` (they are read from the version answered), and `publishable.slug` for a
  form a link names by its address (`intake.open { object, slug }`); `{ role: "submission", form: "<relation to it>", version,
  answers: "<document field with ANSWERS_SCHEMA>", person, certainty: "<select: account, link,
  staff, address>", spam: "<a state the host creates it in>", via?, rating?, marketing?: "<a
  boolean the host sets when a marketing consent line was ticked>" }` on its submission
  (never with `customer`, `public` or `signedIn`); `{ role: "destination", person, fields: [<what
  a form may fill>], source? }` on a record another pack's form may make. The host's one door,
  `intake.submit` (tool-only: your tool calls it for your own form, with `intake.open` first for
  the public's shown-time token), checks the form is open to the caller, Turnstile, the honeypot,
  the fill time, the caps and the answers, and makes the submission, the Person (empty fields
  only) and any destination record itself. Never create a submission or check spam in a tool: only the door creates one, and a
  submission's form, version, answers, certainty, via, rating and marketing are the host's on
  every path. Give a form no `public` scope: the public reads it through `intake.open` only. Shipped
  packs and the org's own extensions only. See `IntakeSpec` in `packages/sdk/src/intake.ts`, ADRs
  0720 to 0722, 0725 and 0726, and Forms: `packs/forms/index.ts`.
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
  `requireOneOf` or choice `requires` the grant does not always fill. What is granted for a time
  (a pass valid for 30 days) adds `valid: { from?, until?, days?: "item.<number field>" }`: the
  host writes its dates when it grants it. Something a Person may buy only once (an intro offer)
  declares `onePerPerson: "<boolean field>"`: while true on a record, one per Person across the
  object's records with it on, bought signed in, held from the order's start (ADR 0512). A line
  that grants holds at most the record's `maxPerOrder` (10 when unset) and an order at most 100
  grants. Say what kind of sale it is in the finance reports with `finance: { category: { key,
  label }, earned }` (ADR 0792): `earned` is `at_sale` (the default), `over_period` (a plan's
  paid period, only with `recurring`), `per_use` (a grant that holds uses, a pass) or `at_date`
  with `at: "<date field or relation.field>"` (an event's start). One key, one label. Only a pack or
  the org's own extension (its client repo) may declare `sellable`: one written in the workspace
  is refused, since selling to the public is a reviewed change. Never create tickets or check a
  sale window in a tool or an automation. See `SellableSpec` in `packages/sdk/src/sellable.ts`
  and ADR 0435.
- **`allowance`** on an object: its records hold uses that something else spends (a pass, a
  membership), or spend them (a booking, a visit). A holder declares `allowance: { holds: { person,
  uses, per, spendsOn, from?, until?, live?, zone? } }`: a relation to person, a number field
  (empty is unlimited), `"total" | "week" | "month"` or a select field with those options, what it
  pays for (`{ object, when?: [{ field, in | atLeast | below }] }`, comparing a spender field the
  host fills with a holder field or a literal), its date fields, the states it can be spent in
  (required with `states`), a timezone field and `emptyIsUnlimited: true` if an empty uses means
  unlimited (otherwise it means none). Keep these fields out of `customer.write` and every tool's
  `customerFields`, and declare no fields named `used` or `left` (the host adds them). A customer
  never creates a holder: grant it from an order or make it as staff. A granted holder (what
  `grants` or `recurring.grants` makes) keeps its terms `readOnly`, and only the host moves it into a
  live state; a live holder, or a granted one not ended or void, cannot go to the Trash; your own
  code writes a holder's terms only from a `humanOnly` tool with a `permission` (ADR 0513). A spender declares `states` and `allowance: { spends:
  { person, holder, spendIn, returnIn, at?, copy?, local?, movedFrom? } }`: a text field for the
  holder's id (callers may set it to choose), the states that spend and give back, its time (a
  datetime of its own or `relation.field`), read-only fields the host copies from one relation away
  and the local `weekday` and `minute` it fills, and `paidBy` (holder objects or extensions of
  other packs that may pay for it; left out, only yours). Conditions read only the fields the host
  fills (`copy`, `local`). Changing what a spender points at while it holds a use spends again for
  the new target, or is refused. A spender paid outside the allowance (a walk-in at the desk)
  names `waived: "<read-only boolean>"`, set by your own code when it is made: it then spends
  nothing, and the mark cannot change while it is in a spend state (ADR 0506).
  Never count uses or pick a holder in a tool: the host spends in the write that moves the record.
  See `AllowanceSpec` in `packages/sdk/src/allowance.ts` and ADRs 0493 and 0494.

- **`healthNotes`** on an object: its records make a list staff read (a class's bookings), on
  which the host may mark "health note" beside a Person whose current health form has a yes (stage
  44, ADR 0643). `healthNotes: { list, person }`: `list` is a relation (one record) to the list's
  own object (the class), `person` a relation to `person`. A tool a person calls asks
  `agreement.listHealthNotes { records, value }` (add it to `permissions.operations`) with the
  list's record id; the host reads the People itself and answers a yes or no each, never the form.
  Only a shipped or repository extension may declare the operation. See Bookings:
  `objects.booking.healthNotes`.

- **`restricted`** on a field: words only some staff may read (a review's private feedback; stage
  54, ADR 0811). `restricted: "<id>:<word>"` on a `text` or `longText` field of an object that
  declares a `customer` who reads and writes it, naming one of the pack's restricted permissions
  (below). The host keeps the value apart from the record: no view, list, filter, search, export,
  dashboard, formula or timeline has it, and nothing else of the object may name it (title,
  indexes, `unique`, `public`, `publishable`, seeds). The customer writes it with `my.create` /
  `my.update` and reads their own; staff read it only from a `humanOnly` tool of yours that names
  the permission and no other, calling `record.readRestricted { object, field, ids }` (up to 50; every read
  audited). A tool whose input takes it (by its name, at any depth, or any other) lists that key in `redact`. Shipped and repository
  extensions only.

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
- **A `timezone` field** (ADR 0460) for a record whose days belong to a place (an event in
  another country): an IANA name (`Asia/Bangkok`), refused when it is not one; left empty on a
  new record it is the deployment's zone. Keep instants in `datetime` fields (UTC) and the zone
  beside them, return both from your tools, and show times in the record's zone. See Ticketing:
  `objects.event.fields.timezone`.
- **`publishable`** on an object: a working copy staff edit and published versions (ADR 0446),
  `publishable: { content: [fields] }`. `record.publish` (a person with `records:publish`; your
  code or the assistant only asks, and a person approves, ADR 0480) snapshots the content fields as the next version; `record.version`
  reads one (the current by default), `record.versions` lists them, `record.restoreVersion`
  copies one back. Records get read-only `publishedVersion` and `publishedAt`, so don't declare
  fields with those names. What follows a version (an assignment) stores its number and reads
  `record.version`, never the working copy. See Programs: `objects.program`.
- **Content the public reads** (a post, an event page; stage 28, ADRs 0440 to 0443): prose is a
  **`richText`** field (`{ type: "richText" }`, the platform's one schema, `RICH_TEXT_SCHEMA`:
  never HTML, never a `longText` of markup); its address is a **`slug`** field, unique among live
  records and made from the title when left empty. Declare `publishable: { content, slug, date? }`
  (the slug is not content; `date`, a content date field, is filled when it goes live), a picture
  is an **`image`** field (`{ media, alt, focal? }`, a media library item the host checks), and
  `public: { read: [...] }` listing the slug. The public then reads only the published version,
  with `content.get { object, slug }` and `content.list`, and a draft is not found. Records also
  get `publishState` (draft, scheduled, published, unpublished) and `publishAt`, for views.
  Publishing, scheduling (`record.schedulePublish`) and unpublishing are a person's; your code and
  the assistant write the working copy, and a call of theirs to publish waits for a person's
  approval whatever the policy (ADR 0480). See Content: `packs/content/index.ts`.
- **Videos and downloads** (stage 42, ADR 0475): a **`video`** field (`{ media, poster? }`, a
  ready video in Cloudflare Stream, checked by the host), or in your own document a ref to media
  with its kind: `{ type: "ref", to: "media", media: "video" }` (`VIDEO_NODE`) or
  `media: "file"` for a PDF (`FILE_NODE`). A video plays only with a token from `media.play`
  (ADR 0476), which the host gives only to someone who may read the part that shows it: never
  build a player address yourself.
- **What only paying customers read** (ADR 0477): declare `access: { sources: [...] }` (a record
  of yours that declares a customer, such as an enrolment, in the states that give access and
  before its `until`, pointing at the record or, with `through`, at a record whose list names it),
  and mark the parts of a document for holders: `holders: { keys: [...], unless?: "<boolean>" }`
  on an object node (or `holders: true` for the whole node). Never check access in a tool or a
  block: the host removes those parts for everyone else, and `media.play` refuses them. Only a
  pack or the org's own extension may declare it. A refund's void state gives no access.
  A customer's own record that must only be written with access (a lesson's progress) lists its
  relation in `customer.requireAccess`; the host then refuses the write without it. See Courses:
  `packs/courses/index.ts`.
- **Something paid for every month** (stage 32a, ADRs 0485 and 0488): a plan object declares
  `sellable.recurring: { interval, trialDays? }` (subscribed to with `subscription.start`, never on
  an order), and the objects it opens add `{ kind: "subscription", options: { plans:
  "<id>.<plan>", covers: "all" } }` to their `access.sources`: the subscription's holder then holds
  every live record while the host's record says it runs. The one free trial per person, the
  provider's page, cancelling and the portal are the host's: a tool or a block never decides them,
  and a native block never calls a subscription's billing operation (the block lint). See Courses'
  `plan`. A plan whose subscription gives a record of its own (a membership, an allowance holder)
  declares `sellable.recurring.grants: { object, set, from?, until?, states }` (`set` from `item`,
  `item.<field>`, `subscription`, `subscription.holder`, `subscription.payer`; `states` maps each
  subscription state to one of the granted object's, `ended`'s final, with host moves between them):
  the host makes it when the provider first reports the subscription running and moves it with
  every verified event, its `until` when it stops giving. It is not the `recurring` behaviour
  above. See Memberships' `plan` (ADR 0510).
- **An extension built on another** declares `requires: ["<id>"]` (Courses requires Programs and
  Content): the host refuses to install it until that one is installed and on, and `cos deploy`
  installs a required pack the product does not list. Require a pack whose blocks yours need too
  (Courses' player draws text lessons with Content's rich text, and its block.json `dependsOn`
  names that block).

### Roles

A pack may declare **fixed staff roles** (`roles`, `RoleSpec` in `contract.ts`, ADR 0436) for
staff who should do one job and nothing else (Ticketing's door role: check tickets in, read
events, ticket types and tickets). A role lists `permissions`, which are permissions its own
tools declare (`permission: "<id>:<word>"` on the tool, see `add-automations-tools-dashboards`),
and `read`, objects of its own (`<id>.<object>`) the holder may open and list. A human admin gives
it to a staff account; while it is held it, and the pack permissions granted to the account, are
all that account may do, on every operation. Use a role only for that; ordinary staff need none. Only a pack or the org's own extension may declare
one. See Ticketing: `roles` in `packs/ticketing/index.ts`.

A shipped pack may also declare **device roles** (`deviceRoles`, `DeviceRoleSpec` in
`contract.ts`, ADR 0781) for the business's own enrolled device, signed in as nobody (a check-in
tablet by the door): `{ label, description, permissions, screen: { block, export } }`. Its
permissions are those of tools declared `audiences: ["device"]` and nothing else's (no staff
role, grant or restriction names them); the tool reads as the extension, returns only what its
output declares (never a Person id or a reason for the room), and records who ticked from
`ctx.caller` (`{ kind: "device", deviceId, name }`). The screen is a web block of the pack.

To let some staff call one tool their role does not reach (a viewer at the door), declare its
permission **grantable** instead (`grantable: ["<id>:<word>"]`, ADR 0449): a human admin grants it
to an account with `user.setPermissions`, on top of its role, a pack role included: they add up
(ADR 0600), and the role's limits (`today`) bind only the calls the role allows. Give it plain words
for the admin's tick (`grantableLabels: { "<id>:<word>": "..." }`). A permission a role holds cannot
be grantable: name another permission on the tools a grant should open, and when one tool is both
the role's and the grant's, give it both (`permission: ["<id>:coach", "<id>:desk"]`, any one opens
it; Bookings' `day`). See Bookings: `grantable` and `bookings:desk`.

Every member holds every tool unless its permission is **restricted** (`restricted: ["<id>:<word>"]`,
ADR 0625): then admins hold it, and anyone a human admin grants it (declare it `grantable` too), and
nobody else; no role may hold it, a tool naming it names only restricted ones, and it is never
called by an automation or another extension's code. For what only some staff should do over
other people (rostering others, pay). See Rostering: `restricted` and `rostering:manage`. The platform's own grantable
permissions are `records:publish` (a coach who is a member publishing programs) and
`orders:refund`; they are never granted to an account with a pack role.

### Staff screens (shipped packs only)

A **shipped pack** (in `packs/<id>/`, never one written in the app) may show its staff web blocks
in the product's admin by declaring **screens** (`screens`, `ScreenSpec` in `contract.ts`, ADR
0660): `screens: { desk: { label: "Front desk", block: "<id>-desk", export: "FrontDesk", nav:
{ group: "Bookings", order: 10 }, opens: ["findPeople", "bookFor"] } }`. `block` is a web
block of the same pack and `export` a component one of its files exports; the admin's build fails
if either is missing. `opens` names the pack's own tools that decide who may open it, its main read and the write its
main action makes (at least one for staff only), not every tool it calls: the host lists the screen
for exactly the people who could call every one of them, and refuses the rest of what the screen
calls, so the block shows its own state for that. A screen that saves through the host's record
writes rather than a tool (a course builder) is gated by `writes: ["<id>.<object>"]` instead: the
viewer must be able to write that object. A record screen adds `record: { object: "person", as: "personId" }` (one of the
pack's objects, `person` or `organisation`) and is a tab on that record page, given the record's id
as that prop; with `nav` too it is also in the navigation, opened without a record. The block gets
the pack's hooks as the prop named for the pack and nothing else, so a screen whose block needs
other props gets a small wrapper export that works them out (Bookings' `FrontDesk` around `Desk`).
A runtime extension declaring `screens` is refused. See Bookings and Rostering: `screens`.

### Numbers on Today (shipped packs only)

A **shipped pack** may add up to 8 numbers to the owner's Today by declaring **Today items**
(`todayItems`, `TodayItemSpec` in `contract.ts`, ADR 0870): `todayItems: { cameToday: { label:
"Came today", order: 20, format: "count", sql: "SELECT count(*) AS value FROM rec_x_<id>_booking
WHERE ... >= :today_from AND ... < :today_to", compare: "yesterday", attention: { above: 0 },
rows: { sql: "SELECT p.name AS member, p.id AS person_id FROM ...", label: "member", record: {
object: "person", id: "person_id" } }, opens: ["roster"] } }`. The SQL follows the widget rules
(one `SELECT`/`WITH` over `rec_*` views) with only `:today_from`, `:today_to` (the business's local
day) and `:now`, and returns exactly one column, `value`; `rows` returns exactly its `label`,
optional `detail` and `record.id` columns (names and ids, never notes, health answers, pay or
leave). `format` is `count` or `percent`: a pack declares no money number (money on Today is the
host's, from Finance reports). `opens` is the gate, as a screen's (this pack's tools, at least one
for staff only); `web: { screen }` names one of the pack's screens for the web card. A runtime
extension declaring `todayItems` is refused.

### Journey signals (shipped packs only)

A **shipped pack** may name the moments about a Person that a journey can start or stop on
(`journeySignals`, `JourneySignalSpec` in `journey-signals.ts`, ADR 0802): `journeySignals: {
attended: { label: "Class attended", object: "booking", enters: ["attended"] } }`. A signal is a
record of one of the pack's objects created (no `enters`), or entering one of its states;
`from: [...]` counts only a move out of those states, and `created: false` leaves out a record
created straight into one. `person` is the relation to one person it is about, by default the
object's customer field. Declare what a business would follow up on ("membership ended", "trial
ended", "class attended"), not every state. Never record one in a tool or a hook: the host records
the last time each Person had each, in the write's batch, for every writer. A runtime extension
declaring `journeySignals` is refused. See Memberships, Bookings and Ticketing: `journeySignals`.

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

**A shipped pack has an overview.** In `packs/<id>/`, write `docs/overview.md` in the same pull
request: front matter (`title`, `summary`, `stage`, `spec`, `adrs`) and the sections "What it is
for", "Concepts", "How the pieces fit", "Main flows" and "What is built", describing only what the
code does (Bookings' and Rostering's are the pattern). Then run
`pnpm --filter @composable-os/docs generate`: the docs site's reference pages are generated from
the manifest and never edited by hand, and CI fails while they are stale (ADR 0930).
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
