# WIP: stage 24, client apps

Branch `claude/stage-24-client-apps`. Spec: `docs/stages/24-client-apps.md`. ADR block S
(0420 to 0424), no migrations.

Coordinator's instruction: build step 1, step 2 and the sign-in part of step 5 (host side, the
binding's part, a fixture Worker standing in for a company's web app), then stop for review.

## Done
- Step 1, packs as packages: `extensions/{deals,leads,lifecycle}` moved to `packs/`, packages
  renamed `@composable-os/pack-<id>`, Deals' headless entry to `packs/deals/client/index.ts`
  (export `./client`). `product.ts` lists `packs`; `productPacks` (packages/product/src/packs.ts)
  reads only the listed packs and never their `client/` or `blocks/`; the runner's bundle uses it.
  A CRM release built before and after: manifests equal apart from hashes; the only module
  changes are the product definition's key (`extensions` → `packs`) in cos-app and `headless.ts`
  no longer in cos-runner's shipped sources.

## Next
- Step 2: the `ClientApp` entrypoint and its refusal tests.
- Step 5 (sign-in only): customer sign-in over the binding, cookie on the web app's hostname,
  fixture web Worker.
- Then stop and report.
