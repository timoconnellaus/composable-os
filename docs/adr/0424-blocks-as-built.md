# ADR 0424: Blocks, the base layers and the block lint, as built

Status: accepted, 2026-11-21 (stage 24 build, step 9). Builds part of
[ADR 0401](0401-platform-packs-screens.md).

## Context
The stage 24 spec decided that a block is a folder of source files with a small manifest (its pack,
its skin, the operations it calls, its files, the blocks it depends on), that blocks ship inside the
release matching the platform version, that `cos add` copies one and records it in a lock file and
`cos diff` shows upstream changes, that blocks are MIT, that the web base layer is the shadcn-style
components of `packages/ui` with the primitive library chosen at build time, that the native base
layer is a small new set, that only the base layers and sign-in ship now, and that a lint refuses a
block holding a rule.

## Decision
- **A block** is a folder with a `block.json`: `name`, `pack` (or null), `skin` (`web` or
  `native`), `operations`, `files`, `dependsOn`, and `packages` (the npm packages its files import,
  at the versions the platform uses). Platform blocks are in `blocks/`; a pack's are in
  `packs/<id>/blocks/`. Names are unique across both.
- **They ship in the release's client kit** (`client/blocks/<name>/`, ADR 0422), each with the MIT
  licence of the folder it ships from.
- **`cos add <block>`** copies a block and the blocks it depends on into
  `<app>/src/blocks/<name>/` (the web app for `web`, the mobile app for `native`), refuses a file
  that exists and a pack's block when the product does not list the pack, records each block's
  version, app and file hashes in `blocks.lock.json`, and prints the packages to add.
  **`cos diff <block>`** says which copied files were edited or removed, then shows the upstream
  diff between the recorded version and the version `product.ts` is on (or `--version`). It
  changes nothing.
- **The web base layer** is `blocks/ui-*`: `ui-utils` (`cn`), `ui-button`, `ui-input`,
  `ui-label`, `ui-card`, generated from `packages/ui` by `blocks/web-base.mjs` with the `cn`
  import pointed at `ui-utils`; `pnpm lint` fails when they differ. **The primitives are Radix**
  (`radix-ui`, as `packages/ui` uses today). Base UI was not adopted: moving `packages/ui` is a
  change of its own, and blocks above the styled layer would not change with it.
- **The native base layer** is `blocks/native-base`: theme, screen, list, row, sheet, tab bar,
  button, field, in plain React Native with no other dependency.
- **Sign-in in both skins:** `web-sign-in` (on `ui-button`, `ui-input`, `ui-label`, posting to the
  template web app's `/auth/*`) and `native-sign-in` (on `native-base`, calling the actions the
  template mobile app's `src/host.ts` gives).
- **The block lint** (`scripts/check-blocks.mjs`, part of `pnpm lint`) reads each block's code
  with comments and string contents removed and refuses a price calculation (a money word in
  arithmetic, a reduce or a rounding), a capacity check (a places word compared) and a permission
  check (a role or permission compared, `isAdmin`, `hasPermission`, …), saying what to do instead.
  It is a lint, not a proof; review covers what it cannot see.
- **Type-checked here:** `blocks/` is a workspace package whose two configs check the web blocks
  (DOM, Radix) and the native ones (React Native).

## Tests
`scripts/check-blocks.test.mjs`: the fixture block with a price calculation fails, a clean one
passes with the same words in its copy, capacity and permission checks fail, and every shipped
block passes. `packages/create-composable-os/test/client-repo.test.ts`: `cos add` copies from the
matching release and writes the lock, the sign-in block brings its base-layer blocks and licence,
a pack's block needs its pack, and `cos diff` shows an upstream change beside a local edit
without touching it.

## Consequences
- The web base layer needs Tailwind and the shadcn CSS variables in the app that copies it; the
  template web app has neither yet, so a copied block is unstyled until the app adds them or the
  client restyles it (the `add-block` skill says so).
- Pack blocks beyond sign-in are later (stage 27 brings ticketing's).

## Amendment, 2026-11-21 (stage 27): pack blocks
Ticketing's blocks are the first a pack ships (`packs/ticketing/blocks/`, seven: four web, three
native). They import the base layer as sibling folders, as they sit after `cos add`, and the
pack's headless entry from `@composable-os/pack-ticketing/client`. In the repository they are
type-checked by the pack (`blocks/tsconfig.{web,native}.json`, with `rootDirs` joining the pack's
blocks and the platform's into one folder). A native block that needs the device (camera, QR,
brightness, haptics) takes it as a prop, so no block depends on a device package.

## Amendment, 2026-11-21 (stage 41): mounting a pack's web blocks in development
`apps/app` serves `/blocks?block=&component=&props=` in development only (a production build
mounts nothing and the path needs a sign-in there). It loads the block's file where it sits
(`packs/<id>/blocks/<block>/`), resolves its sibling base-layer imports to `blocks/` (Vite's
counterpart of the `rootDirs` above, `apps/app/pack-blocks-plugin.ts`), and passes the pack's
hooks over a client that calls `/api/v1/op` from the browser as whoever the cookie says: staff,
a customer or the public. The e2e specs drive Programs' builder and today blocks there; any pack's
web blocks can be mounted the same way. Native blocks are never mounted.
