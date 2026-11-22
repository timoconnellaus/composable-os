# ADR 0572: Bookings' messages, the dashboard and the coach's screen in the app

Status: accepted, 2026-11-23 (stage 31a, build step 9). The pack's part, over
[ADR 0570](0570-date-relative-triggers-in-minutes.md) (triggers in minutes) and
[ADR 0571](0571-a-calendar-file-made-by-the-email-gatekeeper.md) (the calendar file). Extends
[ADR 0504](0504-the-bookings-pack.md); reads what ADRs 0520 (the waitlist), 0540 (the family link),
0553 (cancelling a class) and 0560 (drop-ins) have the host record.

## Context
Decision 16: an email on booking (with "add to calendar"), on a change or a cancellation by the gym,
and a reminder before each class; coach swaps are not emailed. Earlier steps left their messages
here: promotion and being passed over on the waiting list, a place free after the cut-off
(criterion 5), a parent told of their child's booking (ADR 0540, reading `madeBy`), the drop-in's
payment and refund (ADR 0560), staff told of classes with no attendance taken (ADR 0550), and the
coach's list in the gym's app (step 7).

## Decision
**Messages are automations** (`packs/bookings/automations.ts`) through the `email-send` gatekeeper,
one connection a person binds per automation, each send an outbound action the approval policy
decides. They read what the host wrote and write nothing.

| Automation | Trigger | Who | What |
| --- | --- | --- | --- |
| `bookingConfirmed` | a booking created or updated, while `booked` (each change its own run) | the booking's addressees | booked, booked and paid (a drop-in), moved in from the waiting list, or moved by staff; with the calendar file |
| `waitlistPassedOver` | `passedOverReason` changed, while `waiting` | the waiter's addressees | why they could not be moved in; still on the list |
| `placeFree` | a booking `booked` → `cancelled`, `late_cancelled` or `excused` | the addressees of each waiter on that class | a place is free, first to book gets it (only after the cut-off, with a place free) |
| `classChanged` | a scheduled class updated (bulk too; each change its own run) | addressees of its booked, held and waiting bookings | its new time or room; an updated calendar file to the booked. A coach swap sends nothing |
| `classCancelled` | a class `scheduled` → `cancelled` (bulk too: a closure) | addressees of its `cancelled_by_us` bookings | cancelled, the reason, nothing used; a paid drop-in's money back once approved; a cancelling calendar file |
| `classReminder` | `minutesBefore` its start: the class type's reminder, else the organisation's (3 hours) | addressees of its `booked` bookings | the time and room |
| `dropInRefunded` | an order → `refunded` that paid for a booking | the order's own address (the payer) | the refund was made |
| `noAttendanceTaken` | `minutesAfter` 60 its end, while scheduled | the admins, in the app | people were booked and nobody was marked |

**A booking's addressees** are its Person, if they have an address, and each guardian with a live
link to that Person (ADR 0540), if they have one: one email each, one recipient each, so no email
shows another member's address or names another member. `madeBy` (host-set) only words the email
("You booked Sam"); it never adds a recipient, so a parent whose link ended hears nothing more. A
visitor's drop-in held while unpaid has no Person and no addressee. Not emailed: a coach swap, a
booking the member cancelled themselves (the screen says so), anything for a booking that is not
the addressee's or their child's.

**Exactly once.** A record event starts one run per change (the queue's redelivery is the same
run); the booked message is read from the change, and a creation read after the booking was moved
in or paid for is left to that move's run, so a booking gets one booked message. The two record
triggers set `debounceSeconds: 0`: coalescing a record's updates into one run would lose the
change that matters. The reminder is one run per class and start time (ADR 0570), starts only for
a scheduled class, and writes only to bookings still booked when it runs. A send step that failed
part way is retried whole (as Ticketing's are): the gatekeeper does not deduplicate sends.

**The dashboard** (`dashboards.ts`, "Bookings") is read-only SQL over `rec_*` and `rec_capacity`
for the classes in the chosen dates, a cancelled class counting for none: came, no-shows, late
cancels, how full (taken over places), attendance by class type, local hour and coach, late cancels
and no-shows by month and by member, waiting-list joins and how many got in, first visits and how
often they came back. Saved views: no-shows and late cancels this month. Uses spent by plan stay on
the Memberships dashboard (Bookings does not require Memberships).

**The coach's screen in the app** is a native block, `bookings-native-class-list`, over the
coach role's client: today's classes, a class's list, tick, untick and not come. It is
`noPurchase`; it books and cancels nothing (the owner decided the app books and cancels only for
members, and coaches tick the list).

**Settings**: `bookingsUrl`, the page linked from every email; the reminder's minutes are bounded to
two days (2,880) on the class type and the organisation.

## Consequences
- Under Balanced every email waits for a person's approval (an automation's outbound action), as
  Ticketing's do: a gym turns on Autonomous, or approves them, until the platform has a reviewed
  kind for a pack's transactional mail. Not loosened here: loosening approval is a human admin's
  decision, and the kind would be the platform's (ADR 0456 shows the shape).
- A closure that cancels more than 60 classes in a minute meets the automation rate limit and
  pauses `classCancelled` (admins are told); its runs past the limit are dropped.
- There is no unsubscribe: these are the member's own transactional booking emails, and the
  platform has no customer preferences until stage 30.
- "Classes under half full", "First class this week" and "Classes with no attendance taken" are not
  saved views: a view cannot filter on a ratio of places or across bookings; the dashboard and the
  staff notice show them.

## Proof
`packs/bookings/test/automations.test.ts` (each automation: triggers, addressees, words, calendar
events, what sends nothing), `apps/runner/test/bookings-messages.test.ts` (the shipped packs through
a real email-send gatekeeper and the fake Email Service: criterion 13 and criterion 5's emails, the
parent, a redelivery, an AI's cancel sending nothing until approved, Balanced holding every send),
`apps/runner/test/bookings-dashboard.test.ts` (criterion 16: every widget against a fixture worked
out by hand).

## Amended 2026-11-23, after the review of PR #256
- **A burst is never dropped**: runs over the runs-per-minute rail wait their turn
  ([ADR 0573](0573-runs-over-the-rate-rail-wait-their-turn.md)); the consequence above about a
  closure of more than 60 classes no longer holds. Every member of a 70-class closure is told
  once.
- **A retried send step re-sends nothing**: each email carries `<runId>:<n>` as its idempotency
  key ([ADR 0574](0574-an-idempotency-key-on-an-email-send.md)).
- **A visitor who paid is told**: a booking with no Person (a drop-in staff have still to settle,
  ADR 0560) is written to at the order's own address once paid, about that booking only:
  `dropInOrder` (was `dropInRefunded`) tells them their payment was received and the place held,
  and the change, cancellation and reminder reach them as they reach members. An unpaid hold
  still hears nothing.
- **A move** takes the old class's event off the calendar and adds the new one's (two files).
- **Several changes to one class** within two minutes are told once, by the run that changed it
  last, with what is true then (the runs agree through the pack's storage; each change keeps its
  own run, `debounceSeconds: 0`, so none is lost). Changed and changed back tells nothing; a
  change of the end alone is told, with an updated file. The same for several places given back
  after the cut-off (`placeFree`).
- **A calendar's SEQUENCE** is seconds since 2020 (minutes collided for two changes in a minute).
- `bookingsUrl`, the link in every email, is a person's to change (`personApproves`).
- The dashboard's widgets open records only where a list filter says exactly which: the booking
  counts (classes in the dates) open nothing, since a booking list cannot filter on its class's
  start.
- A guardian in the Trash is not written to (person.get does not answer for them).
