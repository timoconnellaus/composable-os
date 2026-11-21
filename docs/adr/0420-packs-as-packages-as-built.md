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
