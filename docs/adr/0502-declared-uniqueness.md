# ADR 0502: Declared uniqueness, refused by a partial unique index

Status: accepted, 2026-11-22 (stage 31, build step 2).

## Context
"One active booking per Person per class" must hold for a member double-tapping Book, for two
devices at once, for staff and for an import. The reconciler had no unique rule an extension
could declare (only a slug's own index, ADR 0442), and a read before the write cannot stop two
writes that both read "none yet".

## Decision
- **The declaration**: `unique: [{ fields, states? }]` on an object, up to four rules of one to
  four single-valued stored fields. With `states`, only live records in those states count; a
  record with any of the fields empty is not counted.
- **The database enforces it**: the reconciler builds a partial unique index per rule on the
  extension's own table, `WHERE deleted_at IS NULL AND <fields> IS NOT NULL AND <state> IN
  (...)`, named `<table>__<columns>__u<hash of the rule>` so a changed rule is a new index and the
  old one is dropped. A second record, or a move back into a counted state, fails its batch
  whoever writes it; `errors.ts` answers `conflict`, `rule: "unique"`.
- **A read before the write** gives the common case a clear message (`There is already a booking
  for this Person and Class`, with the existing record's id) and the approval queue's dry run its
  answer. It is not the guarantee: of 10 identical bookings at once, the index keeps one, and the
  nine failed batches claimed no place.

## Consequences
- Declaring a rule on an object whose records already break it fails the reconcile on the
  index; the records must be put right first.
- Uniqueness across two objects, or "no two bookings that overlap in time" (the spec's other
  guess), is not this: an overlap is a range, which 31b's time-range claim answers.
