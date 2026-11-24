# Stage 24: Client apps

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Packs and
blocks, Client repos, Trust boundaries), [`CONTEXT.md`](../../CONTEXT.md), ADRs
[0401](../adr/0401-platform-packs-screens.md), [0403](../adr/0403-http-surface-and-typed-client.md)
and [0405](../adr/0405-skills-ship-with-the-platform.md), stages [20](20-move-in.md),
[21](21-extension-skills.md) and [23](23-http-surface-and-typed-client.md), and ADRs 0012, 0160 to
0165, 0350, `packages/release`, `packages/create-composable-os`.

Status: **spec agreed** (interview 2026-11-20). Builds on stage 23.

## Goal

A company's own repository can be connected to a host in one command, whether it is new or already
full of code. Its web app and its mobile app are signed in to the host and call it with types. The
host and the web app deploy to the company's Cloudflare account. From there an agent adds packs,
copies in blocks and reshapes them. The company's repository holds no platform code and no path to
the database.

## What exists today (from the code)

- `create-composable-os` installs one product, the CRM, from a verified release bundle: it
  provisions D1, R2 and KV, uploads the Workers, sets secrets and runs migrations, and
  `create-composable-os upgrade` updates it. Its choices are stored in `core_install`. The same
  code is the `cos` command.
- Names come from a product definition (`products/crm/product.ts`). Shipped extensions live in
  `extensions/`.
- After stage 21, `cos ext check` and `cos ext test` exist. After stage 23, `@composable-os/client`
  and `cos client generate` exist, and a pack may ship headless hooks.
- The staff UI is TanStack Start with shadcn/ui in `apps/app`, with shared components in
  `packages/ui`.
- Packages are not on npm.
- Ghetto's repository is an Astro site with a staff PWA, an Expo app in `mobile/` and an Android
  TV app, each hand-built.
- There is no template, no block registry, and no way for a second Worker to reach the host.

## Decided at the interview (2026-11-20)

| Question | Decision |
| --- | --- |
| New repos and existing ones | **Both**: a template for new repos, and an adopt path for existing ones that moves nothing |
| How a client repo gets platform code | **npm**, as public packages under `@composable-os` |
| The blocks' licence | **MIT** |
| Where customers sign in | On the company's own domain, through its web app |
| Where the staff admin lives | On the host's own address, which may be a subdomain of the company's |
| The company's own extensions | Installed by deploy after `cos ext check`, with no approval inside the deployment |
| A gap found in a client repo | Stop that part, say exactly what the platform needs, build the rest. Never work around it |
| Where blocks are served from | Inside the release, matching the platform version in `product.ts` |
| A copied block after upstream changes | Nothing automatic. `cos diff` shows the change |
| What is under the web blocks | Decided at build time, after checking Radix and Base UI then |
| The command line | **One**: `cos` |
| Left out | A TV app in the template; preview deployments; a theme editor; pack blocks beyond sign-in |

## Scope

### One command, `cos`
| Command | What it does |
| --- | --- |
| `cos create <dir>` | A new client repo from the template |
| `cos init` | Adopts the repo it is run in |
| `cos deploy` | Deploys the host and, where there is one, the web app |
| `cos upgrade` | Moves the repo to a newer platform version |
| `cos add <block>`, `cos diff <block>` | Copies a block in; shows upstream changes to one |
| `cos client generate` | Writes the product's typed client (stage 23) |
| `cos ext check`, `cos ext test` | Checks and tests an extension (stage 21) |
| `cos install` | Installs a product with no client repo, as the installer does today |

`npm create composable-os` is a thin alias for `cos create`. Installing a product with no client
repo, which `create-composable-os` does today, becomes `cos install`.

### Published packages
- The platform's packages a client repo needs are published to npm as public packages under
  `@composable-os`: the runtime client, the SDK, the `cos` command, and each pack.
- Publishing is part of the release workflow, from the same commit as the release bundle, with npm
  provenance.
- The host is still deployed only from the verified release bundle. What runs in a company's
  account does not come from npm.
- A person claims the `@composable-os` organisation on npm before this stage is built.

