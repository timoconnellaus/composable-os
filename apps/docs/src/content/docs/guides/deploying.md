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


This guide is [docs/guides/deploying.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/guides/deploying.md), written by hand beside the code.
