# ADR 0504: The Bookings pack (its spine)

Status: accepted, 2026-11-22 (stage 31a, build step 3). Composes ADRs
[0500](0500-recurring-a-weekly-rule-in-local-time.md) to
[0503](0503-time-windows-and-staff-only-on-the-transition-engine.md),
[0493](0493-the-allowance-behaviour.md) and [0494](0494-which-holder-pays-and-what-happens-to-uses.md);
the platform pieces it needed are ADRs [0505](0505-window-numbers-through-two-relations-and-settings.md)
and [0506](0506-a-spender-paid-another-way.md). Spec: [stage 31](../stages/31-bookings.md).

## Context
A gym runs its timetable and its members' bookings from the host. Steps 1 and 2 built the
behaviours (the weekly series, claimants, declared uniqueness, windows and staff-only rules, the
requested cancel), and stage 32b built the allowance. Step 3 is the pack that composes them: a
timetable that makes classes, a booking that holds a place inside its windows, and a cancel that
gives a use back only when it is in time. The Memberships pack (32b steps 6 to 8), whose plans and
passes pay for bookings, is built in a parallel session; step 4 connects the two.

## Decision

### The pack (`packs/bookings`, `@composable-os/pack-bookings`), requiring Programs
- **Class types are Programs'** (`programs.classtype`, spec 31): Bookings adds its fields to it
  (colour, opens days before, closes, late from and promotion stops in minutes before, the
  reminder, staff book only). Each left empty is the organisation's **setting** of the same name
  (`opensDays` 7, at most 56, the timetable's default horizon; `closesMinutes` 0; `lateMinutes`
  60; `promotionMinutes` 120; `reminderMinutes` 180; the owner decided 60 and 120, the rest are
  the spec's defaults and the company's to change). `requires: ["programs"]`, as Courses does.
- **Objects**: `room` (name, places as a guide, notes; public name), `coach` (name, photo, bio,
  the staff account, active; public name, photo, bio), `series` (`recurring`, generating
  `class`: weekdays, an `HH:MM` local time, a length, places, first and last date, zone, room,
  coach, class type; `horizonAtLeast` on the class type's `opensDays`; `closures` from
  `closure`; ended by staff), `class` (its series, class type, start and end, zone, room, coach,
  places, notes for members, `scheduled`/`cancelled`/`done`, `changed`; `capacity` shown exactly;
  public while scheduled, and to a booking's member whatever its state), `closure`, and
  `booking`.
- **The booking**: its class and Person; `states` with every state the spec names, so later
  steps need no breaking change (`booked`, `pending`, `waiting`, `left`, `cancelled`,
  `late_cancelled`, `attended`, `no_show`, `cancelled_by_us`, `moved`, `expired`); `claims` (held
  while `pending`, taken while `booked`, `attended`, `no_show`) declared whole now, since the
  reconciler refuses changing a claims declaration under live records (ADR 0501); one live
  booking per Person per class (`unique`, the five states that hold or wait for a place); the
  windows (create from "opens" until "closes"; `cancelled` by a customer until "late from";
  `late_cancelled` from it until the start; nothing after) and staff-only (the class type's flag,
  or a class not scheduled); the requested `cancel`; and the **allowance spender** below.
- **Nothing reachable by a customer lands in a later step's state.** `waiting` and `pending` are
  creatable by the host only (`create.in`); `attended`, `no_show`, `moved` and `cancelled_by_us`
  have no customer move. Staff may already mark attended and no-show (their moves are declared);
  no behaviour follows them yet. A class is cancelled by the host only (a closure or a series
  ended, each confirmed by a person, ADR 0500): staff cancelling a class, with its bookings in the
  batch, is step 7's cascade, so it is not offered before the cascade exists.
- **The spender, for step 4**: `spendIn: ["booked"]`, `returnIn: ["cancelled",
  "cancelled_by_us", "moved"]`, `at: "class.startsAt"`, `copy: { classType: "class.classType" }`,
  `local: { weekday, minute, zone: "class.timezone" }`, `movedFrom: { field: "movedFrom", state:
  "moved" }`, `paidBy: ["memberships.membership", "memberships.pass"]` (the object ids spec 32
  gives), and `waived: "paidOtherwise"` (ADR 0506). Step 4 installs the real holders; nothing in
  the booking changes.
- **ADR 0493's warning is met**: a customer's move into a return state is `cancelled` only, and
  only until the class type's late-cancel time before the start; `late_cancelled` keeps the use;
  after the start a customer can make neither (both windows have ended), so a cancel after the
  class never returns a use. Staff are not bound (a person on the staff may cancel late and give
  the use back; the assistant asking for `cancel` is resolved by the clock, ADR 0503).

### Tools (`x.bookings.*`)
Open to customers or the public (each a reviewed opening, ADR 0402; `open-operations.json`):
- `timetable` and `classGet` (customer, public; `read`): scheduled classes through `public.list`
  and `public.get`, places through `capacity.get` (shown exactly), coach and room names. Never
  who is booked (decision 13).
- `book` (customer; `write`): `my.create` of the member's own booking, naming a holder or not;
  answers booked, or the host's refusal in words (not open yet with when it opens, closed, booked
  by the gym, nothing to pay with, already booked, full).