### Packs as packages
- A shipped extension becomes a **pack**: `packs/<id>/` holding the extension (`index.ts` and its
  files, unchanged), `client/` for headless hooks, and `blocks/` for its screens.
- Deals, Leads and lifecycle move from `extensions/` to `packs/`. Their extension ids, tables and
  behaviour do not change.
- A product definition lists its packs. A pack that is not listed is not in that product's release.

### The template (`cos create`)

```
apps/web/          TanStack Start, its own Worker
apps/mobile/       Expo (optional)
extensions/        the org's own extensions
product.ts         packs, platform version, names, branding
skills/            the platform's skills for this version
AGENTS.md          the rules for agents in a client repo
```

- **`apps/web`** has sign-in and sign-out for customers, a signed-in example page that reads
  `me.get`, and a public example page. Its wrangler config has a service binding to the host's app
  Worker and no D1, R2 or KV binding of its own.
- **`apps/mobile`** has the same in Expo: sign-in, token storage, the typed client, one signed-in
  screen, a tab bar.
- **`product.ts`** is the product definition from stage 20, now in the company's repository.

### Adopting a repo (`cos init`)
- Run in an existing repository, it adds `product.ts`, the dependency on the platform's packages,
  the generated typed client, `skills/`, and the client-repo rules in `AGENTS.md` (appended to one
  that exists, never replacing it). It asks where the web app and the mobile app are, if any.
- It moves and rewrites nothing. It does not assume TanStack Start: the runtime client works in
  any Worker and any React Native app, and the service binding is one entry in the existing
  wrangler config, which it shows as a diff and adds only when told to.
- It is tested against a fixture shaped like Ghetto's repository: an Astro site on a Worker with
  its own D1, and an Expo app in a subfolder.

### The rules for agents in a client repo
`AGENTS.md` in a client repo states them, and the skills repeat them:
- Call operations through the typed client only. Never open a database.
- Rules live in the host. A screen never calculates a price, checks a capacity or decides what a
  customer may see.
- Copy blocks, do not import them.
- **When the platform lacks something:** stop that part, say exactly what the platform needs (a
  behaviour, an operation, a gatekeeper), and build the rest. Never work around it in client code.

### The service binding
- The host's app Worker exposes an entrypoint for bound Workers that takes an operation call and
  the caller's session, and runs it through `invoke()` exactly as the HTTP surface does.
- The web app forwards the signed-in customer's session. It holds no credential of its own that
  grants more than the caller has: a bound Worker cannot call as staff or as another customer.

### Where people sign in
- **Customers sign in on the company's own domain.** The web app shows the form and passes the
  address and the code to the host over the binding; the host creates the session and the web app
  sets the customer cookie on its own hostname. No redirect to another address.
- **Staff use the admin on the host's own address.** That address may be a subdomain of the
  company's domain (the deploy engine already attaches a custom hostname). Staff cookies and
  customer cookies are therefore never on the same hostname.

### Deploying a client repo
- `cos deploy` resolves the platform version in `product.ts`, downloads and verifies that release,
  deploys the host with the product's packs and the org's extensions, then builds and deploys the
  web app with the binding where the repo has one.
- **The org's own extensions** in `extensions/` are checked with `cos ext check` and installed as
  shipped extensions of this product, reconciled on deploy. They need no approval in the
  deployment: they arrived by a deploy a person ran, as packs do. A failed check stops the deploy
  before anything changes.
- `cos upgrade` moves `product.ts` to a newer platform version, runs the updater's preflight
  against the org's extensions, regenerates the typed client, replaces `skills/`, and reports type
  errors in the client apps before anything is deployed.

### The block registry
- A block is a folder of source files with a small manifest: the pack it belongs to, the skin
  (`web` or `native`), the operations it calls, the files, and the blocks it depends on.
- **Blocks ship inside the release.** `cos add <block>` copies from the release that matches the
  platform version in `product.ts`, into the web app or the mobile app, and records the block's
  name and version in a lock file. After that the files are the client's.
- `cos diff <block>` shows what changed upstream between the recorded version and the current
  one, for an agent or a person to apply by hand. Nothing updates a copied block automatically.
