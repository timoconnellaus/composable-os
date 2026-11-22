# ADR 0506: A spender paid another way (`waived`)

Status: accepted, 2026-11-22 (stage 31a, build step 3). Extends
[ADR 0493](0493-the-allowance-behaviour.md).

## Context
A booking spends a use when it enters `booked`, and the database refuses the batch when its
Person has nothing that can pay (ADR 0493). But a gym books people who hold nothing: a walk-in
who pays at the desk, which staff book in (spec 31, decision 8 (c)), and later a drop-in paid by
its own order (step 8: "a drop-in booking holds no allowance"). Without a way to say "paid another
way", such a booking is refused `no_holder`, for staff too, and a pack would have to model it as a
state of its own outside `booked`, which breaks the claims, the uniqueness and every later step
that reads `booked`.

## Decision
- **A spender may declare `waived: "<field>"`**, a read-only boolean field of its own. A record
  created with it true enters its spend states and spends nothing; it holds no use, so it gives
  nothing back.
- **Who sets it**: the host and the declaring extension's own code only (it is read-only), never a
  customer (the SDK refuses it in `customer.write` or a tool's `customerFields`). The Bookings pack
  sets it from staff's `bookFor { paidAtDesk }`; step 8's drop-in will set it as the host.
- **It is decided when the record is made**: a change of the mark while the record is in a spend
  state or holds a use is refused (`invalid_input`, `rule: "allowance"`, `reason:
  "waived_kept"`), for every actor, the host included: turning it on would let a booking skip a
  use it owes; turning it off would leave one unpaid.

## Consequences
- Booking someone free is staff's (a `write` tool, audited); the assistant may do it under the
  approval policy as for any staff booking.
- Counts of uses spent do not count bookings paid at the desk; the class's places do.

## Proof
`packages/core/test/bookings-platform.test.ts`: a desk booking spends nothing and leaves the pass
as it was; the host cannot clear the mark while it is booked, nor set it on a paid booking.
`apps/runner/test/bookings.test.ts`: staff book a walk-in into a staff-only class paid at the desk
(no use, a place taken), cannot clear the mark, and without it a walk-in with nothing is refused.
