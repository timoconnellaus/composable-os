# Stage 24: Client apps

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Packs and
blocks, Client repos, Trust boundaries), [`CONTEXT.md`](../../CONTEXT.md), ADRs
[0401](../adr/0401-platform-packs-screens.md), [0403](../adr/0403-http-surface-and-typed-client.md)
and [0405](../adr/0405-skills-ship-with-the-platform.md), stages [20](20-move-in.md),
[21](21-extension-skills.md) and [23](23-http-surface-and-typed-client.md), and ADRs 0012, 0160 to
0165, 0350, `packages/release`, `packages/create-composable-os`.

Status: spec proposed. Builds on stage 23.

## Goal

Starting a product for a company is one command. It makes the company's repository, with a web app
and optionally a mobile app that are signed in to a host and can call it with types, and deploys
the host and the web app to the company's Cloudflare account. From there an agent adds packs, copies
in blocks and reshapes them. The company's repository holds no platform code and no path to the
database.

## What exists today (from the code)

- `create-composable-os` (renamed in stage 20) installs one product, the CRM, from a verified
  release bundle:
  it provisions D1, R2 and KV, uploads the Workers, sets secrets and runs migrations. Its choices
  are stored in `core_install`.
- After stage 20, names come from a product definition, and shipped extensions live in
  `extensions/` in the platform repository.
- After stage 23, `@composable-os/client` exists and a pack may ship headless hooks.
- The staff UI is TanStack Start with shadcn/ui in `apps/app`, with shared components in
  `packages/ui`.
- Ghetto's repository is an Astro site with a staff PWA, an Expo app in `mobile/` and an Android
  TV app, each hand-built.
- There is no template, no block registry, and no way for a second Worker to reach the host.

## Scope

### Packs as packages
- A shipped extension becomes a **pack**: `packs/<id>/` holding the extension (`index.ts` and its
  files, unchanged), `client/` for headless hooks, and `blocks/` for its screens.
- Deals, Leads and lifecycle move from `extensions/` to `packs/`. Their extension ids, tables and
  behaviour do not change, so no deployment sees a difference.
- A product definition lists its packs. A pack that is not listed is not in that product's release.

### The client repo template
`create-composable-os` makes a repository with:

```
apps/web/          TanStack Start, its own Worker
apps/mobile/       Expo (optional)
extensions/        the org's own extensions
product.ts         packs, platform version, names, branding
skills/            the platform's skills for this version
AGENTS.md          the rules for agents in a client repo
```

- **`apps/web`** has sign-in and sign-out for customers wired to the host, a signed-in example page
  that reads `me.get`, and a public example page. Its wrangler config has a service binding to the
  host's app Worker and no D1, R2 or KV binding of its own.
- **`apps/mobile`** has the same in Expo: sign-in, token storage, the typed client, one signed-in
  screen, a tab bar.
- **`product.ts`** is the product definition from stage 20, now in the company's repository.
- **`AGENTS.md`** states the client-repo rules: call operations through the typed client only;
  rules live in the host; copy blocks, do not import them; when something needs a platform change,
  stop and say so.

### The service binding
- The host's app Worker exposes an entrypoint for bound Workers that takes an operation call and
  the caller's session, and runs it through `invoke()` exactly as the HTTP surface does.
- The web app forwards the signed-in customer's session. It holds no credential of its own that
  grants more than the caller has: a bound Worker cannot call as staff or as another customer.
- Customer session cookies are set by the host on the web app's hostname through the web app, so a
  company's site at its own domain signs people in without a redirect to another address.

### Deploying a client repo
- `cos deploy` in a client repo: resolves the platform version in `product.ts`, downloads
  and verifies that release, deploys the host with the product's packs and the org's extensions,
  then builds and deploys `apps/web` with the binding.
- The org's own extensions in `extensions/` are installed as shipped extensions of this product:
  checked with `pnpm ext check`, then reconciled on deploy. They need no approval in the
  deployment because they arrived by a reviewed deploy, as packs do.
- `cos upgrade` moves `product.ts` to a newer platform version, runs the updater's
  preflight against the org's extensions, regenerates the typed client, and reports type errors in
  the client apps before anything is deployed.

