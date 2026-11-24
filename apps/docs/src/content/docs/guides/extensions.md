---
title: "Extensions and packs"
description: "What an extension declares, how a pack is made, and how both are checked."
sidebar:
  order: 4
editUrl: false
---

An outline; the full description is in [docs/architecture.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/architecture.md#4-extensions-the-ai-built-layer)
and [Packs and blocks](https://github.com/timoconnellaus/composable-os/blob/main/docs/architecture.md#packs-and-blocks).

## An extension

An extension is a manifest (`defineExtension` from `@composable-os/sdk`) and its code. It
declares objects and their fields, fields on other objects, views, record tabs and panels,
settings, tools, automations, dashboards and, for a shipped pack, roles, grantable permissions,
routine mail and staff screens. Extension code runs in a dynamic Worker with no network and only
the host modules it asks for ([ADR 0025](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0025-extension-authority-and-runtime.md)); it
calls operations through `ctx.ops`.

## A pack

A pack is a shipped extension in `packs/<id>/`: the extension (`index.ts`), its headless client
hooks (`client/`) and its blocks (`blocks/`), released with the platform and turned on per
product ([ADR 0420](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0420-packs-as-packages-as-built.md)). A pack composes behaviours and
does not hook writes; a new behaviour is platform work. Every pack has its own pages under
[Packs](/packs/), generated from its manifest, and an overview written beside it in
`packs/<id>/docs/overview.md`.

## Writing one

The steps are skills in the repository:
[write-extension](https://github.com/timoconnellaus/composable-os/blob/main/skills/write-extension/SKILL.md) for a new extension or new fields, and
[add-automations-tools-dashboards](https://github.com/timoconnellaus/composable-os/blob/main/skills/add-automations-tools-dashboards/SKILL.md) for
tools, automations and dashboards ([ADR 0405](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0405-skills-ship-with-the-platform.md)).
Both end in the checks the host runs:

```sh
pnpm cos ext check packs/<id>
pnpm cos ext test packs/<id>
```

When the platform or the contract lacks what a pack needs, changing the platform is part of the
work; a workaround in extension code is not.


This guide is [docs/guides/extensions.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/guides/extensions.md), written by hand beside the code.