- `cancel` (customer; `write`): first the host's dry run (`state.resolve`, below), then
  `my.update { from: "booked" }` into the state the member was told (`expect`), so a cancel that
  became late meanwhile is refused rather than keeping a use the member was told they would get
  back.
- `mine` (customer; `read`): their own bookings (`my.list`) and their classes (`customerVia`).
Staff only: `bookFor` (any person, a walk-in made on the spot, `paidAtDesk`), `cancelFor` (gives
the use back, or keeps it), `day` (one local date's classes with places, booked and held, and the
class type's staff-only flag), `classList` (a class's bookings with names).

### A core operation: `state.resolve`
The dry run ADR 0503 described ("`resolveStateRequest` is the dry run a pack's tool shows") had no
operation a tool could call. `state.resolve { object, id, request }` (`read`; staff and customer;
tool-only; `hostInternal`, not on MCP) answers the state a request would enter now, by the same
code the write runs, reading the record and what its windows name as the host does; a customer
asks only of their own record (another's is not found). A reviewed opening to customers.

### Blocks and hooks
`@composable-os/pack-bookings/client`: hooks over the typed client (ADR 0453) and display helpers
(a class's time in its zone, the places label, a refusal's words). Web: `bookings-timetable`
(book and cancel, with the host's preview) and `bookings-desk` (staff: the day, a walk-in).
Native: `bookings-native-timetable`, `noPurchase` (decision 9: book and cancel with what the
member holds; buying is the website's). Web and native share the hooks, not screens. No block
works out a window, a place or a price (the block lint).

## Consequences
- `@composable-os/pack-bookings` is a new npm package: it must be published once by hand, and its
  trusted publisher added, before the first release that carries it (`docs/deploying.md`,
  "Publishing to npm"), or that release's `npm` job fails on it.
- A product that lists Bookings lists Programs.
- Until step 4, a booking is paid only by a holder of an extension `paidBy` names; with no
  Memberships pack installed, a member has nothing to spend and is told so, and staff book walk-ins
  paid at the desk. The pack's tests prove the spend with a fixture holder whose object id is
  `memberships.pass` (`apps/runner/test/bookings.test.ts`, and the e2e spec).
- The timetable cannot show "booked by the gym" or "opens Tuesday" before a member tries: the
  public does not read Bookings' fields on Programs' class type, and a class carries no copy of
  them. `book` answers with both, from the host. Showing them up front (the class's own computed
  moments, as the spec sketched) is left to step 9's blocks.
- The organisation's "opens" setting is at most 56 days (the default horizon), so a class always
  exists when its booking opens; a class type that opens further ahead raises the horizon itself
  (`horizonAtLeast`).

## Proof
- `packs/bookings/test/bookings.test.ts` (the SDK's test host, 14 tests): the contract; every
  declaration above; every tool's calls and how it words the host's refusals.
- `apps/runner/test/bookings.test.ts` (the real host and sandbox, 10 tests): refused before
  Programs; a series in Sydney across the clocks going back, titled after its class type, with
  the horizon past 56 days for a type that opens 70 days ahead; a member books with a fixture
  pass (a use spent, the class type and local minute copied), once per class; the public reads
  places left and no names; cancels in time (use back), late by the class type's own rule (kept;
  asking for "in time" refused), and after the start (refused; nothing back); the organisation's
  setting where the class type has none, and changed; not open, closed (the class type's own),
  staff only, no pass, a pass for other class types; 6 members at once for 2 places; a cancelled
  class refused to a member who still reads it; a walk-in into a staff-only class paid at the
  desk, its mark unchangeable, and one with nothing to spend refused; a member reads and cancels
  only their own.
- `packages/core/test/bookings-platform.test.ts` (5 tests): ADRs 0505 and 0506 on a fixture.
- `apps/app/e2e/bookings.spec.ts`: a member books from the timetable block and cancels in time;
  staff book a walk-in into a staff-only class from the desk block.
- `scripts/check-blocks.test.mjs`: every native bookings block is `noPurchase`.

## Amended 2026-11-22, after the independent review (before merge; ADR 0507)
- **A class the host cancels cancels its bookings** in the same batch (`states.follows`): booked,
  waiting and held bookings move to `cancelled_by_us`, places released and uses given back, for a
  closure, a series changed, ended or trashed. The confirm count counts them. This replaces "staff
  cancelling a class waits for step 7": step 7 adds only the staff move and its emails.
- **A class that is not scheduled binds staff too** (`create.closed`); the desk lists only
  scheduled classes. Staff are still not bound by the windows or staff-only.
- **A member's class and holder are set at create only** (`customer.createOnly`), and a member
  never creates a booking in any state but `booked`.
- **Every class has a zone** (required, the organisation's when empty) and **its places** (required:
  a one-off is never unlimited by leaving them out). The timetable's horizon is 57 days, so a class
  56 days out (the organisation's "opens" at most) exists when it opens.
- **A trashed class type closes its classes to members** (its rules cannot be read).
- **`cancelFor` asks the host to cancel**, decided by its clock (a tool's calls are never a
  person's); `keepUse` cancels late. The in-time cancel's window binds staff too (`bindsStaff`).
  **`returnUse`** gives a use back whatever the time, with a reason, into `excused`: a move only
  that tool makes (`tools`, ADR 0513), the tool `humanOnly` with the permission
  `bookings:returns`.
- **Walk-ins** are made with their booking in one batch (`person.createWith`), after the duplicate
  check: someone with that email, or a possible duplicate, is answered with who (`findPeople`, new,
  looks people up first); the desk lets staff pick someone on file and shows refusals.
- **The booking rules are a person's** (`personApproves` on the class type's rule fields and the
  settings): changed by the assistant, MCP, an automation or extension code, they wait for one.
- **Permissions**: no `record.*`, `my.*` or `state.resolve` in `permissions.operations` (they are
  granted by object); `duplicate.check` is listed.
- **The fixture holder** is `bkfixture.pass` (not the Memberships pack's id); the tests and local
  dev use a variant of the pack whose `paidBy` also names it, and the shipped `paidBy` is unchanged.

## Note (2026-11-22, stage 31a steps 4 and 5)
The booking declares its waitlist ([ADR 0520](0520-a-waitlist-on-a-claimant.md)): a member or
staff create a booking `waiting` on a full class before the class type's "waitlist stops" time;
the host promotes and passes over (`promotedAt`, `passedOverAt`, `passedOverReason`). `book` joins
the waitlist when the class is full unless asked not to (`waitlist: false`), also for a member
whose booking was refused for want of a use (joining spends nothing; they are passed over at
promotion if they still cannot pay); `leaveWaitlist` is a new customer tool; `mine` and
`classList` show the waitlist. The shipped packs' spend is proved together (ADR 0493's note).

## Note (2026-11-23, stage 31a step 7)
Attendance, the coach role, moving people and cancelling a class:
[ADR 0553](0553-attendance-the-coach-role-moves-and-cancelling-a-class.md).

## Note (2026-11-23, stage 31a step 6)
The booking opens to guardians ([ADR 0540](0540-the-family-link.md)): `customer.guardians:
{ write: true, madeBy: "madeBy" }`, and `person` joins `customer.read`. `book` takes `forPersonId`
(a child linked to the member), `mine` a `personId` (their own by default), and `family` (new, a
customer read over `me.family`) lists who they may book for; `permissions.operations` lists
`me.family`. A child's booking spends the child's holder only. The web and native timetables show
a "Booking for" choice when the member has a child linked.

## Note (2026-11-23, stage 31a step 8)
The booking declares `sellable.moves` ([ADR 0560](0560-a-paid-line-moves-a-record-that-exists.md)):
a drop-in is made `pending` with its order by the host through `buy` (customers and the public),
priced by the class type's `dropInPrice`, else the organisation's (both a person's to change),
booked when the payment is verified, released when the order expires; a paid one cancelled in
time, given back or cancelled by the gym owes its money back, which a person approves.
`paidOtherwise` is now labelled "Paid another way" (a desk payment or a drop-in).
