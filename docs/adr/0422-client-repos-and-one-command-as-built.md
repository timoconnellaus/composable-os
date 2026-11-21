# ADR 0422: Client repos and one command, as built

Status: accepted, 2026-11-21 (stage 24 build, steps 3, 5 to 8). Builds part of
[ADR 0401](0401-platform-packs-screens.md) on [ADR 0420](0420-packs-as-packages-as-built.md) and
[ADR 0421](0421-the-client-app-binding-and-customer-sign-in.md).

## Context
ADR 0401 decided that each company has its own repository, started from a template or adopted in
place, holding its apps, its own extensions and a product definition naming its packs and its
platform version, with the host deployed from a verified release and one command, `cos`. The
stage 24 spec named the commands and said that blocks ship inside the release. It did not say how
a client repo gets the template and skills of its platform version, how a host from a release
built for one product serves another product's packs, how the org's own extensions reach a host
whose code is fixed by its release, or what a client repo's `product.ts` holds.

## Decision
- **One command, `cos`** (`packages/create-composable-os`, published as `@composable-os/cli`):
  `create`, `init`, `deploy`, `upgrade`, `add`, `diff`, `client generate`, `ext check|test`,
  `install`, and the installer's `status`, `rollback`, `uninstall`. `npm create composable-os`
  runs `cos create` (the `create-composable-os` bin). Installing a product with no client repo is
  `cos install`; `cos` with no command prints its help. `cos upgrade` in a client repo (its
  `product.ts` is a client product) moves the repo; anywhere else it updates a deployment, as
  before. The installer's tests run unchanged under `cos install`.
- **The release carries a client kit** (`client/` in the bundle, listed with hashes in the
  manifest's `client.files` and verified with everything else): the template
  (`templates/client`), the skills as a client repo reads them, the blocks, the API contract per
  audience (`packages/core/api/v1`) and the list of the release's packs. `cos create`, `init`,
  `add`, `diff` and `upgrade` take what they need from the release that matches the repo's
  platform version, downloaded and verified like a release for install (or `--bundle-dir`).
- **A client repo's `product.ts`** is `defineClientProduct({ id, label, platform: { version,
  release, repository }, packs, web?, mobile? })` (`packages/product`). `platform.release` names
  the platform product whose release is the host (`crm`).
- **The host keeps the release's names and strings.** A client repo's host is `crm-app`,
  `crm-runner` and shows "CRM": they are built into the verified release. Naming the host for the
  company's own product needs the platform to apply names and strings at deploy time; that is
  platform work this stage does not do, and stage 27 (the first client) needs it.
- **Packs are chosen at deploy.** A release has its product's packs; the runner installs those
  `COS_PACKS` lists (`*` every one, the default for an install; `""` none, a host with base
  records only). `cos deploy` sets it from `product.ts` and refuses a pack the release does not have.
- **The org's own extensions are installed by deploy, as shipped.** `cos deploy` runs
  `cos ext check` on each folder in `extensions/` first (a failure stops it before anything in
  the account changes), puts their source in the BLOBS bucket at `org-extensions/<sha256>.json`
  and sets `COS_ORG_EXTENSIONS` to the hash. The runner (`shipped-list.ts`) reads the object,
  refuses one that does not match the hash, and installs the extensions through the path packs
  take: source `shipped`, no approval (ADR 0414's "the org's own, reviewed"). An org extension
  may not take a pack's id.
- **`cos deploy`** also type-checks the apps first, then installs, upgrades or repairs the host
  with the product's vars, then uploads the built web app (`apps/web/dist/server`) with its one
  binding, `HOST`, to the host's `ClientApp` entrypoint. It refuses a build with a D1, R2, KV,
  queue, Vectorize or Hyperdrive binding of its own, or any other service binding.
- **`cos init`** moves and rewrites nothing. It adds `product.ts`, `skills/` and each app's
  generated client (`<app>/src/composable-os/customer.ts`), and shows as a diff every change to a
  file that exists (the root `package.json`, each app's `package.json`, `AGENTS.md` appended, the
  web app's wrangler config with the `HOST` binding, JSONC or TOML), applying them only with
  `--yes` or a yes at the prompt.
- **`cos upgrade`** checks the new release speaks the org extensions' contract and has the
  product's packs, moves `platform.version`, regenerates each app's client from the new
  release's contract, replaces `skills/`, and type-checks the apps. It deploys nothing.
- **The typed client of a client repo is generated from the release's contract** (client-gen's
  `releaseContract`): the release's operations, without the tools of packs the product does not
  list, plus the org's own extensions' tools. So it types what the host it will call serves.
- **`cos ext check` outside a checkout** uses the SDK source and core migrations the CLI carries
  (`dist/platform/`, its own version's).
- **`cos create` and `cos init` print the edge rule** for public calls on the web app's zone as a
  step a person does before opening the app to the public (ADR 0421).

## The template
`templates/client`: the root files (`product.ts`, `package.json`, `pnpm-workspace.yaml`,
`.gitignore`, `AGENTS.md` with the client-repo rules, `extensions/`), `apps/web` (TanStack Start
on its own Worker: a public page, sign-in, a signed-in page from `me.get`, sign-out; its
framework-free `src/host.ts` does the binding, the sign-in routes and `keepCustomerSignedIn`) and
`apps/mobile` (Expo, with `--with-mobile`: sign-in, the device session in `expo-secure-store`,
a tab bar, the signed-in screen; `src/host.ts` likewise framework-free). Both templates are
workspace packages here, type-checked and (the web app) built in CI, and their generated clients
are held to the generator's output by a test.

## Tests
- `packages/create-composable-os/test/client-repo.test.ts`, against the fake Cloudflare API and a
  fake GitHub serving releases whose client kit is the real one: create (and `--with-mobile`),
  deploy (host and web app; no packs; an org extension pinned in BLOBS; a failing extension and a
  missing pack stop it with nothing changed; a web app with its own database refused), upgrade
  (a changed operation reported as a type error, nothing deployed; a clean upgrade), add and diff,
  and init in a repo shaped like the first client's (an Astro site on a Worker with its own D1,
  an Expo app in `mobile/`), whose two call sites compile and run against the generated client.
- `apps/app/test/company-web.test.ts` runs the template web app's `host.ts` in its own Worker
  against the real `ClientApp` entrypoint; `apps/app/test/mobile-app.test.ts` runs the template
  mobile app's `host.ts` against the host's public routes.
- `apps/runner/test/shipped-list.test.ts`: `COS_PACKS` and `COS_ORG_EXTENSIONS`.

## Consequences
- A client repo's web app is built by its own `pnpm run build`; `cos deploy` uploads its output.
  The web app's custom hostname needs its DNS done by a person; without one it is on workers.dev.
- The host of a client repo is named for its release's product until names are applied at
  deploy time.
- `create-composable-os` with no arguments no longer installs: it creates. Documentation that
  said `npx create-composable-os` to install now says `npx @composable-os/cli install`.
