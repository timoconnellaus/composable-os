# ADR 0420: Packs as packages, as built

Status: accepted, 2026-11-21 (stage 24 build, step 1). Builds part of
[ADR 0401](0401-platform-packs-screens.md).

## Context
ADR 0401 decided that a shipped extension becomes a pack, released with the platform and turned on
per product, and the stage 24 spec said where a pack lives (`packs/<id>/`: the extension,
`client/` for headless hooks, `blocks/` for screens), that Deals, Leads and lifecycle move there
with their ids, tables and behaviour unchanged, and that a product lists its packs, a pack it does
not list being absent from its release. Until now every directory under `extensions/` was bundled
into every release, and the product definition's `extensions` list was read only by the client
generator.

## Decision
- **`packs/<id>/`** holds the extension (`index.ts` and its files, unchanged), `client/` (the
  headless entry, exported as `<package>/client`) and later `blocks/`. The packages are
  `@composable-os/pack-<id>`. Deals' headless entry moved from `headless.ts` to `client/index.ts`.
  `extensions/` is gone from the platform repository; in a client repo it holds the org's own.
- **A product lists its packs:** `packs: string[]` in its `product.ts` (the key was `extensions`).
  An empty list is a host with base records only.
- **Only the listed packs are built in,** by `productPacks(product, root)`
  (`packages/product/src/packs.ts`), which cos-runner's bundle script calls for the product the
  build is for (`COS_PRODUCT`, else the default product). It reads each pack's extension and never
  its `client/` or `blocks/`: those are client code and never run in the host. A listed pack with
  no directory fails the build.
- **The client generator** reads the product's packs from `packs/<id>`.

## Checked
A CRM release built before the move and after it, from the same commit, has manifests equal apart
from module hashes (workers, bindings, resources, inputs, migrations and module names all equal).
The only module contents that differ: cos-app's copy of the product definition (`extensions:`
became `packs:`), and cos-runner's shipped sources, which no longer include Deals' `headless.ts`.
`packages/product/test/packs.test.ts` holds the rule: the CRM's three packs and none of their client
files, a pack not listed left out, an empty list empty, a missing pack refused.

## Consequences
- Deals' shipped source no longer carries the headless file, so its source hash changes once.
  Nothing is installed anywhere yet, so no deployment sees it.
- `skills/` and `AGENTS.md` point at `packs/<id>/` and tell an author to list a new pack in the
  product.

## Amended 2026-11-21 (client releases and environments): a release carries every pack
"Only the listed packs are built in" is replaced. The only release product is the CRM, and a client
product that names the CRM release and lists `ticketing` got a host with no Ticketing: the runner
had only the CRM's packs, and dropped the unknown one without a word.
- **A release carries every pack in the repository** (`releasePacks`, every `packs/<id>/` with a
  package.json): the runner bundles all of them (`SHIPPED_EXTENSIONS`), and the client kit's
  `packs.json` lists the same ids. A pack added to `packs/` is in the next release.
- **Which packs a deployment installs stays a deploy-time choice** (`COS_PACKS`). `*`, the default,
  now means the release product's own packs (`PRODUCT_PACKS`, generated from the product the build
  is for), so a CRM deployment installs exactly the CRM's three packs, as before, and none of
  Ticketing's until a deploy names it. Checked: the CRM's three packs' sources under `*` are
  identical before and after (the generated `shipped.ts` compared), and
  `apps/runner/test/ticketing.test.ts` still finds no Ticketing object or tool on a CRM host before
  it is installed.
- **A named pack the release does not carry is never dropped:** `listedPacks` throws
  `UnknownPackError`, so nothing is installed from that list; the runner logs it when an isolate
  starts and its `ping` fails with it, so cos-app's `/api/health` is degraded (503) with the reason.
  `apps/runner/test/shipped-list.test.ts`.
- **The API contract is the union, with each tool's pack named.** `open-operations.json` and
  `api/v1/<audience>.json` hold the core operations and every carried pack's tools, each of those
  with `pack: "<id>"`. A deployment serves `forPacks(file, installed)`: the core operations and the
  installed packs' tools (`packages/core/src/audiences.ts`). The generator tests read every pack
  under `packs/` (`packages/core/test/release-packs.ts`) instead of a list, and the tests that
  skipped `x.*` when comparing a deployment with the files now compare with `forPacks`. The client
  generator types a client repo's packs with it.
- The runner's main module with four packs: see `apps/runner/scripts/bundle-budget.mjs`.

## Amended 2026-11-22: a pack a product lists is installed
Found from the first client: Content and Programs carry `composableOs.optional` (so that the CRM's
local dev could offer them to an admin), and the runner's boot install
(`installOne`, `packages/core/src/extensions/shipped.ts`) left an optional shipped extension
`available` unless an admin installed it. Since `COS_PACKS` passed `optional` through, a client
product listing Content or Programs got a host where neither was installed, although each pack
says "Installed in every deployment of a product that lists it". Ticketing, not optional, was
installed.
- **A pack the deployment's product lists is installed at boot:** `listedPacks`
  (`apps/runner/src/extensions/shipped-list.ts`) drops `optional` for every pack an explicit
  `COS_PACKS` names (what `cos deploy` writes from `product.ts`). `optional` holds only for `*`,
  the release product's own catalogue, where an admin chooses (lifecycle in the CRM, ADR 0246,
  unchanged). The boot install itself is unchanged.
- **A product that adds a pack** in a later deploy gets it installed by the next boot; the others
  are left `unchanged`.
- **A product that drops a pack** stops listing it, so releases no longer update it, and nothing
  is deleted: it stays installed and active with its records until a human admin uninstalls it.
- **Local dev:** `COS_DEV_PACKS=<packs> pnpm dev` gives the local runner that `COS_PACKS`, and
  `scripts/dev-setup.mjs` then does not deliver those packs as org extensions (a pack and an org
  extension may not share an id). Without it, local dev stays the CRM's, with Ticketing, Programs
  and Content as optional org extensions.
- Tests: `apps/runner/test/listed-packs.test.ts` runs the real list and the real boot install for a
  product listing Content, Programs and Ticketing (all installed, their objects there, Ticketing's
  and Content's public reads answering; before the fix Content and Programs were `available`), a
  pack added later, a pack dropped (still active), and the CRM's `*` (lifecycle `available`).
