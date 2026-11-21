# WIP: stage 27, build step 1 (the `sellable` behaviour)

Branch `claude/stage-27-sellable`. Spec: `docs/stages/27-ticketing-and-ghetto.md`, "Scope: the
`sellable` behaviour". Stop after step 1 and report to the coordinator.

## Done
- SDK: `packages/sdk/src/sellable.ts` (SellableSpec, GrantSpec, schema, checkObjectSellable),
  wired into the manifest schema, `validateManifest`, `ObjectSpec`.
- Host: `ObjectDefinition.sellable` from the reconciled manifest (extensions/schema.ts);
  `orders/sellable.ts` reads it (registerSellable removed); sale window and maxPerOrder in
  `priceLines`; `orders/grants.ts` move hook (grant at first payment, void on refunded/cancelled);
  migration 0450 `core_order_grant`; reconciler drops grants of a dropped granted object;
  `objectInfo.sellable`.
- Removed `ORDERS_DEV_SELLABLE` and `apps/app/src/server/dev-sellable.ts`.
- Fixture extension `packages/core/test/fixtures/boxoffice/` (passes `cos ext check`).
- Test fixtures declare `sellable`; the payments gateway double is in `test/payments-double.ts`.

## To do
- `packages/core/test/sellable.test.ts` (criteria 2, 3, 5, 6, 6a host half, every actor, dry run).
- SDK declaration-check tests.
- e2e orders spec on the box office fixture.
- Docs: ADR 0435, CONTEXT.md, architecture.md, SDK README, write-extension skill, ADR 0404,
  stage 25 notes and runbook mentions of ORDERS_DEV_SELLABLE.
- Regenerate API contract and release golden manifest; lint, typecheck, full tests.
