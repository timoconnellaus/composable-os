---
title: "Architecture"
description: "The host, operations, data, extensions, gatekeepers and the release, in one page."
sidebar:
  order: 1
editUrl: false
---

Composable OS is a platform for composing products on a trusted host on Cloudflare. This guide is
an outline; [docs/architecture.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/architecture.md) is the full description, and the words are
in the [glossary](/reference/glossary/).

## The host

One deployment of a product is a set of trusted Workers in one Cloudflare account, holding one
organisation's data ([ADR 0001](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0001-self-hosted-single-org.md)):

- the **app Worker**: the staff UI, `/mcp`, the operations registry and approval pipeline, and the
  HTTP surface client apps call;
- the **runner Worker**: extension code, automations and long-running Workflows;
- the **gatekeeper Workers**: one per external service, holding its credentials.

D1 is the database, R2 holds files, Vectorize holds record embeddings, and model calls go through
AI Gateway by **model role**, never by model id.

## Operations, the one API

Anything a user can do is an **operation** in the registry (`packages/core`): a name, zod input and
output schemas, a description written for a model, a permission, a risk class and the audiences
that may call it ([ADR 0003](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0003-operations-registry.md)). The UI, MCP, the HTTP surface
and extension code all call operations; none of them writes to D1 directly. Each call goes through
`invoke()`: validate, gate, check the role, run the handler, then commit one D1 batch holding the
writes, the timeline and the audit row. Every operation is in the
[reference](/reference/operations/).

## Data

Core tables are `core_*` and change only by migrations in `packages/db`. Extensions' tables are
`x_*`, made by the schema reconciler from their manifests, and every record type is readable as a
`rec_*` view. Rules about records (stages, states, places, prices, what a customer may see) are
**behaviours** an object declares and the host enforces in the write's own batch
([ADR 0404](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0404-behaviours-are-the-vocabulary.md)); see the
[behaviours reference](/reference/behaviours/).

## Extensions and packs

An extension adds objects, fields, views, tools, automations and dashboards through a manifest. A
**pack** is a shipped extension with its headless client hooks and its blocks
([ADR 0401](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0401-platform-packs-screens.md)). See [Extensions and packs](/guides/extensions/).

## Gatekeepers

Extension code runs with no network of its own (`globalOutbound: null`). External access goes
only through gatekeepers, which check each call against a typed contract and put outbound changes
through the approval queue ([ADR 0007](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0007-integrations-are-gatekeepers.md)). Each one's
contract is in the [reference](/reference/gatekeepers/).

## Products and releases

A **product** is a named composition of packs, written once in its product definition
([ADR 0400](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0400-a-general-host-and-products.md)); see [Solutions](/solutions/). A
release bundles every Worker, the migrations and every pack, verified by checksum and build
attestation before the `cos` command installs or upgrades a deployment. See
[Deploying](/guides/deploying/).


This guide is [docs/guides/architecture.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/guides/architecture.md), written by hand beside the code.
