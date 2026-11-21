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
- **`cos deploy`** also type-checks the apps and builds and checks the web app first, then
  installs, upgrades or repairs the host
  with the product's vars, then uploads the built web app (`apps/web/dist/server`) with its one
  binding, `HOST`, to the host's `ClientApp` entrypoint. It refuses a build with a D1, R2, KV,
  queue, Vectorize or Hyperdrive binding of its own, or any other service binding. An adopted web
  app (`web.deploy: "own"`, which `cos init` sets) keeps its Worker, its name, any data it already
  has and its own deploy; `cos deploy` deploys the host and leaves it alone. What of its data moves
  into the host is the company's decision (added after the skill trial, 2026-11-21).
- **`cos init`** moves and rewrites nothing. It adds `product.ts`, `skills/`, each app's
  generated client and the template's host module beside it (`<app>/src/composable-os/`), and a
  `pnpm-workspace.yaml` when the apps are in folders of their own, and shows as a diff every change to a
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

## Amendment, 2026-11-21 (issue #155): the host is named for the client's product
The deviation above ("the host keeps the release's names and strings") is closed.
- **Names.** At a host's first install, `cos deploy` names its Workers and resources for the
  client's product: `<id>-app`, `<id>-runner`, `<id>-gatekeeper-…`, the `<id>` database and
  `<id>-…` resources, derived from `product.ts`'s `id` unless its `names` overrides them
  (`clientNames`, `clientNameMaps` in `packages/product`). They are applied as deploy-time
  configuration: the deployment state's `workerNames` and `resourceNames` maps (ADR 0193), which
  the deploy engine, upgrades and the self-updater already follow. The verified release is
  deployed byte-identical.
- **Existing hosts are never renamed** (ADR 0193 stands). `cos deploy` looks for the host under
  the client's database first, then under the release's; one found there keeps its names.
- **The label.** `cos deploy` sets `COS_PRODUCT_LABEL` (the product's `label`) on the app and the
  runner. Each Worker reads it once per isolate (`setProductLabel`), and every surface that names
  the product reads `productName(product)`: the sidebar, the page title, sign-in, setup, the
  settings pages, the MCP consent screen, the MCP server's title and instructions, customer
  sign-in codes, notifications, the digest and the runner's pages. Screens get it from the root
  route (`getProductName`, `useProductName`). Unset, everything reads as before. Copy that said
  "the CRM" generically on those surfaces now says what it means without a product name.
- **Tested:** `packages/create-composable-os/test/client-repo.test.ts` (a first deploy names
  everything `shop-*` and sets the label; a second keeps them; a host deployed under the release's
  names keeps those), `packages/release/test/update.test.ts` (an update of a host installed with a
  client's names stays on them), `packages/core/test/product-label.test.ts` and
  `apps/app/test/product-label.test.ts` (with the label set, no surface says "CRM").
- **Not covered:** the MCP server's machine name (`SERVER_NAME`, the build's product id) is
  unchanged; the hosted path (Workers for Platforms) deploys release names in a namespace and was
  not changed.

## Amendment, 2026-11-21 (client releases and environments)
- **Packs.** "A release has its product's packs" is replaced: a release carries every pack in the
  repository (ADR 0420 as amended). **`cos deploy` and `cos upgrade` trust only `packs.json`**
  (`kitPacks`): the contract files are the union over the repository's packs, so a tool named there
  said nothing about the release's runner, and the old check, which also counted `x.<pack>.*` names
  in the contract, passed for a pack the runner did not have. A pack the release does not carry is
  refused before any call to Cloudflare, naming the pack and the release. `cos init --packs` takes
  the packs to turn on and refuses one the release does not carry.
- **Environments** ([ADR 0450](0450-client-environments.md)): `product.ts` may declare several
  deployments of the product, deployed side by side with `cos deploy --env <name>`.
- **Customer sign-in** is set up by `cos deploy` ([ADR 0450](0450-client-environments.md)).
- **Gatekeepers and their settings** come from `product.ts` ([ADR 0452](0452-gatekeeper-settings-in-product-ts.md)).
- **An adopted site's top-level config gets no `HOST` binding from `cos init`**: it deploys itself,
  perhaps on every push, and a binding to a host that does not exist yet would fail that deploy.
  `cos init` shows it under a matching environment of the site's config, or prints it with when to
  add it; `cos deploy` prints exactly what each environment needs.
- The old "the host keeps the release's names" text of `docs/deploying.md` is corrected.
