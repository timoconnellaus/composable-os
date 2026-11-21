# ADR 0450: Environments of a client product, and customer sign-in set by the deploy

Status: accepted, 2026-11-21 (client releases and environments fix, after the first client
build). Builds on [ADR 0193](0193-pre-rename-installs-keep-their-names.md),
[ADR 0421](0421-the-client-app-binding-and-customer-sign-in.md) and
[ADR 0422](0422-client-repos-and-one-command-as-built.md) as amended.

## Context
The first client (a gym selling tickets) needs a staging host and a live host of one product in one
Cloudflare account. One `product.ts` gave one set of names, so one host per account: a second
deploy found the first host by its database and repaired it. And `cos deploy`, the command meant to
make a host a web app signs customers in through, set neither `CUSTOMER_AUTH_URL` nor
`CUSTOMER_AUTH_SECRET`, so customer sign-in did not work on a deployment it made.

## Decision
- **`defineClientProduct` takes `environments`**, by name (`staging`, `live`, …). Each is its own
  host: its own Workers, database (so its own deployment state), secrets, host hostname (the staff
  admin's address) and web app hostname and Worker.
- **Names.** An environment other than `live` is named from the product's id and its name:
  `<id>-<env>-app`, `<id>-<env>-runner`, `<id>-<env>-gatekeeper-…`, the `<id>-<env>` database,
  `<id>-<env>-…` resources, the web app `<web.worker>-<env>`. **`live` keeps the names a product
  without environments has** (`<id>-app`), so a host deployed before environments becomes the live
  one and nothing is renamed (ADR 0193). Every name can be overridden per environment;
  `defineClientProduct` refuses two environments that share a Worker, database or prefix.
- **`cos deploy --env <name>`** deploys that environment. With several and no `--env` it refuses
  and lists them, before anything else; with one, it deploys it; with none declared it behaves
  exactly as before and refuses `--env`. Only `live` (or a product without environments) can be a
  host deployed under the release's own names.
- **An environment is live unless it says `live: false`**; `live` is always live. A non-live
  environment may use test settings (the fake payment provider, ADR 0452).
- **Customer sign-in is set by the deploy** for a product with a web app: `CUSTOMER_AUTH_URL` is
  the environment's web app origin (its hostname, else its workers.dev address), a deploy-time var
  on the app Worker; `CUSTOMER_AUTH_SECRET` is generated on the first deploy of that environment as
  a Worker secret: random, never equal to the staff secret, never printed (it is redacted), never
  written to disk or the repository, and never changed by a later deploy (it is looked for on the
  deployed Worker). `--rotate-customer-auth-secret` replaces it, which signs every customer out.
  A product with no web app gets neither.
- **An adopted site's own Worker** (`web.deploy: "own"`) is printed exactly what it needs per
  environment: the `HOST` service binding, its target (that environment's app Worker) and
  entrypoint (`ClientApp`), under that environment of its wrangler config. `cos init` never adds
  it to the site's top level (a site that deploys its main branch on every push would fail its own
  deploy until the host exists); with `--envs` it writes it under a matching environment of the
  site's config as a diff, and prints the rest with when to add it.

## Consequences
- Found while building this: the installer looked for existing secrets under the release's Worker
  name, so every redeploy of a client-named host made a new `BETTER_AUTH_SECRET` and signed staff
  out. It now looks on the deployed Worker.
- The verified release is still deployed byte-identical: environments are deploy-time names and
  vars (ADR 0422's amendment), in each environment's own deployment state.
- A site on the Vite or Astro Cloudflare plugin picks its environment at build time
  (`CLOUDFLARE_ENV`); `docs/deploying.md` says so.

## Tests
`packages/create-composable-os/test/client-repo.test.ts` against the fake Cloudflare API: staging
and live side by side with distinct Workers, databases, bindings and secrets, a redeploy of staging
making no write to anything of live's; several environments and no `--env` refused with no call;
the customer variables set once, unchanged by a redeploy, the staff secret unchanged too, rotation
changing only the customer one; no web app, neither; an adopted site with a staging environment of
its own, initialised and deployed per environment. `packages/product/test/product.test.ts`: names,
overrides, collisions.
