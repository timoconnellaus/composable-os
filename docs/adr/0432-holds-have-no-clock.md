# ADR 0432: Holds have no clock; whatever owns a claim confirms or releases it

Status: accepted, 2026-11-21 (stage 26, build steps 3 and 5). Builds on
[ADR 0430](0430-capacity-is-refused-by-the-database.md).

## Context
The interview decided that a place is held for as long as the order it was taken for is unpaid,
and that the order's expiry is the only clock. Two clocks could release a place under an order
that may still be paid. The stage 27 interview added that an order may be part paid (a deposit,
the balance due by a date) and keeps its hold for that whole time, possibly weeks.

## Decision
- **No `holdFor`, no expiry on a claim and no sweep.** Nothing in capacity reads a claim's age.
- **Host-side functions, queued in the owner's own batch** (`packages/core/src/capacity/`):
  - `queueClaim(ctx, { object, record, quantity, for })`: `claimStatements` (ADR 0430), or in the
    approval queue's dry run a refusal judged against the counter as it is, claiming nothing.
  - `confirmStatements(target, now)`: held to taken, on the record and on the pool.
  - `releaseStatements(target, now, { confirmed? })`: held claims back (cancelled, expired), or
    with `confirmed` taken claims back (a refund, when the object releases on refund).
  - `target` is one claim (`{ claim }`) or everything taken for something (`{ for: { type, id } }`).
- **Each is three statements whatever the number of claims**, with no read before them: the
  counters by the claims' records, the counters by the pools the claims drew on (sums over the
  claims), and the claims' state. They match only claims in the state they move from, so
  confirming or releasing twice changes nothing. Places return to the pool the claim drew on.
- **Orders are wired by stage 25's second half.** This stage ships the functions and a fixture
  claimant (`packages/core/test/capacity-behaviour.test.ts`). The order's create queues a claim per
  line; `paid` confirms; `cancelled` and `expired` release; a refund releases unless the object
  says `releaseOnRefund: false`; honouring a late payment claims again and may be refused.

## Consequences
- The platform may briefly show fewer places than there are (after an order expires and before
  the minute cron moves it) and can never sell more.
- A confirm finds its holds however old they are; a payment for an order whose holds were already
  released is stage 25's late payment case, and confirming then changes nothing.
