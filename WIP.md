# WIP: stage 27, the Ticketing pack (build steps 2 and 3, and the door role)

Branch `claude/stage-27-ticketing-pack`. Delete before the PR is final.

## Done
- ADR 0437: a move is made from a current read; `record.update { from }`.
- ADR 0436: pack roles (`roles`, tool `permission`, `ctx.caller`, `core_user.pack_role`,
  migration 0451, `user.packRoles`, `user.setPackRole`).
- `packs/ticketing`: objects, behaviours, door role, tools; pack tests; product test.
- `apps/runner/test/ticketing.test.ts`: criteria 1 to 8 except 9, with the door-role walk.
- open-operations.json, API contract, golden manifest, staff baseline re-recorded.
- Docs: ADRs, CONTEXT.md, architecture.md, stage as-built notes, skills, SDK README.

## Stopped (needs the coordinator)
- `ticketing.events.onSale` and criterion 9: the host has no public read of declared fields.
- A ticket type of an event that is not on sale can be bought by id (no host rule for it).

## Not started (by the brief)
- Step 4 (automations, views, dashboard, Person tab), step 5 (hooks, blocks), Ghetto.