- **Blocks are MIT.** `blocks/` folders and the native base layer carry an MIT licence file, and
  `NOTICE` says so.
- The web base layer is the shadcn-style components of `packages/ui`, copied the same way. Which
  primitive library sits under them (Radix or Base UI) is chosen at build time from their state
  then; blocks are written against the styled layer so the choice can change.
- The native base layer is a small set written for this stage: screen, list, row, sheet, tab bar,
  button, field.
- Blocks ship in this stage for the base layers and for sign-in only.
- A lint pass over blocks refuses one that contains a price calculation, a capacity check or a
  permission check instead of calling an operation.

### Skills
- `cos create` and `cos init` install the platform's skills at the version in `product.ts`;
  `cos upgrade` replaces them.
- Two skills are added: **`start-client-app`** (create or adopt, choose packs, first deploy) and
  **`add-block`** (find a block, copy it, restyle it to the client's brand, wire it to a route).
- The extension skills from stage 21 are installed too, with the client-repo gap rule in place of
  the platform-repo one.

## Out of scope
- Any pack block beyond the examples (stage 27 brings ticketing's).
- A TV app in the template.
- Preview deployments per branch.
- A page builder, a theme editor, or anything that edits screens without code.
- Adopting Ghetto's real repository (stage 27). This stage proves the path on a fixture.

## Acceptance criteria
1. **One command, new repo:** against a fake Cloudflare API, `cos create` then `cos deploy` yields
   a host and a web app; a customer signs in on the web app's own hostname and the example page
   shows their name from `me.get`.
2. **Adopt:** `cos init` in the Ghetto-shaped fixture adds only the files named above, changes no
   existing file without showing the diff, and afterwards the fixture's Worker calls `me.get` over
   the binding and its Expo app calls it over HTTPS, both typed.
3. **No authority of its own:** the web Worker's bundle and config hold no database binding and no
   secret that the host accepts as staff. A test calls the binding with a forged staff principal
   and a forged other-customer principal and both are refused.
4. **Cookies apart:** the customer cookie is set only on the web app's hostname and the staff
   cookie only on the host's.
5. **Mobile:** the Expo app signs in against a local host and shows the same record. Its client is
   the same package as the web app's.
6. **Packs moved:** Deals, Leads and lifecycle live under `packs/`; a CRM release built before and
   after has the same manifest apart from paths.
7. **Product packs:** a product that lists no packs deploys a host with base records only.
8. **Own extensions:** an extension in the repo's `extensions/` is installed by `cos deploy` with
   no pending approval; one that fails `cos ext check` stops the deploy with nothing changed.
9. **Published:** a dry run of the release workflow produces the npm packages from the release
   commit, and a fresh folder that installs them builds the template with no access to this
   repository.
10. **Blocks:** `cos add` copies from the release matching `product.ts` and writes the lock file;
    editing a copied file and running `cos diff` shows upstream changes without touching the edit.
11. **Upgrade:** `cos upgrade` to a fixture release that changes an operation reports the type
    error in the client app and deploys nothing.
12. **Block lint:** a fixture block with a price calculation fails the lint.
13. **Skills:** each of the two new skills is used once by an agent that has not seen this spec,
    one from an empty folder and one in the adopt fixture, to a deployed example with one added
    block, and what went wrong is fixed in the skill.
14. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Pack, Block, Client app,
    Client repo) and `docs/architecture.md` are updated. `NOTICE` names the MIT parts.

## Dependencies
- Stage 23. Stage 21 for the skills' form and the check command.
- A person claims the `@composable-os` organisation on npm.

## Migrations and numbers
No migrations. ADRs 0420 to 0424, and ADR 0401 amended as built.

## Suggested build order
1. Packs as packages; the CRM still builds the same.
2. The service binding entrypoint and its refusal tests.
3. `cos` as one command, with `cos install` taking over from the installer.
4. Publishing to npm in the release workflow, as a dry run first.
5. The web template and `cos create`, deployed by hand; sign-in on the web app's hostname.
6. `cos init` against the fixture.
7. `cos deploy` and `cos upgrade`, with the org's own extensions.
8. The mobile template.
9. The block registry inside the release, the base layers, the lint.
10. The two skills, each tried once.

Steps 2 and 5's sign-in are the spine: they decide what a company's own Worker can do on a
customer's behalf.

## As built (2026-11-21)

Status: built, in review. ADRs [0420](../adr/0420-packs-as-packages-as-built.md) to
[0424](../adr/0424-blocks-as-built.md); ADR 0401 amended.

- **The binding** serves customer sign-in and the HTTP surface for customers and the public, and
  nothing else. **The native token routes (`/api/v1/auth/*`) are left off it on purpose:** a web
  app signs customers in with a cookie and has no use for device tokens, so the binding gives
  less than the public hostname, never more (ADR 0421).
- **Staying signed in:** the template web app renews the customer cookie's lifetime once a day at
  most (`keepCustomerSignedIn`); the HTTP surface is unchanged.
- **Cookies apart** rests on `CUSTOMER_AUTH_URL` naming the web app. Native sign-in that returns
  tokens with no cookie on the host's address is filed for later.
- **The host keeps its release's names and strings** (`crm-app`, "CRM"). The spec's
  "product.ts: names, branding" holds for the client's own Workers; naming the host for the
  client's product needs names applied at deploy time, which is platform work for later (stage 27
  needs it). `product.ts` is `defineClientProduct` and names the release it deploys.
