# WIP: stage 26, capacity and holds

Branch `claude/stage-26-capacity-holds`. Spec: `docs/stages/26-capacity-and-holds.md`.
Block U: migrations 0440 to 0449, ADRs 0430 to 0434.

## Plan (spine first, then stop for review)
- [x] Step 1: counter + claim rows + refusing constraint (migration 0440); concurrency test first
      (criterion 1); all-or-nothing (criterion 2). `packages/core/src/capacity/index.ts`,
      `capacityRefusal` in `errors.ts`, `packages/core/test/capacity.test.ts`, ADR 0430.
- [x] Step 4: pool claim in the same batch (criterion 1, pool of 60 over two records of 50).
- [ ] STOP: reported to the coordinator. Steps 2, 3, 5, 6 wait for the go-ahead.

## Next, once the spine is reviewed
- Step 2: `capacity` declaration in the SDK (`places` field, `pool` relation, `show`, `low`
  threshold, `releaseOnRefund`), reconciler validation (pool target must not itself declare a
  pool), counter row created/updated in record.create/update/import batches; read-only values
  `available`, `held`, `taken`. Keep SDK edits small (stage 25 is in `packages/sdk/src/behaviour.ts`).
- Step 3: confirm and release statements, idempotent (guard on claim state).
- Step 5: order wiring lands with stage 25's second half; ship a fixture claimant only.
- Step 6: `capacity.get` with `show`, `rec_capacity`, `rec_capacity_claim` views, record panel.
- Open: deleting a record with confirmed claims is refused; the counter's FK from claims is
  currently NO ACTION, so a counter with any claims cannot be deleted. Decide in step 2/3.

## Notes
- The refusal is a BEFORE trigger (`core_capacity_refused {json}`, carries the numbers) backed
  by the CHECK `core_capacity_within_places`. Proven both ways (see ADR 0430).
- `CORE_SCHEMA_VERSION` = 440. Stage 25 uses 0420: on merge keep the larger.
