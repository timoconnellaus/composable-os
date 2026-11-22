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

Status: **spec proposed (interview pending).** Nothing here is agreed. The questions at the end are
for the owner; the build waits for their answers and for this spec's status in
[`roadmap.md`](../roadmap.md) to say "spec agreed". Stage 32b (allowances, Memberships, passes) is
agreed and waits for this stage; the two are built side by side. Where this spec guesses, it says
**(guess)**; the build confirms or corrects each one.

## Goal

A gym or studio runs its classes from the host. Staff set a weekly timetable once; the host makes
each week's classes from it, with their coach, room and places. Members see the timetable on the
gym's site and in its app, book a class with their membership or pass, cancel it, join a waitlist
when it is full and are moved in when a place frees. A visitor pays for a single class at booking.
Coaches see the day's classes and who is coming, mark who came and swap a class to another coach.
The gym's rules hold for everyone: how far ahead people may book, when booking closes, and when a
cancel is late and keeps the class it used. Staff cancel a class and everyone booked is told and
given their class back. Later in the stage, members book one-to-one appointments (personal
training) at times a coach has open.

With stage 32b's memberships and passes, and stage 33's move, this replaces the gym's current
booking system.

## Decided already (stage 32's interview, 2026-11-22)

Not asked again. Each constrains this stage.

