# WIP: stage 26, capacity and holds

Branch `claude/stage-26-capacity-holds`. Spec: `docs/stages/26-capacity-and-holds.md`.
Block U: migrations 0440 to 0449, ADRs 0430 to 0434.

## Plan (spine first, then stop for review)
- [ ] Step 1: counter + claim rows + refusing constraint (migration 0440); concurrency test first
      (criterion 1); all-or-nothing (criterion 2).
- [ ] Step 4: pool claim in the same batch (criterion 1, pool of 60 over two records of 50).
- [ ] STOP: report to the coordinator. Steps 2, 3, 5, 6 wait for the go-ahead.

## Notes
