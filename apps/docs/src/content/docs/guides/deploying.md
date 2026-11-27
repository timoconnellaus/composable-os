---
title: "Deploying"
description: "Installing a product, a company's own repository and cos deploy, upgrades and rollback."
sidebar:
  order: 6
editUrl: false
---

An outline; the full instructions are in [docs/deploying.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/deploying.md) and the first
deploy of a client repository in [docs/first-deploy.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/first-deploy.md).

## Two ways in

- **A company's own repository**: `cos create <dir>` makes one from the release's template, or
  `cos init` adopts an existing one. Its `product.ts` names the platform version, the packs that
  are on and its apps. `cos deploy` installs the host from that release with its packs, then the
  web app.
- **A product with no repository**: `cos install` installs a product from a verified release
  bundle into a Cloudflare account; `cos upgrade`, `cos rollback`, `cos status` and
  `cos uninstall` manage it.

Every command and option is on the [cos command](/reference/cli/) page.

## What a release is

A release is one reproducible bundle of every Worker, the migrations and every pack, with a
manifest and SHA256SUMS, verified against its build attestation before anything is deployed. The
deploy engine works over the Cloudflare API, with no wrangler
([ADR 0163](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0163-deploy-engine-over-the-cloudflare-api.md),
[ADR 0165](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0165-installer-cli-and-deployment-state.md)). An upgrade runs a preflight,
bookmarks the database, migrates, switches every Worker and smoke-checks, and rolls back on
failure.

## Where it runs

A first install may give a location hint for its database and buckets
([ADR 0580](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0580-a-location-hint-on-new-installs.md)). Where a client's product is hosted
is decided per client ([ADR 0610](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0610-three-homes-for-a-client-hosted-by-default.md)).

## A host of many clients

One deployment can serve many clients, each with a database of its own
([ADR 0611](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0611-one-host-a-database-per-client.md)). The operator runs it with `cos fleet`
and `cos client` ([ADR 0618](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0618-the-operators-commands-for-a-host-of-many-clients.md);
the steps are in [docs/deploying.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/deploying.md), "A host of many clients"):

- `cos fleet keys` makes the deployment's keys file once; `cos fleet install` installs the host,
  its registry and the operator's Worker; `cos fleet upgrade` takes a release across every client,
  staging first.
- `cos client add` gives a client its database and hostnames with no Worker upload; `pause`,
  `resume`, `secret`, `export`, `import` and `remove` follow it through its life.
- **Email.** Every fleet gets the email-send gatekeeper from `cos fleet install`, kept by each
  upgrade; it is the only gatekeeper on a fleet. It needs no secret: it sends through Cloudflare
  Email Service in the fleet's own account. A client's sign-in mail takes three steps:
  1. The operator onboards the client's domain to Email Sending in that account, with every record
     valid. The domain must be exactly the From address's domain: `gym.example` does not cover
     `hello@mail.gym.example`.
  2. The operator runs `cos client sender add <id> <domain>`, then `cos client sender verify <id>
     <domain>`.
  3. The client's admin, in the app: on Settings → Integrations, turns on email sending and creates
     the connection, and binds a sender address on that domain; on Settings → Users, chooses it as
     "The host's mail" and turns on "Send sign-in codes without review".

  Until then a sign-in code request answers 503 `sign_in_not_set_up`. A client sends only from its
  own verified domains: never from another client's, the fleet's own or an unverified one. A pause,
  an unverify or a removal takes effect within 10 seconds; nothing is sent while a client is
  paused, and nothing after it is removed
  ([ADR 0616](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0616-secrets-and-addresses-per-client.md), "Email sending per client").
- **The first admin.** `cos client add <id> --admin <email>` (or later `cos client first-admin
  <id> <email>`) names who may make the client's first account, and prints a setup link once:
  only that address, with that link, by password, within 72 hours, makes the first account, which
  is the admin. With no admin named, nobody can. The link is a credential: send it yourself. A
  single-client install is as before (its installer signs up at `/setup`).
- **A client's settings after `add`.** `cos client setting list|set|unset <id> [NAME] [value]`
  changes `COS_PACKS`, `API_ALLOWED_ORIGINS`, `NATIVE_REDIRECT_URIS`, `APPROVAL_EXPIRY_DAYS` and
  `COS_PRODUCT_LABEL`, each checked; a running host serves the change within 10 seconds.
  `COS_PACKS` only widens, with packs the release carries and those they require; the host installs
  a new pack at the client's next request. The approval floor, the identity provider and open
  sign-up are not changed this way.
- **A client's own label.** `--label <name>` at `add`, or the `COS_PRODUCT_LABEL` setting: the
  client's screens, sign-in page and mail name the product so, never another client's.
- **Replies to routine mail** go to the address the client's admin sets on Settings → Routine
  email; routine mail keeps going on its own with it. Sign-in codes carry no reply address.
  ([ADR 0618](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0618-the-operators-commands-for-a-host-of-many-clients.md), "The first
  client's day one".)


This guide is [docs/guides/deploying.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/guides/deploying.md), written by hand beside the code.
