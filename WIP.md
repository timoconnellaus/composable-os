# WIP: stage 23 (HTTP surface and typed client)

Branch `worktree-agent-a13e44dc43b009383`. Spec: `docs/stages/23-http-surface-and-typed-client.md`.

## Done (steps 1 and 2, the spine): stopped here for the coordinator's review
- `packages/core/src/http/` (surface, envelope, idempotency), `apps/app/src/server/http/api.ts`
  served in `src/server.ts` before TanStack Start. ADRs 0415, 0416; ADR 0403 amended.
- `invoke.ts`: `resolveFor`, `listFor`, `coreInvoker` exported. `pipeline.ts`: `inBatch` hook.
- Migration 0410 (`core_idempotency_key`, `core_idempotency_claim`), `CORE_SCHEMA_VERSION` 410.
- Tests: core `http-surface`, `http-isolation` (the stage 22 suite, now `isolation-suite.ts`,
  over HTTP), `http-idempotency`; app `http-surface` (one pipeline, real sessions).

## Open questions for the coordinator
- Customer sign-in routes (`/api/customer-auth/*`) are not mounted: who sends the code (the
  email-send gatekeeper call needs a staff-side caller)?
- Public per-address edge rate limiting (Cloudflare rules) not configured.

## Next (only when told): steps 3 to 7
3. `@composable-os/client` runtime and `cos client generate`; type-break and per-product tests.
4. Audience split and bundle test. 5. Native tokens and session setting. 6. Versioning.
7. Deals hooks.
