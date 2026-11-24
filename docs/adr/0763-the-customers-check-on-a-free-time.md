# ADR 0763: The customer's check on a free time, and staff warnings

Status: accepted, 2026-11-24 (stage 49, build step 4). Amends
[ADR 0503](0503-time-windows-and-staff-only-on-the-transition-engine.md) (what the transition
engine judges of a customer's create and move), [ADR 0622](0622-warnings-in-a-writes-answer.md)
(the warnings a write is made with) and, for a customer booking a free time,
[ADR 0626](0626-the-rostering-pack-and-bookings-additions.md) (who says who works a shift). Builds
on [ADR 0762](0762-open-hours-and-free-times.md) (open hours and free times),
[ADR 0760](0760-claim-margins-and-a-required-account-on-staffed.md) (margins, a required account)
and [ADR 0765](0765-occupies-the-claim-on-a-thing.md) (rooms).

## Context
Members and visitors book one-to-one sessions themselves (stage 49 decision 2). The database
already refuses a double-booking for everyone, but a customer could still book a time the
provider is not open, is away, or that leaves no room or no buffer, or for longer than the
service lasts. A check in the pack's tool binds only that tool; a customer's record write, the
native client and a record the host makes for a visitor paying must meet the same rule, so it
lives in the host (ADR 0404). Staff book for a client at any time, including outside open hours,
and must be told rather than refused.

## Decision
- **`staffed.open.customer: true`** turns the check on. A create or a move by a customer or the
  public of such a shift that is live (a create; a change of its person, times, kind, client or
  room; a move into a live state) must be on a time `freeTimes` answers for its person, with the
  kind's length exactly, and, when the kind names rooms, a room of its that is free then. It is
  refused `conflict`, `rule: "not_free_time"`, naming no reason beyond "not free" (and the field:
  the end for a wrong length, the room), and nothing is written. A cancel is never refused for its
  time.
- **Every door, one check** (`assertOnFreeTime`, `staffing/free.ts`): the transition engine's
  `place` for a customer's own create and update (a pack's tool, a customer's record write, the
  typed client), after the create rules' window, which keeps its own answer; and
  `assertCreateRules` for a record the host makes for a customer or visitor (a held booking being
  paid for, `order.startHeld`). The read is in the batch that writes; the time claim's and the
  room claim's triggers still decide a race, so of twenty customers booking one coach's last
  time at once exactly one commits.
- **Staff are warned, never refused for it** (ADR 0622 amended). A staff write of such a shift,
  not yet ended, is made with `outside_hours` (its person's open hours for the kind do not cover
  it) and `client_busy` (its client has another live one overlapping), beside `unavailable`,
  `not_qualified` and `uncovered`. A clash stays a refusal (`double_booked`, `room_taken`).
- **A customer's booking is not rostering.** A customer naming the provider of such a shift is
  not "saying who works it" (ADR 0626): the check decides it (a qualified provider, free then),
  so it is not a rosterer's even where Rostering is installed. A customer's or the public's write
  of a staffed record is answered with no staff warnings (they would say who is away) and tells
  the roster nobody (a booked shift is private and never offered; the provider hears through the
  pack's own messages, step 6). The staffing code's acting account for such a write is the
  caller's stand-in, never a staff account.

## Consequences
- Bookings' appointments (step 5) declare it; the pack's book, move and pay tools (steps 6 and 8)
  answer `not_free_time` with the times still free, from `staffing.free`.
- A staff write naming a provider for a client is still a rosterer's where Rostering is installed
  (ADR 0626); step 5 decides whether `bookings:appointments` covers it.
- The room a customer's booking takes is the one it names: the host choosing the first free room
  when none is given is step 5's.
