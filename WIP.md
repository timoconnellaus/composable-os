# WIP: stage 26, capacity and holds

Branch `claude/stage-26-capacity-holds`. Spec: `docs/stages/26-capacity-and-holds.md`.
Block U: migrations 0440 to 0449 (0440, 0441 used), ADRs 0430 to 0434 (0430 to 0433 used).

All build steps are done except the order wiring, which lands with stage 25's second half: it
calls `queueClaim`, `confirmStatements` and `releaseStatements` (ADR 0432) from the order's create,
`paid`, `cancelled`, `expired` and refund moves, reading `releaseOnRefund` from the object.

## Before release
- Apply migration 0440 once to a real remote D1: check it accepts `RAISE` with an expression as
  its message, and that the trigger's message reaches the host through D1's error (a refused claim
  reports `asked` and `available`). If not: drop the triggers and, on a CHECK failure only
  (`core_capacity_within_places`), read the counter after the refusal to fill in the numbers
  (ADR 0430).
- Measure the 500 claims of criterion 1 against remote D1 for the PR (local: about 0.4 s, 1.1 s
  with every claimant in flight).

## Before the PR is final
- Merge `origin/main` once stage 25's first half (PR #83) is in: keep both sides in
  `records/`, `operations/record.ts`, `sdk/manifest.ts`, `sdk/contract.ts`, `fields/types.ts`,
  `extensions/schema.ts`, `objectInfoSchema`; `CORE_SCHEMA_VERSION` the highest migration;
  regenerate the golden manifest.
- Delete this file.