- **Packs are chosen at deploy** (`COS_PACKS`), from the packs in the release; the org's own
  extensions reach the host through BLOBS, pinned by hash (`COS_ORG_EXTENSIONS`), and install as
  shipped. A release built for a product has only that product's packs.
- **The template's build is the app's own** (`pnpm run build`, TanStack Start's output in
  `dist/server`); `cos deploy` uploads it. Radix is under the web base layer.
- **npm:** published only when the `NPM_PUBLISH` variable is turned on, with trusted publishing
  (no token anywhere); every release dry-runs it (ADR 0423).
- **The two skills, each tried once** (criterion 13) by an agent that had not seen this spec,
  against the real release kit, the npm tarballs and a local fake Cloudflare API
  (`packages/create-composable-os/scripts/fake-cloudflare.ts`): `start-client-app` and
  `add-block` from an empty folder ("a website for a yoga studio where members sign in", with the
  web sign-in block; deployed, host and web app bound), and both in the Ghetto-shaped fixture
  (adopted; the native sign-in block wired into the Expo app; the host deployed). What went wrong,
  and what was fixed:
  - `cos client generate` crashed in a client repo: it now writes each app's client from
    `product.ts`.
  - Blocks could only be listed by name: `cos add` with no name lists skin, pack, calls and
    dependencies; the skill says to run the `pnpm add` line it prints.
  - The web blocks' Tailwind classes resolved to nothing: the template web app now has Tailwind
    and the tokens, and the skill says how to brand them.
  - `cos deploy` assumed the template's build layout and failed on the Astro site after the host
    had deployed: the web build is checked before the host, and an adopted web app keeps its own
    Worker and its own deploy (`web.deploy: "own"`).
  - `cos init` left an adopted repo without the host modules, the root app's client dependency
    and a workspace for its mobile app, and named a new Worker: it now writes the host modules
    (and the secure store), adds the dependency, a `pnpm-workspace.yaml` and keeps the Worker's
    name, and says when the site has data of its own (the company's decision).
  - The skills did not say: `--id`/`--label`, that the template already has the sign-in and
    account pages, `/setup` and the customer mail connection, that an app without a tsconfig is
    not type-checked, `git init`, the sign-in blocks' actions, or how to wire a block. They do now.
  Not re-run after the fixes.
- **Fixed 2026-11-24, from the first client's app** (ADR 0424 amended): every native block's text
  and spinner takes its colour from `native-base/theme.ts` (the themed `Text` in
  `native-base/text.tsx`), held by the block lint; `native-sign-in` says why a sign-in failed
  (not switched on, too many tries, offline) and lets the person try again, as do the other
  native blocks' calls that failed silently; the Courses players bring Content's rich text block,
  and Courses requires Content (ADR 0478 amended).
