---
title: Client apps and blocks
description: A company's own web and mobile apps, the typed client, and blocks copied with cos add.
order: 5
---

An outline; the full description is in [docs/architecture.md](../architecture.md#the-http-surface-and-the-typed-client),
[Packs and blocks](../architecture.md#packs-and-blocks) and [Client repos](../architecture.md#client-repos).

## The typed client

A client app reaches the host only through the typed client, generated per product from the
registry, over the HTTP surface: one route per operation, for staff, customers and the public
([ADR 0403](../adr/0403-http-surface-and-typed-client.md),
[ADR 0415](../adr/0415-the-http-surface-as-built.md),
[ADR 0418](../adr/0418-the-typed-client-as-built.md)). Client code never opens the database. A
web app on Cloudflare reaches its host by a service binding; the mobile app by HTTP.

## Blocks

A block is a screen, or part of one, in a web or a native skin: a folder with a `block.json`
naming its pack, skin, operations, files and the blocks it depends on
([ADR 0424](../adr/0424-blocks-as-built.md)). `cos add <block>` copies it into a client app, where
it is the app's own; `cos diff <block>` shows upstream changes. A block holds no rules: the block
lint refuses one that does. Web and native share logic (the hooks), not screens. Every block is in
the [reference](/reference/blocks/).

## Staff screens

A shipped pack may declare staff screens: web blocks the product's admin builds in and shows to
whoever could call the tools that open them. Each pack's are on its Screens page.

## Role clients

A staff role on a phone (a coach, the rostered team) gets a client holding only its role's
operations and its grants ([ADR 0451](../adr/0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md)).
