# WIP: stage 23 (HTTP surface and typed client)

Branch `worktree-agent-a13e44dc43b009383`. Spec: `docs/stages/23-http-surface-and-typed-client.md`.

## Done
- Steps 1 and 2 (reviewed): surface, callers, envelope, manifest, idempotency (ADRs 0415, 0416).
- Review fixes: bounded body stream; key cost asserted (1 round trip, 3 statements); erase removes
  stored replies; public edge rule documented.
- Step 3/4: `packages/client` runtime, `packages/client-gen` + `cos client generate`, audience
  split, tests (ADR 0418).
- Step 5: device sessions (migration 0411), `/api/v1/auth/*`, idle setting, customer sign-in
  mounted, codes sent by the host as the system user (ADR 0419).
- Step 6: contract, golden files `packages/core/api/v1/*.json`, versions, upgrade_required (ADR 0417).
- Step 7: Deals headless entry; skill convention.

## Left
- Merge origin/main, full lint/typecheck/test, report. Delete this file before the PR is final.
