# ADR 0900: The app's identity, brand and listing from product.ts

Status: accepted, 2026-11-24 (stage 63 steps 1 to 3, `feat/stage-63-app-cli`). Builds on
[ADR 0422](0422-client-repos-and-one-command-as-built.md),
[ADR 0450](0450-client-environments.md) and
[ADR 0451](0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md).

## Context
A client's app goes to the two phone app stores under the client's own name, icon and colours
([stage 63](../stages/63-app-publishing.md)). The template's app had a static `app.json`
(`name: "Client"`, the host's address written by hand, no store ids, no icon), and its brand was
the copied native base theme's constants, edited by hand. Nothing tied the app to the
environment it talks to, so a staging app could not install beside the live one, and nothing could
be checked before a store build.

## Decision
- **`mobile.app` in `product.ts`** holds the app's identity: `name` (at most 30 characters),
  `version` (x.y.z, bumped by a pull request), `ids` (`ios` bundle id, `android` package name,
  reverse-domain), `icon`, `splash` (image and background), three `colours` (`primary`,
  `background`, `text`), `listing` (a folder in the repo) and `purchases`, whose only value is
  `"none"` (ADR 0490). `environments.<name>.mobile.app` changes the `name`, `ids`, `icon`,
  `splash` or `listing` for that environment's app; the colours and the version are the product's.
- **`defineClientProduct` checks it** (so `cos deploy` and `cos app check` both refuse, before any
  call): ids reverse-domain and different in every environment, per platform; schemes different in
  every environment; colours `#rrggbb` with the text colour at WCAG contrast 4.5 or more on the
  background; `purchases` `"none"`. A product without `mobile.app` is unchanged.
- **`appBuild(product, environment)`** (`@composable-os/product`) is the one reading of it: the
  build's name, slug, scheme, version, store identity, the host's address
  (`https://<environment hostname>`) and the web app's account page. The environment is required
  when the product declares environments.
- **The template's `app.json` becomes `app.config.ts`**, which imports `product.ts` and calls
  `appBuild` with `COS_ENV`, and takes the build number from `COS_APP_BUILD`. No host address, id
  or colour is written in the app's files. `COS_HOST_URL` overrides the host for local development
  only; `cos app check` refuses an environment without a hostname. An adopted app keeps its own
  `app.json` until it copies the template's `app.config.ts`, which `cos app check` asks for.
- **The brand is written by cos**: `cos client generate` (and so `create`, `init`, `upgrade` and
  `deploy`) writes `<app>/src/blocks/brand.ts` from `mobile.app.colours`, with the colour on the
  primary chosen for contrast. The native base theme (`blocks/native-base/theme.ts`) reads it as
  `../brand.ts`; `blocks/brand.ts` is the platform's default, which a client app without
  `mobile.app` gets. `cos app check` refuses a `brand.ts` that is not product.ts's.
- **The store listing is in the repo**, `<listing>/<locale>/`: `name.txt` (30), `subtitle.txt`
  (30), `description.txt` (4000), `keywords.txt` (100), `release-notes.txt` (500),
  `support-url.txt` and `privacy-url.txt` (https), and `screenshots/`. The limits are the lower of
  the two stores' as we read their guidelines on 2026-11-24.

## Deviation from the spec
The spec puts the brand at `apps/mobile/src/brand.ts`. It is `apps/mobile/src/blocks/brand.ts`,
beside the copied blocks, so the theme's import (`../brand.ts`) resolves the same way in a client
app and in the platform's own `blocks/` (where the packs' native blocks and their tests already
reach the base layer by a sibling path). At `src/brand.ts`, the platform would need a stand-in at
the repository's root, or a change to every pack's block config.

## Consequences
- `cos create --with-mobile` writes `app.config.ts` and a commented `mobile.app` to fill in.
- The `.gitignore` the template writes ignores the native projects the build makes (`android/`,
  `ios/`), so the build's own debug keystore is never committed.
- The store ids never change once published: `cos app check` and `cos app record` compare them
  with the recorded builds (ADR 0901).

## Tests
`packages/product/test/product.test.ts` (the checks and `appBuild`),
`packages/create-composable-os/test/app.test.ts` (the template's `app.config.ts` evaluated for
staging and live; no host address in the app's files; `brand.ts` written, rewritten when the
colours change, and read by the copied theme by type). The template's `app.config.ts` was also
read by the app framework's own CLI (`expo config`, SDK 58) on 2026-11-24, for staging and live.
