# ADR 0865: A field locked in some states, and a write made only while in one

Status: accepted, 2026-11-26 (stage 59, the second review of PR #491, issue #498). Block BU.
Extends [ADR 0425](0425-one-transition-engine-for-stages-and-states.md) (`states`) and
[ADR 0437](0437-a-move-is-made-from-a-current-read.md) (`record.update { from }`); no migration.

## Context
The second review of PR #491 found the out-of-service bypass again, by a write that is not a
delete: a member takes treadmill TM-03 out of service, changes its tag to `TM-03-OLD`, and makes a
new item tagged `TM-03`, which starts in service. The sticker on the machine that must not be used
now names a record that says it may be. The tag must not change while the item is out of service.

Two ways were open. The tag could be `readOnly` with a manager's `retag` tool, but a read-only
field cannot be set by a form or the admin's import either, and loading a register from a
spreadsheet (stage 59, criterion 15) needs the tag. Or the field could be locked only in the states
where changing it does harm. That is a rule about a field in a state, which is the host's to hold
for every writer (ADR 0405), and the platform had no way to say it.

The same review found a manager's correction of why an item is out (`correctOutReason`) written
after a read of the state with nothing holding it there: a put-back landing in between leaves a
reason on an item in service. `record.update { from }` holds a write to a state, but only a write
that moves the record out of it.

## Decision
- **`lockedIn: [<states>]` on a field** of an object with `states`: while the record is in one of
  those states, a write that changes the field is refused (`invalid_input`, `rule: "field_locked"`,
  "Item's tag does not change while it is out of service"), for every caller but the host and the
  field's own extension's code (its tools and automations, which the pack writes on purpose). A
  value written unchanged (after the host's folding, ADR 0864) is not a change. The contract
  refuses it on the state field and on a formula, and names states the machine does not have. It
  binds updates; a record is created in its initial state.
- **`record.update { while: <state> }`**: write only if the record is in that state when it is read,
  and leave it there; refused as a conflict (`reason: "not_in_position"`) when it is elsewhere, and
  held at commit by the `unmoved` guard (migration 0670), so a move landing before the commit fails
  the batch. A write naming `while` that would change the state is refused. It is `from`'s pair for
  a correction that holds only in one state.
- **Equipment** locks the item's tag in `out_of_service` (the rule chosen: the tag changes only
  while the item is in service, since retired is final and its tag is free, ADR 0862), and its
  manager's corrections write with `while`.

## Consequences
- Any pack may lock a field in the states where changing it would undo what the state protects,
  without a tool for every edit.
- The test host (`@composable-os/sdk/testing`) holds `while` as the host does.

## Proof
`apps/runner/test/equipment.test.ts`, "the second review (issue #498)": a member's, a manager's and
an admin's retag of an out-of-service item is refused, a new item with its tag is refused, the same
tag written again is no change, and in service the tag changes; `record.update { while }` is refused
when the record is elsewhere and applied when it is there. With `lockedIn` taken off the tag, the
retag test fails.
