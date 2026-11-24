---
title: "Composable OS documentation"
description: "Technical documentation for Composable OS: a platform for composing products on a trusted host on Cloudflare."
sidebar:
  label: "Introduction"
  order: 0
editUrl: false
---

Composable OS is a platform for composing products on a trusted host on Cloudflare. A product is a
named composition of **packs** (shipped extensions such as Bookings or Rostering) on the platform's
**host**, which holds every rule: who may do what, prices, places, and what a customer may see.
Client apps and extension code reach the host only through **operations**.

These pages document what the code does. Most of them are generated from the code itself, so they
change in the same pull request as the code they describe.

## Where to start

- [Architecture](/guides/architecture/): the host, operations, extensions, gatekeepers and the
  release, in one page.
- [Packs](/packs/): each pack's overview, data model, tools, permissions, screens, messages and
  settings.
- [Capabilities](/capabilities/): platform pieces any pack composes, such as
  [Agreements](/capabilities/agreements/).
- [Solutions](/solutions/): which packs a product is made of.
- [Core operations](/reference/operations/): every operation in the registry, with its
  description, audiences, permission, risk class and schemas.
- [Glossary](/reference/glossary/): the words the code and these docs use.

## How these docs are made

- **Generated reference.** `apps/docs/scripts/generate.mjs` reads every pack's manifest, every
  block's `block.json`, the core operations registry, the behaviours an object may declare, the
  gatekeepers' contracts, the `cos` command's help, the products and `CONTEXT.md`, and writes the
  reference pages. Nobody edits a generated page by hand.
- **Written beside the code.** Each pack's overview is `packs/<id>/docs/overview.md`, and the
  cross-cutting guides are `docs/guides/*.md`. A pull request that changes a pack, a block or an
  operation updates its overview in the same pull request.
- **Checked in CI.** CI fails when a generated page is stale, when a pack, block, core operation
  or gatekeeper has no reference page, when a pack has no overview, or when an internal link is
  broken.
- **For tools.** [`/llms.txt`](/llms.txt) lists every page with its description, from the same
  sources.
