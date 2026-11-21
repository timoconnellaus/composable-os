# ADR 0437: A move is made from a current read, or not at all

Status: accepted, 2026-11-21 (stage 27, build step 3). Amends
[ADR 0425](0425-one-transition-engine-for-stages-and-states.md).

## Context
Checking a ticket in moves it from `valid` to `used`. Two coaches can scan the same code at the
same moment, and the spec asks that it is accepted once. A tool cannot make that true: its
calls are separate operations, and a read followed by `record.update` is the race itself. The
host's own write was not safe either. `record.update` reads the record, the transition engine
judges the move from that read, and the batch closed the record's current history row and opened
the next one unconditionally. Two updates judged from the same read both committed: two moves
into `used`, the second overwriting who and when.

`core_transition_history_current_idx` (migration 0420) already says a record has one current row.
It never fired, because each batch closed whatever row was current before opening its own.

## Decision
- **The engine's close is conditioned on the record's position.** When a write moves a record,
  the engine queues the close itself, before the caller queues the record's own write, as
  `UPDATE core_transition_history SET left_at = ? WHERE … AND left_at IS NULL AND EXISTS (SELECT 1
  FROM <object's view> WHERE id = ? AND <position column> IS <the position read>)`. If another
  write moved the record in between, nothing is closed, and opening the next row breaks the
  one-current-row index: the batch fails and nothing is applied. `toOperationError` answers it as
  `conflict` with `reason: "moved_meanwhile"`. Nothing is read for it; the guard is the statement.
- It reads the record, not the history, so a current row left behind by an older path (a
  position changed outside the engine, or a stage cleared) is closed by the next move, and a
  record with no history moves as before.
- **`record.update` gains `from`:** "move only if it is still in this state (or stage), and move
  it out of it". The write must move the position (otherwise `invalid_input`), and a record that
  is no longer in `from` when it is read is refused as `conflict` with `reason:
  "not_in_position"` and the current position. Without `from`, a write that reads the record
  after another moved it is an edit, not a move, and succeeds: `from` is how a caller says the
  move is the point. With it, of any number of writes expecting `from`, exactly one moves the
  record.
- The SDK's test host honours `from` the same way.

## Proof (`packages/core/test/transition-race.test.ts`; check-in in `apps/runner/test/ticketing.test.ts`)
Eight `record.update { from: "valid" }` calls at once on one record: one wins, the others are
conflicts, the history has one move. Three stage moves at once on one deal-like record: one wins.
Six check-ins of one code at once through the pack's tool, as two different staff accounts: one
accepted, five told who was first, one move into `used`. Made unconditional again, the first
core test lets two writes through and the stage test three; with `from` taken out of the check-in
tool (check, then write), five of six scans are accepted.

## Consequences
- Every lifecycle write in the host, for every actor, is now a compare-and-set on its position.
  A write that lost a race fails as a conflict instead of silently stacking a second move. A
  caller that should simply retry (an import, an automation) reads the record again.
- Orders keep their own version column (ADR 0427); the guard applies to them too and agrees.
- The close statement reads the object's view by primary key once per move.
