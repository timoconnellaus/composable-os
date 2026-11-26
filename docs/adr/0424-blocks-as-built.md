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

## Amended 2026-11-21 (issue #177): accepting upstream changes merged by hand
`blocks.lock.json` recorded only what a block was copied from, so after its upstream changes were
merged by hand every later `cos diff` showed them again. **`cos diff <block> --accept`** shows the
changes once more and records the block as merged up to the kit of the version `product.ts` is on:
that version and the kit's content hashes. The copy here is not touched. It refuses `--version` of
any other release (upgrade first), so the lock never claims a version the repo is not on. Test:
`packages/create-composable-os/test/client-repo.test.ts`.

## Amendment, 2026-11-24: a release ships every pack and every block
Found while putting the first client's app on the platform: `v0.1.0-beta.11` had no
`@composable-os/pack-rostering` and none of the account, agreement, rostering blocks or
`bookings-native-class-list`. Nothing dropped them: the bundle's kit holds exactly the blocks at
its tag, and every one of them was merged after it. A release is complete for its commit by
construction (every `packs/<id>/` with a package.json, every folder with a `block.json`), but a
folder missing either would have dropped out without a word. **`scripts/release/test/release-completeness.test.ts`**
(run in CI and before every release build) fails when a folder under `packs/` is not carried and
built as `@composable-os/pack-<id>`, or a folder under `blocks/` or `packs/*/blocks/` is not a
block in the client kit with its licence, unless an allow-list there names it with the reason it
is not released (empty today). A new pack is also not on npm until a person publishes it once
(docs/deploying.md, "Publishing to npm"): the release workflow now checks that before the release
goes public.

## Amended 2026-11-24: native blocks on a dark theme, failures said, a block of a required pack
Found while putting the first client's app on the platform.
- **Text takes the theme's colour.** React Native draws a `<Text>` with no colour black, so most
  native blocks were unreadable on a dark theme. `native-base` gains **`text.tsx`**: a `Text` in
  `theme.color.text`, with `tone="muted"` or `tone="danger"`, a given style still winning. Every
  native block writes its text with it or with a style that names a theme colour; spinners take
  `color={theme.color.muted}`. The theme gains the colours blocks had of their own (`success`,
  `successSurface`, `dangerSurface`, `info`, `warning`, `scrim`, and `codeBackground`, white
  behind a code to scan whatever the theme), so a dark theme is `theme.ts` changed and nothing
  else.
- **The block lint holds it** (`native-text-colour`, `native-literal-colour`): in a native block,
  React Native's own `<Text>` (by whatever name it is imported) not inside another needs a style
  with a colour in every branch, a `<TextInput>` a colour and a placeholder colour, an
  `<ActivityIndicator>` a colour; `color`, `placeholderTextColor` and `tintColor` must read the
  theme; and no colour literal (hex, `rgb()`, `hsl()`, white, black) appears outside
  `native-base/theme.ts`. It reads the code with TypeScript's parser and follows
  `StyleSheet.create` styles in the same file.
- **A failed call is said.** `native-sign-in` caught nothing, so a 503 (sign-in not switched on),
  a 429 or being offline showed nothing. It now says each in plain words from
  **`signInErrorWords(error, step)`** in `@composable-os/client` (shared logic, so a web screen
  can use the same words), keeps its button to try again, and offers "Use another email, or get a
  new code" once a code is sent. The token session reads the status of an answer that is not JSON
  (a gateway's page). The other native blocks' calls were checked the same way: Programs' "Mark
  done", Bookings' cancel and confirm-cancel, Rostering's copy to the clipboard and Courses'
  progress now say when they fail, and Programs' today, class, coach and progress screens say when
  they could not load (the progress screen showed "Loading…" for ever).
- **A block may depend on a block of a pack its pack requires.** The Courses player draws a text
  lesson with Content's rich text, so `courses-player` depends on `content-rich-text` and
  `courses-native-player` on `content-native-rich-text`, and Courses requires Content (ADR 0478,
  amended the same day). `cos add` counts a pack as listed when a listed pack requires it.

Tests: `scripts/check-blocks.test.mjs` (the `native-dark` fixture and the rule's cases; every
shipped block passes), `packages/client/test/client.test.ts` (each failure's words, from the
host's real answers), `packages/create-composable-os/test/client-repo.test.ts` (the players bring
Content's blocks).

## Amended 2026-11-26: cos upgrade over an older copy of a block

Found at the review of PR #467: Courses' section of My account came to name `MyCoursesSection`,
and `cos upgrade` wrote `account-sections.gen.ts` importing it from the client's own, older copy
of `courses-my-courses`, which did not export it. The app stopped compiling and nothing said why.

- **A section is wired only when the client's copy exports what the release's section names.**
  One that does not is left out of `account-sections.gen.ts`, and `cos add` and `cos upgrade` say
  which block it is and that `cos diff <block>` shows what changed upstream; once the copy is
  brought up to date, `cos add web-account` (or `native-account`) wires it again. The copy is never
  changed.
- **`cos upgrade` lists every copied block whose upstream files changed** since it was copied (or
  last accepted with `cos diff --accept`), compared by content, with any block it now depends on
  that is not copied (`cos add <block>`). Nothing is changed.
- **The upgrade still succeeds.** A copied block is the client's (this ADR): an older copy is not
  an error, and what fails an upgrade is the apps' type check (ADR 0422), which the wiring passes
  once the out-of-date section is left out. The exit code stays the type check's.

Test: `packages/create-composable-os/test/client-repo.test.ts` (an upgrade over a client holding
1.0.0's `courses-my-courses`).

**Amended 2026-11-26** (stage 38 step 6, [ADR 0708](0708-the-knowledge-packs-blocks-and-screens.md)):
a block may depend on a block of another pack (Knowledge's blocks on Content's rich text
renderers). `cos add` copies such a block whatever `product.ts` lists when it calls no operation
and a block being added, or one already copied, depends on it; asked for by name with nothing
copied depending on it, or calling the host, it still needs its pack listed. "Calls no operation"
rests on the block's own declaration (its `block.json` `operations`), which the block lint checks
only for some operation names and review checks the rest of; nothing rests on it for safety: the
host refuses any call the block makes to a pack that is not installed, whatever it declares. In
this repository the admin's and the pictures' builds resolve the sibling import to that pack's
`blocks/` (`apps/app/pack-blocks-plugin.ts`).