| Decision | What it means here |
| --- | --- |
| The gym sells unlimited memberships, N per week or month, class packs that expire, drop-ins and a once-per-person intro offer (32's question 8, answered (c)) | A booking spends from any of them; a drop-in is paid at booking or bought as a pass (question 8 below) |
| Limits by class type and by time of day (question 8, (c)) | Class type is in 32b's `spendsOn`; the time of day needs the booking's class time, which this stage gives the allowance (below) |
| No carry-over (question 9) | A use counts in the period of the class it was spent on |
| Pauses by staff for a set time (question 10) | A paused membership spends nothing; bookings inside a pause are dealt with (below) |
| A payer and a holder may differ (question 13) | The holder is who books and attends; whether a parent may book for a child is question 14 below |
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
  that grant a ticket with a code, `states` on the ticket (valid, used, void), the `door` pack role
  (ADR 0436), and check-in by code from a current read (ADR 0437): of two scanners one wins and the
  other is told who was first. The native door scanner (`ticketing-native-scanner`,
  `DoorScannerScreen` with an app-supplied `CodeScanner`) calls `x.ticketing.checkIn`.
- **Orders and `sellable`** (stage 25, ADRs 0427 and 0435): `order.start` prices the lines and
  claims their places in the same batch; `order.checkout` opens the provider's page; only a
  verified payment pays; an unpaid order expires after 15 minutes by default (`order.expireDue` on
  the runner's minute cron) and its holds are released. A paid line grants records (`grants`).
  There is no declaration for "a paid line moves a record that already exists".
- **The operations registry** (`packages/core/src/operation.ts`, `gate.ts`): every operation has
  zod schemas, a model-facing description, a permission, a risk class (`read` to `outbound`),
  `actors` and `audiences` (`staff` by default; opening one to `customer` or `public` is a reviewed
  change, ADR 0402, listed in `open-operations.json`). Customer calls are applied or refused, never
  queued. Under the default `balanced` preset an assistant's `write` is applied, `destructive` and
  `outbound` go to a person. A pack tool (`defineTool`) becomes `x.<pack>.<tool>` with its own risk
  and audiences.
- **The visibility seam** (`packages/core/src/visibility/`): `customer: { field, read, write }`
  gives a customer their own records only; `signedIn` lets every signed-in customer read shared
  records (Programs' class sessions); `customerVia` reads a record one of your own points to;
  `public` reads what an object declares. A Person's name is never readable by another customer.
  `registerAccessSource` (ADR 0477) is for "who may read this record", which bookings do not need.
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
  cancels, no-shows, a link between two People ("may book for"), a unique rule an extension can
  declare ("one booking per person per class"), and the `allowance` behaviour (32b).

## The model

### Words
A **class type** is a kind of class (CrossFit, Yoga, Open gym). A **series** is one line of the
timetable: a class type every Tuesday and Thursday at 06:00 for 60 minutes, in a room, with a coach,
from a date. A **class** is one dated occurrence of a series (Tuesday 3 March, 06:00), or a one-off
class with no series. A **booking** is one Person's place in one class. A **waitlist** is the
bookings of a full class that are waiting. An **appointment** (31b) is a one-to-one booking of a
coach's time for a **service** (a 60-minute personal training session). CONTEXT.md already says
"a class is the timetable's" and "a booking is a place in a class"; Programs' **session** stays
Programs' word (a dated workout), so this stage never calls a class a session.

### Objects (`packs/bookings`)

| Object | What | Behaviours |
| --- | --- | --- |
| `programs.classtype` (Programs', extended) | Bookings adds fields to it: a colour, the default length and places, a drop-in price, and the booking rules (below) when they differ from the gym's | (Programs': `signedIn`) |
| `bookings.room` | Name, places (the most it holds), notes | none |
| `bookings.coach` | Name, photo, short bio (public), the staff account (a `user` field, optional: a visiting coach may have none), active | `public` (name, photo, bio) |
| `bookings.series` | Class type, weekdays, local start time, length, room, coach, places, first date, last date (empty for ongoing), time zone (defaults to the organisation's), state (`active`, `ended`) | **`recurring`** (new), generating `bookings.class` |
| `bookings.class` | Its series (empty for a one-off), class type, starts at, ends at, time zone, room, coach, places, notes for members, state (`scheduled`, `cancelled`, `done`), whether it was changed from its series (host), the booking rules' moments (host: opens, closes, late from) | `capacity` with waitlist (new); `states`; `public` while scheduled; `sellable` for a drop-in (question 8) |
| `bookings.booking` | Its class, its Person (the holder, who attends), who made it (the Person, or staff), state, the allowance holder it spent from (host), its code (host), when it was promoted, when checked in and by whom | `customer: person`; `states` with time windows (new); a **capacity claimant** (new); an **allowance spender** (32b) |
| `bookings.closure` | A date range and a reason (holidays): the host cancels the classes inside it | none |
| `bookings.standing` | A Person, a series, from, until: a booking made every week (question 12) | `customer: person` |

31b adds `bookings.service` (title, length, price, which coaches, how far ahead, the gap after),
`bookings.availability` (a coach's open hours: weekdays, from, to, from a date; `recurring` again)
and `bookings.appointment` (a Person, a coach, a service, starts at, ends at, state; a time-range
claim, below).

**The class type is Programs' (guess).** Programs already names it and assigns programs to it, so a
class shows "today's workout" (the Programs session of its class type for its local date) on its
roster and in the member's view, which is the connection the roadmap asks for. Bookings then
`requires: ["programs"]`, as Courses does. The cost: a studio with no use for programs installs the
Programs pack anyway (it shows nothing until a program is assigned). The other way, a class type
of Bookings' own that Programs points to, is a breaking change to a built pack. `classToday` moves
to the class's local date.

### Booking states

| From | To | By | What happens in the same batch |
| --- | --- | --- | --- |
| (new) | `booked` | customer, staff | a place claimed, a use spent (or a drop-in order started, below) |
| (new) | `waiting` | customer, staff | nothing claimed, nothing spent; a position in the waitlist |
| `waiting` | `booked` | host (promotion) | a place claimed from the waitlist's hold, a use spent |
| `waiting` | `left` | customer, staff | none (final) |
| `booked` | `cancelled` | customer, staff; only before the class's "late from" moment (customer) | the place released (to the waitlist first), the use returned |
| `booked` | `late_cancelled` | customer, staff; from "late from" until the start | the place released (to the waitlist first), the use kept (decided) |
| `booked` | `attended` | staff, door, host (a scan) | none |
| `booked` | `no_show` | host, after the class ends and attendance was taken (question 11); staff | the use kept |
| `attended` ↔ `booked`, `no_show` → `attended` | | staff | corrections, audited |
| `booked`, `waiting` | `cancelled_by_us` | host (the class cancelled, below) | the place released, the use returned (final) |
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
| `recurring`: a series generates dated records, in its zone, across clock changes | **Platform** (new behaviour, ADR 0404's row) | Also Rosters (stage 40) and 31b's availability |
| Capacity claimants: a record whose states hold, confirm and release its own claim | **Platform** (extends `capacity`) | Today only orders claim; a booking paid by an allowance has no order |
| A waitlist on a capacity, and promotion under races | **Platform** (extends `capacity`) | A freed place must go to the next waiter for every actor, without a read-then-write race |
| Time windows on creates and moves (opens, closes, late from) | **Platform** (the transition engine, ADR 0425) | A customer, an MCP client and an import must meet the same window; a pack tool deciding "late" would be the pack hooking a write |
| One active booking per Person per class | **Platform** (a declared uniqueness among records in given states) | The reconciler has no unique rule an extension can declare |
| A parent's move moves its children (a class cancelled cancels its bookings) | **Platform** (a cascade on `states`) | Otherwise a class cancelled through `record.update` would leave its bookings booked |
| A paid line moves a record that exists (a drop-in booking held while its order is unpaid) | **Platform** (extends `sellable`) | Today a paid line can only grant new records |
| The allowance spend, give-back and the class's time as the period | **Platform** (32b, amended below) | Built in 32b; this stage states what it needs |
| A time-range claim: no two appointments of one coach overlap (31b) | **Platform** (a new kind of capacity) | Places are a count; a coach's time is a range |
| `dateRelative` in hours and minutes; an ICS feed route | **Platform** (small) | Reminders hours before a class; calendar feeds |
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
- **The host makes the records ahead**, up to the horizon (proposed: 56 days, and never less than
  the longest booking window), as the host, each with an idempotency key of the series and the local
  date, so a repeated run makes nothing twice. The runner runs it once a day after midnight in the
  series' zone and at once when a series is created or changed.
- **Local time is the rule.** 06:00 in the series' zone is 06:00 on both sides of a clock change:
  the instant moves, the wall clock does not. A local time that does not exist on the change day
  (02:30 when clocks go forward) moves forward by the gap; one that happens twice takes the first
  (guess; the same rule `paidUpMoment` uses). Each class stores its instant and its zone.
- **Exceptions.** A class edited by staff (another coach, room, time or places) is marked as
  changed and is never overwritten by the series again. A class cancelled stays, cancelled. A
  closure cancels the classes in its range (below).
- **Changing a series** applies from a date to the classes not yet changed by hand: its coach,
  room and places at once, with a booked class's places never set below its taken places
  (capacity's own rule). A new time or weekday on classes that already have bookings is refused
  unless staff confirm it, and then each booker is told (guess). **Ending a series** removes its
  future classes that have no bookings, and cancels the rest as a class cancel does, after staff
  confirm with the count.
- **A one-off class** is a `bookings.class` with no series.

### Places and the waitlist (extends `capacity`)
- **A booking is a claimant.** The booking object declares `capacity: { claims: { on: "class",
  states: { held: [], confirmed: ["booked", "attended", "no_show"], released: [...] } } }`
  (guess at the shape): entering `booked` claims one place on its class in the booking's own batch,
  refused by the database past the places as stage 26 built; leaving it releases. A late cancel
  releases the place even though it keeps the use, so someone else can come.
- **The class's places** default from the series (then the class type, then the room). The room's
  places are a ceiling staff are warned about, not a pool (guess: classes in one room do not share
  places, they are at different times).
- **The waitlist** is declared on the class: `capacity: { places: "places", waitlist: { from:
  "booking", until: "closes" } }`. When a place is released and anyone is waiting, the same
  statement that releases it gives it to the waitlist as a hold of its own (a claim for the
  class's waitlist, made by a conditional statement, with no read), so **nobody booking directly
  can take a place the waitlist is owed** (question 6). While a class has a waitlist, a new
  booking joins it.
- **Promotion** is a host step after the release, from a current read (ADR 0437): the first waiter
  by the time they joined moves `waiting` → `booked` in one batch that takes the waitlist's hold,
  spends their use and records when they were promoted. If their spend is refused (no uses left,
  their pass expired, their membership paused), they are skipped, stay waiting and are told why,
  and the next is tried. If nobody can take it, the hold is released to everyone. Two promotions at
  once for one hold: one succeeds, the other finds nothing.
- **How promotion works for the member** is question 4 (booked for them and told, or offered with a
  time to accept). **When it stops** is question 5: after the cut-off a freed place goes to anyone,
  and the waiters are told a place is free.
- **Who runs it:** the runner, on the booking's move event (stage 5's queue) and swept by the
  minute cron, so a place freed is offered within about a minute (guess at the mechanism).

### Booking windows, cut-offs and the late-cancel window (time windows on moves)
- **The gym's rules** (questions 2 and 3), set in the pack's settings with an override per class
  type: booking opens N days before the class (at a local time, or the same time of day), closes M
  minutes before it starts, and a cancel is late from L hours before it starts.
- **The host computes the class's moments** when it makes or changes the class: `opensAt`,
  `closesAt`, `lateFrom`, read only. The booking's moves name them: `booked → cancelled` by a
  customer `until: "class.lateFrom"`; `booked → late_cancelled` `from: "class.lateFrom", until:
  "class.startsAt"`; create by a customer `from: "class.opensAt", until: "class.closesAt"`. The
  transition engine checks them against the host's clock in the write, for every outside actor.
  **A member's cancel asks for "cancel" and the host picks** `cancelled` or `late_cancelled` by
  the time, and says which before they confirm (a dry run returns it).
- **Staff are not bound by the windows** (they book a member into a closed class, or cancel late
  without keeping the use, with a reason); the assistant and MCP are bound as staff are, with the
  approval gate below.
- **Other limits** (guess, to confirm with question 2): one active booking per Person per class;
  no two booked classes for one Person that overlap in time; at most N future bookings at once
  (a setting, empty for none).

### Spending and returning an allowance use (the 32b contract)
Stage 32b's `allowance` behaviour is agreed; this stage is its spender. What the booking declares,
and **what 32b must provide that its spec does not yet say** (amend 32b's build with these):

1. **Spend on entering a state, not only on create.** A waiting booking spends nothing; it spends
   when it becomes `booked` (on create, or by promotion). 32b's "a spend is written in the
   spender's create" becomes "in the move into a spending state" (`spendIn: ["booked"]`).
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
5. **Which holder:** `auto` (the holder that expires first among the Person's live ones that match,
   32b) unless the member picks one when they have several. Staff may pick any of the Person's.
6. **Unlimited memberships still write a use** (no limit), so attendance and "uses spent per week"
   count every class.

**Pauses** (32's question 10, by staff): a membership paused over dates with future bookings in
them: staff are shown the bookings, and the host cancels them as `cancelled_by_us`, uses returned,
each member told (guess; the other way is to refuse the pause until staff move them). **An
ending membership** (cancelled at the period's end) cannot pay for a class after its end (rule 2).
**A downgrade at the next period** keeps the bookings already made under the old plan (guess).

### Booking and cancelling, by members, on the web and in the app
| | Web | App |
| --- | --- | --- |
| See the timetable (classes, coach, places as the object's `show` says) | yes, public | yes |
| Book a class with a membership or pass, join a waitlist, cancel, leave a waitlist | yes | yes (question 9) |
| Pay for a single class (drop-in) | yes | no (question 9) |
| See their bookings, waitlist position, history and uses left | yes | yes |
| Show their booking's code at the door | yes | yes (full brightness, as a ticket) |
| Standing bookings (if question 12) | yes | yes |

- **Booking with an allowance is not a purchase.** Spending a use the member already holds moves no
  money; the block lint lets a native block call `x.bookings.book`, `cancel`, `leaveWaitlist` and
  `mine`. Paying for a drop-in is a purchase and goes through `order.start` and the provider's page:
  the lint's purchase pattern gains `x.bookings.buy`, and the native booking blocks are marked
  `noPurchase`, so a member with nothing to spend is sent to the website (question 9). (Whether
  the app stores allow paying in an app for a class taken in person is **not checked here**; the
  platform's rule today keeps every payment on the web, and this proposal keeps it.)
- **Tools** (customer audience unless said): `timetable { from, to, classType?, coach? }` (public,
  read; places as `show` allows), `classGet` (public), `book { classId, holderId?, forPersonId? }`
  (returns `booked`, `waiting` with a position, or the reason it cannot: closed, no use, already
  booked, a clash), `cancel { bookingId }` (returns `cancelled` or `late_cancelled`, with a dry run
  first), `leaveWaitlist`, `mine { from?, to? }`, `buy { classId, email? }` (public; web only; a
  drop-in, below). Each is a reviewed opening of an operation to `customer` or `public` (ADR 0402).
- **Who can book for whom** (question 14): a customer books for themselves. Staff book for anyone.
  If a parent books for their children, that is a link between two People ("may book for") that the
  visibility seam reads: the parent sees and manages the child's bookings and the child's
  allowance spends. That link is platform work (identity-adjacent, its own ADR, set by staff only)
  and is not built unless question 14 asks for it.

### Paying for a drop-in at booking (question 8)
- **Proposed:** a visitor or member picks a class and pays for that class. `buy` creates the
  booking in a `pending` state that holds a place (a held claim, as an order's line does), and
  starts an order whose line is the booking at the class type's drop-in price (the host reads the
  price; `sellable` on the booking). A verified payment moves the booking `pending → booked` and
  confirms the place; the order expiring moves it to `expired` and releases the place. That is the
  new "a paid line moves a record that exists" declaration (`sellable.moves: { paid: "booked",
  expired: "expired", refunded: "cancelled" }`), the same transition engine and holds as Ticketing.
- A drop-in booking holds no allowance; a late cancel or no-show keeps the money (decided: no fee,
  no refund either), an in-time cancel refunds it through approval (guess; or a credit pass, a 32b
  record).
- **The other way** (question 8 (b)): the drop-in is a one-use pass (32b's guess), bought on the
  web, then spent by booking. No new declaration, two steps for the visitor, and the place is not
  held while they pay.
- The intro offer is 32b's pass type with one per Person; it is spent by booking like any pass.

### Recurring (standing) bookings (question 12)
- If wanted: a member (or staff) sets a standing booking on a series; when the host makes each
  class, it books them in that class's batch as if they had booked, with the same windows, places
  and spend. When it cannot (full: they join the waitlist; no use left; a clash), they are told and
  the standing booking stays. Ended by the member, by staff, or when their membership ends.
- Standing bookings are made **when booking opens** for that class, not at generation, so a
  member's standing booking does not take a place before others can book (guess).

### Attendance, check-in and no-shows
- **Three ways** (question 10): the coach marks the roster (`markAttended { bookingId }`, a tap per
  member on the class's roster, in the admin or the coach's app); the front desk scans the member's
  booking code with the door scanner (the native `DoorScannerScreen` with a Bookings check-in hook;
  `checkIn { code }` from a current read, as Ticketing's: one scanner wins, the other is told who
  was first); or a walk-in is booked and checked in at once by staff.
- **The code** is the booking's, made by the host as a ticket's is (`newGrantCode`) (guess: whether
  the host can fill a code on a record a tool created, not a grant, is checked at build; the other
  way is one code per member, shown in the app, that checks them into their booking of the next
  class).
- **A desk pack role** (`bookings.desk`, like Ticketing's `door`): check in, read today's classes
  and rosters, book walk-ins. A staff account holds at most one pack role (ADR 0436), so a front
  desk that also scans event tickets needs a role over both packs: **check at build**, and amend ADR
  0436 if pack roles must combine.
- **No-shows** (question 11): after a class ends (plus a grace, 30 minutes, guess), the host moves
  its still-`booked` bookings to `no_show`, **only if attendance was taken for that class** (a
  check-in or a roster mark), so a coach who forgot to mark the roster does not make the whole class
  no-shows; staff are told of classes with no attendance. The use is kept either way (decided).
  What a no-show leads to, if anything, is question 11.

### The staff side, from the host
- **Timetable**: series as a list and a week grid (the host's `calendar` view), with the classes a
  series made; closures; rooms; coaches.
- **Today**: the day's classes with places, waiting and checked in; each class's **roster** (its
  record page): who is booked, waiting (in order), cancelled late, checked in, with each member's
  uses left and a note if this is their first class; "today's workout" from Programs.
- **Moving people**: `move { bookingId, toClassId }` (staff): one batch releases the old place,
  claims the new one, moves the use, writes `moved` on the old booking and a new booking; refused
  whole if the new class is full (staff may raise its places first, audited, as stage 26 decided).
- **Promote by hand**: staff move a waiter in ahead of the order, with a reason.
- **Substitutions**: changing a class's coach (one class, or a series from a date); members are
  told only if question 16's settings say so (guess: not by default).
- **Cancelling a class** (`cancelClass { classId, reason, notify }`): the class moves to
  `cancelled`; in the same batch the host moves every `booked` and `waiting` booking to
  `cancelled_by_us` (a cascade declared on the class's states), every use is returned and every
  place released; paid drop-ins are refunded through approval or given a credit (question 15); each
  member is emailed. Destructive: an AI asks, a person approves.
- **Reports** (a Bookings dashboard over `rec_*` views): attendance by class type, time and coach;
  how full classes are (booked over places); late cancels and no-shows by member and by month;
  waitlist joins and how many got in; first-time visitors and whether they came back; uses spent by
  plan (with 32b). Saved views: "No-shows this month", "Late cancels this month", "Classes under
  half full", "First class this week".
- **A Person's page** gets a **Bookings** tab: upcoming, waiting, history, uses left (32b's
  Membership tab beside it).

### Reminders and messages (email; no SMS or push until stage 30)
Pack automations through the `email-send` gatekeeper, as Ticketing's:
- booked (with the code and an "add to calendar" file), promoted from the waitlist, a place free
  after the cut-off (to those waiting), class cancelled, class time changed, skipped on the
  waitlist (and why), a standing booking that could not be made;
- a reminder before the class (question 16): needs `dateRelative` with an offset in hours and
  minutes (platform, small; today it counts whole days), by the class's own zone.
- Promotion close to a class is only as good as email: push is stage 30's. Nothing here sends a
  push.

### Calendar feeds
- **An "add to calendar" file** (`.ics`) per booking, made by the host and attached to the booked
  email and linked from the booking (a small route; no ICS exists today).
- **A personal feed** (a private address per member, read only, that a phone's calendar
  subscribes to and that shows their upcoming bookings) is proposed for later (guess): it is a
  token that must be revocable, and phones refresh feeds on their own schedule, so a cancellation
  can show late.

### Time zones and clock changes
- A series' zone defaults to the organisation's (ADR 0460); each class stores its instant and zone;
  every member-facing time is shown in the class's zone, with the zone named only when the viewer's
  device is in another.
- Windows (opens, closes, late from) are lengths of time before the start instant, except a window
  that opens "at 00:00 seven days before", which is local (guess: both are offered).
- A week, for the allowance (32b's guess: Monday in the deployment's zone), is the class's local
  week; the series' zone and the organisation's are the same for a single-site gym.
- The shared helper (wall clock and zone to instant, across a clock change) is exported from core
  and used by `recurring`, closures, the import and `paidUpMoment`; tests cover both clock changes
  in the gym's zone and in one with a half-hour offset.

### Privacy: who sees who is in a class (question 13)
- Proposed default: members see how many are booked and their own place on the waitlist, never
  names. Coaches and the desk see the roster.
- If question 13 shows names to members: the host copies a display name (first name and initial)
  onto the booking when it is made, and the class's `signedIn` (or a booked-member-only read, which
  the seam does not have: "visible to others who hold one too" is new) shows them. A member can
  hide their name (a field on their booking or their Person, guess).
- A Person's other bookings, uses and history are never visible to another member, whatever the
  answer.

### What an AI assistant may do
Under the approval gate (ADR 0480's pattern: an AI asks, a person approves, where it matters):
| Action | Risk | Under `balanced` |
| --- | --- | --- |
| Read the timetable, rosters, attendance, reports | read | applied |
| Book a member into a class, cancel their booking, put them on a waitlist | write | applied, audited, the member emailed as for staff (guess; `alwaysReview` for the assistant if the owner prefers) |
| Move a member, promote by hand, mark attendance | write | applied, audited |
| Draft a timetable or a change to a series from text ("add a 07:00 yoga on Saturdays") | write on a draft, then a person applies it | the series change is `destructive` when it touches classes with bookings: a person approves |
| Cancel a class, end a series, add a closure | destructive (and outbound) | a person approves |
| Refund a drop-in | `payments.refund` | always a person (as built) |
| Change the booking rules (windows) | settings, `actors: ["human"]` | a person only |

Members' own AI clients reach only the customer tools, like any customer call (applied or refused,
never queued).

## Scope, 31b: appointments (question 1)
- **Services**: what may be booked one-to-one (a 60-minute session), which coaches give it, its
  price or which allowance pays it (32b's `spendsOn` names the service object), how far ahead, a gap
  after, the cancel rules (the same windows).
- **Availability**: a coach's open hours as series (`recurring` again, generating availability
  windows), with exceptions (leave) and their own classes taken out.
- **Slots** are computed, not stored: the host lists start times in a coach's availability, at the
  service's step, not overlapping a booked appointment or a class they teach.
- **A time-range claim** (platform): an appointment claims a coach's time from start to end; the
  database refuses two that overlap for one coach (a trigger over ranges), as capacity refuses
  places, so two members booking the same slot at once get one.
- Appointments spend a use or are paid like a drop-in; booked, cancelled, late cancelled, attended
  and no-show as classes are. Coaches see their day; members book on the web and in the app.

## What stage 33 needs from this stage (stage 33 runs the move)
`cos bookings import <folder>`, with import keys (each row's id in the old system), a dry run and
re-runs that change nothing, like `cos courses import` (ADR 0470's import door):
- **Class types, rooms, coaches**, matched by name or key.
- **The timetable**: series with their weekdays, times, coach, room, places and dates; one-off
  classes; closures. The host then makes the classes itself; imported classes are matched to the
  generated ones by series and local start.
- **Future bookings**, onto those classes, as the host: they claim places (a class over its places
  is reported as a conflict, not overfilled) and spend uses from the holders 32b's members import
  made (matched by the old system's keys), with the windows not applied; waitlists in order.
- **Visit history**: past classes and their bookings in their final states (`attended`,
  `no_show`, `late_cancelled`, `cancelled`), with no places and no spends, except **visits inside
  the current period**, which spend from the member's holder so "3 a week" is right on the day of
  the move.
- **Standing bookings**, if question 12 keeps them.
- **A period where both run**: the import can be re-run from a fresh export until the switch (new
  rows added, changed ones updated, nothing doubled); bookings made on the new host before the switch
  are kept.
What 33 decides (the switch date, freezing the old system, telling members) is not this stage's.

## What belongs to 32b or 33 instead
- **32b:** the `allowance` behaviour, memberships, passes, pass types, the intro offer, pauses and
  plan changes, members' billing, `cos memberships import`. This stage only declares the booking a
  spender and lists, above, what 32b's behaviour must also do.
- **33:** exporting from the current booking system, mapping its data to these import folders, the
  switch and the overlap, and moving billing (32's question 14).
- **Here:** the timetable and its classes, bookings and their rules, waitlists, attendance, the
  staff side, reminders, the import door for schedules, bookings and history.

## Out of scope
- Fees for a late cancel or a no-show (decided: none).
- Picking a spot (a bike, a mat): places have no identity (stage 26).
- Bringing a guest on your booking, unless question 14 asks for it.
- Several locations with their own timetables and reports beyond a room's name (guess: one site).
- Livestreamed or online classes.
- Waivers and forms before a first class (stage 29).
- SMS and push reminders (stage 30).
- Coaches' pay, rosters and timesheets (stage 40, which reuses `recurring`).
- Rules other than weekly (every second week, the first Monday of a month).
- Buying anything in the app.

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
4. **Windows:** a customer cannot book before it opens or after it closes; a cancel before "late
   from" returns the use and one after keeps it, decided by the host's clock; staff are not bound
   and their override is audited.
5. **Waitlist:** a freed place goes to the first waiter with a use, in the cancel's batch as a hold
   nobody else can take, then to them by promotion; a waiter with no use left is skipped and told;
   after the cut-off it goes to anyone; a race of a cancel, a direct booking and two promotions
   leaves the class at its places with no place lost.
6. **Cancelling a class** cancels every booking and waiter in its batch, returns every use, refunds
   or credits drop-ins as question 15 decides, and emails each member; it is refused to an AI
   without a person's approval.
7. **Attendance:** a booking checked in by two scanners at once is let in once and the second is
   told who was first; no-shows are written only for classes whose attendance was taken; the use is
   kept for late cancels and no-shows.
8. **Drop-in:** a visitor pays for a class on the web; the place is held while the order is unpaid
   and released when it expires; a verified payment books them; no native block can start one (the
   block lint).
9. **The app:** a member books and cancels with their membership in the native blocks against the
   fake host; the blocks calculate no price and check no capacity (the lint).
10. **Moves:** staff move a member to another class with their use in one batch, refused whole when
    the new class is full.
11. **Privacy and isolation:** a customer reads only their own bookings; other members' names are
    visible only as question 13 decides; stage 22's isolation test covers every Bookings object.
12. **Programs:** a class shows its class type's Programs session for its local date.
13. **Import:** `cos bookings import` loads a fixture timetable, future bookings and history; a
    re-run changes nothing; a class over its places is a conflict; current-period visits spend.
14. **Dashboard:** the Bookings dashboard's numbers match a fixture worked out by hand.
15. `pnpm lint typecheck test`, `cos ext check` and `cos ext test` on `packs/bookings`, and one e2e
    test per journey (book with a pass and cancel late; join a waitlist and be promoted; pay for a
    drop-in; the coach's roster) pass in CI; ADRs for each platform piece; CONTEXT.md (Class type,
    Series, Class, Booking, Waitlist, Promotion, Late cancel, No-show, Closure, Appointment,
    Service, Availability) and `docs/architecture.md` updated.

31b:
16. **Appointments:** two members booking one coach's same slot at once get one; a coach's classes
    and leave are never offered as slots; an appointment spends or is paid as a class is.

## Dependencies
- Stages 25, 26, 27, 41 and 32a (merged).
- **32b, built beside this stage:** the `allowance` behaviour (32b's build step 5) with the
  amendments above, before this stage's step 4. Until then the booking's spend is proved against
  32b's fixture holder.
- Stage 30 only for push and SMS (not needed); stage 29 only for waivers (not needed).
- Stage 33 for the gym's move; it needs step 9 here.

## Migrations and numbers
Proposed: migrations 0560 to 0579 (capacity claimants and waitlist holds, time-range claims,
declared uniqueness, the `recurring` bookkeeping, the person link if question 14 wants it) and
ADRs 0500 to 0509, claimed in [`parallel-work.md`](../parallel-work.md) as block AI. The build
confirms the claim in its first commit.

## Suggested build order
31a:
1. The shared wall-clock helper; **the `recurring` behaviour** with a fixture series and the
   clock-change tests.
2. **Capacity claimants** (a record's states hold and release its claim), declared uniqueness, and
   **time windows on creates and moves** in the transition engine.
3. **The Bookings pack's spine**: class types (on Programs'), rooms, coaches, series, classes,
   bookings; book and cancel with the windows; the timetable read; staff booking.
4. **Spending** with 32b's `allowance` (amended as above): spend on `booked`, the class's time as
   the period, time-of-day and class-type conditions, give-back on in-time cancels.
5. **The waitlist and promotion**, with the race tests.
6. Attendance (the roster, the scanner, the desk role), no-shows, moving people, cancelling a class
   (the cascade), closures.
7. **Drop-ins** (`sellable.moves`) and the drop-in refund or credit.
8. Emails and reminders (`dateRelative` in hours), the "add to calendar" file, the dashboard, views,
   the Person tab, hooks and blocks (web and native); standing bookings if question 12 wants them.
9. `cos bookings import` for stage 33.
31b:
10. Services, availability, time-range claims, appointments.

**The spine is steps 1 to 4**: a timetable that makes classes, a booking that holds a place inside
its windows and spends a real allowance. Steps 2 and 32b's step 5 can run in parallel sessions;
they meet at step 4.

## Questions for the interview
Ordered by how much each changes the build. Each is answerable without reading the spec; several
ask what the gym does today, which only the gym knows.

1. **Personal training and other one-to-one sessions: are they booked in your current booking
   system today?**
   - (a) Yes, members book them themselves at times the coach has open.
   - (b) Yes, but staff book them for members.
   - (c) No, they are arranged another way.
   **Recommended: build classes first and one-to-one bookings second, in either case.** Classes
   are what every member books every week; one-to-one booking is a different engine (a coach's
   open hours, not places in a class). (a) or (b) says how soon the second part is needed; (c)
   means it can wait.

2. **How far ahead can members book a class, and until when?**
   - (a) Up to 7 days ahead, until the class starts.
   - (b) Up to 14 days ahead, until 1 hour before.
   - (c) Something else: tell us your current setting.
   **Recommended: keep exactly what your members are used to today (c), with one rule for the gym
   and a different one only for class types that need it.** Changing booking habits at the same
   time as the move adds confusion.

3. **When does a cancel become late (they lose the class from their membership or pack)?**
   - (a) Less than 12 hours before the class.
   - (b) Less than 24 hours before.
   - (c) Less than 2 hours before.
   - (d) Something else, or it differs by class type: tell us.
   **Recommended: your current rule.** Already decided: a late cancel costs no money, the class is
   just used up. An on-time cancel always gives it back.

4. **A place opens in a full class. What happens to the first person on the waitlist?**
   - (a) They are booked in automatically and emailed.
   - (b) They are emailed an offer and have a set time (say 30 minutes) to accept, then it goes to
     the next person.
   - (c) Everyone waiting is emailed and the first to tap gets it.
   **Recommended: (a).** It fills the place without anyone racing, and it is what most members
   expect from joining a waitlist. Its risk is someone booked in who no longer wants it, which the
   cut-off in question 5 limits. (b) leaves places empty while people do not read email; (c)
   rewards whoever is on their phone.

5. **How close to the class do you stop moving people up from the waitlist?**
   - (a) 2 hours before.
   - (b) 30 minutes before.
   - (c) Right up to the start.
   **Recommended: (a), or your current rule.** Without app notifications (they come later), a
   person moved in 10 minutes before a class may not see the email, and would then be a no-show
   through no fault of their own. After the cut-off the free place is open to anyone and the
   people waiting are told.

6. **While people are waiting, can someone else book the freed place first?**
   - (a) No: a freed place always goes to the waitlist first.
   - (b) Yes: whoever books first gets it.
   **Recommended: (a).** It is fair to the people who joined the waitlist, and the system holds the
   place for them so nobody can take it in between.

7. **Does joining a waitlist use up a class from someone's membership or pack?**
   - (a) No, only when they are moved into the class. If they have none left by then, they are
     skipped and told.
   - (b) Yes, it is set aside when they join and given back if they never get in.
   **Recommended: (a).** Members can wait for several classes without their week's classes being
   locked up; (b) can stop someone booking a class with space because their classes are tied up on
   waitlists.

8. **How does someone pay for a single class (a drop-in)?**
   - (a) They pick the class on the website and pay for that class; their place is held while they
     pay.
   - (b) They buy a single-class pass on the website first, then book with it.
   - (c) They pay at the front desk; staff book them in.
   **Recommended: (a), with staff still able to book walk-ins (c).** One step for a newcomer is the
   first impression the gym makes; (b) is simpler to build but makes a visitor do two things and
   does not hold the place while they pay.

9. **What can members do in the gym's app?**
   - (a) Book, cancel and join waitlists with the membership or pack they already have; buying
     anything (a drop-in, a pack, a membership) is on the website.
   - (b) Everything, including paying for a drop-in in the app.
   - (c) See their bookings only; booking is on the website.
   **Recommended: (a).** Booking with a pass they own moves no money, so it fits the platform's rule
   that paying happens on the website; (b) needs checking against the app stores' payment rules
   first; (c) makes the app much less useful.

10. **How do you record who came to a class?**
    - (a) The coach ticks names on the class list on a phone or tablet.
    - (b) Members show a code in the app at the front desk and staff scan it.
    - (c) Both.
    - (d) We don't record it.
    **Recommended: (a) for every class, plus (b) if you have a front desk.** The coach's list works
    everywhere; scanning is quicker with a desk and reuses the event-ticket scanner.

11. **What happens when someone books and doesn't turn up (a no-show)?**
    - (a) It is recorded and they lose that class (already decided); nothing else.
    - (b) As (a), and after a set number of no-shows in a month they cannot book for a week.
    - (c) It is not recorded at all.
    **Recommended: (a).** It needs nothing more, and staff can see repeat no-shows in a report and
    talk to the member. A no-show is only recorded for classes where attendance was taken, so a
    forgotten class list never punishes anyone. (b) is a rule to explain and to undo when it is
    wrong.

12. **Can members set a standing booking ("every Tuesday at 6am") that books itself each week?**
    - (a) No, members book each class themselves.
    - (b) Yes, members can set one; it books each week while their membership allows, and tells
      them when it can't (class full, none left).
    - (c) Yes, but only staff can set one up.
    **Recommended: (a), unless your members use this in your current booking system today.** It is
    the most complex part to get fair (standing bookings can fill a class before others can book),
    so build it only if it is used now.

13. **Who can see who is booked into a class?**
    - (a) Members see only how many places are left; names are for coaches and staff.
    - (b) Members booked into the class see first names and an initial, and can hide theirs.
    - (c) Everyone signed in sees the full list.
    **Recommended: (a).** It is the private default and needs nothing extra; (b) is a nice social
    touch some gyms want, and can be added later.

14. **Who can a person book for?**
    - (a) Only themselves; staff can book anyone.
    - (b) Parents can also book for their children (kids' classes).
    - (c) Members can also bring a friend as a guest on their booking.
    **Recommended: (a), unless you run kids' classes or guest passes today.** Each of (b) and (c) is
    real extra work (a family link between people, or a guest who is not a member), so build only
    what is used.

15. **When the gym cancels a class, what does a person who paid for a drop-in get?**
    - (a) Their money back to their card.
    - (b) A free class to use another time.
    - (c) They choose.
    **Recommended: (a).** It is the clearest and needs no new kind of credit; a refund is approved
    by a staff member as every refund is. Members always get their class back from their
    membership or pack, whatever the answer.

16. **Which reminders and messages should members get?**
    - (a) An email when they book (with an "add to calendar" button) and when the gym cancels or
      changes their class.
    - (b) As (a), plus a reminder email before each class (say 2 hours before).
    - (c) As (b), plus an email when a coach is swapped.
    **Recommended: (b).** Booking confirmations and cancellations are essential; a reminder cuts
    no-shows; coach swaps are frequent and most members don't need an email for each. App
    notifications and text messages come with a later stage.

## Sources
Read 2026-11-22, all in this repository: ADRs 0404, 0425, 0430 to 0437, 0449, 0460, 0477 and
0487; stages 26, 27, 32 (32b and the interview's answers), 41 and 42; `packages/core/src/capacity/`
(`index.ts`, `holds.ts`, `records.ts`), `packages/db/migrations/0440_capacity.sql`,
`packages/core/src/orders/` (`holds.ts`, `grants.ts`, `guests.ts`, `late.ts`),
`packages/core/src/operation.ts`, `gate.ts`, `audiences.ts`, `visibility/`,
`subscriptions/offers.ts` (`paidUpMoment`), `settings.ts`, `packages/sdk/src/` (`capacity.ts`,
`sellable.ts`, `automation.ts`, `manifest.ts`), `packs/ticketing` (manifest, tools, automations,
native blocks), `packs/programs` (`classtype`, `assignment`, `session`, `classToday`),
`apps/runner/src/index.ts` and `automations/schedule.ts`, `scripts/check-blocks.mjs`.

Not found or not confirmed: the gym's actual rules (booking window, late-cancel window, waitlist
cut-off, kids' classes, standing bookings: the questions); whether the app stores' rules allow
paying in an app for a class attended in person (not checked; the proposal keeps payment on the
web); whether the host can fill a code on a record a tool created (the booking's code); whether
pack roles can combine (a desk that scans tickets and classes); how the current booking system
exports schedules, future bookings and visit history (stage 33's to find out).
