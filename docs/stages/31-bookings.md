# Stage 31: Recurring schedules and Bookings

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Behaviours, Orders, Packs and blocks), [`CONTEXT.md`](../../CONTEXT.md), ADRs
[0404](../adr/0404-behaviours-are-the-vocabulary.md),
[0425](../adr/0425-one-transition-engine-for-stages-and-states.md),
[0430](../adr/0430-capacity-is-refused-by-the-database.md) to
[0433](../adr/0433-what-outsiders-are-told-about-places.md),
[0435](../adr/0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md) to
[0437](../adr/0437-a-move-is-made-from-a-current-read.md),
[0460](../adr/0460-time-zones-on-records.md) and
[0487](../adr/0487-the-payer-and-the-holder.md); stages [26](26-capacity-and-holds.md),
[27](27-ticketing-and-ghetto.md), [41](41-programs.md) and [32](32-memberships.md) (all of 32b,
and its interview's answers); `packages/core/src/capacity/`, `packages/core/src/orders/`,
`packages/core/src/records/states.ts`, `packages/core/src/visibility/`, `packs/ticketing`,
`packs/programs`, `apps/runner/src/automations/schedule.ts`, `scripts/check-blocks.mjs`.

Status: **spec agreed** (interview 2026-11-22: questions 1 to 16 answered; the proposal merged as
PR #231). Split in two: **31a**, the timetable and class bookings, first; **31b**, appointments
booked by staff, second. Stage 32b (allowances, Memberships, passes) is agreed and waits for this
stage; the two are built side by side, and 32b takes on what this spec lists for it (also recorded
in stage 32's spec). Where this spec still guesses, it says **(guess)**; the build confirms or
corrects each one.

## Goal

A gym or studio runs its classes from the host. Staff set a weekly timetable once; the host makes
each week's classes from it, with their coach, room and places. Members see the timetable on the
gym's site and in its app, book a class with their membership or pass, cancel it, join a waitlist
when it is full and are moved in automatically when a place frees. Parents book their children
into kids' classes. A visitor pays for a single class on the website at booking. Coaches see the
day's classes and who is coming, tick who came, and swap a class to another coach. The gym's rules
hold for everyone: how far ahead each class type may be booked, when booking closes, which class
types only staff book, and when a cancel is late and keeps the class it used. Staff cancel a class
and everyone booked is told and given their class back, and drop-in payers their money. Later in
the stage, staff book one-to-one appointments (personal training) for members.

With stage 32b's memberships and passes, and stage 33's move, this replaces the gym's current
booking system.

## Decided at the interview (2026-11-22)

Every question was answered; the questions are kept at the end with their decision. What was left
out is an issue each.

| Question | Decision |
| --- | --- |
| 1. One-to-one sessions | Staff book them for members today. Classes first (31a), appointments second (31b), **booked by staff**; members booking their own at a coach's open times is left out ([#239](https://github.com/timoconnellaus/composable-os/issues/239)) |
| 2. Booking windows | They differ by class type, and **some class types are booked only by staff**. Both are settings on the class type (opens, closes, staff book only) over the organisation's defaults; the owner gave no numbers, so the defaults below are the company's to change |
| 3. Late cancel | **From 1 hour before the class**: an organisation default, overridden per class type |
| 4. Waitlist promotion | **(a)**: the first person is booked in automatically and emailed |
| 5. Promotion cut-off | **(a)**: promotion stops **2 hours before** the class (a setting). With decision 3, a place freed less than 2 hours before goes to whoever books first, and the people waiting are told |
| 6. A freed place | **(a)**: it always goes to the waitlist first (until the cut-off) |
| 7. Joining a waitlist | **(a)**: it spends nothing; the use is spent on moving into the class; someone with none left is skipped and told |
| 8. Drop-ins | **(a), with (c)**: picked and paid on the website, the place held while paying; staff can still book walk-ins |
| 9. The app | **(a)**: book, cancel and join waitlists with what the member already holds; buying is on the website (paying for a drop-in in the app left out, [#237](https://github.com/timoconnellaus/composable-os/issues/237)) |
| 10. Attendance | **(a)**: the coach ticks names on the class list. Scanning a member's code at a desk is left out ([#236](https://github.com/timoconnellaus/composable-os/issues/236)) |
| 11. No-shows | **(a)**: recorded, and the class is used; nothing else (a booking block after repeats, [#235](https://github.com/timoconnellaus/composable-os/issues/235)) |
| 12. Standing bookings | **(a)**: none; members book each class ([#232](https://github.com/timoconnellaus/composable-os/issues/232)) |
| 13. Who sees who is booked | **(a)**: members see only how many places are left; names are for coaches and staff ([#233](https://github.com/timoconnellaus/composable-os/issues/233)) |
| 14. Booking for others | **(b)**: parents book for their children (kids' classes), **in scope**; a guest on a member's booking is left out ([#234](https://github.com/timoconnellaus/composable-os/issues/234)) |
| 15. A class the gym cancels | **(a)**: a drop-in payer gets their money back to their card, a refund approved by staff as every refund is |
| 16. Messages | **(b)**: an email on booking (with "add to calendar"), on a change or cancellation by the gym, and a reminder before each class; coach swaps are not emailed ([#238](https://github.com/timoconnellaus/composable-os/issues/238)) |

### The defaults (the company's to set)
The owner gave no numbers for question 2. Proposed defaults, each an organisation setting with an
override on a class type, changed by staff with the settings permission (a person only):

| Setting | Default | Why |
| --- | --- | --- |
| Booking opens | 7 days before the class, at the same time of day | A week ahead is the common rule, and the horizon covers it |
| Booking closes | At the class's start | A member arriving early can still book; staff can close earlier for a class type |
| Late from | 1 hour before (decided) | |
| Waitlist promotion stops | 2 hours before (decided) | |
| Reminder | 3 hours before (guess) | Sent before promotion stops, so a member who cancels on reading it frees a place the waitlist still gets |
| Staff book only | Off | Turned on for the class types the gym books by hand |

## Decided already (stage 32's interview, 2026-11-22)

Not asked again. Each constrains this stage.

| Decision | What it means here |
| --- | --- |
| The gym sells unlimited memberships, N per week or month, class packs that expire, drop-ins and a once-per-person intro offer (32's question 8, answered (c)) | A booking spends from any of them; a drop-in is paid at booking (decision 8) |
| Limits by class type and by time of day (question 8, (c)) | Class type is in 32b's `spendsOn`; the time of day needs the booking's class time, which this stage gives the allowance (below) |
| No carry-over (question 9) | A use counts in the period of the class it was spent on |
| Pauses by staff for a set time (question 10) | A paused membership spends nothing; bookings inside a pause are dealt with (below) |
| A payer and a holder may differ (question 13) | A parent pays for a child's membership; the child holds it and the child's bookings spend it (decision 14 below) |
| A late cancel or a no-show costs no money: it keeps the use (question 15) | Only an in-time cancel, and a class the gym cancels, give the use back; no fees anywhere |

## What exists today (from the code)

- **`capacity`** (stage 26; `packages/core/src/capacity/`, ADRs 0430 to 0433). Any object may
  declare `capacity: { places, pool?, show?, lowAt?, releaseOnRefund? }`. Each record gets one
  `core_capacity` row (places, held, taken), and the host adds read-only `held`, `taken` and
  `available`. A claim (`claimStatements`, three statements, no read first) is made in the owner's
  own batch, and a CHECK and triggers in migration 0440 refuse one past the places, for every
  actor, as `invalid_input` with `rule: "capacity"`. Claims are `held`, `confirmed` or
  `released`; `ClaimFor` is typed "an order line (stage 25), later a booking", but **the only
  caller of `queueClaim` today is the order's move hook** (`orders/holds.ts`). A record that is not
  paid for cannot claim places yet. The concurrency test (500 claims at once for 100 places, exactly
  100 held) is the shape every race test here follows. Stage 26 left out waitlists, "offering a
  released place to the next person", and "time slots and calendars (stage 31)".
- **Ticketing** (`packs/ticketing`) is the model of a pack that composes behaviours: an event with
  places and a `timezone` field, ticket types drawing on its places as a pool, `sellable` lines
  that grant a ticket, `states` on the ticket, the `door` pack role (ADR 0436), and a conditional
  move from a current read (ADR 0437): of two people marking the same record, one wins and the
  other is told who was first.
- **Orders and `sellable`** (stage 25, ADRs 0427 and 0435): `order.start` prices the lines and
  claims their places in the same batch; `order.checkout` opens the provider's page; only a
  verified payment pays; an unpaid order expires after 15 minutes by default (`order.expireDue` on
  the runner's minute cron) and its holds are released. A paid line grants records (`grants`).
  There is no declaration for "a paid line moves a record that already exists". Refunds go through
  approval by a person with `orders:refund`.
- **The operations registry** (`packages/core/src/operation.ts`, `gate.ts`): every operation has
  zod schemas, a model-facing description, a permission, a risk class (`read` to `outbound`),
  `actors` and `audiences` (`staff` by default; opening one to `customer` or `public` is a reviewed
  change, ADR 0402, listed in `open-operations.json`). Customer calls are applied or refused, never
  queued. Under the default `balanced` preset an assistant's `write` is applied, `destructive` and
  `outbound` go to a person. A pack tool (`defineTool`) becomes `x.<pack>.<tool>` with its own risk
  and audiences.
- **The visibility seam** (`packages/core/src/visibility/`): `customer: { field, read, write }`
  gives a customer their own records only (the field is their own Person); `signedIn` lets every
  signed-in customer read shared records (Programs' class sessions); `customerVia` reads a record
  one of your own points to; `public` reads what an object declares. A Person's name is never
  readable by another customer. **No customer can act for another Person**: there is no link
  between two People.
- **People** (`packages/core/src/fields/person.ts`): an email is not required, so a child can be a
  Person with no email and no account. `person.merge` and `person.erase` exist; merges re-point
  extension relations (stage 16), and 32a's subscriptions follow a merge (ADR 0487).
- **Programs** (`packs/programs`) already has **`programs.classtype`** (name, order; read by every
  signed-in member) and assigns a program to a class type from a start date, which makes one dated
  `programs.session` per day of the layout (a date, no time). `classToday` lists a class type's
  sessions for a date, in UTC rather than the gym's zone.
- **Time zones** (ADR 0460): a `timezone` field type (IANA names), defaulting to the organisation's
  zone (`loadGeneralSettings(db).timezone`); date-relative automations by a record's own zone. The
  wall-clock-to-instant conversion that survives a clock change exists only privately in
  `subscriptions/offers.ts` (`paidUpMoment`). Relative filter tokens (`today`, `startOfWeek`) are
  UTC. No Temporal.
- **The minute cron** is the runner's (`apps/runner`, `* * * * *`): schedules, the outbox,
  notifications, orders' expiry and subscriptions' sweep. Automation triggers are `schedule` (a
  cron, by the minute), and `dateRelative`, which counts in **whole days** only.
- **Email to customers**: the host's own messages (`sendHostEmail`, order confirmations) and a
  pack's automations through the `email-send` gatekeeper (Ticketing's tickets email and its
  day-before reminder). Hard-coded text, no templates, no SMS, no push, no preferences: stage 30
  (Notifications) is not specced.
- **The native app** signs customers in by an email code and may call write operations (Programs'
  set logging); every native block is barred from subscription billing by the block lint, and a
  block marked `noPurchase` from any purchase (`scripts/check-blocks.mjs`). The lint also refuses
  a block that calculates a price, checks a capacity or checks a permission.
- **Calendars**: no ICS anywhere; staff calendar gatekeepers (Google, Microsoft) act on staff
  calendars only.
- **Not anywhere:** a `recurring` behaviour, occurrences, waitlists, booking windows, late
  cancels, no-shows, a link between two People, a unique rule an extension can declare ("one
  booking per person per class"), and the `allowance` behaviour (32b).

## The model

### Words
A **class type** is a kind of class (CrossFit, Yoga, Kids). A **series** is one line of the
timetable: a class type every Tuesday and Thursday at 06:00 for 60 minutes, in a room, with a coach,
from a date. A **class** is one dated occurrence of a series (Tuesday 3 March, 06:00), or a one-off
class with no series. A **booking** is one Person's place in one class. A **waitlist** is the
bookings of a full class that are waiting. A **guardian** is a Person linked by staff to a
**dependant** (a child) they may book for. An **appointment** (31b) is a one-to-one booking of a
coach's time for a **service** (a 60-minute personal training session), made by staff. CONTEXT.md
already says "a class is the timetable's" and "a booking is a place in a class"; Programs'
**session** stays Programs' word (a dated workout), so this stage never calls a class a session.

### Objects (`packs/bookings`)

| Object | What | Behaviours |
| --- | --- | --- |
| `programs.classtype` (Programs', extended) | Bookings adds fields to it: a colour, the default length and places, a drop-in price, and the booking rules when they differ from the organisation's: opens, closes, late from, promotion stops, reminder, **staff book only** | (Programs': `signedIn`) |
| `bookings.room` | Name, places (the most it holds), notes | none |
| `bookings.coach` | Name, photo, short bio (public), the staff account (a `user` field, optional: a visiting coach may have none), active | `public` (name, photo, bio) |
| `bookings.series` | Class type, weekdays, local start time, length, room, coach, places, first date, last date (empty for ongoing), time zone (defaults to the organisation's), state (`active`, `ended`) | **`recurring`** (new), generating `bookings.class` |
| `bookings.class` | Its series (empty for a one-off), class type, starts at, ends at, time zone, room, coach, places, notes for members, state (`scheduled`, `cancelled`, `done`), whether it was changed from its series (host), whether attendance was taken (host), the rules' moments (host: opens, closes, late from, promotion stops), staff book only (host, from the class type) | `capacity` with a waitlist (new); `states`; `public` while scheduled; with a cascade to its bookings (new) |
| `bookings.booking` | Its class, its Person (the holder, who attends), who made it (the Person, a guardian, or staff), state, the allowance holder it spent from (host), its drop-in order (host), when it was promoted, when attendance was marked and by whom | `customer: person` with guardians (new); `states` with time windows (new); a **capacity claimant** (new); an **allowance spender** (32b); `sellable` for a drop-in with moves (new) |
| `bookings.closure` | A date range and a reason (holidays): the host cancels the classes inside it | none |

31b adds `bookings.service` (title, length, price or which allowance pays it, which coaches, a gap
after) and `bookings.appointment` (a Person, a coach, a service, starts at, ends at, state; a
time-range claim, below). A coach's working hours (`bookings.availability`, `recurring` again) are
optional in 31b: staff book, so they guide staff rather than gate members (guess).

The **family link** is a core record, not the pack's (below): who may book for whom is identity,
and the seam reads it.

**The class type is Programs'.** Programs already names it and assigns programs to it, so a class
shows "today's workout" (the Programs session of its class type for its local date) on its roster
and in the member's view. Bookings then `requires: ["programs"]`, as Courses does. The cost: a
studio with no use for programs installs the Programs pack anyway (it shows nothing until a program
is assigned). The other way, a class type of Bookings' own that Programs points to, is a breaking
change to a built pack. `classToday` moves to the class's local date.

### Booking states

| From | To | By | What happens in the same batch |
| --- | --- | --- | --- |
| (new) | `booked` | customer (themselves or a dependant), staff | a place claimed, a use spent |
| (new) | `pending` | customer, public (a drop-in), staff | a place held while the drop-in order is unpaid |
| `pending` | `booked` | host (the order paid) | the place confirmed |
| `pending` | `expired` | host (the order expired) | the place released (final) |
| (new) | `waiting` | customer, staff | nothing claimed, nothing spent; a position in the waitlist |
| `waiting` | `booked` | host (promotion) | a place taken from the waitlist's hold, a use spent |
| `waiting` | `left` | customer, staff | none (final) |
| `booked` | `cancelled` | customer, staff; a customer only before the class's "late from" moment | the place released (to the waitlist first), the use returned, a drop-in refunded through approval (guess, below) |
| `booked` | `late_cancelled` | customer, staff; from "late from" until the start | the place released (to the waitlist first, if before the cut-off), the use kept (decided) |
| `booked` | `attended` | staff (the coach ticks the name) | none |
| `booked` | `no_show` | host, after the class ends, if attendance was taken; staff | the use kept |
| `attended` ↔ `booked`, `no_show` → `attended` | | staff | corrections, audited |
| `booked`, `waiting`, `pending` | `cancelled_by_us` | host (the class cancelled, below) | the place released, the use returned, a drop-in refunded through approval (final) |
| `booked` | `moved` | staff (a move to another class, below) | the place released, the use moved with the new booking (final) |

32b's allowance declares which moves return a use: `cancelled`, `cancelled_by_us` and `moved`
(moved returns here and is spent again on the new booking in the same batch). `late_cancelled`
and `no_show` keep it.

## What is platform work and what is pack work

AGENTS.md: "a new behaviour is platform work; a pack composes behaviours and does not hook writes."
So every rule that must hold for every actor (a person, MCP, the assistant, an import) is in the
host; the pack declares it.

| Piece | Platform or pack | Why |
| --- | --- | --- |
| `recurring`: a series generates dated records, in its zone, across clock changes | **Platform** (new behaviour, ADR 0404's row) | Also Rosters (stage 40) and 31b's working hours |
| Capacity claimants: a record whose states hold, confirm and release its own claim | **Platform** (extends `capacity`) | Today only orders claim; a booking paid by an allowance has no order |
| A waitlist on a capacity, and promotion under races | **Platform** (extends `capacity`) | A freed place must go to the next waiter for every actor, without a read-then-write race |
| Time windows on creates and moves (opens, closes, late from), and "staff only" on a create | **Platform** (the transition engine, ADR 0425) | A customer, an MCP client and an import must meet the same window; a pack tool deciding "late" would be the pack hooking a write |
| One active booking per Person per class | **Platform** (a declared uniqueness among records in given states) | The reconciler has no unique rule an extension can declare |
| A parent's move moves its children (a class cancelled cancels its bookings) | **Platform** (a cascade on `states`) | Otherwise a class cancelled through `record.update` would leave its bookings booked |
| A paid line moves a record that exists (a drop-in booking held while its order is unpaid) | **Platform** (extends `sellable`) | Today a paid line can only grant new records |
| The family link: a guardian acts for a dependant | **Platform** (a core record, the seam, merge and erase) | Who may act for whom is identity; staff set it, a person only |
| The allowance spend, give-back and the class's time as the period | **Platform** (32b, amended below) | Built in 32b; this stage states what it needs |
| A time-range claim: no two appointments of one coach overlap (31b) | **Platform** (a new kind of capacity) | Places are a count; a coach's time is a range |
| `dateRelative` in hours and minutes; the "add to calendar" file | **Platform** (small) | Reminders hours before a class; the booking email's attachment |
| A wall-clock-to-instant helper, exported | **Platform** (small; `paidUpMoment`'s private one moved and shared) | Generation, closures, reminders and imports all need it |
| Objects, fields, views, the roster, tools, automations (emails), dashboards, hooks and blocks | **Pack** | Composition |

Each platform piece gets an ADR. They are listed in the build order so the spine is the smallest
set that books a real class with a real allowance.

## Scope, 31a: the timetable and class bookings

### The `recurring` behaviour (new)
- **A series declares** what it generates and from which fields:
  `recurring: { generates: "class", link: "series", rule: { weekdays, time, length, from, until,
  zone }, copy: { classType, room, coach, places }, horizonDays }`. The rule is **weekly on chosen
  weekdays** (guess: every N weeks and monthly rules are left for later; a gym's timetable is
  weekly). Not RFC 5545 RRULE.
- **The host makes the records ahead**, up to the horizon (56 days, and never less than the
  longest booking window any class type sets), as the host, each with an idempotency key of the
  series and the local date, so a repeated run makes nothing twice. The runner runs it once a day
  after midnight in the series' zone and at once when a series is created or changed.
- **Local time is the rule.** 06:00 in the series' zone is 06:00 on both sides of a clock change:
  the instant moves, the wall clock does not. A local time that does not exist on the change day
  (02:30 when clocks go forward) moves forward by the gap; one that happens twice takes the first
  (guess; the same rule `paidUpMoment` uses). Each class stores its instant and its zone.
- **Exceptions.** A class edited by staff (another coach, room, time or places) is marked as
  changed and is never overwritten by the series again. A class cancelled stays, cancelled. A
  closure cancels the classes in its range, as a class cancel does.
- **Changing a series** applies from a date to the classes not yet changed by hand: its coach,
  room and places at once, with a booked class's places never set below its taken places
  (capacity's own rule). A new time or weekday on classes that already have bookings is refused
  unless staff confirm it, and then each booker is emailed (a change by the gym, decision 16).
  **Ending a series** removes its future classes that have no bookings, and cancels the rest as a
  class cancel does, after staff confirm with the count.
- **A one-off class** is a `bookings.class` with no series.

### Places and the waitlist (extends `capacity`)
- **A booking is a claimant.** The booking object declares `capacity: { claims: { on: "class",
  held: ["pending"], confirmed: ["booked", "attended", "no_show"] } }` (guess at the shape):
  entering `booked` claims one place on its class in the booking's own batch, refused by the
  database past the places as stage 26 built; leaving those states releases it. A late cancel
  releases the place even though it keeps the use, so someone else can come.
- **The class's places** default from the series (then the class type, then the room). The room's
  places are a ceiling staff are warned about, not a pool (guess: classes in one room are at
  different times and do not share places).
- **The waitlist** is declared on the class: `capacity: { places: "places", waitlist: { from:
  "booking", until: "promotionStops" } }`. Until the cut-off, when a place is released and anyone
  is waiting, the same statement that releases it gives it to the waitlist as a hold of its own (a
  claim for the class's waitlist, made by a conditional statement, with no read), so **nobody
  booking directly can take a place the waitlist is owed** (decision 6). While a class has anyone
  waiting, a new booking by a member joins the waitlist.
- **Promotion** (decision 4) is a host step after the release, from a current read (ADR 0437): the
  first waiter by the time they joined moves `waiting` → `booked` in one batch that takes the
  waitlist's hold, spends their use and records when they were promoted; they are emailed that
  they are in. If their spend is refused (no uses left, their pass expired, their membership
  paused), they are skipped, stay waiting and are emailed why (decision 7), and the next is tried.
  If nobody can take it, the hold is released to everyone. Two promotions at once for one hold: one
  succeeds, the other finds nothing.
- **The cut-off** (decision 5): from 2 hours before the class (the class type's setting), nobody is
  promoted. A place freed after the cut-off is released to everyone, first to book gets it, and
  the people still waiting are emailed that a place is free. With the late-cancel default of 1
  hour, this covers both an in-time cancel between 2 hours and 1 hour before and a late cancel in
  the last hour. At the cut-off the waitlist's own hold, if one is unclaimed, is released the same
  way.
- **Who runs it:** the runner, on the booking's move event (stage 5's queue) and swept by the
  minute cron, so a freed place is given within about a minute (guess at the mechanism).

### Booking windows, staff-only class types and late cancels (time windows on moves)
- **The rules** (decisions 2, 3 and 5), the organisation's defaults with an override per class
  type (the table above): booking opens N days before the class (at the same time of day, or at a
  local time), closes M minutes before it starts (the default is at the start), a cancel is late
  from L minutes before it starts (60), promotion stops P minutes before (120).
- **Staff book only** (decision 2): a class type marked so is shown on the timetable with "booked
  by the gym" (guess: members see it rather than wonder where it went), and a customer's create is
  refused for its classes, for themselves, a dependant or a drop-in; staff book and waitlist
  members into it. A member may still cancel a staff-made booking under the same late rule
  (guess).
- **The host computes the class's moments** when it makes or changes the class: `opensAt`,
  `closesAt`, `lateFrom`, `promotionStops`, read only. The booking's moves name them: `booked →
  cancelled` by a customer `until: "class.lateFrom"`; `booked → late_cancelled` `from:
  "class.lateFrom", until: "class.startsAt"`; create by a customer `from: "class.opensAt", until:
  "class.closesAt"`, and only while `class.staffOnly` is false. The transition engine checks them
  against the host's clock in the write, for every outside actor. **A member's cancel asks for
  "cancel" and the host picks** `cancelled` or `late_cancelled` by the time, and says which before
  they confirm (a dry run returns it).
- **Staff are not bound by the windows** (they book a member into a closed class, or cancel late
  without keeping the use, with a reason); the assistant and MCP are bound as staff are, with the
  approval gate below.
- **Other limits** (guess): one active booking per Person per class; no two booked classes for one
  Person that overlap in time; at most N future bookings at once (a setting, empty for none).

### Spending and returning an allowance use (the 32b contract)
Stage 32b's `allowance` behaviour is agreed; this stage is its spender. What the booking declares,
and **what 32b must provide that its spec did not say** (recorded in stage 32's spec, 2026-11-22):

1. **Spend on entering a state, not only on create.** A waiting booking spends nothing (decision
   7); it spends when it becomes `booked` (on create, or by promotion). 32b's "a spend is written
   in the spender's create" becomes "in the move into a spending state" (`spendIn: ["booked"]`).
2. **The period is the class's, not the booking's.** A member with 3 a week who books next
   Tuesday's class today spends one of next week's. The spender names its time: `at:
   "class.startsAt"`; the use counts in the holder's period that contains it, and the holder must be
   live then (a pass that expires before the class cannot pay for it).
3. **Conditions read the class's time of day and class type.** The host copies onto the booking, as
   it books, the class type, the local weekday and the local minute of the day in the class's zone,
   so a holder's `spendsOn.when` can say "class type in (…)" and "starts between 09:00 and 16:00 on
   weekdays" (the off-peak limit decided at 32's question 8). Times are the gym's local time.
4. **`moved` returns and the new booking spends in the same batch**, so a move never fails for want
   of a use the member already had.
5. **Which holder:** `auto` (the holder that expires first among the booking's Person's live ones
   that match, 32b) unless the member picks one when they have several. Staff may pick any of the
   Person's. **The holder is always the booking's Person's**: a parent's booking for a child spends
   the child's membership or pass, never the parent's (32's question 13: each holder has their own,
   no shared pool).
6. **Unlimited memberships still write a use** (no limit), so attendance and "uses spent per week"
   count every class.

**Pauses** (32's question 10, by staff): a membership paused over dates with future bookings in
them: staff are shown the bookings, and the host cancels them as `cancelled_by_us`, uses returned,
each member emailed (guess; the other way is to refuse the pause until staff move them). **An
ending membership** (cancelled at the period's end) cannot pay for a class after its end (rule 2).
**A downgrade at the next period** keeps the bookings already made under the old plan (guess).

### Booking and cancelling, by members, on the web and in the app
| | Web | App |
| --- | --- | --- |
| See the timetable (classes, coach, places left as the object's `show` says) | yes, public | yes |
| Book a class with a membership or pass, join a waitlist, cancel, leave a waitlist | yes | yes (decision 9) |
| The same for a dependant (a guardian) | yes | yes |
| Pay for a single class (drop-in) | yes | no (decision 9; [#237](https://github.com/timoconnellaus/composable-os/issues/237)) |
| See their bookings (and their dependants'), waitlist position, history and uses left | yes | yes |

- **Booking with an allowance is not a purchase.** Spending a use the member already holds moves no
  money; the block lint lets a native block call `x.bookings.book`, `cancel`, `leaveWaitlist` and
  `mine`. Paying for a drop-in is a purchase and goes through `order.start` and the provider's page:
  the lint's purchase pattern gains `x.bookings.buy`, and the native booking blocks are marked
  `noPurchase`, so a member with nothing to spend is sent to the website.
- **Tools** (customer audience unless said): `timetable { from, to, classType?, coach? }` (public,
  read; places left as `show` allows, never names), `classGet` (public), `book { classId,
  holderId?, forPersonId? }` (returns `booked`, `waiting` with a position, or the reason it cannot:
  not open yet, closed, booked by the gym only, no use, already booked, a clash), `cancel {
  bookingId }` (returns `cancelled` or `late_cancelled`, with a dry run first), `leaveWaitlist`,
  `mine { from?, to?, personId? }`, `buy { classId, forPersonId?, email? }` (public; web only; a
  drop-in, below). Each is a reviewed opening of an operation to `customer` or `public` (ADR 0402).

### Parents booking for their children (decision 14)
A **family link** between two People: a guardian and a dependant. It is core (identity-adjacent:
it widens what a customer may read and do), with its own ADR.

- **The record:** `core_person_link` (guardian Person, dependant Person, kind `guardian`, who set
  it, when, ended). A dependant may have several guardians (two parents), and a guardian several
  dependants. Not an extension record, so no pack and no import can make one on its own.
- **Who sets it:** staff only, **a person only** (`person.link.add`, `person.link.end`, `actors:
  ["human"]`, a permission `people:link` grantable as `orders:refund` is; the assistant and MCP
  may not, and nothing a customer does creates one). Audited. A parent asks the desk, and staff link
  them, the way a gym signs up a child today (guess at the permission's name).
- **The child** is a Person who may have no email and no account; they never sign in unless the
  gym later gives them one (then they see their own bookings as anyone does, and the link stays).
  The child's name and date of birth are what staff hold; nothing here needs more.
- **What the guardian does:** books, cancels, joins and leaves waitlists for a linked dependant,
  under the same windows and rules as for themselves (`book { forPersonId }`; the host checks a
  live link in the write). A drop-in for a child is paid by the guardian (the order's Person) and
  is the child's booking.
- **Whose allowance:** the child's own holders only. 32b's payer and holder: the parent pays for
  the child's membership or pass, the child holds it, and the child's bookings spend it. A parent's
  own membership is never spent on a child's class (no shared pool, 32's question 13).
- **What the guardian sees:** their dependants' bookings, waitlist positions, history, and the
  uses left on the dependants' memberships and passes (32b's holders declare the same read for
  guardians). Nothing else of the child's (Programs' logs, other records) and nothing of other
  members. The seam's `customer` key gains `guardians: true` (opt in per object, with its own
  `read` and `write` lists, guess at the shape): a customer's scope on such an object is their own
  Person's records **or a live dependant's**.
- **Emails** about a dependant's booking go to whoever made it and to the guardians (the child may
  have no email), naming the child.
- **Privacy:** a link is visible to staff, to the guardian and (if they have an account) to the
  dependant; never to other members. Ending a link stops the guardian's reads and writes at once;
  bookings they made stay (staff are told).
- **A person merge** re-points links to the survivor; a link from a Person to themselves, or a
  duplicate, is dropped; staff see what changed in the merge preview. **An erase** of a dependant
  removes their links with their records, as erase does; an erase of a guardian ends their links
  and leaves the child, and staff are told the child has no guardian left.
- **Left out:** a member bringing a guest on their booking
  ([#234](https://github.com/timoconnellaus/composable-os/issues/234)); age rules (a class type for
  ages 6 to 12 is a name, not a check: guess); a guardian adding a child themselves.

### Paying for a drop-in at booking (decision 8)
- A visitor or member picks a class and pays for that class on the website. `buy` creates the
  booking in `pending`, which holds a place (a held claim, as an order's line does), and starts an
  order whose line is the booking at the class type's drop-in price (the host reads the price;
  `sellable` on the booking). A verified payment moves the booking `pending → booked` and confirms
  the place; the order expiring moves it to `expired` and releases the place. That is the new "a
  paid line moves a record that exists" declaration (`sellable.moves: { paid: "booked", expired:
  "expired" }`), on the same transition engine and holds as Ticketing.
- **Staff book walk-ins** as for anyone, and take payment however the gym does at the desk
  (outside the host, guess), or start the same order for the walk-in.
- A drop-in booking holds no allowance. A late cancel or a no-show keeps the money (decided: no
  fee, no refund). An in-time cancel by the payer is refunded through approval (guess: the same
  rule as a use given back).
- **A class the gym cancels** refunds every paid drop-in to the payer's card (decision 15), as a
  refund of the order's payment through approval by a person with `orders:refund`, as every refund
  is; the booking is `cancelled_by_us` at once, the refund follows when approved, and the payer is
  emailed that it is on its way.
- The intro offer is 32b's pass type with one per Person; it is spent by booking like any pass.

### Attendance and no-shows (decisions 10 and 11)
- **The coach ticks names** on the class's list (`markAttended { bookingId }`, and `markAll`
  for a class, staff), in the admin or in the gym's app with a coach's account; a walk-in is booked
  and ticked at once. Two coaches ticking the same name: one wins, the other is told (a conditional
  move, ADR 0437). Ticking anyone marks the class's attendance as taken.
- **A coach pack role** (`bookings.coach`, like Ticketing's `door`): read today's classes and their
  lists, tick attendance, book walk-ins and members into a class; no people beyond the lists, no
  orders, no settings. A staff account holds at most one pack role (ADR 0436): a coach who also
  scans event tickets needs a role over both packs, **checked at build**, amending ADR 0436 if pack
  roles must combine.
- **No-shows** (decision 11): after a class ends (plus 30 minutes, guess), the host moves its
  still-`booked` bookings to `no_show`, **only if attendance was taken for that class**, so a
  coach who forgot the list does not make the whole class no-shows; staff are told of classes with
  no attendance. The use is kept (decided). Nothing else follows; a booking block after repeated
  no-shows is [#235](https://github.com/timoconnellaus/composable-os/issues/235).
- **Left out:** scanning a member's code at a desk
  ([#236](https://github.com/timoconnellaus/composable-os/issues/236)); so a booking has no code.

### The staff side, from the host
- **Timetable**: series as a list and a week grid (the host's `calendar` view), with the classes a
  series made; closures; rooms; coaches; the booking rules per class type.
- **Today**: the day's classes with places, waiting and ticked; each class's **list** (its record
  page): who is booked (with a dependant's guardian), waiting (in order), cancelled late, attended,
  with each member's uses left and a note if this is their first class; "today's workout" from
  Programs.
- **Moving people**: `move { bookingId, toClassId }` (staff): one batch releases the old place,
  claims the new one, moves the use, writes `moved` on the old booking and a new booking; refused
  whole if the new class is full (staff may raise its places first, audited, as stage 26 decided).
  The member is emailed (a change by the gym).
- **Promote by hand**: staff move a waiter in ahead of the order, with a reason.
- **Substitutions**: changing a class's coach (one class, or a series from a date). Members are not
  emailed (decision 16; [#238](https://github.com/timoconnellaus/composable-os/issues/238)); the
  timetable shows the new coach.
- **Cancelling a class** (`cancelClass { classId, reason }`): the class moves to `cancelled`; in
  the same batch the host moves every `booked`, `pending` and `waiting` booking to
  `cancelled_by_us` (the cascade declared on the class's states), every use is returned and every
  place released; paid drop-ins are refunded through approval (decision 15); each member is
  emailed. Destructive: an AI asks, a person approves.
- **Reports** (a Bookings dashboard over `rec_*` views): attendance by class type, time and coach;
  how full classes are (booked over places); late cancels and no-shows by member and by month;
  waitlist joins and how many got in; first-time visitors and whether they came back; uses spent by
  plan (with 32b). Saved views: "No-shows this month", "Late cancels this month", "Classes under
  half full", "First class this week", "Classes with no attendance taken".
- **A Person's page** gets a **Bookings** tab: upcoming, waiting, history, uses left, and their
  guardians or dependants (32b's Membership tab beside it).

### Messages (decision 16; email only until stage 30)
Pack automations through the `email-send` gatekeeper, as Ticketing's, to the booking's Person and,
for a dependant, the guardians:
- **booked**, with an "add to calendar" file (`.ics`, one event, made by the host: a small
  platform piece, no ICS exists today);
- **promoted** from the waitlist; **skipped** on the waitlist (and why); **a place free** after
  the cut-off (to those waiting);
- **a change by the gym**: the class's time, day or room changed, the member moved, the class
  cancelled (with the drop-in refund if any);
- **a reminder before each class** (3 hours before by default, a setting per class type): needs
  `dateRelative` with an offset in hours and minutes (platform, small; today it counts whole
  days), by the class's own zone, and the runner's minute cron.
- **Not emailed:** a coach swap (decision 16), a booking the member cancelled themselves (shown on
  screen; guess).
- Promotion close to a class is only as good as email; push is stage 30's. Nothing here sends a
  push or a text.
- A personal calendar feed (a private address a phone subscribes to) is left for later (guess: no
  issue yet; it needs a revocable token, and phones refresh feeds on their own schedule).

### Time zones and clock changes
- A series' zone defaults to the organisation's (ADR 0460); each class stores its instant and zone;
  every member-facing time is shown in the class's zone, with the zone named only when the viewer's
  device is in another.
- Windows (opens, closes, late from, promotion stops, reminder) are lengths of time before the
  start instant, except a window that opens at a local time of day ("00:00 seven days before"),
  which is local.
- A week, for the allowance (32b's guess: Monday in the deployment's zone), is the class's local
  week; the series' zone and the organisation's are the same for a single-site gym.
- The shared helper (wall clock and zone to instant, across a clock change) is exported from core
  and used by `recurring`, closures, the import and `paidUpMoment`; tests cover both clock changes
  in the gym's zone and in one with a half-hour offset.

### Privacy: who sees who is in a class (decision 13)
- Members see how many places are left and their own (or their dependant's) place on the
  waitlist, never names. Coaches and staff see the list.
- A Person's bookings, uses and history are never visible to another member, except to a linked
  guardian (above). Showing first names to classmates is
  [#233](https://github.com/timoconnellaus/composable-os/issues/233).

### What an AI assistant may do
Under the approval gate (ADR 0480's pattern: an AI asks, a person approves, where it matters):
| Action | Risk | Under `balanced` |
| --- | --- | --- |
| Read the timetable, class lists, attendance, reports | read | applied |
| Book a member into a class, cancel their booking, put them on a waitlist | write | applied, audited, the member emailed as for staff (guess; `alwaysReview` for the assistant if the owner prefers) |
| Move a member, promote by hand, tick attendance | write | applied, audited |
| Draft a timetable or a change to a series from text ("add a 07:00 yoga on Saturdays") | write on a draft, then a person applies it | the series change is `destructive` when it touches classes with bookings: a person approves |
| Cancel a class, end a series, add a closure | destructive (and outbound) | a person approves |
| Refund a drop-in | `payments.refund` | always a person (as built) |
| Link a guardian and a dependant | `actors: ["human"]` | a person only |
| Change the booking rules | settings, `actors: ["human"]` | a person only |

Members' own AI clients reach only the customer tools, like any customer call (applied or refused,
never queued).

## Scope, 31b: appointments booked by staff (decision 1)
- **Services**: what may be booked one-to-one (a 60-minute personal training session), which
  coaches give it, its price or which allowance pays it (32b's `spendsOn` names the service
  object), a gap after, the cancel rules (the same windows; a member may cancel in time, guess).
- **Staff book them** for a member with a coach at a time: `appointment.book { personId, coachId,
  serviceId, startsAt }` (staff). The admin shows each coach's day with their classes and
  appointments; a coach's working hours, if set, are shown as a guide (guess).
- **A time-range claim** (platform): an appointment claims a coach's time from start to end (plus
  the gap); the database refuses two that overlap for one coach, and an appointment over a class
  the coach teaches, as capacity refuses places, so two staff booking the same slot at once get one.
- Appointments spend a use or are paid as a drop-in is (an order started by staff, or settled at
  the desk); booked, cancelled, late cancelled, attended and no-show as classes are. Members see
  their appointments on the web and in the app, get the same emails, and a guardian sees a
  dependant's.
- **Left out:** members booking their own appointments at times a coach has open
  ([#239](https://github.com/timoconnellaus/composable-os/issues/239)); computed slots go with it.

## What stage 33 needs from this stage (stage 33 runs the move)
`cos bookings import <folder>`, with import keys (each row's id in the old system), a dry run and
re-runs that change nothing, like `cos courses import` (ADR 0470's import door):
- **Class types (with their rules), rooms, coaches**, matched by name or key.
- **The timetable**: series with their weekdays, times, coach, room, places and dates; one-off
  classes; closures. The host then makes the classes itself; imported classes are matched to the
  generated ones by series and local start.
- **Family links**: guardians and their dependants, as a list staff review and apply (a person
  only, as for any link), never made by the import on its own.
- **Future bookings**, onto those classes, as the host: they claim places (a class over its places
  is reported as a conflict, not overfilled) and spend uses from the holders 32b's members import
  made (matched by the old system's keys), with the windows not applied; waitlists in order.
- **Visit history**: past classes and their bookings in their final states (`attended`,
  `no_show`, `late_cancelled`, `cancelled`), with no places and no spends, except **visits inside
  the current period**, which spend from the member's holder so "3 a week" is right on the day of
  the move.
- **Appointments** booked ahead (31b).
- **A period where both run**: the import can be re-run from a fresh export until the switch (new
  rows added, changed ones updated, nothing doubled); bookings made on the new host before the switch
  are kept.
What 33 decides (the switch date, freezing the old system, telling members) is not this stage's.

## What belongs to 32b or 33 instead
- **32b:** the `allowance` behaviour, memberships, passes, pass types, the intro offer, pauses and
  plan changes, members' billing, `cos memberships import`, and a holder's read for guardians. This
  stage only declares the booking a spender and lists, above, what 32b's behaviour must also do.
- **33:** exporting from the current booking system, mapping its data to these import folders, the
  switch and the overlap, and moving billing (32's question 14).
- **Here:** the timetable and its classes, bookings and their rules, waitlists, attendance, family
  links, the staff side, messages, the import door for schedules, bookings and history.

## Out of scope
- Standing bookings ([#232](https://github.com/timoconnellaus/composable-os/issues/232)).
- Classmates' names ([#233](https://github.com/timoconnellaus/composable-os/issues/233)).
- A guest on a member's booking ([#234](https://github.com/timoconnellaus/composable-os/issues/234)).
- A booking block after repeated no-shows ([#235](https://github.com/timoconnellaus/composable-os/issues/235)).
- Scanning a member's code at a desk ([#236](https://github.com/timoconnellaus/composable-os/issues/236)).
- Paying for a drop-in in the app ([#237](https://github.com/timoconnellaus/composable-os/issues/237)); buying anything in the app.
- Emails for coach swaps ([#238](https://github.com/timoconnellaus/composable-os/issues/238)).
- Members booking their own appointments ([#239](https://github.com/timoconnellaus/composable-os/issues/239)).
- Fees for a late cancel or a no-show (decided: none).
- Picking a spot (a bike, a mat): places have no identity (stage 26).
- Several locations with their own timetables and reports beyond a room's name (guess: one site).
- Livestreamed or online classes.
- Waivers and forms before a first class (stage 29).
- SMS and push messages (stage 30); a personal calendar feed.
- Coaches' pay, rosters and timesheets (stage 40, which reuses `recurring`).
- Rules other than weekly (every second week, the first Monday of a month).

## Acceptance criteria
31a:
1. **Generation:** a series on Tuesdays and Thursdays at 06:00 makes exactly the classes inside the
   horizon, at 06:00 local on both sides of each clock change, in the gym's zone and in a zone with
   a half-hour offset; a re-run makes nothing twice; a class changed by hand is never overwritten;
   a closure cancels the classes inside it.
2. **Places:** 50 members booking at once into a class of 12: exactly 12 booked and the rest
   waiting or refused as asked, for every actor and in the dry run (stage 26's test's shape).
3. **Spend:** a booking spends one use of the holder live at the class's time, counted in the
   class's week; a member with 3 a week cannot book a fourth class that week but can book one the
   next; two bookings at once for their last use: one succeeds; an off-peak holder cannot book a
   class at 18:00; a class type outside a holder's list is refused.
4. **Windows and staff-only:** with a class type's own rules overriding the defaults, a customer
   cannot book before it opens or after it closes, nor book a staff-only class type at all (for
   themselves, a dependant or a drop-in); a cancel more than 1 hour before returns the use and one
   later keeps it, decided by the host's clock; staff are not bound and their override is audited.
5. **Waitlist:** joining spends nothing; a place freed more than 2 hours before goes to the first
   waiter with a use, in the cancel's batch as a hold nobody else can take, then to them by
   promotion, and they are emailed; a waiter with no use left is skipped and emailed; a place freed
   less than 2 hours before goes to whoever books first and the waiters are emailed; a race of a
   cancel, a direct booking and two promotions leaves the class at its places with no place lost.
6. **Cancelling a class** cancels every booking, pending drop-in and waiter in its batch, returns
   every use, puts each paid drop-in's refund through approval, and emails each member; it is
   refused to an AI without a person's approval. (Decided at step 7's review, 2026-11-23: "every
   booking" includes those already ticked as come, marked not come and cancelled late, each use
   returned once; a class that has ended cannot be cancelled. ADR 0553.)
7. **Attendance:** two coaches ticking one name at once mark it once and the second is told who was
   first; no-shows are written only for classes whose attendance was taken; the use is kept for
   late cancels and no-shows.
8. **Drop-in:** a visitor pays for a class on the web; the place is held while the order is unpaid
   and released when it expires; a verified payment books them; no native block can start one (the
   block lint).
9. **The app:** a member books, cancels and joins a waitlist with their membership in the native
   blocks against the fake host; the blocks calculate no price and check no capacity (the lint).
10. **Family:** a link is made and ended only by a person with `people:link` (refused to the
    assistant, MCP, an extension, an import and a customer); a guardian books, cancels and joins a
    waitlist for a linked child with no email, spending only the child's allowance, and reads only
    the child's bookings and uses; an unlinked customer naming the child is refused as if the child
    did not exist; ending the link stops it at once; a merge re-points links and drops a self-link;
    erasing the guardian leaves the child and tells staff.
11. **Moves:** staff move a member to another class with their use in one batch, refused whole when
    the new class is full.
12. **Privacy and isolation:** a customer reads only their own bookings and their dependants'; no
    member sees another's name; stage 22's isolation test covers every Bookings object and the
    family link.
13. **Messages:** booking (with a valid `.ics` file), promotion, a change and a cancellation by the
    gym, and the reminder 3 hours before (a class type's own setting honoured, across a clock
    change) are each sent once; a coach swap sends nothing.
14. **Programs:** a class shows its class type's Programs session for its local date.
15. **Import:** `cos bookings import` loads a fixture timetable, future bookings and history; a
    re-run changes nothing; a class over its places is a conflict; current-period visits spend;
    family links are proposed, not made.
16. **Dashboard:** the Bookings dashboard's numbers match a fixture worked out by hand.
17. `pnpm lint typecheck test`, `cos ext check` and `cos ext test` on `packs/bookings`, and one e2e
    test per journey (book with a pass and cancel late; join a waitlist and be promoted; pay for a
    drop-in; a parent books a child; the coach's list) pass in CI; ADRs for each platform piece;
    CONTEXT.md (Class type, Series, Class, Booking, Waitlist, Promotion, Late cancel, No-show,
    Closure, Guardian, Dependant, Appointment, Service) and `docs/architecture.md` updated.

31b:
18. **Appointments:** two staff booking one coach's same time at once get one; an appointment over
    a class the coach teaches is refused; an appointment spends or is paid as a class is; the member
    sees it on the web and in the app.

## Dependencies
- Stages 25, 26, 27, 41 and 32a (merged).
- **32b, built beside this stage:** the `allowance` behaviour (32b's build step 5) with the
  amendments above, before this stage's step 4. Until then the booking's spend is proved against
  32b's fixture holder.
- Stage 30 only for push and SMS (not needed); stage 29 only for waivers (not needed).
- Stage 33 for the gym's move; it needs step 10 here.

## Migrations and numbers
Migrations 0560 to 0579 (capacity claimants and waitlist holds, time-range claims, declared
uniqueness, the `recurring` bookkeeping, `core_person_link`) and ADRs 0500 to 0509, claimed in
[`parallel-work.md`](../parallel-work.md) as block AI.

## Suggested build order
31a:
1. The shared wall-clock helper; **the `recurring` behaviour** with a fixture series and the
   clock-change tests.
2. **Capacity claimants** (a record's states hold and release its claim), declared uniqueness, and
   **time windows and staff-only creates** in the transition engine.
3. **The Bookings pack's spine**: class types (on Programs') with their rules, rooms, coaches,
   series, classes, bookings; book and cancel with the windows; the timetable read; staff booking.
4. **Spending** with 32b's `allowance` (amended as above): spend on `booked`, the class's time as
   the period, time-of-day and class-type conditions, give-back on in-time cancels.
5. **The waitlist and promotion**, the cut-off, with the race tests.
6. **The family link**: `core_person_link`, the seam's guardian scope, booking for a dependant,
   merge and erase, its isolation tests (32b's holders declare the guardian read at the same time).
7. Attendance (the class list, the coach role), no-shows, moving people, cancelling a class (the
   cascade), closures.
8. **Drop-ins** (`sellable.moves`) and their refunds through approval.
9. Messages and the reminder (`dateRelative` in hours), the "add to calendar" file, the dashboard,
   views, the Person tab, hooks and blocks (web and native).
10. `cos bookings import` for stage 33.
31b:
11. Services, time-range claims, appointments booked by staff.

**The spine is steps 1 to 4**: a timetable that makes classes, a booking that holds a place inside
its windows and spends a real allowance. Step 2 and 32b's step 5 can run in parallel sessions;
they meet at step 4. Step 6 is core and touches the visibility seam: give it its own session,
reviewed with the care stage 22 was.

## Built
### Step 3: the Bookings pack's spine (2026-11-22, `feat/stage-31a-bookings-pack`)
[ADR 0504](../adr/0504-the-bookings-pack.md) (the pack), [0505](../adr/0505-window-numbers-through-two-relations-and-settings.md)
(window numbers two relations away and over settings, staff-only lists and formulas,
`horizonAtLeast` on another pack's object, `state.resolve`) and
[0506](../adr/0506-a-spender-paid-another-way.md) (`waived`); no migration. Where the build read
the spec one way, or decided what it left open:

- **The rules are read, not copied.** The spec had the host compute each class's moments (opens,
  closes, late from) when it makes the class. A copy goes stale when the gym changes a class
  type's rule or the organisation's for the 56 days of classes already made; the windows instead
  read the class type's field two relations away and, when it is empty, the organisation's
  setting, in each write (ADR 0505). The cost: the public timetable cannot show "opens Tuesday"
  or "booked by the gym" up front (the public does not read Bookings' fields on Programs' class
  type); `book` answers with both. Step 9's blocks may revisit it.
- **The defaults**: `opensDays` 7 (at most 56, the default horizon, so a class always exists when
  its booking opens; a class type may open further ahead and raises the horizon), `closesMinutes`
  0, `lateMinutes` 60, `promotionMinutes` 120, `reminderMinutes` 180, staff book only off. They are
  Bookings' settings, changed with `extensionSettings.update` (the extensions permission). The
  spec says "a person only"; that operation is not limited to people today, and changing it is a
  platform change beyond this step (noted for review).
- **Not reachable yet**: `waiting` and `pending` are created by the host only; no customer move
  enters `attended`, `no_show`, `moved` or `cancelled_by_us`. Staff may mark attended and
  no-show (declared moves, no behaviour). A class is cancelled by the host only (closures and a
  series ended, confirmed by a person); staff cancelling a class waits for step 7's cascade.
- **A member cannot book a class that is not scheduled**, even one they still read through an
  old booking (`customerVia`): the class's `closed` formula is a staff-only flag (ADR 0505).
- **Walk-ins** are booked by staff with `bookFor { newPerson, paidAtDesk }`: a booking paid at the
  desk spends no use (ADR 0506). Without it, a person with nothing to spend is refused, staff
  included (the allowance binds everyone).
- **The cancel's preview and confirm**: `cancel` shows the host's answer (`state.resolve`), then
  confirms into that state (`expect`), so a cancel that became late meanwhile is refused, not made
  late silently.
- **Not built here** (later steps): the class type's default length and places and its drop-in
  price (no host defaulting from a related record exists; staff enter a series' length and
  places), the coach role, attendance, the waitlist, the family link, moves, cancelling a class,
  drop-ins, messages, the dashboard and the import. The timetable shows the class's own title,
  which is its class type's name unless staff rename it (`titleDefault`).
- **Proof**: the pack's own tests (17), the real host with a fixture pass `bkfixture.pass` (16),
  the platform pieces on a fixture (13), the block lint, and one e2e test per journey (a member
  books from the timetable and cancels in time; staff book a walk-in into a staff-only class).
- **After the independent review** ([ADR 0507](../adr/0507-what-the-bookings-review-needed-of-the-platform.md)):
  a class the host cancels cancels its bookings in its batch (uses back); a closed class binds
  staff; a member's class and holder are create-only and a member creates only `booked`; a trashed
  class type closes its classes; every class has a zone and places; `cancelFor` is decided by the
  clock and `returnUse` (destructive) gives a use back late; walk-ins are made with their booking in
  one batch after the duplicate check; the booking rules are a person's (`personApproves`); permissions
  by object only. This replaces the notes above on the "a person only" settings and on staff
  cancelling a class: the host's cancels cascade now; staff's own cancel is step 7's, with emails.

### Steps 4 and 5: spending and the waitlist (2026-11-22, `feat/stage-31a-spending-waitlist`)
[ADR 0520](../adr/0520-a-waitlist-on-a-claimant.md) (a waitlist on a capacity claimant) and
migration 0610 (block AL); ADRs 0493, 0501 and 0504 amended. Where the build read the spec one way,
or decided what it left open:

- **Spending (step 4) needed no new code.** Step 3 and 32b's step 5 already built the six
  amendments (spend on entering `booked`, the class's time as the period, the class type and local
  weekday and minute copied, `movedFrom`, the holder `auto` or chosen and always the booking's
  Person's, unlimited holders writing a use). This step proves them on the shipped Bookings and
  Memberships packs together, through the fake provider (acceptance criterion 3): a membership of 3
  a week counted in the class's week, a fourth refused and the next week booked, two bookings at
  once for the last use (one booked), an 18:00 class and another class type refused, an unlimited
  membership spent before a pass and still writing a use, a named pass spent, a pass ending before
  the class refused. **A move with its use** (amendment 4) stays proved on the platform's fixture:
  the staff `move` tool that makes one is step 7's ("moving people").
- **The waitlist is declared on the booking, not the class** (`claims.waitlist`, ADR 0520): the
  spec guessed `capacity: { waitlist }` on the class; its states are the booking's, as `claims`
  already was (ADR 0501). Its cut-off is read in each write from the class type's
  `promotionMinutes`, else the organisation's (ADR 0505), not copied onto the class.
- **"While a class has anyone waiting, a new booking joins the waitlist"** is kept by the hold: a
  place owed to the waitlist is held, so a direct booking finds the class full and joins behind.
  A free place with people waiting happens only after the cut-off, after every waiter was passed
  over for that place, or when staff raise a class's places; it goes to whoever books first (raised
  places are not handed to the waitlist; staff promote by hand in step 7).
- **Joining** is refused when a place is free (book it) and **from the cut-off** (the spec said
  nobody is promoted then; waiting would be pointless). A member whose booking was refused for want
  of a use may still join a full class: joining spends nothing (decision 7), and they are passed
  over at promotion if they still cannot pay. `book` joins by default (`waitlist: false` refuses
  instead); staff's `bookFor` joins only with `waitlist: true`.
- **Promotion runs on the minute cron** (`runWaitlistDue`), not on the booking's move event: the
  place is held meanwhile, so the minute costs nobody their place. A waiter passed over stays first
  and is tried again for the next freed place.
- **Messages are step 9.** Criterion 5's emails (promoted, passed over and why, a place free after
  the cut-off) are not sent yet; the host records what they will say on the booking
  (`promotedAt`, `passedOverAt`, `passedOverReason`), which step 9's automations read.
- **Blocks**: the web and native timetables show a "waiting" answer as a message; the client entry
  has `useLeaveWaitlist`. Showing a waiter's position and a Leave button in the blocks is step 9's.
- **Proof**: the platform's fixture tests (`packages/core/test/waitlist.test.ts`: joining only when
  full and before the cut-off, the hand-on in the release's batch, promotion and the cut-off by an
  injected clock, the last waiter leaving, 50 at once into 12, a cancel, a direct booking and two
  promotions at once, two promotions of one waiter, a pack's automation refused); the shipped
  packs together (`apps/runner/test/bookings-waitlist.test.ts`: criterion 3, and criterion 5 with a
  waiter passed over for want of a use, the use spent on promotion, the cut-off, and 12 at once into
  4 then a cancel, a direct booking and two promotions at once); the pack's own tests.
- **After the review** (ADR 0520's amendment): promotion is a host step the approval gate never
  queues from the system origin (a deny is counted and logged); the hand-on happens only for a
  place really given back, and an erase hands on; a waiting booking cannot change class; a member
  already waiting takes a free place with `book` (never a place held for the queue); every refusal
  in the step passes the waiter over or gives the holds back, logged, and a long queue is worked
  down across ticks; the cut-off is read on the real clock; `bookFor` refuses paid at the desk
  with the waitlist.

### Step 7: attendance, the coach role, moves and cancelling a class (2026-11-23, `feat/stage-31a-attendance`)
ADRs [0550](../adr/0550-timed-moves-and-a-cancel-that-races-a-booking.md) (timed moves, and the
guards a cancel and a booking racing it need), [0551](../adr/0551-staff-bound-windows-and-a-move-only-by-its-new-record.md)
(windows on staff moves; `moved` only by the new booking; `waived` moves with it),
[0552](../adr/0552-a-tool-a-person-approves.md) (a tool a person approves) and
[0553](../adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md) (the pack's part);
migration 0670 (block AO); ADRs 0436, 0493, 0504, 0507 and 0520 amended. Where the build read the
spec one way, or decided what it left open:

- **Ticking has a window**: from an hour before the class (guess), binding staff, and no end (a
  correction after the class, a no-show ticked as come, is allowed). A no-show is marked from the
  start. Of two coaches ticking one name, one tick is made; the other is told who was first
  (`markedByName`). `markAll` ticks everyone still booked.
- **"Attendance was taken" is read, not stored**: the host's no-show move (`states.after`, 30
  minutes after the class's end) needs another booking of the class `attended` or `no_show`. No flag
  on the class goes stale when a tick is undone; a one-off class without an end time gets none; the
  sweep looks back 14 days.
- **The coach role** reads its class records and holds `day`, `roster` (names and marks, nothing
  paid), `markAttended`, `undoAttended`, `markNoShow`, `markAll`. **It does not book walk-ins or
  members** (spec: "book walk-ins and members into a class"): finding someone on file, and the
  walk-in's duplicate check, show people beyond the lists, which the same sentence rules out. The
  desk books; the coach ticks. Pack roles still do not combine (ADR 0436 amended).
- **A move is the new booking's create** (`movedFrom`), refused whole when the new class is full
  (its waitlist's holds count: a staff move never takes a held place; raise the places first), was
  cancelled, already has them, or the use cannot be spent then; only before the old class starts.
  The `moved` state cannot be written on its own (it gave a use back late). A desk-paid booking
  moves desk-paid. A freed place goes to the waitlist before the cut-off.
- **Cancelling a class** is `cancelClass`, a tool a person approves: the assistant, MCP and
  automations may ask, and it waits for a person whatever the preset; no other staff write cancels a
  class. The cascade now holds under races (ADR 0550).
- **After the review** (ADR 0553's amendment): a class the gym cancels takes every booking holding
  a place or a use with it (ticked, not come and late-cancelled included), each use back once; a
  class that has ended cannot be cancelled (`endsAt` is now required); nothing takes a place on a
  closed class, for anyone; `cancelClass` fails visibly when it cannot apply; `move` answers a race
  as `changed`; the coach role reaches today only (a role's `today`: a class starting today in its own zone, or running now), so
  another day's corrections are the desk's; the timed-move sweep pages past records that keep
  failing; a cascade cannot follow a pooled parent.
- **Not built here** (later steps): promote by hand, the emails (a move, a cancel, the class list
  "no attendance taken"), drop-in refunds on a cancel (no drop-ins yet), the coach's screen in the
  gym's app (the web `bookings-class-list` block is the list; native is step 9).
- **Proof**: `packs/bookings/test/bookings.test.ts` (29), `packages/core/test/attendance-platform.test.ts`
  (6), `apps/runner/test/bookings-attendance.test.ts` (11: criteria 6, 7 and 11 on the shipped
  packs), and the e2e journey "a coach ticks who came on a class's list".

## Questions for the interview
All were answered on 2026-11-22; each keeps its text and the decision.

1. **Personal training and other one-to-one sessions: are they booked in your current booking
   system today?**
   - (a) Yes, members book them themselves at times the coach has open.
   - (b) Yes, but staff book them for members.
   - (c) No, they are arranged another way.
   **Decided 2026-11-22: (b)**: staff book them; classes first, appointments second, booked by
   staff; members booking their own is #239. **Recommended: build classes first and one-to-one
   bookings second, in either case.** Classes are what every member books every week; one-to-one
   booking is a different engine (a coach's open hours, not places in a class).

2. **How far ahead can members book a class, and until when?**
   - (a) Up to 7 days ahead, until the class starts.
   - (b) Up to 14 days ahead, until 1 hour before.
   - (c) Something else: tell us your current setting.
   **Decided 2026-11-22: (c)**: it differs by class type, and some class types are booked only by
   staff; both are settings on the class type over the organisation's defaults (7 days ahead,
   until the start), which are the company's to set. **Recommended: keep exactly what your members
   are used to today, with one rule for the gym and a different one only for class types that need
   it.**

3. **When does a cancel become late (they lose the class from their membership or pack)?**
   - (a) Less than 12 hours before the class.
   - (b) Less than 24 hours before.
   - (c) Less than 2 hours before.
   - (d) Something else, or it differs by class type: tell us.
   **Decided 2026-11-22: (d)**: less than 1 hour before, an organisation default with a class
   type's override. **Recommended: your current rule.** Already decided: a late cancel costs no
   money, the class is just used up. An on-time cancel always gives it back.

4. **A place opens in a full class. What happens to the first person on the waitlist?**
   - (a) They are booked in automatically and emailed.
   - (b) They are emailed an offer and have a set time (say 30 minutes) to accept, then it goes to
     the next person.
   - (c) Everyone waiting is emailed and the first to tap gets it.
   **Decided 2026-11-22: (a)**, as recommended. **Recommended: (a).** It fills the place without
   anyone racing, and it is what most members expect from joining a waitlist.

5. **How close to the class do you stop moving people up from the waitlist?**
   - (a) 2 hours before.
   - (b) 30 minutes before.
   - (c) Right up to the start.
   **Decided 2026-11-22: (a)**, a setting. With question 3's answer, a place freed less than 2
   hours before goes to whoever books first, and the people waiting are told. **Recommended: (a),
   or your current rule.** Without app notifications, a person moved in 10 minutes before a class
   may not see the email.

6. **While people are waiting, can someone else book the freed place first?**
   - (a) No: a freed place always goes to the waitlist first.
   - (b) Yes: whoever books first gets it.
   **Decided 2026-11-22: (a)**, as recommended (until the cut-off). **Recommended: (a).** It is fair
   to the people who joined the waitlist, and the system holds the place for them.

7. **Does joining a waitlist use up a class from someone's membership or pack?**
   - (a) No, only when they are moved into the class. If they have none left by then, they are
     skipped and told.
   - (b) Yes, it is set aside when they join and given back if they never get in.
   **Decided 2026-11-22: (a)**, as recommended. **Recommended: (a).** Members can wait for several
   classes without their week's classes being locked up.

8. **How does someone pay for a single class (a drop-in)?**
   - (a) They pick the class on the website and pay for that class; their place is held while they
     pay.
   - (b) They buy a single-class pass on the website first, then book with it.
   - (c) They pay at the front desk; staff book them in.
   **Decided 2026-11-22: (a), with staff still booking walk-ins (c)**, as recommended.
   **Recommended: (a), with (c).** One step for a newcomer is the first impression the gym makes.

9. **What can members do in the gym's app?**
   - (a) Book, cancel and join waitlists with the membership or pack they already have; buying
     anything (a drop-in, a pack, a membership) is on the website.
   - (b) Everything, including paying for a drop-in in the app.
   - (c) See their bookings only; booking is on the website.
   **Decided 2026-11-22: (a)**, as recommended; paying in the app is #237. **Recommended: (a).**
   Booking with a pass they own moves no money, so it fits the platform's rule that paying happens
   on the website.

10. **How do you record who came to a class?**
    - (a) The coach ticks names on the class list on a phone or tablet.
    - (b) Members show a code in the app at the front desk and staff scan it.
    - (c) Both.
    - (d) We don't record it.
    **Decided 2026-11-22: (a)**; scanning at a desk is #236. **Recommended: (a) for every class,
    plus (b) if you have a front desk.**

11. **What happens when someone books and doesn't turn up (a no-show)?**
    - (a) It is recorded and they lose that class (already decided); nothing else.
    - (b) As (a), and after a set number of no-shows in a month they cannot book for a week.
    - (c) It is not recorded at all.
    **Decided 2026-11-22: (a)**, as recommended; a block after repeats is #235. **Recommended:
    (a).** Staff can see repeat no-shows in a report and talk to the member.

12. **Can members set a standing booking ("every Tuesday at 6am") that books itself each week?**
    - (a) No, members book each class themselves.
    - (b) Yes, members can set one; it books each week while their membership allows, and tells
      them when it can't (class full, none left).
    - (c) Yes, but only staff can set one up.
    **Decided 2026-11-22: (a)**, as recommended; standing bookings are #232. **Recommended: (a),
    unless your members use this today.**

13. **Who can see who is booked into a class?**
    - (a) Members see only how many places are left; names are for coaches and staff.
    - (b) Members booked into the class see first names and an initial, and can hide theirs.
    - (c) Everyone signed in sees the full list.
    **Decided 2026-11-22: (a)**, as recommended; names for classmates are #233. **Recommended:
    (a).** It is the private default and needs nothing extra.

14. **Who can a person book for?**
    - (a) Only themselves; staff can book anyone.
    - (b) Parents can also book for their children (kids' classes).
    - (c) Members can also bring a friend as a guest on their booking.
    **Decided 2026-11-22: (b)**: parents book for their children, in scope; guests are #234.
    **Recommended: (a), unless you run kids' classes or guest passes today.** The gym runs kids'
    classes, so the family link is built.

15. **When the gym cancels a class, what does a person who paid for a drop-in get?**
    - (a) Their money back to their card.
    - (b) A free class to use another time.
    - (c) They choose.
    **Decided 2026-11-22: (a)**, as recommended. **Recommended: (a).** It is the clearest and needs
    no new kind of credit; a refund is approved by a staff member as every refund is.

16. **Which reminders and messages should members get?**
    - (a) An email when they book (with an "add to calendar" button) and when the gym cancels or
      changes their class.
    - (b) As (a), plus a reminder email before each class (say 2 hours before).
    - (c) As (b), plus an email when a coach is swapped.
    **Decided 2026-11-22: (b)**, as recommended; coach-swap emails are #238. The reminder's default
    is 3 hours before, so it arrives before promotion stops (a setting). **Recommended: (b).**

## Sources
Read 2026-11-22, all in this repository: ADRs 0404, 0425, 0430 to 0437, 0449, 0460, 0477 and
0487; stages 26, 27, 32 (32b and the interview's answers), 41 and 42; `packages/core/src/capacity/`
(`index.ts`, `holds.ts`, `records.ts`), `packages/db/migrations/0440_capacity.sql`,
`packages/core/src/orders/` (`holds.ts`, `grants.ts`, `guests.ts`, `late.ts`),
`packages/core/src/operation.ts`, `gate.ts`, `audiences.ts`, `visibility/`, `fields/person.ts`,
`subscriptions/offers.ts` (`paidUpMoment`), `settings.ts`, `packages/sdk/src/` (`capacity.ts`,
`sellable.ts`, `automation.ts`, `manifest.ts`), `packs/ticketing` (manifest, tools, automations,
native blocks), `packs/programs` (`classtype`, `assignment`, `session`, `classToday`),
`apps/runner/src/index.ts` and `automations/schedule.ts`, `scripts/check-blocks.mjs`.

Not confirmed, and checked at build: whether pack roles can combine (a coach who also scans
tickets); how a merge preview shows links; how the current booking system exports schedules,
future bookings, family links and visit history (stage 33's to find out).