### The block registry
- A block is a folder of source files with a small manifest: the pack it belongs to, the skin
  (`web` or `native`), the operations it calls, the files, and the blocks it depends on.
- `cos add <block>` copies a block's files into the client repo, into `apps/web` or
  `apps/mobile`, and records its name and version in a lock file. After that the files are the
  client's.
- `cos diff <block>` shows what has changed upstream since the copy, for an agent or a
  person to apply by hand. Nothing updates a copied block automatically.
- The web base layer is the shadcn-style components of `packages/ui`, copied the same way. The
  native base layer is a small set written for this stage: screen, list, row, sheet, tab bar,
  button, field.
- Blocks ship in this stage for the base layer and for sign-in only. Pack blocks arrive with their
  packs.
- The rule from ADR 0401 is checked: a lint pass over blocks refuses one that contains a price
  calculation, a capacity check or a permission check instead of calling an operation.

### Skills
- The template installs the platform's skills at the version in `product.ts`; `cos upgrade`
  replaces them.
- Two skills are added: **`start-client-app`** (run the template, choose packs, first deploy) and
  **`add-block`** (find a block, copy it, restyle it to the client's brand, wire it to a route).

## Out of scope
- Any pack block beyond the examples (stage 27 brings ticketing's).
- A TV app in the template.
- A page builder, a theme editor, or anything that edits screens without code.
- Publishing packages to npm, unless the interview chooses it.
- Preview deployments per branch.

## Acceptance criteria
1. **One command:** against a fake Cloudflare API, `create-composable-os` then `cos deploy`
   yields a host and a web app; a customer signs in on the web app and the example page shows
   their name from `me.get`.
2. **No authority of its own:** the web Worker's bundle and config hold no database binding and no
   secret that the host accepts as staff. A test calls the binding with a forged staff principal
   and a forged other-customer principal and both are refused.
3. **Mobile:** the Expo app signs in against a local host and shows the same record. Its client is
   the same package as the web app's.
4. **Packs moved:** Deals, Leads and lifecycle live under `packs/`; a CRM release
   built before and after has the same manifest apart from paths.
5. **Product packs:** a product that lists no packs deploys a host with base records only.
6. **Blocks:** `cos add` copies files and writes the lock file; editing a copied file and
   running `cos diff` shows upstream changes without touching the edit.
7. **Upgrade:** `cos upgrade` to a fixture release that changes an operation reports the
   type error in the client app and deploys nothing.
8. **Block lint:** a fixture block with a price calculation fails the lint.
9. **Skills:** each of the two skills is used once by an agent that has not seen this spec, from
   an empty folder to a deployed example with one added block, and what went wrong is fixed in the
   skill.
10. `pnpm lint typecheck test` and e2e pass in CI. ADRs, `CONTEXT.md` (Pack, Block, Client app,
    Client repo) and `docs/architecture.md` are updated.

## Dependencies
- Stage 23. Stage 21 for the skills' form and the check command.

## Migrations and numbers
No migrations. ADRs 0420 to 0424, and ADR 0401 amended as built.

## Suggested build order
1. Packs as packages; the CRM still builds the same.
2. The service binding entrypoint and its refusal tests.
3. The web template, deployed by hand.
4. `cos deploy` and `upgrade`.
5. The mobile template.
6. The block registry, the base layers, the lint.
7. The two skills, each tried once.

## To settle at the interview
- **How client repos get platform packages:** from npm, from the release bundle, or from a git
  reference. It decides whether the platform must publish to npm.
- **The blocks' licence** (ADR 0401). Proposed: MIT for `blocks/` and the native base layer.
- **Base UI or Radix** under the web base layer. Check the state of both when this is built.
- **Where the company's site signs people in:** on its own domain through the web app, as
  proposed, or on the host's address.
- **Does the staff admin stay on the host's address,** or can a company put it under its own
  domain.
- **One CLI or two:** `create-composable-os` (install) and `cos` (deploy, upgrade, add, diff) as
  they are today, or everything under `cos`.
