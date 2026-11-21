# WIP: stage 27, the Ticketing pack (build steps 2 and 3, and the door role)

Branch `claude/stage-27-ticketing-pack`. Delete before the PR is final.

## Done
- ADR 0437 (code): a move is made from a current read. The history close is conditioned on the
  record's stored position; `record.update { from }`; `moved_meanwhile` / `not_in_position`
  conflicts. `packages/core/test/transition-race.test.ts`.
- ADR 0436 (code): pack roles. SDK `roles`, tool `permission`, `ctx.caller`; core
  `core_user.pack_role` (migration 0451), `pack-roles.ts`, pipeline check, `user.packRoles`,
  `user.setPackRole`, runtime extensions refused; `cos ext check` prints roles.
- `packs/ticketing`: objects, behaviours, door role, tools orderStart, myTickets, salesSummary,
  checkIn, undoCheckIn; pack tests; product test.

## Next
- apps/runner/test/ticketing.test.ts: install the pack as shipped (wrapping host), buy, refuse,
  expire, refund, deposit, 500-order race through orderStart, isolation, check-in race, door walk.
- core test for user.setPackRole guards.
- open-operations.json and API contract regen; client fixtures.
- ADRs 0436, 0437 text; CONTEXT.md; architecture.md; skills; parallel-work row.
- lint, typecheck, full test.

## Stopped (needs the coordinator)
- `ticketing.events.onSale` and criterion 9: the host has no public read of declared fields.
