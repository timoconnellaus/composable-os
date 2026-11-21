# ADR 0430: Capacity is refused by the database, in the batch of the write that needs it

Status: accepted, 2026-11-21 (stage 26, the spine: build steps 1 and 4). Settles the `capacity`
row of [ADR 0404](0404-behaviours-are-the-vocabulary.md).

## Context
A record can have a limited number of places, and the platform must never give out more than
there are, however many ask at once (stage 26). Every operation's writes go out as one D1 batch
with its audit row (ADR 0018), and a D1 batch is a transaction. A read of the count followed by a
write is a race: two buyers both see one place left. The interview chose to put the refusal in a
statement that fails, so that the batch, including the order it belonged to, is not applied, and
asked the build to prove that D1 behaves that way before anything else.

## Decision
- **The host keeps a counter row per record with a capacity** (`core_capacity`, migration 0440):
  places (null is unlimited), held, taken, and the pool it draws on, if any. The record's own
  number field is what staff edit; the counter is the host's.
- **A claim is three statements queued in the caller's batch, with no read before them**
  (`claimStatements`, `packages/core/src/capacity/`): `held = held + n` on the record's counter,
  the same on the counter its pool names (no row matches when there is none), and the claim row
  (`core_capacity_claim`), which copies the pool it drew on from the counter. One level of pool
  only: the claim touches the record and its direct parent, never further.
- **The database refuses.** `core_capacity_within_places`, a CHECK that `held + taken` never
  exceeds `places`, is the guarantee for any write to the row. A BEFORE trigger with the same
  condition refuses first, with `core_capacity_refused {json}` naming the counter, what was asked
  and what was left, so the host reports the refusal without a read: `toOperationError` turns it
  into `invalid_input` with details `{ rule: "capacity", object, record, asked, available }`.
  The same trigger refuses places set below what is claimed, with the numbers.
- **A claim on a record with no counter fails the batch** (the claim row's foreign key to the
  counter), so it can never be silently unlimited. Unlimited is a counter with null places, which
  still counts what is claimed.

## Proof (acceptance criterion 1, `packages/core/test/capacity.test.ts`)
Against the D1 binding in workerd, through the real pipeline, with a fixture claimant: 500 claims
of 1 at once against 100 places give exactly 100 held and 400 refusals with the details; a pool of
60 over two records of 50 gives 60. Both hold when every claimant is in flight before any batch
commits. With the CHECK and the triggers removed, all 500 succeed; with only the triggers
removed, the counts still hold and only the details are lost. A read-then-write control under the
same rush sells all 500.

## Consequences
- Whatever owns a claim (an order, later a booking) queues it in its own write; there is no
  separate claim operation and no check-then-write anywhere.
- The refusal message relies on SQLite accepting an expression as `RAISE`'s message. Workerd's
  SQLite does. If a D1 database ever did not, the migration would fail to apply rather than the
  rule silently weakening, and the CHECK alone still holds the limit.
- **Before release** (review, 2026-11-21): migration 0440 must be applied once to a real remote
  D1, checking that it accepts `RAISE` with an expression as its message and that the trigger's
  message reaches the host through D1's error (a refused claim reports `asked` and `available`).
  If it does not, the fallback is to drop the triggers and, on a CHECK failure only
  (`core_capacity_within_places`), read the counter after the refusal to fill in the numbers. The
  CHECK stays the guarantee either way.
- A refusal names the counter that refused: the pool's when the pool is full (review,
  2026-11-21).
- The local proof runs on workerd's D1 simulation, which, like D1, runs one statement at a time
  per database. It does not measure production latency.
