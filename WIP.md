# WIP: stage 24, client apps

Branch `claude/stage-24-client-apps`. Spec: `docs/stages/24-client-apps.md`. ADR block S
(0420 to 0424), no migrations.

Coordinator's instruction: build step 1, step 2 and the sign-in part of step 5 (host side, the
binding's part, a fixture Worker standing in for a company's web app), then stop for review.
**Stopped here for review. Do not start steps 3, 4, the rest of 5, or 6 to 10 until told.**

## Done
- Step 1, packs as packages (ADR 0420): `packs/<id>/`, `@composable-os/pack-<id>`, Deals'
  headless entry at `packs/deals/client/`, `product.ts` lists `packs`, `productPacks` reads only
  the listed packs' extensions. Release before/after compared (see the ADR).
- Step 2, the binding (ADR 0421): `ClientApp` in `apps/app/src/server/http/bound.ts`, exported from
  `src/server.ts`. Tests: `apps/app/test/client-binding.test.ts`, `company-web.test.ts`.
- Step 5's sign-in: over the binding, cookie passed through to the web app's hostname; the fixture
  web Worker `apps/app/test/fixtures/company-web/` (generated CRM customer client committed there).
  `customerSession`/`customerCookies` in `@composable-os/client`. Runbook in `docs/deploying.md`.

## Open for review
- ADR 0421 is "proposed for review".
- The host's own `/api/customer-auth/*` still serves native apps (no Origin); browsers on the
  host's hostname are refused by Better Auth's origin check once `CUSTOMER_AUTH_URL` names the
  web app.

## Next (after review)
- Step 3 `cos` as one command; step 4 npm dry run; the rest of step 5 (template, `cos create`);
  steps 6 to 10.
