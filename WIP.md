# WIP: stage 23 (HTTP surface and typed client)

Branch `worktree-agent-a13e44dc43b009383`. Spec: `docs/stages/23-http-surface-and-typed-client.md`.

Scope of this session so far: build-order steps 1 and 2 only (the spine), then stop for review.

## Plan
- [ ] Step 1: `packages/core/src/http/` (framework-free surface over an invoker), app adapter
      `apps/app/src/server/http/`, mounted in `src/server.ts` before TanStack Start. Principals:
      staff session, customer session, public. Error envelope. Manifest. CORS from env.
- [ ] Step 1 tests: one-pipeline (HTTP vs server function), isolation over HTTP (stage 22 suite
      re-run through the HTTP handler), manifest equals open list per audience.
- [ ] Step 2: idempotency (migration 0410, `inBatch` hook in pipeline), purge in daily cron, tests.
- [ ] ADR 0415 (HTTP surface as built), 0416 (idempotency as built). Docs.
