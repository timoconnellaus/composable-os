# Stage 49: Appointments

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Behaviours, Orders, Packs and blocks), [`CONTEXT.md`](../../CONTEXT.md) (Shift, Roster, Booking,
Drop-in, Care link), ADRs [0404](../adr/0404-behaviours-are-the-vocabulary.md),
[0430](../adr/0430-capacity-is-refused-by-the-database.md),
[0500](../adr/0500-recurring-a-weekly-rule-in-local-time.md),
[0502](../adr/0502-declared-uniqueness.md),
[0503](../adr/0503-time-windows-and-staff-only-on-the-transition-engine.md),
[0504](../adr/0504-the-bookings-pack.md), [0506](../adr/0506-a-spender-paid-another-way.md),
[0540](../adr/0540-the-family-link.md),
[0551](../adr/0551-staff-bound-windows-and-a-move-only-by-its-new-record.md),
[0553](../adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md),
[0560](../adr/0560-a-paid-line-moves-a-record-that-exists.md),
[0571](../adr/0571-a-calendar-file-made-by-the-email-gatekeeper.md),
[0590](../adr/0590-routine-mail.md), [0600](../adr/0600-a-pack-role-and-its-grants-add-up.md),
[0620](../adr/0620-field-level-exceptions-in-recurring.md) to
[0629](../adr/0629-the-rosters-screens-role-clients-with-grants-and-the-roster-import.md),
[0641](../adr/0641-agreement-points-a-pack-declares-documents-a-person-attaches.md),
[0644](../adr/0644-enforcement-nobody-pays-or-books-without-what-is-due.md);
stages [31](31-bookings.md) (its 31b section, which this stage replaces), [32](32-memberships.md),
[34](34-offers.md) (the pricing seam and "an order paid another way"),
[43](43-practitioners.md), [44](44-agreements.md), [45](45-rostering.md) and
[47](47-pack-screens.md); stage 48, My account (PR #311); issues
[#239](https://github.com/timoconnellaus/composable-os/issues/239),
[#213](https://github.com/timoconnellaus/composable-os/issues/213) and
[#237](https://github.com/timoconnellaus/composable-os/issues/237); code:
`packages/sdk/src/staffed.ts`, `packages/core/src/staffing/`, `packages/db/migrations/0811_staff_time.sql`,
`packages/core/src/pack-role-today.ts`, `packages/core/src/records/states.ts`, `packs/bookings/index.ts`,
`packs/memberships/index.ts` (`SPENDS_ON`), `packages/sdk/src/allowance.ts`.

Status: **spec agreed** (owner interviewed 2026-11-24; the other points decided the same day by the
coordinator as best practice, below). Build may start with step 1.

- **Step 1 built** (`feat/stage-49-claim-margins`; migration 1091, ADRs 0760 and 0761): claim
  margins on `staffed` (`claimBefore`, `claimAfter`, kept on the claim as `margin_before` and
  `margin_after`, followed on the kind's table for shifts not yet ended), `account: "required"`
  (refused at write and by triggers on the shift's and the profile's tables), and `private`
  (the roster shows the kind to anyone but the provider and rosterers, clash answers name the kind,
  never offered; the feed already showed no title). Platform only: no Bookings object declares them
  yet (step 5). The spec's ADR "0764" part about the roster and the feed is ADR 0761.
- **Step 4 built** (`feat/stage-49-free-times`; migration 1092, ADR 0763, ADR 0762 amended): free
  times and the customer's check. `staffed.open` (the kind's length, step and rooms, the client,
  the closures, `customer: true`); `freeTimes` (`staffing/free.ts`) worked out at read time from
  open hours less time off, claims with margins (the batch's queued ones counted), taken rooms (the
  first free in the kind's order), closures and the client's own, on the step from local midnight,
  inside the create rules' window for a customer or the public; only qualified, active providers;
  at most 31 days and 20 providers in a fixed number of reads. The tool-only `staffing.free`, open
  to staff, customers and the public through a shipped pack's tool, keyed by the shift's person
  value (a coach profile) rather than an account (the spec's `accounts?`). The customer's check
  (`not_free_time`) in the transition engine's place and in `assertCreateRules` (the held door),
  with exactly one of the kind's free rooms or none, and the client's own bookings guarded at
  commit (`core_client_guard`, migration 1092; a visitor paying is step 8's);
  staff warnings `outside_hours` and `client_busy`. A customer's booking of such a shift is not a
  rosterer's act (ADR 0626 amended) and carries no staff warnings or roster notices. Platform only:
  no Bookings object declares `open` yet (step 5), so nothing calls `staffing.free` outside tests.

This stage was drafted as "31b". It **replaces stage 31's 31b section** and widens it: stage 31's
decision 1 agreed appointments "booked by staff" and left members booking their own to #239; a gym
needs members booking one-to-one sessions themselves on day one, so this stage takes #239 in. Stage
31's 31b section, its acceptance criterion 18 and its "Left out" line are superseded
by this spec (a dated note in stage 31 points here; the coordinator adds it). It also takes in
**outside practitioners** (stage 43): a physiotherapist the gym works with takes appointments in the
gym's rooms on the same calendar, which stage 43 did not cover.

## Goal

A person books a time with someone who gives one-to-one sessions: one of the business's coaches, or
an outside practitioner the business works with. Each of them says when they are open for
sessions, week by week, with time off and one-off extra hours. The business sets up its kinds of
session (a 60-minute personal training session, a 30-minute assessment, a physiotherapy
consultation) with a length, a price or the pass that pays for it, the rooms it needs, and a gap
after. Members and visitors see the times that are really free, on the website and in the app, and
book one: with a session pass, or by paying on the website. Staff book for a client at any time,
including a weekly standing session. The business's rules hold for everyone: how far ahead and how
late a session may be booked, and when a cancel is late and the session is used. Clients get a
confirmation with a calendar file and a reminder; coaches and practitioners see their day.
**Nobody is ever booked twice at once** across classes, duties and appointments, and no private
room is either.

## Who it is for

- **Gyms and studios (first).** Personal training, assessments, a coach's one-to-one technique
  session, a child's private lesson booked by a parent, and sessions with an outside practitioner
  in the gym's treatment room. Paid by a session pass ("10 PT sessions") or per session; staff
  can mark one paid at the desk. A coach also teaches classes and works duties, so the clash rule
  spans all three. Most sessions are on the floor; some need a private room.
- **Services businesses (next).** The same core, with different stress, which this stage keeps
  possible without building:
  - *Salons:* many staff, many short services, "anyone free" is common, a chair as the room. Later:
    several services in one visit, a processing gap, a deposit.
  - *Clinics:* a practitioner's own hours, intake questions (stage 44's health questions at an
    agreement point), a treatment room, private notes (stage 43's Care pack, never this stage's
    records).
  - *A tradesperson's site visits:* served only as a fixed-length visit with buffers; arrival
    windows, routing and the client's address as the place are deferred.

## What exists today (from the code)

- **The time claim** (stage 45 step 2, [ADR 0621](../adr/0621-the-staffed-behaviour-and-the-time-claim.md),
  migration `0811_staff_time.sql`, `packages/sdk/src/staffed.ts`, `packages/core/src/staffing/`):
  an object declaring `staffed` is a shift; `core_staff_time` holds one row per live, covered shift,
  keyed by an account id (a text column with no foreign key), and `BEFORE INSERT/UPDATE` triggers
  refuse an overlap (`core_staff_double_booked`) for every writer and under races. Triggers on the
  object's own table, built by the reconciler, derive the claim. The claim is the shift's own time;
  `payBefore` and `payAfter` are pay only. `staffed.who` is a `user` field, or a relation to a
  profile whose `user` field holds the account; a coach profile with no account claims nothing.
- **Classes and duties already claim**: `bookings.class` declares `staffed` (live `scheduled`,
  `done`; `place: "room.name"`), as does Rostering's duty shift (`packs/rostering/index.ts`).
- **Qualifications, time off, offers, uncovered shifts** (ADRs 0622 to 0624, migrations 0811 and
  0812): `core_staff_qualification` (account × kind record), `core_staff_away` (one-off ranges and
  weekly rules in local time, checked on the fly), offers with exactly one take, warnings
  (`unavailable`, `not_qualified`, `uncovered`), `staffing.check`, `staffing.week`, the uncovered
  notices, and `user.deactivate` taking a leaver off future shifts (`staffing/leaving.ts`).
- **Pay periods and the calendar feed** (ADRs 0627, 0628, migrations 0813 and 0814): every live
  staffed shift is counted for pay and appears in its person's private feed, whatever object it is;
  both are keyed by a staff account.
- **Recurring** (ADRs 0500, 0620): a weekly rule in local time generates dated records up to a
  horizon, skipping declared closures (Bookings' `closure`, by date), with field-level exceptions;
  generation never fails on a clash (the date is made uncovered).
- **The booking machinery** (`packs/bookings`): states with time windows and staff-only rules
  (ADR 0503) read from the class type over the organisation's settings, declared uniqueness (ADR
  0502), the `allowance` spender (the Memberships pack's memberships and passes; `spendsOn` takes
  one declaration or a list, `packages/sdk/src/allowance.ts`), a spender paid another way (ADR
  0506), a paid line that moves a held record (`sellable.moves`, ADR 0560, with `guest: true` and a
  hold cap), the family link (ADR 0540), the agreement point `booking` with an inline step (ADRs
  0641, 0644), routine mail with a calendar file and reminders in minutes (ADRs 0570, 0571, 0590),
  the coach role limited to today (`pack-role-today.ts`, ADR 0553).
- **Rooms** are `bookings.room` (a name and a number of places, "a guide for staff, not a limit"),
  used by classes as a label. **No time claim exists for a room or any other thing.**
- **Outside practitioners** (stage 43) are specced, not built past step 1: a fourth principal with
  its own account (`core_practitioner`, `prc_…` ids), care links and consent. Nothing in staffing
  knows them.
- **Not anywhere:** someone's open hours, a computed list of free times, a check that a customer's
  booking is on a free time, a claim margin (buffer), a room claim, a service.

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | **A late cancel or a no-show counts the session as used, with no fee.** Staff can give it back. (A fee stays #213) |

### Decided by the coordinator the same day (best practice, not asked; open to override)

| # | Decision |
| --- | --- |
| 2 | **Members, and visitors who pay on the website, book online by themselves.** A visitor pays the way a drop-in already does |
| 3 | **Three ways to pay**: a session pass (a pack of 10 sessions), paying for each session on the website when booking, or paid at the desk / settled by staff. A membership that includes sessions is possible with no extra work (a membership is an `allowance` holder too) but is not set up by this stage |
| 4 | **A cancel is late from 24 hours before the start**, changeable per kind of session |
| 5 | **Some sessions need a private room, and a class in that room blocks it** (and the reverse) |
| 6 | **Staff set up a weekly standing session for a client**; clients do not make their own |
| 7 | **When a coach is off or away, a manager moves each session to another coach and the client is emailed.** No offer and take for appointments |
| 8 | **Clients pick a coach, or choose "any coach who is free"** |
| 9 | **Each coach sets their own weekly open hours and extra or changed hours, and a manager can change them** |
| 10 | How the business books and prices one-to-one sessions today, each coach's hours and how far ahead people book are **checked with the business during setup**: they are settings and records, not design |

### From the coordinator's brief (2026-11-24)

| # | Decision |
| --- | --- |
| 11 | **Outside practitioners (stage 43) take appointments** too, on the same calendar and rooms, from day one |
| 12 | **This stage defines `occupies`**, the claim on a room or space for a time. Events and venue hire (stage 57) reuses it and does not redefine it |
| 13 | The build order **starts with what a gym needs on day one**: one-to-one sessions with its own coaches, then with outside practitioners |
| 14 | A customer sees their appointments as **a section of My account** (stage 48), with no separate customer area; no new attention kind is needed (below) |

## The design in one page

**Appointments are a second kind of record in the Bookings pack; the rules are the host's.** An
appointment is a shift: it declares `staffed`, so it shares the one time claim with classes and
duties. That table is the whole answer to "nobody is double-booked": every class, duty and
appointment of one account is a row in `core_staff_time`, and the database refuses an overlapping
row whoever writes it (a member online, a coach in the app, staff at the desk, the assistant once
approved, an import, the host's own generation, a take of an offer). Two members picking the last
07:00 time at once: one batch commits, the other is refused and shown the times still free.

**Five platform pieces, each pack-agnostic, so a salon or clinic pack later reuses them:**
1. **Claim margins.** `staffed` may declare minutes before and after that enter the claim (the
   buffer). Classes declare none, so back-to-back classes stay allowed (ADR 0621 amended).
2. **`occupies`, the claim on a thing.** An object may declare that it occupies a thing (a room, a
   chair, a hall) for its time, refused by the database like the time claim, in a new core table
   keyed by the thing. Only things marked as taking one booking at a time are claimed. Appointments
   occupy their room when the service needs one; classes occupy theirs. Stage 57 reuses it.
3. **Open hours.** A core table of each provider's weekly open times and one-off extra times,
   beside `core_staff_away` and read the same way (wall clock, on the fly). Time off is the existing
   away record: one place for "not working", not two.
4. **Free times and the customer's check.** A tool-only host read computes the free start times for
   a service (open hours, minus time off, minus claims with margins, minus occupied rooms, minus
   closures, inside the booking window); and the host refuses a customer's or visitor's appointment
   that is not on one. Staff may book outside open hours with a warning, never over a clash.
5. **A practitioner as a provider.** The time claim, open hours, qualifications and free times are
   keyed by an account that is a staff account **or a practitioner account** (stage 43). A
   practitioner's appointments are claimed like a coach's; their pay is not the business's (no pay
   lines, no time entries); they read their own day through one host read, and see a client's name
   only under a live care link.

**Who gives which service is a qualification.** A service is the shift's kind (`staffed.kind`), so
stage 45's qualifications say who gives it, and there is no second list on the service.

**Paying is what already exists.** A pass pays through the `allowance` spender (pass types gain the
services they cover); paying per session is a held appointment and an order, exactly as a drop-in
(`sellable.moves`), priced through the pricing seam (`priceLines`, stage 34), with a visitor as a
guest; staff mark it paid at the desk as a spender paid another way (ADR 0506). Nothing charges a
card on its own.

**Screens are declared.** Staff screens are Bookings' declared pack screens (stage 47): the
coaches' day, book for a client, standing sessions, my open hours. The customer's appointments are
Bookings' section in My account (stage 48). A practitioner's day is on the practitioners' web pages
(stage 43 step 7).

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **A separate Appointments pack now**, for businesses without classes | A gym would keep two profiles per coach and two lists of rooms, and a room shared by a class and a session would need a link across packs. The rules are platform pieces anyway, so a later services pack reuses them; the line is drawn when a second client tests it |
| **Free times as generated records** (a row per free half hour) | Thousands of rows per coach, rewritten on every class change and time off; a stale row is a lie. Free times are computed at read time and the database refuses the race |
| **Open hours as Bookings records** (`recurring` availability, stage 31's guess) | Records are in `rec_*` views (every staff account reads them by SQL), and a free-times read must combine them with time off and duties, which are core tables a pack cannot read. Stage 45 kept time off out of records for the same reason |
| **The buffer as a longer end time** | The client would see a wrong end, pay would count the gap, and changing a service's gap would rewrite every future appointment |
| **The service lists which coaches give it** (stage 31's guess) | A second source beside qualifications; offers and warnings would disagree with it |
| **A room as a capacity of one** (ADR 0430) | Capacity counts places on one record; a room's time is a range shared across many records and objects, the same reason the time claim is not a capacity |
| **Every room claimed** | Today many classes share the gym floor; claiming every room would refuse timetables that are fine and fail the pack's update on install. Only rooms marked "one booking at a time" are claimed |
| **The open-hours check in the pack's tool** | A tool's check binds only that tool; a customer's `record.create` and the native client must meet the same rule. Rules live in the host (ADR 0404) |
| **Appointments offered and taken like classes** | The client chose their coach; a swap nobody approves suits a class, not a client's session (decision 7) |
| **A practitioner as a staff account or a coach profile with a staff login** | Stage 43 rejected it: staff read every row, and one person may be practitioner, coach and member, kept apart (stage 43 decisions 15 and 16). The claim keys on the practitioner account instead |
| **A second claim table for practitioners** | Two tables would let a practitioner's appointment and a room or class clash in ways one table refuses; the account id is already an opaque text, and `prc_` ids never collide with staff ids |

## Platform work and pack work

| Piece | Platform or pack | Notes |
| --- | --- | --- |
| Claim margins on `staffed` (`claimBefore`, `claimAfter`: `kind.field` number paths) | **Platform** (amends ADR 0621) | Reconciler triggers derive `starts - before`, `ends + after`; free times read the same margins |
| A shift that must be covered by an account (`staffed.account: "required"`) | **Platform** (small) | Refused at write and by the trigger: no appointment escapes the claim |
| A practitioner account as a shift's person (`staffed.who.practitioner`: a profile field holding a practitioner account) | **Platform** (after stage 43 step 3) | One claim table; pay lines, time entries and the staff feed leave practitioner claims out |
| `occupies` and `core_thing_time` | **Platform** (new behaviour, new table and triggers, built by the reconciler like the time claim) | `core_thing_double_booked`; the shared piece stage 57 uses |
| Open hours: `core_staff_hours`, `staffing.hours.*` (tool-only) | **Platform** (new table; in no `rec_*` view) | Set by the person or a rosterer; a practitioner's by themselves or a person with `practitioners:manage` |
| Free times: `staffing.free` (tool-only read) | **Platform** (new `staffing/free.ts`) | Bounded: 31 days and 20 people per call |
| The customer's check (`staffed.open`) | **Platform** (the transition engine's create and move checks, beside ADR 0503's windows) | Staff get `outside_hours` as a warning instead |
| The coach role's reach to **its own** shifts beyond today | **Platform** (`pack-role-today.ts`, ADR 0553 amended) | Today's limit stays for class lists |
| Redacting a shift's client from `staffing.week` and the feed (`staffed.private`) | **Platform** (small; `staffing/week.ts`, `feed.ts`) | The roster shows the service, never the client, to anyone but the provider and rosterers |
| A customer moving their own appointment (`movedFrom` by a customer, inside the window) | **Platform** (amends ADR 0551: a move is staff's today) | The use moves in the same batch |
| A practitioner's day and marks: `staffing.mine` and `appointments.mark` opened to the practitioner audience | **Platform** (reviewed opening, `open-operations.json`) | Reads over the practitioner's own claims only |
| `bookings.service`, `bookings.appointment`, `bookings.appointmentseries`, `bookings.room.exclusive`, the coach profile's practitioner field, settings, tools, automations, views, dashboard numbers, blocks, screens, the My account section | **Pack** (`packs/bookings`) | |
| Pass types and memberships may cover services (`spendsOn` gains `bookings.appointment` by service) | **Pack** (`packs/memberships`) | |
| Routine mail kinds and reminders for appointments | **Pack** (declared routine mail) | No email gatekeeper change |

## The model

### Words
A **service** is a kind of one-to-one session the business offers (Personal training, 60 minutes).
An **appointment** is one booked session: a Person, a provider, a service, a start and an end. A
**provider** is whoever gives it: a coach (a staff account) or a practitioner (stage 43's account),
shown to clients through a coach profile. **Open hours** are when a provider takes appointments. A
**free time** is a start time at which a service can be booked now. A **buffer** is the gap a
service keeps before or after itself. A **thing** is what a record **occupies** for its time: a
room, a chair, a hall. A **standing appointment** is a weekly series made by staff. Avoid "slot"
and "reservation" in the product; Programs' "session" stays Programs' word.

### Records (`packs/bookings`)

| Object | Fields | Behaviours |
| --- | --- | --- |
| `bookings.service` | title, description (public), length (minutes), buffer before and after (minutes), price (minor units; empty: not sold per session), rooms it may use (relation, many; empty: none needed), step (start times every 15, 30 or 60 minutes), booking rules when they differ from the organisation's (opens, closes, late from), who books it (members and visitors, members only, staff only), active | `public` (title, description, length, price while active and not staff only); the kind for qualifications |
| `bookings.appointment` | service, Person (the client), coach (`bookings.coach`, the provider's profile), room (set by the host from the service's rooms when not given), starts at, ends at, time zone, state, made by (self, guardian, staff, host), holder spent (host), order (host), series (empty for one-off), staff note (staff only), marked by (host) | `staffed` (`kind: service`, margins from the service, account required, open-hours check for customers, the client private); `occupies` the room; `states` with windows; `allowance` spender, paid another way; `sellable.moves` (held while paying, guest allowed); `customer: person` with guardians; agreement point `appointment` with an inline step; `recurring` target |
| `bookings.appointmentseries` | Person, coach, service, weekdays, local time, room, first date, last date, time zone, state | `recurring` generating appointments 8 weeks ahead, skipping closures; the coach as the pattern |

- **The coach profile** (`bookings.coach`) keeps its public name, photo, bio and staff account, and
  gains an optional **practitioner** field (a practitioner account). A profile holds a staff account
  or a practitioner account, never both (a contract and a write check). A practitioner's profile is
  made by a person with `practitioners:manage` and shows the practitioner's public name and
  discipline; it never teaches classes (a class's coach must hold a staff account or none).
- **Rooms** (`bookings.room`) gain **one booking at a time** (`exclusive`, default off). Only an
  exclusive room is claimed, by appointments and by classes.

### Appointment states

| From | To | By | Same batch |
| --- | --- | --- | --- |
| (new) | `booked` | customer (self, dependant), staff, host (a series date) | time and room claimed; a use spent, or marked to pay at the desk |
| (new) | `pending` | customer, public (paying per session) | time and room claimed while the order is unpaid (a 15-minute hold, capped per service and per address as drop-ins) |
| `pending` | `booked` / `expired` | host (paid / hold ended) | confirmed / released |
| (new) | `unpaid` | host (a series date with nothing to spend) | time and room claimed; staff told |
| `unpaid` | `booked` / `cancelled_by_us` | staff | spent or paid at the desk / released |
| `booked` | `cancelled` | customer until "late from"; staff any time before the start | released; use given back; money owed back through a person's approval |
| `booked` | `late_cancelled` | customer or staff, from "late from" to the start | released; use kept, no fee (decision 1) |
| `booked` | `moved` | customer before "late from"; staff before the start | the new appointment made in the batch; the use moves |
| `booked` | `attended` / `no_show` | the provider or staff; the host marks `attended` 30 minutes after the end if nobody marked | use kept (decision 1) |
| `attended` / `no_show` | the other | the provider or staff, within 7 days | a correction, audited |
| `late_cancelled` / `no_show` | `excused` | staff (a person) | use given back (decision 1: staff can give it back) |
| any live | `cancelled_by_us` | staff, the host (the provider leaves, a closure, a practitioner's care link ended) | released; use given back; refund through approval |

`staffed.live` and `occupies.live` are `pending`, `unpaid`, `booked`, `attended`, `no_show` (a coach
who waited for a no-show was still there, and pay counts it).

### How nobody is double-booked (the one rule)
- **People**: classes, duty shifts and appointments all declare `staffed`, so each live one has a
  row in `core_staff_time` keyed by its account; the triggers refuse an overlap, margins included.
  An appointment **must** have an account (`account: "required"`), staff or practitioner. A visiting
  coach with no account may still teach classes, as today, and cannot be booked for appointments.
  One person who is both a coach and a practitioner (stage 43's three hats) has two accounts and two
  sets of claims; the business keeps their hours apart (an overlap between hats is not refused:
  stage 43 keeps the hats unconnected on purpose).
- **Rooms**: an appointment or a class in an exclusive room occupies it in `core_thing_time`; the
  triggers refuse a second live occupant at an overlapping time, whatever the object.
- **The client**: one Person may not hold two live appointments that overlap. A uniqueness cannot
  express a range, so free times leave out the client's own appointments, a customer's create over
  one is refused, and staff get a warning (`client_busy`).
- **Every path**: series generation makes a clashing date uncovered (as ADR 0621 does) and tells
  rosterers; a room clash on generation makes the date with no room and tells them; an import
  checks first; a restore into a taken time is refused; a take of an offer meets the trigger.

### `occupies` (the shared piece; stage 57 uses it)

```ts
occupies: {
  thing: "room",            // a relation field (one record, or many: one claim per thing)
  starts: "startsAt",
  ends: "endsAt",
  live: ["pending", "unpaid", "booked", "attended", "no_show"],
  before?: { field: "service.bufferBefore" },  // minutes, number paths
  after?: { field: "service.bufferAfter" },
  only?: "exclusive",       // a boolean field of the thing: only those things are claimed
}
```

- **`core_thing_time`**: object, record, thing object, thing record, starts, ends (unix seconds,
  half-open); primary key (object, record, thing object, thing record); `BEFORE INSERT/UPDATE`
  triggers raising `core_thing_double_booked`, written as `core_staff_time`'s are (every statement
  shape: REPLACE, upsert, an id change). The reconciler builds the triggers on each declaring
  object's table and on the thing's table (its `only` flag changing). A refusal answers
  `conflict`, `rule: "room_taken"`, naming no other record.
- **Installing or turning on**: a claim over a future clash is refused with the clashing records
  listed to staff; past ones are skipped (ADR 0621's rule). Marking a room exclusive is refused the
  same way while two future live records overlap in it.
- **What it is not**: no capacity (one occupant at a time), no nesting (a hall that contains two
  rooms), no setup time beyond `before`/`after`. Stage 57 adds what it needs (nesting, a whole venue)
  by amending this stage's ADR, not by a second claim.

### Open hours and free times
- **`core_staff_hours`**: account (staff or practitioner), weekly rules (weekdays, local start and
  end, zone, from and until dates) or one-off ranges (extra hours on a date); optionally for some
  kinds only (a coach who does assessments only on Saturdays). A one-off "not open" is time off
  (`core_staff_away`), not a second record. In no `rec_*` view.
- **`staffing.hours.set` / `.clear` / `.list`**: by the person themselves, or a rosterer for anyone
  (decision 9); for a practitioner, by themselves or a person with `practitioners:manage`.
- **`staffing.free { object, kind, from, to, accounts? }`**: for each qualified account, the start
  times on the service's step where open hours cover the whole appointment, nobody is away, the
  claim with margins fits, an allowed room is free (the first free one, in the service's order),
  no closure covers the date (`staffed.open.closedBy`, Bookings' `closure`), and the time is inside
  "opens" and "closes". Worked in the organisation's zone by wall clock, across clock changes and
  overnight hours. Answers times and, for each, the providers free; never why a time is not free.
- **The customer's check** (`staffed.open: { customer: true, step, closedBy }`): a create or move
  by a customer or the public must be on a time `staffing.free` would answer, checked in the batch
  that writes it (the trigger still decides the race). Staff are answered `outside_hours` as a
  warning beside `unavailable`, `not_qualified` and `client_busy`.

### Practitioners as providers (decision 11)
- **Needs stage 43 steps 3 and 4** (the principal, the account, the care link). Until then the
  Bookings side is built and practitioner profiles cannot be made.
- **Consent first** (stage 43 decision 7). A client books a practitioner's service online only
  with a live care link to that practitioner, or by agreeing to one in the same flow: the booking
  page shows stage 43's consent (the `care` document, stage 44) inline, and the link becomes live in
  the batch that books. This adds a **client-started** request to stage 43, with the same consent
  text and record (stage 43's ADR amended). Staff booking for a client with a practitioner send the
  client the consent request; until they agree, the practitioner sees "a client (waiting for
  consent)".
- **What the practitioner sees**: `staffing.mine { from, to }`, their own claims only: time,
  service, room, state, and the client's name under a live care link. Never the order, the pass,
  whether it was paid, the staff note or the client's other bookings (stage 43 decision 8).
  `appointments.mark` lets them mark their own `attended` or `no_show`.
- **What staff see**: the appointment like any other (the business runs the room and the booking).
  It is the business's record, not practitioner work: no notes, nothing clinical. Its service title
  is the business's ("Physiotherapy consultation").
- **Money**: a practitioner's service has a price or none, as the business chooses per service: a
  price is the business's sale; none means the client pays the practice outside the host. No pay
  lines, time entries (stage 58) or staff feed for a practitioner's claims.
- **Ending**: a care link ended by the client cancels their future appointments with that
  practitioner (`cancelled_by_us`, use given back); `practitioner.end` does the same for all of
  theirs and tells staff.

### Operations and tools

All appointment writes are record operations with the declared states (customers through their
seam) or Bookings tools over tool-only host operations, as stage 45 does.

| Name | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `staffing.hours.set`, `.clear`, `.list` (host, tool-only) | staff, practitioner (own) | the person; a rosterer; `practitioners:manage` for practitioners | write |
| `staffing.free` (host, tool-only) | through the pack's tool | anyone reading the services | read |
| `staffing.mine` (host) | staff, **practitioner** (opened, reviewed) | their own claims | read |
| `appointments.mark` (host) | **practitioner** (opened, reviewed) | their own appointments | write |
| `x.bookings.freeTimes { serviceId, from, to, coachId? }` | **public, customer, staff** (opened, reviewed) | anyone; rate limited per address; 31 days at most | read |
| `x.bookings.bookAppointment { serviceId, startsAt, coachId?, personId?, holderId? }` | **customer** (self or a live dependant), staff | members; staff with `bookings:desk` or `bookings:appointments` | write |
| `x.bookings.buyAppointment` (held, order) | **public, customer** (opened, reviewed) | visitors and members, when the service has a price | write (an order; a card is charged only by the payer at checkout) |
| `x.bookings.moveAppointment`, `cancelAppointment` | customer (own, dependant's), staff | inside the windows | write |
| `x.bookings.markAppointment` (attended, no-show, excused) | staff | the coach of it; staff; excused by a person | write |
| `x.bookings.reassignAppointment { id, coachId }` | staff | `bookings:appointments` | write; the client is emailed (decision 7) |
| `x.bookings.standing.*` (make, change, end a series) | staff | `bookings:appointments` | write; ending one with future bookings is destructive |
| `x.bookings.coachDay { date, coachId? }` | staff | the coach (own), staff | read |
| services: `record.*` on `bookings.service` | staff | those who may write Bookings' records (admins and members; not the coach role) | write |

`bookings:appointments` is a new pack permission, held by admins and members, grantable to a coach
(ADR 0600). The coach role reads and marks **its own** appointments on any date, never another
coach's (the platform amendment above).

### Settings (organisation, overridden per service)
Opens (how far ahead: 28 days), closes (minimum notice: 12 hours), late from (24 hours, decision
4), hold while paying (15 minutes), reminder (24 hours before), whether clients may pick "any
coach" (on, decision 8). Changing booking rules is a person's act (`actors: ["human"]`).

### Screens
- **Staff (declared pack screens, stage 47)**: *Coaches' day* (columns per provider: classes,
  duties and appointments; open hours shaded; time off shown to rosterers only); *Book for a client*
  (a Person, a service, a coach or anyone, a free time, or any time with its warnings); *Standing
  appointments*; *My open hours* (and a rosterer's view of everyone's); *Services* (record pages);
  a Person tab with their appointments.
- **Customer web (blocks)**: pick a service, a coach or "anyone", a day; free times; book with a
  pass, or pay; the agreement step inline (and a practitioner's consent); **My account's
  Appointments section** (stage 48's `portal` declaration: `has: ["bookings.appointment"]`), with
  move and cancel, a parent's view of a child's included. A held appointment not yet paid appears
  under stage 48's existing `finish_paying` attention kind; a pass used up is `pass_used_up`. No
  new attention kind.
- **Native (blocks, same hooks)**: the same booking flow for members (paying per session on the
  website, as drop-ins, #237); the coach's own day and next 14 days with marking.
- **Practitioners (web, stage 43 step 7's pages)**: my day, my open hours.
- Web and native share hooks and client calls, not screens.

### Notifications
Declared routine mail (ADR 0590), each kind an admin's to turn off: confirmation with a calendar
file (ADR 0571), reminder before, moved, reassigned to another coach, cancelled by the business, a
standing series made or changed, a refund owed. Staff notices: a client booked or cancelled with a
provider (to that provider), a series date left unpaid, uncovered or without a room (to rosterers),
a provider leaving with appointments ahead. SMS and push wait for stage 30 (Notifications), which
also owns consent to be contacted.

### What an AI may do

| Action | How |
| --- | --- |
| Read services, free times, a coach's day (the reader's own reach) | applied |
| Book, move, reassign or cancel for a client as staff | waits for a person under Balanced (writes on a customer's record and a spend) |
| Set or change someone's open hours | waits for a person |
| Make a standing series; cancel the business's appointments; excuse a use; refund | a person approves; refunds always a person |
| Change booking rules; open an operation to customers; make a practitioner profile | never (human only) |
| A member's own AI client | the customer tools only, applied or refused, never queued |

### Privacy and erase
- Clients see only free times, the provider's public name and photo, and their own (and
  dependants') appointments. No one outside sees why a time is not free.
- Open hours and time off are core tables in no `rec_*` view. The free-times read leaks only "not
  free" at a time, rate limited and bounded.
- The roster and the calendar feed show an appointment as its service, never the client's name, to
  anyone but its provider and rosterers; a feed is a bearer link, so it carries no client names at
  all.
- The staff note is staff only, never in the client's or a practitioner's reads; there is no
  free-text field from the client (health questions belong to stage 44's agreement point).
- **Erase** of a Person: their appointments' Person is replaced as bookings' are (kept for pay and
  the business's books: for the business to confirm with its accountant); a standing series ends.
  **Merge** moves appointments. **Leaving** (`user.deactivate`, `practitioner.end`): future
  appointments become uncovered (a coach) or cancelled by the business (a practitioner) and
  rosterers are told; open hours are removed.
- Audited: every appointment write, open-hours change, mark, excuse and refund.

### Pay and time
A coach's appointment is a rostered shift for pay periods (ADR 0627) like a class: counted while
live, with the appointment's mark as its evidence. Recorded hours are stage 58's time entries
(Timesheets and leave): hourly pay comes from approved recorded hours, and a shift with nothing
recorded counts its rostered time and is flagged, as stage 58 says. This stage writes no time
entries. A practitioner's appointments are never counted.

## Out of scope (deferred)
- Several services in one visit, a processing gap in the middle, two providers on one appointment.
- Deposits, late-cancel and no-show fees (#213), price adjustments (stage 34 applies when built).
- A membership that includes sessions, set up as a product (possible later with no platform change).
- Arrival windows, travel routing, the client's address as the place; group appointments (a class
  is that).
- Clients making their own standing series; a waitlist for a full day; offers and takes of
  appointments.
- Two-way sync with someone's own calendar (the feed is one way); hours read from a calendar app.
- SMS and push reminders (stage 30); paying in the app (#237).
- Several sites with their own hours and rooms; rooms inside rooms (stage 57).

## Acceptance criteria
1. **One claim across everything**: an appointment over a class, a duty or another appointment of
   the same account is refused for every writer (a member, staff, MCP, the assistant once approved,
   an import, a series' generation, a take, a restore); of twenty concurrent bookings of one coach's
   same time exactly one commits.
2. **Buffers**: a service with 15 minutes after blocks the coach's next 15 minutes in free times and
   in the database; two classes back to back are still allowed.
3. **Rooms (`occupies`)**: two appointments needing one exclusive room at overlapping times: one is
   refused; a service with two rooms gets the free one; a class over a booked session in an
   exclusive room is refused and the reverse; a non-exclusive room is never claimed; every statement
   shape is tested on `core_thing_time`; marking a room exclusive over a future clash is refused.
4. **No account, no appointment**: an appointment with a profile holding no account is refused at
   write and by the trigger; a profile with both a staff and a practitioner account is refused.
5. **Open hours**: free times are exactly open hours minus time off, claims with margins, occupied
   rooms, closures and the client's own appointments, on the service's step, inside opens and
   closes, in the organisation's zone across a clock change and overnight; a fixture worked out by
   hand matches.
6. **The customer's check**: a customer's or visitor's create or move outside a free time is
   refused through every door (the tool, `record.create`, the typed client); staff are warned
   (`outside_hours`, `unavailable`, `not_qualified`, `client_busy`) and the write is made.
7. **Qualifications**: only qualified providers appear for a service; "anyone" books the first free
   qualified one.
8. **Paying**: a pass covering the service spends one use; a class-only pass does not pay for it; a
   visitor pays per session with the time held while paying and released on expiry; staff mark it
   paid at the desk; an in-time cancel gives the use back or owes the money back through a person's
   approval.
9. **Late cancel and no-show (decision 1)**: from 24 hours before (or the service's own setting) a
   cancel is `late_cancelled` and keeps the use; a no-show keeps it; no fee is ever charged; staff
   excusing either gives the use back.
10. **Move and reassign**: a member moves to another free time before "late from" in one batch, the
    use moving with it; after it, they cannot. Staff reassign to another qualified free coach and
    the client is emailed.
11. **Standing**: staff make a weekly series; dates are generated 8 weeks ahead, skipping closures;
    a date that would clash is made uncovered (or without a room) and rosterers are told; a date
    with nothing to spend is `unpaid` and staff are told.
12. **Privacy**: a team member's roster and every calendar feed show appointments without the
    client's name; a coach with the coach role reads their own appointments next week and nobody
    else's; open hours and time off appear in no `rec_*` view.
13. **Practitioners**: a client books a practitioner's service only with a live care link or by
    agreeing in the same flow; the practitioner's `staffing.mine` shows their own appointments, the
    client's name only under a live link, never payment or the staff note; ending the link cancels
    future appointments with that practitioner; their claims make no pay line and no feed entry.
14. **Guardians**: a parent books, moves and cancels for a live dependant with the child's pass, and
    sees it in My account's Appointments section.
15. **Messages**: confirmation with a calendar file, the reminder, moved, reassigned and
    cancelled-by-us emails are sent as routine mail and can be turned off per kind.
16. **Leaving and erase**: a deactivated coach's future appointments become uncovered and rosterers
    are told; an erased Person's appointments keep no personal data.
17. `pnpm lint typecheck test`, `cos ext check` and `cos ext test` on `packs/bookings` and
    `packs/memberships`; one e2e test per journey (a member books with a pass and cancels late; a
    visitor pays for a session; staff book a standing session; the coach's day; a client books a
    practitioner with consent inline); the ADRs below; `CONTEXT.md` (Service, Appointment, Provider,
    Open hours, Free time, Buffer, Thing and `occupies`, Standing appointment) and
    `docs/architecture.md` updated; the site and `SITE.md` checked.

## Dependencies
- **Built**: 31a (all but step 10), 32's allowance and Memberships, 44 (agreement points and
  enforcement), 45 steps 1 to 7 and 4b, routine mail.
- **Stage 47** (pack screens): the staff screens are declared there; if it has not merged when step
  6 is built, the screens wait for it (the blocks work on the development page meanwhile).
- **Stage 48** (My account, PR #311): the Appointments section uses its `portal` declaration; if it
  is not built, the "my appointments" block ships standalone and becomes the section when 48 lands.
- **Stage 43** steps 3 and 4 (the practitioner principal and the care link) before step 7 here.
  Stage 44's `care` document for the inline consent, as stage 43 already plans.
- **Stage 34**: per-session prices go through `priceLines` when it is built; the desk payment is a
  spender paid another way (ADR 0506), not stage 34's shared "order paid another way" (ADR 0694),
  which this stage does not need.
- **Stage 58** (Timesheets and leave) owns time entries; **stage 30** owns SMS, push and consent to
  be contacted; **stage 57** (Events and venue hire) uses `occupies` from step 2.
- **Stage 33** (the move): `cos bookings import` (31a step 10, not built) gains appointments ahead,
  step 10 here.

## Migrations and numbers
Block **BK**: migrations **1090–1109**, ADRs **0760–0769**. Expected migrations: 1090 `core_thing_time`
and its triggers; 1091 `core_staff_hours`; 1092 if the claim margins need a stored column (the
build decides; none touches `core_write_guard` or an `x_*` table). ADRs the build will need (not
written until built):
1. **0760** Claim margins and a required account on `staffed` (amends 0621).
2. **0761** `occupies`: the claim on a thing, exclusive things, install over clashes (the piece stage
   57 reuses).
3. **0762** Open hours and free times: the table, who sets them, the computation, the bounds.
4. **0763** The customer's check on a free time; staff warnings (amends 0503, 0622).
5. **0764** A customer's own move (amends 0551) and the coach role's own shifts beyond today
   (amends 0553); the client kept off the roster and the feed (amends 0626, 0628).
6. **0765** Appointments in the Bookings pack: services, states, paying, late cancel and no-show
   with no fee, reassigning, standing series (amends 0504).
7. **0766** A practitioner as a provider: the claim, hours and marks keyed by a practitioner account,
   consent before booking, no pay (amends stage 43's principal and care-link ADRs when written).

**As built (2026-11-24):** step 3 (open hours) used migration 1090 and ADR 0762 as listed. Step 2
was given migrations from 1095 and ADRs from 0765 for parallel work: it used migration **1095**
(`core_thing_time`) and ADR **0765** (`occupies`, listed above as 0761). So the ADR listed above as
0765 (appointments in the Bookings pack) takes the lowest free number when step 5 builds it.
Step 4 (free times and the customer's check) used migration **1092** (`core_client_guard`) and
ADR **0763**, and amended 0762.

## Suggested build order

Day one for a gym is steps 1 to 6 (its own coaches), then 7 (outside practitioners).

| Step | What | Touches | Beside / collides |
| --- | --- | --- | --- |
| 1 | **Claim margins and `account: "required"`** on `staffed`; the client kept off roster and feed (`staffed.private`) | `packages/sdk/src/staffed.ts`, `packages/core/src/staffing/` (`week.ts`, `feed.ts`), the reconciler's trigger builder | Beside 2 and 3. **Collides** with any stage 45 follow-up or stage 58 work in `staffing/`, and with 2 in the reconciler's trigger code (agree who lands first) |
| 2 | **`occupies` and `core_thing_time`**; `bookings.room.exclusive`; classes occupy their room | `packages/sdk` (new `occupies.ts`), the reconciler, migration 1090, `packs/bookings/index.ts` (room and class only) | Beside 1 and 3. Collides with anyone editing the reconciler's triggers; stage 57 waits for it |
| 3 | **Open hours**: `core_staff_hours`, `staffing.hours.*` | migration 1091, `packages/core/src/staffing/` (new `hours.ts`) | Beside 1 and 2; Rostering screen work |
| 4 | **Free times and the customer's check** | `staffing/` (new `free.ts`), `packages/core/src/records/states.ts` (create and move checks) | After 1 and 3. **Collides** with anything in the transition engine's create checks (stage 44 follow-ups, 31a step 10) |
| 5 | **The pack spine, staff-booked**: services, appointments, states, passes paying, desk payment, late cancel and no-show, excuse, reassign, the coach's day; Memberships' services | `packs/bookings`, `packs/memberships` | Beside 3 and 4 (after 1 and 2). **Collides** with 31a step 10 and any Memberships pack work |
| 6 | **Members book online**: freeTimes, book, move, cancel (web and native blocks); the coach role's own reach; confirmation and reminder mail; staff screens; the My account section | `packs/bookings` tools, blocks, `routine-mail.ts`; `pack-role-today.ts`, `pack-roles.ts` | After 4 and 5. **Collides** with `pack-roles.ts` work, stage 48 step 7 (Bookings blocks), stage 47 if still open |
| 7 | **Outside practitioners as providers**: the profile's practitioner field, the claim keyed by a practitioner account, hours, consent inline, `staffing.mine`, `appointments.mark`, no pay | `packages/sdk/src/staffed.ts`, `staffing/` (`pay.ts`, `feed.ts`), `open-operations.json`, `packs/bookings`, stage 43's practitioner pages | After 5, and after stage 43 steps 3 and 4. **Collides** with stage 43 steps 4 to 7 (agree the care-link change) |
| 8 | **Visitors pay per session** (held, order, guest, hold caps, refunds owed) | `packs/bookings` (`tools.ts`, the drop-in's buy path), `orders/` read only | After 6; beside 7 and 9. Collides with stage 34 step 1 if it changes `priceLines`' signature |
| 9 | **Standing appointments** (`recurring`, the `unpaid` date, rooms on generation) | `packs/bookings`, maybe `packages/core/src/recurring/` | After 5; beside 7 and 8 |
| 10 | **Dashboards, views, the rest of the mail kinds**; appointments in `cos bookings import` once 31a step 10 exists | `packs/bookings` (`dashboards.ts`, `automations.ts`, import), `packages/create-composable-os` | After 6; the import after 31a step 10 |

**Size: large.** Up to three build sessions at once: steps 1, 2 and 3 in parallel; then 4 and 5;
then 6 with 9; then 7 and 8.

## Decided by this spec, open to override
1. Appointments live in the **Bookings pack**, not a pack of their own.
2. A provider must have an account (staff or practitioner) to be booked for appointments.
3. Who gives a service is a **qualification**, not a list on the service.
4. The buffer enters the claim; classes keep none.
5. Free times are computed at read time; there are no slot records.
6. Customers must book on a free time; staff may book outside open hours with warnings, never over
   a clash.
7. Only rooms marked "one booking at a time" are claimed; the gym floor is not.
8. Defaults: book up to 28 days ahead, at least 12 hours before, late from 24 hours, a reminder 24
   hours before, a 15-minute hold while paying, start times every 30 minutes, generation 8 weeks
   ahead (as stage 45).
9. An unmarked appointment is marked `attended` by the host 30 minutes after its end (the
   conventional default for one-to-one sessions); the provider or staff correct it within 7 days.
   Either way the use is kept (decision 1), so the default changes only reporting.
10. The calendar feed and the team roster never show a client's name.
11. No free-text note from the client; one site, one zone.
12. A client books a practitioner only under a live care link or by agreeing in the same flow; a
    practitioner sees a client's name only under a live link.
13. A practitioner's service is priced or not, per service, as the business chooses; practitioner
    claims never count for pay.
14. A care link ended, or a practitioner ended, cancels their future appointments and gives uses
    back.
15. One person as a coach and a practitioner has two accounts whose claims do not refuse each other
    (stage 43 keeps the hats apart); the business keeps their hours apart.

## Questions for the owner
None open. Decision 1 was the owner's; the rest were decided as best practice (above).

## To confirm with the business during setup
Not design, only settings and records (decision 10): its services, lengths and prices; each coach's
and practitioner's open hours; which rooms are "one booking at a time"; how far ahead and how late
clients may book; which passes cover which services.

## Risks
- **Security**: two operations open to the public (free times, paying per session) and two to
  practitioners. Free times reveal when providers are busy: rate limit per address, bound the range.
  Unpaid holds could fill a coach's day: a hold cap per service and per address, as drop-ins have.
- **Privacy**: an appointment titled with a client's name would leak to every team member and any
  calendar app; the redaction is a must-pass test (criterion 12). A practitioner's view of an
  appointment is health-adjacent: it follows stage 43's consent rule (criterion 13).
- **Money**: refunds only through a person's approval; no card charged on its own; per-session
  payment run against the fake provider until the payment provider's test mode is tried.
- **Races**: correctness rests on the database triggers; every statement shape must be tested on
  both claim tables, as ADR 0621 did.
- **Time**: open hours across a clock change and overnight; a fixture per case.
- **Needs real things**: phones for the native flow; the payment provider in test mode; a real
  week of coaches' hours and services to check that free times look right.
