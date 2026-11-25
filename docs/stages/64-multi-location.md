# Stage 64: More than one location

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md) (Deployment, Host, Visibility seam, Pack role, Grant, Allowance,
Shift, Location hint), ADRs [0001](../adr/0001-self-hosted-single-org.md) (one organisation per
deployment), [0244](../adr/0244-visibility-enforced-at-one-seam.md) and
[0410](../adr/0410-the-seams-first-door-as-built.md) (the visibility seam),
[0402](../adr/0402-staff-and-customers.md) (audiences),
[0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) (one
currency, the host prices), [0435](../adr/0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md)
(`sellable`), [0436](../adr/0436-pack-roles-and-the-door-role.md) (pack roles, what a fixed-role
account is refused), [0460](../adr/0460-time-zones-on-records.md) (a record's own zone),
[0493](../adr/0493-the-allowance-behaviour.md) and
[0494](../adr/0494-which-holder-pays-and-what-happens-to-uses.md) (the allowance, a holder's zone),
[0502](../adr/0502-declared-uniqueness.md) (declared rules refused on every write),
[0553](../adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md) (a pack role limited
to today), [0600](../adr/0600-a-pack-role-and-its-grants-add-up.md) (roles and grants add up),
[0610](../adr/0610-three-homes-for-a-client-hosted-by-default.md) (clients kept apart by their
data), [0621](../adr/0621-the-staffed-behaviour-and-the-time-claim.md) and
[0622](../adr/0622-warnings-in-a-writes-answer.md) (shifts, the time claim, warnings),
[0627](../adr/0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md) (pay periods),
[0057](../adr/0057-dashboards-params-cache-and-click-through.md) and
[0871](../adr/0871-day-windows-in-the-business-zone.md) (dashboard filters, the business's day),
[0762](../adr/0762-open-hours-and-free-times.md) (open hours); stages
[14](14-teams-permissions.md) (14a, staff scopes), [31](31-bookings.md), [32](32-memberships.md),
[34](34-offers.md), [37](37-shop.md), [45](45-rostering.md), [46](46-hosted-clients.md),
[47](47-pack-screens.md), [49](49-appointments.md), [50](50-till.md),
[51](51-kiosk-check-in.md), [52](52-finance-reports.md), [57](57-events-venue-hire.md),
[48](48-my-account.md) and [58](58-timesheets-leave.md); `packages/core/src/pack-role-today.ts`,
`packages/core/src/settings.ts` (`org_timezone`), `packages/core/src/orders/sellable.ts` and `orders/gateway.ts`,
`packages/core/src/fields/` (the base records), `packs/bookings/index.ts`,
`packs/memberships/index.ts` (`SPENDS_ON`) and `packages/sdk/src/allowance.ts`.

Status: **spec agreed** (owner interviewed 2026-11-24: decision 1; the other points were decided
as best practice without asking, below). Build may start.

## Status

- **Step 1** — built — PR #416 — `core_location`, its operations, the main location and the public reads
  (`feat/stage-64-locations`; migration 1390, ADRs 0910 and 0916, which amend ADRs 0001 and 0610):
  the base record `location` (`fields/location.ts`, in the registry's base objects; `core_location`
  and `rec_location`), with name (unique whatever the case), short name, address, zone, public,
  drop-in price, open or closed, notes; the main location made by the migration from `org_name`
  and `org_timezone` (else "Main location" in UTC), re-runnable without change, which keeps the
  organisation's zone (`settings.update`) and its name while it has the one it was given;
  `location.list`, `location.get`, `location.create` and `location.update` (an AI's waits for a
  person), `location.close` and `location.reopen` (a person only), the last open location refused
  closing by the handler and a trigger; the `public` declaration (name, short name, address, zone
  of a public open location, through `public.list` and `public.get` from a pack's tool; no new
  open operation). Not yet: the coverage choices in `location.create` (step 4), a closed location
  refusing new classes (step 2), what a pack-role account reads of locations (step 5), screens.

- **Step 2** — built — PR #492 — `located`, `agree`, the reconciler fill, the located zone default
  (`feat/stage-64-located`; ADR 0911, which amends ADR 0460; no migration): `location` a relation
  target; `located` (a required relation to one location, or `relation.field` one relation away)
  and `agree` in the SDK and checked by `cos ext check`; a new located record at the only open
  location, a located record's empty zone its location's (`record.create`, `recurring`, the
  reconciler), the reconciler's fill of a new or newly located field with the main location (one
  statement per field); `agree` refused by triggers on the declaring table and the table a path
  passes through (`location_mismatch`: a used room keeps its location), read first in the write
  path, and an install over disagreeing records refused; a closed location takes no new located
  record and its series make nothing. Not yet: any shipped pack located (steps 4 and 6), the zone
  readers (step 3).

- **Step 3** — not built — needs: step 2 — Zone readers made location-aware; `core_staff_hours.location`
  (1393); the dashboard filter and day.

- **Step 4** — not built — needs: step 2 — Bookings and Memberships: fields, copies, `covers` and the
  coverage step in `location.create`, `SPENDS_ON`, the price chain, `core_order.location` (1392),
  emails, dashboards.

- **Step 5** — not built — needs: step 2 — Staff limits: `core_user_location` (1391), `user.locations.*`,
  the limit beside "today", the registry-wide test.

- **Step 6** — not built — needs: step 5 — Rostering: duty series and duty shifts located, the grid
  filter, offers and notices by location, the warning.

- **Step 7** — not built — needs: step 4, step 6, stage 47, stage 48 — Screens and blocks: Settings →
  Locations with coverage, Works at, the switcher, the picker, My account sections, native.

- **Step 8** — not built — needs: step 1, step 2, step 3, step 4, step 5, step 6, step 7 — Docs and the
  site: `CONTEXT.md`, `docs/architecture.md`, `apps/marketing` and `SITE.md` (last).

## Goal

A business with two or three locations (a gym with a second studio across town; later, a trades
business with a second depot) runs them all from **one system, sharing one member list, with each
location's timetable, rooms, staff and reports kept apart inside it**. A member is one Person with
one sign-in and one membership, usable at the locations their plan covers. Each location has its
own timetable, rooms, coaches and roster, and its own time zone. Prices may differ by location.
Every report can be read for one location or for all of them. A coach, the front desk or a cleaner
sees only the locations they work at. One payment account and one currency serve every location.

## Who it is for

- **Gyms and studios, first.** One owner, one brand, one member list, two or three locations a
  short drive apart. Members want one sign-in, one membership and one app, and to book at the
  other studio when it suits them. The owner wants to compare locations ("which one is full at
  6 am"). The team at each studio works only there, apart from a few coaches who teach at both.
  Rooms and timetables belong to one location; a membership may cover one location or all of them
  and may cost more when it covers all; a drop-in may cost more at the newer studio.
- **Trades and services businesses** (the next vertical) need the same backbone with a different
  meaning: their location is a **branch or depot** that owns work, not where the work happens (the
  job is at the customer's address). Jobs (stage 39) and Invoices (stage 35) are specced and list
  several branches as out of scope; this stage gives them the platform piece (`located`, the staff
  limit, the report filter) and names what they declare when a trades client with a second branch
  needs it. Service areas, handing a job between branches and stock per branch stay with their own
  stages.
- **Not franchises.** Separately owned businesses that share a brand are separate organisations
  with their own members, money and staff: several hosts, one per owner (ADR 0610), nothing shared.

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | **One system for all locations, sharing one member list, with each location's timetable, rooms, staff and reports kept apart.** Not a separate system per location. Separate systems stay the answer only for franchises, where each location has a different owner |

The other questions drafted for this stage were decided as best practice without asking (the
owner's standing rule of 2026-11-24). They are listed under
[Decided by this spec, open to override](#decided-by-this-spec-open-to-override), items 1 to 9.

## What exists today (from the code, checked 2026-11-24)

- **One organisation per deployment** (ADR 0001): no tenant id anywhere. ADR 0610 keeps it for
  hosted clients: "Clients are kept apart by their data, never by a tenant id." So a location is a
  record inside the one organisation, never a tenant.
- **Base records** live in core with their field lists in `packages/core/src/fields/`
  (`person.ts`, `organisation.ts`, `task.ts`, ...). There is no location among them.
- **Rooms** (`packs/bookings/index.ts`, `room`: name, places as "a guide for staff, not a limit",
  notes; the public reads the name) are where classes are held. A series and a class each relate
  to a room. Nothing says which building a room is in. Stage 31 lists "Several locations with their
  own timetables and reports beyond a room's name (guess: one site)" as out of scope; stage 45
  lists "Several locations with their own rosters". Stage 49 (built in part: open hours,
  `core_staff_hours`, migration 1090) adds appointments, services and `occupies` on rooms. Stage 57
  hires out spaces made of rooms.
- **Time zones are per record.** A `timezone` field defaults to the organisation's zone
  (`org_timezone`, `packages/core/src/settings.ts`, ADR 0460). A series and a class carry their
  own zone; a holder's weeks count in its own zone or the organisation's (ADR 0494). The
  organisation's zone is read as the only zone by: pay periods (`staffing/pay.ts`), the daily
  uncovered notice (`staffing/due.ts`), leaving (`staffing/leaving.ts`), the rostering screens'
  "today" (`operations/staffing-screens.ts`), offers (`staffing/offers.ts`), open hours
  (`operations/staffing-hours.ts`), a pack role's "today" for a record with no zone
  (`pack-role-today.ts`), window numbers (`records/windows.ts`), checklist runs with no zone
  (`checklists/runs.ts`), `orders/grants.ts`, the agreements copy (`agreements/copy.ts`), the
  duplicates scan and every dashboard's date presets (ADR 0871, `dashboards/run.ts`).
- **The visibility seam** (`packages/core/src/visibility/`) gives staff the scope `all`. Staff
  scopes (own, own team), the rewrite of free SQL (door 2) and the filtering of search (door 3) are
  stage 14a's, proposed and not built. Teams there are owner-based, not place-based.
- **A role limited by object exists**: a pack role may reach `bookings.class` only when it is on
  today (`pack-role-today.ts`, ADR 0553): a predicate in `record.list`'s own query, a check of the
  stored row on `record.get` and `record.update` (not found otherwise), anything else on the object
  refused. The coach role and the rostered team role are pack roles; the front desk is a grant
  (`bookings:desk`, ADR 0600). A fixed-role account is refused `person.list`, search, `query.sql`,
  dashboards and the assistant (ADR 0436).
- **Memberships spend by declared conditions.** A plan's limits are copied onto the membership it
  grants; Bookings' booking copies its class type and local weekday and minute from the class; the
  allowance spends only when every condition holds (`SPENDS_ON` in `packs/memberships/index.ts`;
  `AllowanceCondition` in `packages/sdk/src/allowance.ts`, where an empty holder list allows any
  value). 20 spends at once for 5 uses make exactly 5 (ADR 0493).
- **Prices.** A drop-in is priced from `class.classType.dropInPrice`, else the organisation's
  `dropInPrice` setting (`sellable.moves.price` in `packs/bookings/index.ts`, read by
  `orders/sellable.ts`). One currency per deployment (ADR 0427).
- **One payment account**: "the first active org connection of the payments gatekeeper"
  (`orders/gateway.ts`).
- **Dashboard filters** (ADR 0057) are `user`, date ranges, `select`, `field` (choices from a
  registry field) and `text`, bound into read-only SQL over `rec_*` views. There is no filter whose
  choices are records, so a location filter is a small new kind, not nothing new (the draft said
  otherwise).
- **No shared identity between hosts** (ADRs 0419, 0458, 0610; stage 46).

## The design in one page

- **A Location is a base record in core** (`core_location`): name, short name, address, time zone,
  shown to the public or not, and open or closed. A base record, not a pack's object, because
  Bookings, Rostering, Memberships and later Till, Kiosk, Jobs and Shop relate to it whether or not
  the others are installed, and which locations a staff account works at is identity and policy.
- **Every host has one location from the start.** A migration makes it, named after the
  organisation, in the organisation's zone. The reconciler fills it into every existing record that
  gains a location field. With one location no screen shows a picker, a filter or a badge; nothing
  changes for a single-site business.
- **A pack says what is located by declaring it** (`located`): a field that is a relation to
  `location`, or a path to one (a booking's `class.location`). That one declaration drives staff
  limits, report filters, the default zone and the public timetable filter. A pack never filters
  by location in its own code.
- **The location's zone is the default zone of what is located there.** An empty `timezone` on a
  located record takes its location's zone, not the organisation's. The organisation's zone stays
  the zone of what is not located, including pay periods and the books.
- **A room belongs to a location.** The host refuses a series, class or appointment whose room is
  at another location (`location_mismatch`), declared as "these two relations agree".
- **A membership covers chosen locations.** Plans, pass types, memberships and passes gain
  `locations` (empty: every location). A booking copies its class's location, so the allowance
  spends only where it is covered. **When a location is added, the owner chooses for each plan and
  pass type whether it covers the new one**, and that choice applies to the members who already
  hold it as well as to new sales.
- **Prices differ by separate plans** (a "City studio" plan, an "All locations" plan) **and a
  drop-in price per location**, read between the class type's and the organisation's.
- **Staff limited to locations.** A human admin may set the locations a staff account works at.
  For a pack-role or grant-only account (a coach, the desk, a cleaner) the limit is enforced as
  ADR 0553's "today" is. Managers and the owner always see everything.
- **Reports per location and combined.** Every shipped dashboard gains a Location filter (all, or
  one; all by default). An order records its location where it has one, so money figures can be
  split by it.
- **Members choose.** The timetable has a location picker, defaulting to the member's home
  location. Bookings, emails and calendar files name the location and its address.
- **One payment account, one currency.** A payment account per location is a later step.
- **Going from one location to two is adding the second.** Nothing is migrated except what the
  owner reassigns.

### What was weighed and rejected

- **Several hosts, one per location, with a shared identity** (refused at the interview, decision
  1). It would make hardest what the owner wants most: one member record becomes one per host kept
  in step by a sync that does not exist, with merge, erase and agreements done in each; one
  membership at two locations means a spend in one database counted in another's, a distributed
  lock the platform has nowhere (ADR 0493); a shared sign-in needs an identity service across
  hosts, which ADR 0610 and stage 46 keep hosts apart from; combined reports read several
  databases; a coach at two locations has two accounts and "never on two overlapping shifts"
  (ADR 0621) cannot see across them; and it is two or three times the hosting for one customer. It
  stays right for franchises.
- **A location as a text field or a room's name** (stage 31's guess). Nothing could be limited,
  filtered or zoned by it reliably, and every pack would invent its own.
- **A Locations pack.** Rostering works without Bookings, Memberships without either; each would
  need an optional dependency the manifest cannot express, and staff limits would live in a pack.
- **Locations as stage 14a's teams.** Teams decide visibility by who owns a record; a class at a
  location is not owned by its staff. The location limit is a second dimension on the same seam.
- **Limiting managers and the owner now.** It needs doors 2 and 3 of the seam, or a manager limited
  to one location could still read the other through a dashboard, `query.sql`, search or the
  assistant. A limit with holes is worse than none; it waits for 14a.
- **"Empty means every location" deciding existing memberships silently.** Adding a location would
  then hand every all-locations member the new studio, or (the other way) take a choice away from
  the owner. The per-plan choice at add time replaces both (decided item 1).
- **One plan with a price by home location.** Invites disputes when a member changes home; separate
  plans are clearer and need almost nothing new.
- **Several currencies.** Would change every order, report and price (ADR 0427). Out of scope.

## Platform work and pack work

| Piece | Kind | Notes |
| --- | --- | --- |
| `core_location`: fields, open and closed, operations, the first location by migration | **Platform, new base record** | Migration; `fields/location.ts`; `operations/location.ts` |
| `located` declaration (`packages/sdk`), checked by `cos ext check` | **Platform, new declaration** | A field or a path to `location`; one per object |
| Reconciler fill of a new located field with the only location | Platform, small | As ADR 0460's zone fill |
| A located record's empty `timezone` takes its location's zone | Platform, small | `record.create`, `recurring`, the reconciler |
| Organisation-zone readers made location-aware for located records | Platform, medium | The record's zone, else its location's, else the organisation's |
| `agree` rule: two relations name the same location | **Platform, new declaration** | Checked in the write path on every write, as ADR 0502's rules are |
| `covers` declaration and the per-plan choice in `location.create` | **Platform, new declaration** | Generic over holder objects; Memberships declares it |
| The drop-in price chain (class type, then location, then setting) | Platform, small | `orders/sellable.ts` reads a list of paths |
| `core_order.location`, stamped by the host | Platform, small | `orders/orders.ts`; read by stage 52 |
| `core_user_location` and `user.locations.*`, set by a human admin | **Platform, identity** | Audited; not on MCP |
| The location limit for pack-role and grant-only accounts | **Platform, the seam** | Beside `pack-role-today.ts`; every nested tool run |
| `not_at_this_location` warning on a shift | Platform, small | A fourth warning (ADR 0622) |
| A `location` dashboard filter, bound from `located`; a location's zone for date presets | Platform, small | Amends ADR 0057 and 0871 |
| Public reads of public locations | Platform, opening to `public` | A reviewed opening (ADR 0402) |
| `core_staff_hours.location` (stage 49's open hours, built) | Platform, small | Free times per location |
| Bookings: `location` on room, series, class, appointment, appointment series; the booking's path; `dropInPrice` on location in the chain; home location on Person; timetable filter; emails, calendar files; dashboards | **Pack** | `packs/bookings` |
| Memberships: `locations` on plan, pass type, membership, pass; `covers`; `SPENDS_ON` gains the location; dashboards | **Pack** | `packs/memberships` |
| Rostering: `location` on duty series and duty shift (`dutyseries`, `shift`; a duty, the kind of work, stays shared); the grid filtered; offers and notices by location | **Pack** | `packs/rostering`, `staffing/offers.ts` |
| Programs: class types, programs shared across locations | None | |
| Blocks and screens: Settings → Locations, Works at, the switcher, the picker, badges | Pack (blocks) and stage 47 declarations | Web and native share the hooks |

## The model

### Words

- **Location**: one place the business works from, inside the one organisation. Not a tenant. In
  trades, a branch or depot. Avoid "site" (here a site is a client app); not the **location hint**
  (where Cloudflare keeps a host's data, ADR 0580).
- **Main location**: the first location, made by the migration. Its zone is the organisation's
  zone, shown on Settings → Locations as "the business's zone: pay periods and the books".
- **Located**: an object whose records each belong to one location, by a field or a path.
- **Home location**: where a member usually trains; a default for screens, never a limit.
- **Covered locations**: where a membership or pass may be spent.
- **Works at**: the locations a staff account is limited to; set only by a human admin.

### The location record

`core_location`, a base record:

| Field | Notes |
| --- | --- |
| `name` | Required, unique among live locations |
| `shortName` | For a badge ("City"), at most 16 characters |
| `address` | Text lines; the business's address, not personal data |
| `timezone` | Required; defaults to the organisation's |
| `public` | Shown on the website and in the app; default yes |
| `dropInPrice` | Minor units; empty: not set (the chain reads on) |
| `state` | `open`, `closed` |
| `notes` | Staff only |

- `open` ↔ `closed` by a human admin only. A closed location takes no new series, class,
  appointment or duty shift; future classes already made are not cancelled by the move (staff
  cancel them with the existing closure or cancel tools, which email members). The last open location cannot
  be closed. A location is never deleted while anything is located at it; it is closed.
- The main location cannot be deleted. The organisation's zone is changed in Settings → General as
  today; the main location's zone follows it.

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `location.list`, `location.get` | staff | any staff | read |
| `location.create` | staff | `settings:manage` | write; an AI may draft, a person approves; carries the coverage choices (below) |
| `location.update` | staff | `settings:manage` | write; an AI may draft, a person approves (name, zone, public, price change what members see) |
| `location.close`, `location.reopen` | staff | `settings:manage`, `actors: ["human"]` | write, high |
| `public.list`, `public.get` of `location` | **public** (new opening, reviewed) | anyone | read: name, short name, address, zone, only where `public` and `open` |
| `user.locations.set` | staff | human admins, `actors: ["human"]`, not on MCP | policy; audited; every admin told |
| `user.locations.get` | staff | admins; an account reads its own | read |

### Located objects (the declaration)

```
located: { field: "location" }          // room, series, class, appointment, duty series, duty shift
located: { path: "class.location" }     // booking
agree: [{ a: "location", b: "room.location" }]   // series, class, appointment
```

- A located field is a required relation to `location`. With one open location the host fills it
  and forms hide it.
- Copied, never chosen twice: a class takes its series' location (`recurring.copy`), a booking
  reads its class's, an appointment its room's when it has one.
- `agree` is checked in the write path on every write by every actor (a person, the assistant once
  approved, MCP, an import, a series' generation): `location_mismatch`. A room's location is fixed
  once a live series, class or appointment uses it (make a new room instead), so no race between a
  room's move and a class's write is possible.
- `cos ext check` refuses a `located` field that is not a relation to `location`, a path that does
  not end at one, two declarations on one object, and an `agree` whose sides do not both reach
  `location`.
- Moving a series to another location changes its future classes as any series change does
  (ADR 0620); a class with bookings moved to another location emails its members as a change by the
  gym.

### Memberships and coverage

- `locations` (many relations to `location`; empty: every location) on plan and pass type, copied
  onto membership and pass as the other limits are. The booking copies `location` from its class;
  `SPENDS_ON` gains `{ field: "location", in: "locations" }`. Coverage is the allowance's own
  condition, so no new path spends a use.
- A member whose membership does not cover the class's location is refused with
  `not_covered_here`, naming the locations it covers, and offered a drop-in where drop-ins are on.
- **`covers`**, a declaration on a holder object: `covers: { field: "locations", follows?: "plan" }`.
  Memberships declares it on plan and pass type, and on membership and pass with `follows` naming
  the record they were granted from.
- **Adding a location when one or more exist**: `location.create` takes `coverage`, one choice per
  live record of every object declaring `covers` without `follows` (each plan and pass type):
  `include` yes or no. There is no default; the screen lists every plan and pass type with its
  current coverage and the operation is refused until each has a choice.
  - `include: yes`: a record with an explicit list gains the new location; a record with an empty
    list (every location) stays empty.
  - `include: no`: a record with an explicit list is unchanged; a record with an empty list is
    written the explicit list of the locations that existed before.
  - The same write is made, in the same batch, on every running membership and live pass that
    follows that record. A member never loses a location they had; at most they do not gain the
    new one. This is the one place a granted holder's terms change after the grant (ADR 0513 is
    amended with a dated note): applied by a person, audited per record, and shown in My account.
- A plan change from one location to all is an upgrade as today (ADR 0530).

### Prices

- Separate plans and pass types per location cover membership prices; each keeps one price.
- A drop-in's price is the first that is set of `class.classType.dropInPrice`,
  `class.location.dropInPrice` and the organisation's `dropInPrice` setting:
  `price: { fields: [..., ...], setting: "dropInPrice" }` in `sellable.moves.price`. The price is
  always the host's, never the caller's. A class type's own drop-in price wins because it is the
  more specific choice (a workshop), and a business wanting the location to win leaves the class
  type empty.
- Offers (stage 34) adjust after this in `priceLines`; an offer limited to a location is a later
  condition of stage 34's, not this stage's.

### An order's location

- `core_order.location` (nullable), stamped by the host when the order is made: the till's
  location for a desk order (stage 50), else the one location every located line reaches (a
  drop-in's class), else, for a plan or pass type covering exactly one location, that one; else
  empty (business-wide). Never written by a caller.
- Stage 52's figures stay one set of books per business day in the organisation's zone; its
  summaries gain a split by location with a "not tied to a location" line. Stage 52 owns the
  figures and stage 61 sends them; this stage only adds the column.

### Staff limits

- An account with no locations set works everywhere (the default; nothing changes today).
- An account whose only access is a pack role or grants (the coach role, the rostered team role,
  `bookings:desk`), with locations set, reaches a located record only at those locations:
  `record.list` (a predicate in the query, before its limit, count and cursor), `record.get` and
  `record.update` (the stored row checked, else not found), every tool it runs and every nested
  run; any other operation naming a located object is refused. Combined with "today" for the coach
  role: both must hold.
- Members are shared (decided item 3): the desk's member lookup finds every member, and it may
  book one at its own locations. A member's bookings at another location are not shown to it.
- A full staff role (owner, manager, admin) ignores the limit; the Works at screen says so plainly
  for such an account. Limiting full roles is stage 14a's.
- Shifts: an account limited to A is never offered or shown a shift at B. Assigning it to B warns
  `not_at_this_location` (a fourth warning, ADR 0622 amended), not refused. "Never two overlapping
  shifts" holds across locations. Travel time is not checked.
- Every location-limited read is tested with a registry-wide test that fails on any operation over
  a located object the limit does not cover (as the "today" limit's tests do).

### Time zones

- A located record's empty `timezone` takes its location's zone. A location's zone may be changed
  by an admin; existing records keep theirs (as a holder keeps its zone, ADR 0494) and the screen
  offers to move the future classes of that location's series, applied by a person.
- Made location-aware (the record's zone, else its location's, else the organisation's): a pack
  role's "today", window numbers, checklist runs, the uncovered notice and offers' cut-off, the
  rostering screens' "today" (for the location chosen), open hours and free times, the booking
  reminder.
- Stay in the organisation's zone: pay periods (one payroll, decided item 6), time entries' local
  date (stage 58), the books (stage 52), `orders/grants.ts`, agreements' copies, the duplicates
  scan.
- Dashboards: date presets are in the organisation's zone; with the Location filter on one
  location they are in that location's zone (ADR 0871 amended).

### Shared pieces of other stages

Each is owned by its stage; whichever is built second does the join.

| Stage | What it gains | Who builds it |
| --- | --- | --- |
| 49 Appointments | Appointment and appointment series located; room `agree`; `core_staff_hours.location` (open hours at a location; empty only while there is one); free times per location | This stage for what is built (open hours); stage 49 for the rest if built after |
| 50 Till | A till is at a location (required with two or more); a desk order's location from its till; a reader registered at its till's location's address | Stage 50, or this stage if 50 is built first |
| 51 Kiosk check-in | An enrolled device is at a location; a check-in tablet shows that location's classes only | Stage 51, or this stage if built first |
| 52 Finance reports | The split by `core_order.location` | Stage 52 |
| 57 Venue hire | A space's rooms all at one location (`agree`); the space located by its rooms | Stage 57 |
| 58 Timesheets | A time entry's location: its against record's, else the one chosen at start (default the account's only location), else empty; for reports only, never pay | Stage 58 |
| 37 Shop | A stock place may name its location when stock in several places is built | Stage 37's later step |
| 35, 39 Invoices, Jobs | Declare `located` (a branch) when a trades client needs a second branch | Those stages |
| 47 Pack screens | The switcher and Settings → Locations live in the admin | This stage, on 47's declarations |
| 48 My account | Home location, covered locations and each booking's location in the Bookings and Memberships sections; no new attention kind | This stage, in those sections |

### Tools

- Bookings' `timetable`, `day`, `classList`, `bookFor`: an optional `location`; for a limited
  account they default to, and are bounded by, its locations.
- Rostering's `week`, `mine`, `offers` and `uncovered`: a location filter; a rosterer limited to one location
  rosters only there.
- Memberships' staff tools show which locations a plan covers.
- No tool takes a location to escape a limit: the host checks the record's own location.

### Screens

- **Web admin (stage 47):** Settings → Locations (list, add with the coverage step, close); on a
  staff account, Works at (admins only); a location switcher at the top of Bookings' and
  Rostering's screens, remembered per person; a location column and filter on class, series, room,
  booking, appointment and duty shift lists; the Location filter on every shipped dashboard. All hidden
  with one location.
- **Customer web and app (stage 48's sections):** the timetable's location picker (public, open
  locations only; hidden with one), remembered on the device, defaulting to the home location;
  location and address on each class and booking; a plan's covered locations on the plan page and
  in the Memberships section; the home location, set in the Bookings section.
- **Native:** the same from the same hooks, with "open in maps" on a booking's address; a coach's
  and the team's screens show their own locations only.

### Notifications

- Booking emails and the calendar file carry the location's name and address (the calendar file's
  location becomes "Location, room") when there are two or more locations.
- Rostering's notices (an uncovered shift, an offer) go to that location's rosterers: those limited
  to it, then those with no limit.
- No new kind of routine mail.

### What an AI may do

- Read locations; filter any read or report by location: applied.
- Draft a new location or a change to one, including the coverage choices: asks, a person applies.
- Close or reopen a location, set a staff account's locations: **never**, not even by asking.
- Book, move or roster across locations: as today for the acting person, within their limit.

### Privacy and erase

- A location holds no personal data.
- A member's home location is theirs to read and change; staff read it; it is erased with the
  Person.
- A staff account's locations are policy: audited (who set them, when, from what) and kept after
  the account leaves, as other policy changes are.
- A limited account learns nothing from another location's records: its lists, gets and tools
  return nothing there.

## Out of scope

- A payment account per location (a later step: an order's account chosen from its location, one
  order per account, subscriptions and refunds kept on the account they started on, webhooks per
  connection; touches `orders/`, `subscriptions/` and the payments gatekeeper). Whether a location
  needs its own account or registration is for the business to confirm with its accountant.
- Several currencies; locations in several countries with different tax set-ups.
- Limiting managers and the owner to locations: with stage 14a.
- Agreement documents that differ by location: stage 44's points could take a location condition
  later.
- Offers limited to a location (stage 34); stock per location (stage 37); service areas and job
  hand-over between branches (stage 39).
- Pay periods per location; pay rates by location; travel time between locations.
- A sender, branding or website per location.
- Franchises (several hosts, nothing shared).

## Acceptance criteria

1. **One location by default:** after the migration a host has exactly one open location named
   after the organisation in its zone; every room, series, class, duty series and duty shift, and
   every open-hours row, has it; no screen shows a location picker, filter or badge; every existing test
   passes unchanged; the migration and fill re-run without change.
2. **Located declaration:** `cos ext check` refuses a `located` field that is not a relation to
   `location`, a path that does not end at one, two declarations on one object, and an `agree` that
   does not reach `location` on both sides.
3. **Mismatch refused:** a class, series or appointment whose room is at another location is
   refused (`location_mismatch`) for a person, the assistant once approved, MCP, an import and a
   series' generation; a used room's location cannot change.
4. **Zone default:** with the organisation in one zone and a second location in another, a series
   made at the second location without a zone generates classes at 06:00 local there on both sides
   of each clock change in both zones; reminders and a coach's "today" follow that zone.
5. **Coverage:** a membership covering only A spends on a booking at A and is refused at B with
   `not_covered_here`; 20 bookings at once at A for 5 uses make exactly 5; an every-location
   membership spends at both.
6. **Adding a location:** `location.create` is refused without a choice for every live plan and
   pass type; a plan chosen "yes" covers the new location for its running members and new sales;
   a plan chosen "no" keeps exactly its earlier locations for both; no member loses a location;
   each change is audited; the assistant can only draft it.
7. **Drop-in price chain:** a drop-in at a location with its own price and a class type without one
   is charged the location's; with a class type price, the class type's; with neither, the
   organisation's; a caller-sent price is ignored.
8. **Staff limit:** a coach limited to A lists, opens and ticks only A's classes, and is refused or
   not found for B's through `record.list`, `record.get`, `record.update`, every Bookings and
   Rostering tool, nested tool runs and any other operation naming a located object; with "today",
   both hold. A desk grant limited to A finds a member who trains at B and books them at A, and
   cannot `bookFor` at B. The registry-wide test fails when a new operation over a located object
   is not covered.
9. **Only a person sets limits:** `user.locations.set` is refused for the assistant, MCP, code and
   an approval; audited for a human admin; every admin is told.
10. **Full roles unaffected:** an admin and a manager see every location in lists, dashboards,
    `query.sql`, search and the assistant.
11. **Reports:** every shipped dashboard has a Location filter; with one location its numbers equal
    a hand-written query for that location and its "today" is that location's day; with "all" they
    equal today's numbers.
12. **Orders:** a drop-in's order carries its class's location; an every-location membership's
    order carries none; a caller cannot set it.
13. **Public reads:** the public reads a public open location's name, short name, address and zone,
    nothing of a hidden or closed one; the timetable filtered by location returns only its classes.
14. **Rostering across locations:** one person on overlapping shifts at A and B is refused
    (`double_booked`); assigning a coach limited to A to a shift at B warns `not_at_this_location`;
    offers and notices at B do not reach accounts limited to A.
15. **Closing:** the last open location cannot be closed; a closed location takes no new series,
    class, appointment or duty shift; closing is refused for the assistant.
16. **Emails and calendar files** name the location and address when there are two or more.
17. **E2E** (one per journey): a member with one membership books at each of two locations; a coach
    limited to one location sees only its day; the owner adds a second location, choosing coverage
    per plan, and reads a dashboard per location.

## Dependencies

- **Built:** stages 22 (the seam's first door), 25, 26, 31a (Bookings, `recurring`), 32 (allowance,
  Memberships), 45 (Rostering, `staffed`), stage 49's open hours (ADR 0762), ADR 0553's "today",
  ADR 0600's grants, ADR 0871's business day.
- **Spec agreed, not built:** stage 47 (the admin screens wait for it, or ship on the development
  page and the app first); stages 49 (the rest), 50, 51, 52, 57 and 58, joined as the table above
  says; 48 (My account) for the sections.
- **Proposed:** stage 14a, needed only for limiting full roles. Its interview should read this spec:
  location is a second dimension on the same seam.

## Migrations and numbers

Block **BZ** in [`parallel-work.md`](../parallel-work.md): migrations 1390 to 1409, ADRs 0910 to
0919. No `x_*` table is touched by a migration (located fields on pack objects are the
reconciler's).

| Migration | What |
| --- | --- |
| 1390 | `core_location`, the first location from `org_name` and `org_timezone`, idempotent |
| 1391 | `core_user_location` (account, location, set by, set at) |
| 1392 | `core_order.location` (nullable) and its index |
| 1393 | `core_staff_hours.location`, filled with the first location |

| ADR | What |
| --- | --- |
| 0910 | Locations: a base record inside the one organisation; the main location; open and closed (amends 0001 and 0610 with notes) |
| 0911 | `located` and `agree`; the located zone default (amends 0460) |
| 0912 | Coverage: `covers` and the per-plan choice when a location is added (amends 0493 and 0513) |
| 0913 | The drop-in price chain and an order's location (amends 0435) |
| 0914 | Staff location limits beside "today"; `not_at_this_location` (amends 0553, 0600, 0622) |
| 0915 | The Location dashboard filter and a location's day (amends 0057 and 0871) |
| 0916 | Public reads of locations (an opening under ADR 0402) |

## Suggested build order

| Step | What | Files or areas | Beside |
| --- | --- | --- | --- |
| 1 | `core_location`, its operations, the first location (1390), public reads | `packages/db`, `fields/location.ts`, `operations/location.ts`, `open-operations.json` | Anything not touching `open-operations.json` or the field registry index; collides with other new base records |
| 2 | `located`, `agree`, the reconciler fill, the located zone default | `packages/sdk` manifest and checks, `extensions/reconciler.ts`, the records write path, `recurring/` | After 1. **Collides** with any other new declaration in the SDK manifest or reconciler work |
| 3 | Zone readers made location-aware; `core_staff_hours.location` (1393); the dashboard filter and day | `pack-role-today.ts`, `records/windows.ts`, `checklists/runs.ts`, `staffing/due.ts`, `staffing/offers.ts`, `operations/staffing-screens.ts`, `operations/staffing-hours.ts`, `dashboards/` | After 2. Collides with stage 49's further steps in `staffing/` and stage 60/52 work in `dashboards/`; not beside 5 (`pack-role-today.ts`) |
| 4 | Bookings and Memberships: fields, copies, `covers` and the coverage step in `location.create`, `SPENDS_ON`, the price chain, `core_order.location` (1392), emails, dashboards | `packs/bookings`, `packs/memberships`, `orders/sellable.ts`, `orders/orders.ts`, `allowance/` | After 2. **Collides** with anything in `orders/` (stage 34's `priceLines`, 50, 35); Bookings and Memberships can be two sessions |
| 5 | Staff limits: `core_user_location` (1391), `user.locations.*`, the limit beside "today", the registry-wide test | `pack-role-today.ts` or a sibling, `pack-roles.ts`, `principals.ts`, `users.ts` | After 2. **Collides** with `pack-roles.ts` work (stage 47 step 1) and stage 14a |
| 6 | Rostering: duty series and duty shifts located, the grid filter, offers and notices by location, the warning | `packs/rostering`, `staffing/offers.ts`, `staffing/` warnings | After 5 |
| 7 | Screens and blocks: Settings → Locations with coverage, Works at, the switcher, the picker, My account sections, native | stage 47's declarations, `packs/*/blocks`, `apps/app` | After 4 and 6, and after stage 47 for the admin; after stage 48 for the sections |
| 8 | Docs and the site: `CONTEXT.md` (Location, Located, Main location, Home location, Covered locations, Works at), `docs/architecture.md`, `apps/marketing` and `SITE.md` | docs, `apps/marketing` | Last |

Steps 1 and 2 are sequential; then 3, 4 and 5 can run as three sessions (3 and 5 one after the
other where both touch `pack-role-today.ts`).

## Decided by this spec, open to override

Decided as best practice without asking (coordinator, 2026-11-24):

1. **When a location is added, the owner chooses for each plan and pass type** whether it covers
   the new location, for existing members and new sales alike.
2. **Coaches, the front desk and cleaners are limited to their locations now; managers and the
   owner always see everything** (until stage 14a).
3. **Members are shared between locations**: the desk at one finds and books a member of the other.
4. **Prices differ by separate plans per location plus a drop-in price per location.**
5. **One shared payment account for every location.**
6. **One pay period for the whole business**, in the main location's zone (the organisation's).
7. **A coach set up at one location is warned, not stopped,** when rostered at another.
8. **How the businesses run their locations today** (how many, how far apart, whether members and
   staff use more than one, one account or several): the draft's assumptions stand, checked with
   the business during setup.
9. **What a branch means to trades businesses**: the draft's assumptions stand, checked with the
   first trades client; this stage builds only the shared backbone.

Decided by this spec:

10. A location is a base record in core, not a pack and not a tenant.
11. Every host has one location from the migration; one location shows nothing new.
12. Empty coverage means every location, as every allowance list does.
13. A class type's drop-in price wins over the location's.
14. A used room never changes location.
15. An order's location is stamped by the host and used for reports only, never for money routing.
16. Home location is Bookings' field on Person, a default for screens, never a limit.
17. Dashboards default to all locations; filtered to one, their day is that location's.
18. Class types, programs, qualifications and agreements are shared across locations.
19. Time entries, pay and the books stay in the organisation's zone.

## Questions for the owner

None. To check with the first business that has two locations, during setup: how members move
between them, which staff work at both, and whether one plan should cover every location.

## Risks

- **Security:** the staff limit must hold on every path a limited account can reach, including
  nested tool runs and objects reached through a path (a booking through its class). The registry-
  wide test is the guard.
- **Money:** coverage is the allowance's own condition; the coverage step at add time writes
  holders in one batch with the location; the price chain never reads a caller's price.
- **Time:** a second location in another zone is the first real test of two zones in one host;
  tests cover both clock changes in both zones.
- **Migration:** the fill is one batch per object and idempotent; a real client's host is checked
  after the upgrade.
