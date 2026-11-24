# Stage 65: Booking system connection

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Integrations, Identity, the visibility seam), [`CONTEXT.md`](../../CONTEXT.md) (Gatekeeper,
Connection, Person, Customer account, Sign-in address, Erase, Allowance, Pack role, Grant),
[`docs/integrations.md`](../integrations.md); ADRs
[0007](../adr/0007-integrations-are-gatekeepers.md),
[0020](../adr/0020-query-sql-validator-and-csv-import.md) (the stateless CSV import the file
source copies),
[0050](../adr/0050-integration-host-and-connections.md),
[0114](../adr/0114-own-gatekeepers-pickers-and-host-modules.md),
[0247](../adr/0247-duplicate-rules-and-scan.md) (`checkPerson`), [0320](../adr/0320-erase-reaches-every-store.md) (the
erased-address list), [0402](../adr/0402-staff-and-customers.md),
[0421](../adr/0421-the-client-app-binding-and-customer-sign-in.md) (linking by verified email),
[0449](../adr/0449-permissions-granted-one-by-one.md),
[0457](../adr/0457-confirm-your-email-and-confirm-the-native-sign-in.md),
[0500](../adr/0500-recurring-a-weekly-rule-in-local-time.md) (the Worker budgets),
[0621](../adr/0621-the-staffed-behaviour-and-the-time-claim.md),
[0880](../adr/0880-the-accounting-contract.md) (the pattern this stage copies: a contract package,
a fake and a conformance suite) and
[0921](../adr/0921-no-named-connector-and-a-file-source.md) (no named connector; a file first);
the specs of stages [29](29-forms.md) (an address on file is not proof), [31](31-bookings.md),
[32](32-memberships.md), [34](34-offers.md) (members' prices), [41](41-programs.md),
[44](44-agreements.md), [45](45-rostering.md), [47](47-pack-screens.md),
[48](48-my-account.md) and [61](61-accounting-sync.md); `packages/gatekeeper-accounting/`,
`packages/core/src/operations/import.ts` (`import.csv.*`, `CSV_LIMITS`),
`packages/core/src/customers/accounts.ts` (`linkCustomer`, `sameEmailPeople`),
`packages/core/src/records/erase.ts` and `erase-stores.ts`, `scripts/check-stray-names.mjs`.

Status: **spec agreed** (owner interviewed 2026-11-24: decisions 1 to 5; decisions 4 and 5 changed
by the owner the same day: no named connector, a file first). Steps 1 and 2 may start now; the
questions at the end set defaults and block nothing.

- Step 2, the naming rule, is built ([ADR 0921](../adr/0921-no-named-connector-and-a-file-source.md)):
  `scripts/check-stray-names.mjs` keeps the booking-system rule strict, allowed only in the check
  and its tests, with no exception for this spec; a test proves the name fails here. No other file
  names the system.

**This is not legal advice.** What a business may do with its own booking system's data, an export
included, is set by that system's terms. Whether a business's use is within them is for the
business, and its lawyer or the booking system's support, to confirm. The load screen says so.

## Status

- **Step 1** (built 2026-11-24, branch `feat/stage-65-booking-contract`; ADR 0920; no migration):
  `packages/gatekeeper-booking-system`: `BookingSystemSession` and its types (`types.d.ts`, served
  as the resource's types), the input checks and limits and the contract's shape every answer is
  copied into (`validate.ts`, `reads.ts`), the refusal codes (`refusal.ts`), the shared facet
  `BookingSystemGatekeeper` (each read an observation, no action kind, apply, reject and revert
  refused), `BookingSystem` for a connector to implement, the fake (`FakeBookingSystem`, with every
  control the spec lists), `directSession`, and the conformance suite (21 checks), passing against
  the fake in memory and through the fake gatekeeper's session. The fake gatekeeper
  (`cos-gatekeeper-booking-system-fake`, vendor `booking-system-fake`, `wrangler.fake.jsonc`) is
  bound to cos-runner in its tests (`GATEKEEPER_BOOKING_SYSTEM_FAKE`, controls
  `TEST_BOOKING_SYSTEM`) and the CRM's dev server; the catalogue has `implements:
  "booking-system"` and the dev-only entry. Left for later steps: the Settings → Integrations
  heading and the one-connection rule (with step 3 or 6), the host path (step 3), everything else.
- **Owner's change of plan (2026-11-24, during step 1)**: the booking system this spec names for the
  first connector cannot be used (its developer terms bar use in a competing product), so there is
  no named connector, and no outside product is named in code, tests, docs or the catalogue. Step 1
  added, beside the fake, a **file source** in the same package (`file-source.ts`: `parseCsv`,
  `loadFiles`, `dryRunFiles`, `FileBookingSystem`): the read-only contract from a people file
  (each person with their membership or pass, its status and dates) and an optional timetable a
  business exports and a member of staff loads, with column mapping by header, value mapping, row
  issues named by row, local times in the site's zone, and a dry run; it passes the conformance
  suite. The matching-by-address rules of "Matching" are `matchPeople` (`match.ts`), used by the
  dry run and meant for the host's pass. The contract gained `offers.source` (`api` or `file`).
  Not done: amending this spec (steps 2 and 9, ADR 0927 and the names in it are moot), and
  storing and loading files through an operation and a screen (with step 4 on).
- **Step 3** (built 2026-11-24, branch `feat/stage-65-core`; ADR 0922; migration 1410): the core
  copy in `packages/core/src/outside/`. Migration 1410 adds all eleven `core_outside_*` tables (one
  settings row by default). `settings.ts`: the settings and each list's age (from its export date,
  in the business's zone; a members list past the largest age is "too old to count").
  `ingest.ts`: `readMembers` and `readTimetable` read any `BookingSystemSession`;
  `planMembers` and `planTimetable` plan one batch that replaces the copy of a kind, keep only
  members, live passes, the booked and the staff-linked, write set based (100 rows a statement, one
  JSON parameter) and add one timeline activity per Person linked; the fixture costs about 34 and 69
  statements (`outside-ingest-cost.test.ts`). `match.ts`: matching by folded address with the
  contract's `matchPeople`, erased addresses and suppressed refs keeping nothing, and
  `matchPersonAddresses`, called from `person.create` and `person.update`, linking someone who
  appears later. `bookingSystem:manage` in `principals.ts` (admins, grantable, never to a fixed
  role). Operations (`operations/outside.ts`): `outside.settings.get`, `outside.settings.update`
  (a human admin), `outside.status`, `outside.matches`, `outside.link` and `outside.unlink` (a
  person with `bookingSystem:manage`). Tests: `outside.test.ts` (criteria 3 for link, unlink and
  settings, 4, 10 for the copy's reads, the allowance part of 8, the file source through the same
  ingest) and the cost test (criterion 11). Decided here: "the same address" is the folded form
  (ADR 0692), so two Persons can be candidates; an unlink is a staff link to nobody, kept by ref;
  no foreign key to `core_person`. Left for later steps: `outside.file.preview`, `outside.file.load`,
  `outside.lists.remove`, saved mappings and the notices (step 4, which runs these plans); the
  screens and `outside.person` (step 5); `memberOf` and every consumer (step 6); outside classes in
  Bookings (step 7); erase writing `core_outside_suppressed` and removing the rows, and merge (step
  10).
- **Step 3, after review** (2026-11-24, PR #428): `person.restore` and `import.csv.commit` link
  too (one read for a whole import), and nothing links from a Person write while the copy is off;
  an unlink is kept by the hash of the ref (`core_outside_unlinked`, in migration 1410), so an
  unlinked person's row stays only while they count; a staff link to a Person in the Trash is
  dropped at the next load and not counted; To match pages by kind and ref; a booking naming an
  erased address keeps nothing; a membership is live by the business's day; a plan over 900
  statements is refused. **Gate: step 4 does not merge before step 10** (erase reaching the copy),
  because from step 4 on a list can be loaded and `person.erase` would leave its copy behind.

## Goal

A business that keeps its booking system for months still gets the new system's worth from the
first day, beside it. Event tickets, the online program, training programs logged in the app, the
blog and the site, and staff checklists run on the new system. Members and whether their membership
is live come from a list the business exports from its booking system and a member of staff loads,
so a member pays the members' price for a ticket, opens the members' program and sees "your
membership is managed in your booking system" in My account, without anyone typing a list in twice.
The timetable and who is booked can be loaded the same way and are shown read only, so coaches and
the desk see the day in one place; booking still happens in the booking system. Nothing is ever
written back. With no list loaded at all, every one of those pieces still works: people are just
people with accounts.

There is **no API connection** to the first client's booking system (decision 5): its developer
terms bar use in a competing product. Core speaks one read-only booking-system contract; the first
source behind it is a file. A system whose terms allow it can be connected later through the same
contract, as its own gatekeeper. When a business later leaves its booking system (stage 33), the
move reads through the same contract and the same file source, so nothing is built twice.

## Who it is for

- **A gym or studio staying on its booking system for a while**, with memberships, passes and its
  timetable there, and new things (tickets, an online program, logged training, content,
  checklists) on the new system.
- **Its members**, who keep booking where they always have and find the new system already knows
  they are members.
- **Its coaches and desk**, who see the day's classes and who is booked beside the new system's own
  work, and (later) the roster with every class on it.
- **Its manager or owner**, who exports a list from the booking system and loads it, and sees how
  old the list is.
- **What all of them share:** the booking system stays the only place memberships and bookings are
  made and changed. The new system shows what was loaded, how old it is, and never pretends to be
  the booking system.

## What exists today (from the code)

| Piece | Where | What this stage uses |
| --- | --- | --- |
| Gatekeepers, accounts, resources, sessions, observations | `packages/gatekeeper-interface/src/gatekeeper.ts` (vendored), `packages/gatekeeper-kit/src/` | The contract's session runs on these unchanged |
| A contract package with a fake, a conformance suite and a dev-only fake Worker | `packages/gatekeeper-accounting/` (`session.ts`, `fake.ts`, `fake-worker.ts`, `conformance.ts`, `direct.ts`, `wrangler.fake.jsonc`); ADR 0880 | The shape copied one for one |
| The catalogue, enabled per deployment, with `implements` | `packages/core/src/integrations/catalogue.ts` (`CatalogueEntry.implements?: "accounting"`, `devOnly`) | Gains `"booking-system"` for the dev-only fake |
| A stateless CSV import with column mapping, a preview and a commit | `packages/core/src/operations/import.ts` (`import.csv.preview`, `import.csv.commit`, `CSV_LIMITS`, the RFC 4180 parser, `json_each` chunks); ADR 0020 | The file source's parser, limits and preview-then-commit shape |
| Matching a Person by address | `linkCustomer` and `sameEmailPeople` in `packages/core/src/customers/accounts.ts`, `checkPerson` in `duplicates/check.ts`, `normaliseCustomerEmail` | The same rule, one Person or none |
| An address on file is not proof (certainty `address`) | Stage 29, decision 7 and its "certainty" rules | An outside person links with certainty `address` |
| A customer's verified sign-in address | `me.get` (`signInEmail`, `signInEmailVerified`), ADR 0421's amendment | What a members' price and a members' program check |
| Erase, the erased-address list, erase of other stores | `person.erase` (`operations/person.ts`), `records/erase.ts`, `records/erase-stores.ts`, `core_erased_address`, `erasedAddressHash` | Outside copies go; the outside ref is suppressed |
| Bookings: classes, the coach, the coach role, the timetable reads and blocks | `packs/bookings` (`class`, `booking`, `coach`, `roles.coach`, tools `timetable`, `day`, `roster`, `classList`; blocks `bookings-timetable`, `bookings-native-timetable`, `bookings-class-list`) | Outside classes shown beside them, read only |
| Allowances: only a declared spender spends | `packages/core/src/allowance/`, `bookings.booking`'s `allowance.spends` | Outside bookings declare nothing, so never spend |
| Memberships and their statuses | `packs/memberships` (`membership` `trialing` … `ended`, `pass`) | The words an outside membership maps onto |
| Programs assigned to a person or a class type | `packs/programs` (`programs.assignment`, `kind` `personal` or `class`), the coach's client screen (`programs-coach-client`) | A third kind, to members; the coach's client list |
| Rostering's time claim and week read | `packages/core/src/staffing/`, ADR 0621, `staffing.week` | Outside classes on the roster (a later step) |
| Checklists in core | `core_checklist*`, ADR 0650 | Used on their own (the follow-on recorded in stage 45) |
| The stray-names lint | `scripts/check-stray-names.mjs` (rule "a client's booking system", allowed only in the check and its tests) | Kept strict by step 2 |

Not built, specced: stage 34's discounts and `priceLines` rules (no `packs/offers` yet), stage 48's
`me.portal` and `me.attention`, stage 33 (not specced).

## Decided at the interview (2026-11-24)

The owner's reason for the stage: a business may stay on its current booking system for months. The
new system must be useful beside it, with or without a list from it, and must not need memberships
or bookings moved over.

| # | Decision |
| --- | --- |
| 1 | **The first things on the new system while the booking system stays**: event tickets, the online program, training programs logged in the app, the blog and site content, and staff checklists. Checklists come on their own first; the roster and hours can follow |
| 2 | **The new system knows members and whether their membership is live from the booking system's data**, and never writes anything back |
| 3 | **The timetable and who is booked show in the new system, read only.** Booking still happens in the booking system |
| 4 | **No named connector** (changed 2026-11-24). The repository names no booking system; the lint keeps the name out of every file (ADR 0921) |
| 5 | **No API connection to the first client's booking system** (changed 2026-11-24): its developer terms bar a competing product, so the first source is a file the business exports and staff load. The generic read-only contract stays so a system whose terms allow it can be connected later |

## The design in one page

- **One read-only contract, many sources.** `BookingSystemSession` is a small typed session every
  source implements: who the people are, their memberships and passes with status and dates, class
  types, scheduled classes, who is booked and who attended, staff. It has **no write of any kind**:
  no outbound action, no action kind, nothing to approve. It lives in
  `packages/gatekeeper-booking-system` with input checks, a fake booking system and a conformance
  suite. The first source is **the file source** (`fileSession`), a session over a loaded file; a
  connected system later is its own gatekeeper Worker implementing the same session.
- **Core owns the copy, not a pack** (`packages/core/src/outside/`). What is read touches several
  packs at once (Offers' prices, Agreements, Programs, Bookings, Rostering, My account), and the
  rules about it (who counts as a member, what a customer may see, what is kept and for how long)
  are the host's. Packs show it through their blocks and read it through host operations; no pack
  hooks a write.
- **The file source: map, check, load.** A member of staff exports a list from the booking system
  (members and their memberships; separately, the timetable and its bookings), uploads it in
  Settings → Booking system, maps its columns (the mapping is saved for next time), sees a dry run
  (rows, errors, who would link, who waits for staff), and loads it. Loading is a human's act with
  `bookingSystem:manage`, never an AI's. A load **replaces** the previous list of its kind.
- **A loaded list is as old as its file.** Each list carries the date it was exported (asked at
  load, the upload time by default) and every screen shows it ("from the list of 3 March"). A list
  older than the **largest age** (31 days by default) stops counting for members' prices and
  programs; the admins are told 3 days before. A membership's own `until` still ends it.
- **An outside person is matched to a Person by address, never merged.** Exactly one live Person
  with the same address: linked, with certainty `address` (stage 29): nothing on the Person is
  changed and nothing is sent to them. None: the outside person stays in the copy, unlinked, and no
  Person is made for them. Several, or several outside people with one address: nobody is linked
  and staff choose. A customer gets anything from the link (a members' price, a members' program,
  My account) only when the address is their **verified sign-in address**.
- **An outside membership is a source of truth the host trusts**, while its list is within the
  largest age: for members' prices (stage 34), for who is a member for agreements and programs, and
  for My account, where a member sees it "managed in your booking system", with a link the
  business sets.
- **Outside classes are shown, never bookable here.** Bookings' timetable, the coach's and the
  desk's day and (later) the roster show them, marked "your booking system" with a link where to
  book. They are not records of `bookings.class`, take no place, and never spend an allowance.
- **No list is a normal state.** Every first-wave piece works with none; every outside read answers
  empty.
- **Stage 33 reuses it.** The move reads through the same session (the file source, or a connected
  system where one exists), the same links and the same fake, and writes stage 31's and 32's import
  folders.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **An API connection to the first client's booking system** | Decision 5: its developer terms bar use in a competing product. A file the business exports from its own account is the business's to give |
| **Naming the system's connector in the repository** | Decision 4 and the owner's rule of 2026-11-22: the repository is public, and a system's name beside what a business is doing says who it is |
| **Writing bookings back** (book in the new system, pushed to the booking system) | Decision 2. Two places to book makes two sources of places and two sets of rules. Booking stays where it is |
| **Loading the file as People and memberships here** (`import.csv`, `cos memberships import`) | The records would stay and drift from the booking system, which still changes them every day. The copy is replaced by each load and never becomes the business's records; the move (stage 33) is when they become records |
| **Making a Person for every row** | Copies people (leads, lapsed members) the new system does not need. A Person is made as today: a sign-in, a purchase, staff |
| **Merging on a matching address** | Shared family addresses and typing mistakes are common in booking systems. A link by address changes nothing on the Person; several candidates wait for a person |
| **Outside classes as `bookings.class` records** | They would claim places, take bookings, spend allowances and fire Bookings' messages; every rule would need an "unless outside" exception. A read-only core copy shown beside them keeps the pack's rules whole |
| **A pack ("Booking system pack")** | What is read spans six packs and core; who is a member and what a customer sees are host rules (ADRs 0401, 0404) |
| **A list that counts for ever** | A cancelled member would keep a members' price as long as nobody loads a new list. The largest age bounds it, and the date is always shown |
| **An AI loading the list** | Who is a member decides prices and what a customer may open; it is a human's act, as connecting a system is |
| **The members' price on any matching address** | An address typed in the booking system proves nothing. The price goes to the account that proved the mailbox, or to staff selling to that Person |

## Platform work and pack work

| Piece | Kind | What |
| --- | --- | --- |
| The booking-system contract, checks, fake, conformance suite, dev-only fake Worker, the file session | **Platform** (new package) | `packages/gatekeeper-booking-system/` |
| Catalogue: `implements: "booking-system"` | **Platform** | `CatalogueEntry.implements` widened, for the dev-only fake (and a connected system later) |
| The `outside` core module: settings, the copy, matching, ingest, age, who is a member | **Platform** (new) | `packages/core/src/outside/`, `operations/outside.ts`, migration 1410 (new tables only) |
| The file source: mapping, dry run, load | **Platform** | `outside/file.ts`, `outside.file.preview` and `outside.file.load`, reusing `import.ts`'s CSV parser and limits |
| A core permission | **Platform** | `bookingSystem:manage` (`principals.ts`): admins by default, granted one by one (ADR 0449); never to a pack role |
| Members' prices on outside memberships | **Platform** (host pricing) and **pack** (Offers' discount field) | `discount.who` gains outside membership types; the check is the host's in `priceLines` |
| A members' program | **Platform** (a read scope) and **pack** (Programs) | `programs.assignment` gains `kind: "members"`; the host decides who reads it |
| My account | **Platform** (a base section) | "Your membership" from the booking system's list, web and native base-layer blocks |
| Bookings | **Pack** (blocks and tools) | The timetable blocks and the coach's and desk's day show outside classes, read only, through `outside.*` reads |
| The coach's client list | **Pack** (Programs' coach screen) over a host read | People booked into the coach's outside classes |
| The roster | **Platform** (the time claim, read only) and **pack** (Rostering's week) | A later step (decision 1) |
| The naming rule | **Repository** | `scripts/check-stray-names.mjs` and its tests kept strict (step 2) |

No new behaviour. No pack hooks a write. No `x_*` table is touched by a migration.

## The model

### Words (for `CONTEXT.md`)

- **Booking system**: an outside system where a business's members book classes and hold
  memberships. Avoid: provider (that is payments'), source.
- **Booking system source**: where the host's copy of it comes from. The first is **a list** (a
  file the business exports and staff load); a connected system later is a gatekeeper implementing
  the booking-system contract. Read only either way.
- **List**: one loaded file of one kind (`members`: people and their memberships and passes;
  `timetable`: classes, their bookings and their coaches), with the date it was exported.
- **Outside person**, **outside membership**, **outside class**, **outside booking**, **outside
  staff**: the host's copies of what the booking system says. Each carries the list it came from
  and so its **age**. Avoid: synced member, imported member (an import makes records that stay).
- **Linked (by address)**: an outside person matched to one Person by the same address. Not a
  merge, not proof that the Person is them.
- **Member**: a Person with a live membership here (stage 32) or a live outside membership of a
  type the business counts, from a list within the largest age (below). One host question answers
  it everywhere.

### The contract (`BookingSystemSession`)

Every method is a read, recorded as an observation. Times are ISO 8601 with an offset; a date is
`YYYY-MM-DD`; a time zone is IANA. Each item carries the source's `ref` (a string, stable for the
life of the record) and `modifiedAt` where the source has one.

| Method | Answers |
| --- | --- |
| `describeSite()` | The site's name, time zone, locations (ref, name), what this source offers (`modifiedSince` per kind, `hints` or none, the largest page) and, for a list, the date it was exported |
| `listPeople({ modifiedSince?, refs?, cursor? })` | A page of people: ref, email, given and family name, the system's own member status mapped (`member`, `not_member`, `suspended`, `expired`, `ended`, `declined`), active or not, `modifiedAt`. Never an address, a phone, a birth date, a card or notes |
| `listMembershipTypes()` | What the business sells that grants membership or uses: ref, name, kind (`membership` or `pass`), active |
| `listMemberships({ people })` | For at most 200 people: each membership and pass they hold: ref, person, type ref, name, kind, status (`live`, `paused`, `ended`, `cancelled`), from, until, uses total and left (passes), renews (whether it charges again) |
| `listClassTypes()` | ref, name, short description, active |
| `listClasses({ from, until, modifiedSince?, cursor? })` | A page of classes from `from` to `until` (at most 35 days): ref, class type ref, title, starts and ends, location ref, staff ref, places, booked, waiting, cancelled, `modifiedAt` |
| `listBookings({ classes })` | For at most 50 classes: each booking: ref, class, person, state (`booked`, `waiting`, `attended`, `late_cancelled`, `no_show`, `cancelled`), `modifiedAt` |
| `listStaff()` | ref, display name, email where the source gives it, active. Nothing else about them |
| `listVisits({ person, from, until, cursor? })` | A person's past bookings in their final states. Used by stage 33 only |
| `takeHints({ max })` | Hints received since the last take, for a connected system that has them; none for a list |

The session serves exactly these methods (`BOOKING_SYSTEM_SESSION_METHODS`) and declares **no
outbound actions**: its action set is empty, so nothing can be submitted, journalled or approved
through it. A source that adds a write fails the conformance suite.

**Refusals carry a reason code** at the front of the message, `[booking-system:<code>] `:
`unauthorised`, `not_activated`, `rate_limited`, `unavailable`, `invalid`. A list answers only
`invalid` (a read outside what it holds); the others are for a connected system later.

**The fake** (`FakeBookingSystem`, `fake.ts`) holds invented people, types, memberships, classes,
bookings and staff in one plain state object, and lets a test: change anything; make the next call
fail (transient or not); move the clock; share one address between two people; count every call by
method. **The conformance suite** (`conformance.ts`, `runConformance`) runs every read against any
target: paging to the end, `modifiedSince` returning what changed and nothing older where the
source offers it, refs stable across reads, the 200-people and 50-classes limits refused above
them, every refusal code the source declares, no outbound action declared, no field outside the
contract returned (checked by key). Checks needing the fake's controls are skipped without them. It
runs against the fake in memory, the fake gatekeeper through its session, and the file session over
the fixture files.

**The file session** (`fileSession(list)`, `file.ts`) answers the contract from parsed, mapped rows:
everything of its kind, `modifiedSince` not offered, no hints, and `describeSite` giving the export
date. It is pure (no I/O) so it runs in core, in the runner and in the CLI alike.

**The fake gatekeeper is never released** (`cos-gatekeeper-booking-system-fake`, vendor
`booking-system-fake`, catalogue `devOnly`, config in `wrangler.fake.jsonc`), as the accounting
fake.

### The file source

- **Kinds and columns.** A `members` list: one row per membership or pass held, or one row per
  person with none: person ref (or, when the export has none, the address), email, given and
  family name, member status, membership type, kind, status, from, until, uses total and left,
  renews. A `timetable` list: one row per booking, or one per class with none: class ref (or date,
  time and title), class type, title, starts, ends, location, coach name and email, places, booked,
  person ref or email, booking state. Only the columns the contract uses are read; any other column
  is ignored and never stored.
- **Mapping.** As `import.csv.preview`: the headers are read, a mapping is suggested from header
  names and saved per kind in `core_outside_settings`, so the next export of the same shape loads
  with no questions. Values the business's export writes its own way (a status "Active", a kind
  "Pricing option") map onto the contract's words through a small value map in the same settings.
- **Dry run** (`outside.file.preview`, read only): the rows read, the rows refused with why (no
  email, a date that does not parse, an unknown status), what would be added, changed and removed
  against the current list, who would link by address, who would wait in To match, and how many
  members would count. Nothing is written.
- **Load** (`outside.file.load`, a human with `bookingSystem:manage`): the same text, mapping and
  export date; the host plans again against current data (ADR 0020's stateless rule) and replaces
  the list of that kind in one pipeline: rows not in the new file go, with their links and matches.
  Never an AI, an MCP client, Code Mode, an extension or an automation (`actors: ["human"]`,
  `mcp.expose: false`). Limits as `CSV_LIMITS` (10 MB, 20,000 rows).
- **The file itself is not kept.** It is read in the request and dropped; only the mapped rows the
  contract uses are written.
- **Age.** The list's age is from its export date. The largest age (31 days by default, a setting a
  human admin may lower or raise up to 90) decides when a list stops counting; it stays shown, marked
  "too old to count", until a new list replaces it or an admin removes it.

### Records

Core tables (migration 1410), in no `rec_*` view, `query.sql`, export, search or dashboard; read
only through `outside.*` operations:

- **`core_outside_settings`** (one row; human admin, `actors: ["human"]`): the source (`file`, or
  later a connection); on or off; the **member types** (which outside membership and pass types make
  a Person a member: by default every type of kind `membership`, no pass); the **links** the business
  sets (where a member manages their membership, where to book a class: each an `https` address,
  shown as is); the **largest age**; the saved **mappings** and value maps per kind.
- **`core_outside_list`**: each loaded list: kind, export date, loaded at and by, rows, refused
  rows, the mapping used. The current one per kind is what the copy is; earlier ones are kept 30
  days as a log (counts only, never names). It is how the screens say "from the list of 3 March".
- **`core_outside_person`**: list, ref, address (normalised by `normaliseCustomerEmail`), given and
  family name, member status, active; the **link**: Person (or none), how (`address` or `staff`,
  with who), when; `why_kept` (a member, holds a live pass, booked in the window, or staff). Unique
  by ref.
- **`core_outside_membership_type`**: ref, name, kind, active.
- **`core_outside_membership`**: ref, outside person, type, name, kind, status, from, until, uses
  total and left, renews.
- **`core_outside_class_type`**, **`core_outside_class`** (ref, type, title, starts, ends, location
  name, outside staff, places, booked, waiting, cancelled),
  **`core_outside_booking`** (ref, class, outside person, state),
  **`core_outside_staff`** (ref, display name, address, active, the staff account it is linked to or
  none).
- **`core_outside_match`**: an outside person or outside staff waiting for a person to link: the
  candidates (Persons, or staff accounts) and why (`several_people`, `shared_address`,
  `no_address`). Kept while the outside row is.
- **`core_outside_suppressed`**: the hash of the ref and of the address for an erased Person's
  outside person, so the next load keeps nothing of them (as `core_erased_address` does for mail).

A link made by staff is kept across loads by ref (or by address when the export has no ref).

**What is kept is the least the first wave uses.** An outside person is kept only while they are a
member, hold a live pass, are booked in a loaded timetable, or are staff-linked; anyone else in a
file is dropped at load. No address, phone, birth date, card, note, visit history, sale or price is
copied.

### Matching (never merged)

For each outside person kept, at each load and when a Person's addresses change, in order:

1. The ref or the address is suppressed (an erased Person): keep nothing.
2. The address is on the erased-address list: keep nothing.
3. A link already held whose Person still has that address live: keep it. A link made by staff is
   kept whatever the address.
4. Exactly one live Person has the address among their live addresses (`checkPerson`), and no other
   kept outside person shares it: link, how `address`. Nothing on the Person changes: no name,
   address or phone is written, no customer account is touched, nothing is sent (stage 29's
   certainty `address`). The timeline gets one activity, "linked to the booking system's list",
   naming no address.
5. Several Persons have the address, or several outside people share it (a family on one address):
   link nobody; a `core_outside_match` row lists the candidates for staff.
6. No Person has it: stay unlinked. A Person who later appears with the address (a sign-in, a
   purchase, staff) is linked then, by the same rule, without waiting for a load.

A link whose Person no longer has the address is dropped and matched again. **Staff link by hand**
(`outside.link`, a person with `bookingSystem:manage`): any outside person to any Person, or an
outside staff member to a staff account, with why; and unlink. Never an AI. **A merge** in the host
moves links to the survivor; two outside people linked to one Person are kept apart and both shown.
**Staff** are matched the same way, to staff accounts by their address, so a coach's classes are
theirs here.

### Who is a member (one host question)

`memberOf(db, person, now)` answers, for one Person: their live memberships here (stage 32's
`membership` in `trialing`, `active` or `past_due`) and their live outside memberships: linked,
status `live`, today within from and until, of a member type, and from a `members` list within the
largest age. Every consumer below calls it; none works it out again.

- **Members' prices (stage 34).** A discount's `who` gains "holders of chosen outside membership
  types" beside "members of chosen plans". In `priceLines` the host applies it to a **signed-in
  customer** only when their verified sign-in address (`signInEmailVerified`) equals the linked
  outside person's address, or a link made by staff; and to **staff buying for a Person** who is a
  member by `memberOf` (the staff member sees "member in the booking system, from the list of …").
  A guest never qualifies (stage 34's rule 2). The one-deal rule (decision 9 there) is unchanged.
- **Agreements (stage 44).** The Due list's "members with a live membership" counts outside
  members. Points and enforcement are unchanged: they fire on what is bought or booked here.
- **Programs (stage 41).** `programs.assignment` gains `kind: "members"` (optionally limited to
  chosen plans or outside types). The host decides who reads it: a signed-in customer for whom
  `memberOf` is true by the same verified-address rule. A new read scope in the visibility seam,
  `member`, beside `signedIn` (ADR 0447).
- **The coach's client list.** `outside.clientsOf { staff }` lists the people booked into, or who
  attended, that coach's outside classes in the loaded timetable: name, the Person when linked, the
  next class. Programs' coach client screen shows it, with "no account here yet" for the unlinked. A
  coach sees only their own classes' people; `bookingSystem:manage` and the desk see everyone's.
- **My account (stage 48).** A base section, **Your membership**, shown when the caller has a live
  outside membership (by the verified-address rule) from a list within the largest age: each
  membership and pass, its status, until, uses left, "Managed in your booking system", the
  business's link, and the list's date. Base-layer blocks `account-outside-membership` (web and
  native). No attention item comes from outside data. A guardian's view of a child is not in this
  stage.

### Outside classes (read only)

- **The timetable.** `outside.timetable { from, until }` (customer and **public**: newly opened, a
  reviewed change, ADR 0402) answers outside classes from the loaded timetable in the window that
  are not cancelled and not yet past: class type, title, starts, ends, location, the coach's display
  name, places left as of the list (as Bookings shows its own, `show: "exact"`, with the list's
  date), and the business's booking link. Never who is booked. Bookings' `bookings-timetable` and
  `bookings-native-timetable` blocks merge them in by time, each marked "Book in your booking
  system" with the link and no Book button. With no timetable loaded the read is empty and the
  blocks show only Bookings' own classes.
- **The desk's and the coach's day.** `outside.day { date }` (staff: `bookings:coach` or
  `bookings:desk`, as Bookings' `day`) answers that day's outside classes with who was booked when
  the list was exported (names from the copy, the Person when linked). Shown in
  `bookings-class-list` beside the pack's classes, marked read only and dated: no mark attended, no
  move, no cancel. A coach's own classes are those whose outside staff is linked to them.
- **Never spending.** Outside classes and bookings are core rows, not records of `bookings.class`
  or `bookings.booking`. They declare no behaviour, take no place in `capacity`, and never touch
  `core_allowance_use`. A test proves a member's allowance is the same before and after a load that
  writes their outside bookings.
- **The roster (a later step, decision 1).** Rostering's week shows outside classes with their
  coach, read only. A class whose outside staff is not linked to a staff account shows "coach not
  linked" and a rosterer links them once (`outside.link`). Each class with a linked coach enters
  the time claim as a read-only claim (kind `outside`), so a duty shift overlapping a class the
  person teaches is a **warning** (ADR 0622), never refused: the next list can move a class and the
  roster must not then refuse its own reconcile.

### Loading in budget

- **Statements per call.** `outside.file.load` writes set-based, a list of rows as one
  `json_each(?)` parameter, at most 100 rows a statement (ADR 0500's budgets: 1,000 queries an
  invocation, 100 bound parameters a statement). A `members` list of 3,000 rows with 800 members
  and a `timetable` list of 28 days of 15 classes with their bookings each load within **250 D1
  statements** (statement-count test). Removing the rows a new list drops is one statement per
  table.
- **D1.** Rows are small (no text over 500 characters is copied; a title or description longer is
  cut). Expected size: a few thousand people, ten thousand bookings, well under a megabyte. Indexes:
  person by ref and by address; class by starts; booking by class and by person.
- **The list's age** is checked when read, so no cron is needed for it; the minute cron only
  removes list log rows past 30 days and sends the "too old in 3 days" notice once.

### Operations

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `outside.settings.get` | staff | `bookingSystem:manage` | read |
| `outside.settings.update` (on and off, member types, links, largest age, mappings) | staff | human admin (`settings:manage`, `actors: ["human"]`) | write |
| `outside.file.preview` (the dry run) | staff | `bookingSystem:manage`, human only | read |
| `outside.file.load` | staff | `bookingSystem:manage`, human only | write |
| `outside.lists.remove` (one kind, or all) | staff | `bookingSystem:manage`, human only | write |
| `outside.status` (the current lists, their dates and ages, refused rows, To match count) | staff | `bookingSystem:manage` | read |
| `outside.matches`, `outside.link`, `outside.unlink` (with why) | staff | `bookingSystem:manage`, human only for link and unlink | read / write |
| `outside.person` (a Person's outside memberships and upcoming outside bookings) | staff | anyone who may read the Person | read |
| `outside.day`, `outside.clientsOf` | staff | `bookings:coach` (own classes) or `bookings:desk`; `bookingSystem:manage` | read |
| `outside.timetable` | customer, **public** | anyone, rate limited | read |
| `outside.mine` (Your membership) | customer | the signed-in customer, by the verified-address rule | read |

None writes to the booking system, a Person's fields, an order, a membership here, a booking here
or an allowance. `outside.timetable` opening to the public is called out for review (ADR 0402).

### Screens

- **Web admin, Settings → Booking system** (core, `bookingSystem:manage`): **Load a list** (choose
  the kind, upload the file, the export date, map the columns, the dry run, Load; the terms notice
  above); **Lists** (each kind's date, age, rows, refused rows, "too old to count", Remove);
  **Settings** (member types from the loaded list's own types, the two links, the largest age);
  **To match** (outside people and staff waiting, with their candidates; link, or leave).
- **Person page**: an "In the booking system" panel: linked how, outside memberships with status and
  dates, upcoming outside bookings, the list's date.
- **Bookings' blocks**: the timetable, the desk's and the coach's day (above). **Programs' coach
  client screen**: the coach's client list. **Rostering's week**: later.
- **My account**: Your membership (above).
- Every screen says "from your booking system's list of …" and has no control that would change
  outside data.

### Notifications

To `bookingSystem:manage` holders: 3 days before a `members` list passes the largest age, and when
it does ("members' prices from the booking system's list have stopped; load a new list"). A daily
digest line when people wait in To match. Nothing to customers.

### What an AI may do

- **May**: read outside data only where the same caller may read the record it belongs to, through
  the same operations (a staff assistant reading a Person sees the panel staff see; a coach's
  assistant sees their own classes' people). Explain a list's age and why someone is waiting to be
  matched, and tell a person how to export and load a new list.
- **May not**, whatever is granted: preview or load a list, remove one, change settings, or link or
  unlink. The outside tables are in no `rec_*` view, so no dashboard, `query.sql` or export reaches
  them. Nothing is shown to an AI beyond what the record shows a person in the same seat.

### Privacy, audit and erase

- **What is kept**: names, an address, member status, memberships and passes (names, status,
  dates, uses), classes, bookings and attendance from the loaded timetable, staff names and
  addresses. The least the first wave uses; nothing else in the file is stored, and the file itself
  is not kept. A list is replaced by the next of its kind, and removed at once by `outside.lists.remove`.
- **Who sees**: staff who may read the Person (their panel); coaches their own classes' people; the
  desk the day; customers only their own memberships (by the verified-address rule) and the public
  timetable (no names).
- **Audit**: every settings change, each load and removal (kind, export date, counts, who; never
  names or addresses), link and unlink (with why).
- **Erase**: erasing a Person deletes their outside person, memberships, bookings, links and
  matches, and suppresses the ref and the address (`core_outside_suppressed`), so the next load
  keeps nothing of them; their addresses are already on the erased-address list. The erase result
  says "a copy remains in the booking system": the host cannot remove it there, and staff deal with
  it there. Erasing a staff account unlinks its outside staff.

### Working without a list

Each first-wave piece is built and tested with no list loaded: tickets (members' prices from
memberships here only), the online program (its other assignment kinds), logged training, content
and the site, checklists (stage 45's follow-on). Every `outside.*` read answers empty, `memberOf`
answers memberships here only, and no screen shows a booking-system panel.

### A connected system later

The contract is the seam for a booking system whose terms allow an API connection. That system is
its own small stage: its terms read first, its own gatekeeper Worker implementing
`BookingSystemSession` and passing the conformance suite, its secrets env-only and set by a person,
connecting a human admin's act, the connection the host's alone (not callable through
`integration.call`, Code Mode or an extension), and passes that refresh the same core copy. Its own
terms set how long its copy may be kept, in place of the largest age. None of it is built in this
stage.

### What stage 33 reuses

Stage 33 (leaving the booking system) reads through the same contract (the file source, with a
visits list for history, or a connected system where one exists) and writes the import folders
stages 31 and 32 already define (`cos bookings import`, `cos memberships import`), with the
booking system's refs as import keys. The matching rules above decide which Person each outside
person becomes, and links already made carry over. What stage 33 decides (the switch, billing and
stored cards, which an export does not hold) stays stage 33's.

## Out of scope

- Any write to a booking system: bookings, cancellations, attendance, people, memberships, sales.
- An API connection to any booking system (a later stage per system, above).
- Appointments, waitlist order, sales and prices from the booking system.
- A guardian's view of a child's outside membership; attention items from outside data.
- More than one booking system per deployment.
- The move itself (stage 33).
- The roster's outside classes ship in this stage's later step, not the first wave (decision 1).

## Acceptance criteria

1. The conformance suite passes against the fake in memory, through the fake gatekeeper, and
   against the file session over the fixture files: every read, paging, stable refs, the limits,
   every declared refusal code, no outbound action declared, no field outside the contract.
2. The file source: a mapping is suggested from the headers and saved; the dry run reports refused
   rows with why, what would change, who would link and who would wait, and writes nothing; a load
   replaces the list of its kind; a column the contract does not use is never stored; the file is
   not kept.
3. Only a human with `bookingSystem:manage` may preview, load or remove a list: an AI actor, an MCP
   client, Code Mode, an extension and an automation are refused each of them.
4. Matching: one Person with the address links (by address) and changes no field on the Person; two
   Persons, or two outside people on one address, link nobody and wait in To match; no Person stays
   unlinked and links when a Person with that address signs up; an erased address keeps nothing; a
   staff link survives the next load.
5. A signed-in customer whose verified sign-in address matches a live outside membership of a
   member type, from a list within the largest age, gets the members' price on an event ticket; the
   same address unverified, a guest, a list past the largest age, or a type not counted, does not.
6. A members' program opens to such a customer and to no one else.
7. Your membership in My account shows the outside membership, "managed in your booking system",
   the business's link and the list's date; nothing shows for a customer without one.
8. Outside classes appear on the timetable blocks with the booking link and no Book button, and on
   the coach's and desk's day with who was booked; nothing on them can be changed; a member's
   allowances are unchanged by any load.
9. Age: every screen shows the list's date; a `members` list past the largest age stops counting
   at once and is marked "too old to count"; the admins are told 3 days before and when it happens.
10. With no list at all, every first-wave journey passes and every `outside.*` read answers empty.
11. Cost: loading the fixture (a `members` list of 3,000 rows with 800 members; a `timetable` list
    of 28 days of 15 classes with their bookings) stays within 250 D1 statements each
    (statement-count test).
12. Erase removes every outside row for the Person, suppresses the ref and the address so the next
    load keeps nothing, and the result names the copy in the booking system.
13. `node scripts/check-stray-names.mjs` passes, and the booking system's name appears in no file
    but the check and its tests.
14. E2E, one per journey: an admin loads a members list (map, dry run, load), a member's price
    applies to a ticket, the coach's day shows outside classes from a loaded timetable; and the same
    ticket journey with no list.

## Dependencies

- **Built**: stage 6 (integrations, the catalogue), the CSV import (ADR 0020), stage 22 and 23
  (customers, verified sign-in), stage 25 (orders), stage 31a (Bookings), stage 32b (Memberships),
  stage 41 (Programs), stage 45 (Rostering, checklists), stage 61 step 1 (the contract pattern,
  `implements`).
- **Not built, needed for one step each**: stage 34's Offers spine (members' prices, step 6),
  stage 48's `me.portal` (Your membership, step 6).
- **Not needed**: stage 33, stage 30 (notices use today's), stage 47 (the screens are core admin and
  existing pack blocks).
- **Needs a person**: for a real business, an export from its booking system in the shape the
  mapping reads (a sample file, anonymised, to shape the fixture), and that business's own check
  that its booking system's terms allow it to export and use its data this way.

## Migrations and numbers

Block **CA** in [`parallel-work.md`](../parallel-work.md): migrations 1410–1429, ADRs 0920–0929.

- Migration 1410: `core_outside_settings`, `core_outside_list`, `core_outside_person`,
  `core_outside_membership_type`, `core_outside_membership`, `core_outside_class_type`,
  `core_outside_class`, `core_outside_booking`, `core_outside_staff`, `core_outside_match`,
  `core_outside_suppressed` (step 3).
- Migration 1411: the read-only `outside` claim kind for the time claim (step 9), if ADR 0621's
  tables need one; otherwise unused.
- New tables only; no `x_*` table and no `core_write_guard` kind; `bookingSystem:manage` is code in
  `principals.ts`.

ADRs the build writes:

1. **ADR 0920**: the booking-system contract: one read-only session, no outbound action, the shared
   fake and conformance suite, the file session (step 1).
2. **ADR 0921**: no named connector and a file source first: the naming rule stays strict, no API
   connection to the first client's booking system (step 2, written).
3. **ADR 0922**: the outside copy: what is kept, matching by address with no merge, the
   verified-address rule, suppression on erase (step 3).
4. **ADR 0923**: the file source: kinds, mapping, the dry run, a human's load, replace on load, the
   list's age and the largest age (step 4).
5. **ADR 0924**: outside memberships as a source of truth: `memberOf`, members' prices, members'
   programs and the `member` read scope, My account (step 6).
6. **ADR 0925**: outside classes: shown read only, never bookable here, never spending; the roster's
   read-only claim (steps 7 and 9).
7. ADRs 0926 to 0929 stay free.

## Suggested build order

| Step | What | Files and areas | Beside what (collides with) |
| --- | --- | --- | --- |
| 1 | **The contract, fake, conformance suite and file session** | `packages/gatekeeper-booking-system/` (new), the fake bound in the runner for dev and tests, `catalogue.ts` (`implements`) | Beside anything; `catalogue.ts` is one line |
| 2 | **The naming rule** (built) | `scripts/check-stray-names.mjs`, `check-stray-names.test.mjs` | Beside anything |
| 3 | **Core records, settings, matching, ingest, `bookingSystem:manage`** | migration 1410, `packages/core/src/outside/`, `operations/outside.ts`, `principals.ts` | After 1. Collides with **`principals.ts`** and the operations registry |
| 4 | **The file source**: column mapping and value maps, the dry run, the staff-only load (never an AI), replace on load, the list's age, the notices | `outside/file.ts`, `outside.file.preview`, `outside.file.load`, `outside.lists.remove`, the minute cron's notice; reuses `operations/import.ts`'s CSV parser | After 3. Collides with `operations/import.ts` only if the parser is moved to share it |
| 5 | **Admin screens and the Person panel** | `apps/app/src/routes/_app/settings/booking-system*` (Load a list, Lists, Settings, To match), the Person page | After 4. Collides with the Settings index |
| 6 | **Members**: `memberOf`, members' prices, the `member` scope and Programs' `members` kind, Your membership | `outside/members.ts`, `orders/` pricing, `visibility/`, `packs/programs`, base-layer blocks | After 3. Prices wait for stage 34's spine; Your membership for stage 48. **`visibility/` is reserved** (stage 22, 14): coordinate |
| 7 | **Outside classes** in Bookings' blocks and the coach's client list | `packs/bookings` blocks and tools, `packs/programs` coach screen | After 3. Beside 6 |
| 8 | **E2E, the site and `SITE.md`** | `apps/app/e2e/`, `apps/marketing`, `SITE.md` | After 4 to 7 |
| 9 | **The roster** (later, decision 1) | `packages/core/src/staffing/`, migration 1411, `packs/rostering` week | After 7. Collides with staffing work |
| 10 | **Erase, merge, removal** | `records/erase.ts`, `erase-stores.ts`, `person.merge` | Last. **Erase is reserved** (`docs/parallel-work.md`) |

Steps 1 and 2 start first; then two sessions can run: core and the file source (3 and 4), then
the screens (5) and the pack reads (6, 7) once 3 is merged.

## The naming rule (step 2)

`scripts/check-stray-names.mjs` refuses the booking system's name in every file but the check and
its tests (the owner's decision of 2026-11-22, kept on 2026-11-24 by decisions 4 and 5). This
spec's first pull request had added an exception for this spec; step 2 removes it, and the spec
names no outside product. The tests prove the name fails in this spec and in any other file, and
that the repository's rules are well formed. The course platform and CMS rules are unchanged.

## Decided by this spec, open to override

- One read-only contract with no outbound action, a shared package with the fake, the conformance
  suite and the file session (ADR 0880's shape); no named connector.
- The file source is the first and only source in this stage; a connected system is its own later
  stage.
- Two list kinds, `members` and `timetable`, loaded separately; each load replaces its kind.
- A list's age is from its export date; the largest age is 31 days by default, at most 90.
- Core owns the copy and the rules; packs show it.
- No Person is made from a list; a link by address changes nothing on the Person; a customer
  benefits only through their verified sign-in address; staff link by hand; never merged.
- Member types default to every membership type and no pass; the business changes it.
- The coach of an outside class is the booking system's, shown on the roster read only; a clash
  with a duty is a warning, never a refusal.
- No attention items and no child's view from outside data in this stage.
- The public timetable shows outside classes with places left as of the list and no names (a
  reviewed change).

## Questions for the owner

1. **The largest age.** A members' list counts for 31 days from its export by default, and a
   cancelled member keeps a members' price until the next list or that day. Options: **(a)** 31
   days, the admins told 3 days before; **(b)** 7 days, so a weekly export is the habit; **(c)** no
   limit, the date only shown. **Recommended: (a)**; a human admin can lower it.
2. **The timetable list in the first wave.** A timetable changes daily, so a loaded one is out of
   date within a day unless staff load it often. Options: **(a)** build it in this stage (step 7) as
   specced, its date shown everywhere; **(b)** members only in this stage, the timetable when a
   connected system exists. **Recommended: (a)**, since the desk's and the coach's day are decision
   3, and a business can choose not to load one.

## Risks

- **A wrong link** gives one person's member status to another. Mitigations: links by address change
  nothing, benefits need the verified sign-in address, shared addresses wait for staff, the Person
  panel shows how each link was made.
- **Stale truth**: a cancelled member keeps a members' price until the next list or the largest
  age. The money is small; the list's date is shown to staff.
- **A list nobody reloads**: members' prices stop at the largest age and the admins are told
  before; nothing else depends on it.
- **An export's shape changes**: the saved mapping no longer matches; the dry run shows the refused
  rows before anything is written.
- **Terms**: what a business may do with its own export is set by its booking system's terms; the
  load screen says so and the business confirms it.

## Sources

Read 2026-11-24, in this repository: `AGENTS.md`, `CONTEXT.md`, `docs/architecture.md`,
`CONTRIBUTING.md` (Working in parallel), `docs/roadmap.md` (stage 33's row), `docs/parallel-work.md`,
stages 29, 31, 32, 34, 41, 44, 45, 47, 48 and 61, ADRs 0020, 0457 and 0880, and the code named in
"What exists today". There is no stage 33 spec yet. The owner's decision of 2026-11-24 that the
first client's booking system's developer terms bar a competing product.
