# WIP: stage 41, Programs (build steps 1 to 3)

Branch `claude/stage-41-programs`. Spec: `docs/stages/41-programs.md`. Block X: migrations
0470–0479 (0470 used), ADRs 0445–0449 (0445 to 0448 used).

## Status
- [x] step 1: the document field (ADR 0445); `publishable` without its public half (ADR 0446,
  migration 0470); the signed-in scope, relations a customer sets, `my.update { from }` (ADR 0447);
  `record.createMany` (ADR 0448)
- [x] step 2: `packs/programs` objects, the layout schema, versions, `assign`
- [x] step 3: logging, history, progress; isolation suite; criteria 1 to 7 (7's dashboard half is
  step 4)
- [x] docs: ADRs, CONTEXT, architecture, roadmap, the stage's as-built notes, SDK README, skills
- [x] merged origin/main (client host names)
- Stopped after step 3 for review, as asked.

## Next (not started)
4. Training dashboard, views, the Person page's Training tab.
5. Hooks; the builder and the bank (web); native blocks.
6. The assistant's draft and the text import.
7. Ghetto.

## Open questions for review
- `records:publish` is admins only (the shape of `orders:refund`): a coach who is a member cannot
  publish until stage 14a gives permissions out one by one.
- Customers read the whole exercise bank, not only what their programs use (see the stage's
  as-built notes).
