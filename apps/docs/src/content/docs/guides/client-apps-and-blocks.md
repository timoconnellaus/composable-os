---
title: "Client apps and blocks"
description: "A company's own web and mobile apps, the typed client, and blocks copied with cos add."
sidebar:
  order: 5
editUrl: false
---

An outline; the full description is in [docs/architecture.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/architecture.md#the-http-surface-and-the-typed-client),
[Packs and blocks](https://github.com/timoconnellaus/composable-os/blob/main/docs/architecture.md#packs-and-blocks) and [Client repos](https://github.com/timoconnellaus/composable-os/blob/main/docs/architecture.md#client-repos).

## The typed client

A client app reaches the host only through the typed client, generated per product from the
registry, over the HTTP surface: one route per operation, for staff, customers and the public
([ADR 0403](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0403-http-surface-and-typed-client.md),
[ADR 0415](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0415-the-http-surface-as-built.md),
[ADR 0418](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0418-the-typed-client-as-built.md)). Client code never opens the database. A
web app on Cloudflare reaches its host by a service binding; the mobile app by HTTP.

## Blocks

A block is a screen, or part of one, in a web or a native skin: a folder with a `block.json`
naming its pack, skin, operations, files and the blocks it depends on
([ADR 0424](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0424-blocks-as-built.md)). `cos add <block>` copies it into a client app, where
it is the app's own; `cos diff <block>` shows upstream changes. A block holds no rules: the block
lint refuses one that does. Web and native share logic (the hooks), not screens. Every block is in
the [reference](/reference/blocks/).

## Contact preferences and the one-tap stop

My account's **Contact preferences** section (`web-account-contact`, `native-account-contact`,
over `useContactChoices` and `useSetContactChoices`) shows each kind of message a member may get,
on each channel it goes by, for them and each child they act for, and turns one channel on or off
with a tap. What may change is the host's answer: a booking's or a payment's email always goes,
news and offers need a yes and never go to a child. The template web app's `/stop` route
(`stopRoute` in `src/host.ts`) is where a stoppable email's one-tap stop and its List-Unsubscribe
header point: it shows one button and posts the host's token to the public `contact.stop`, which
can only turn that one kind off ([ADR 0675](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0675-consent-to-be-contacted.md)).

## Staff screens

A shipped pack may declare staff screens: web blocks the product's admin builds in and shows to
whoever could call the tools that open them. Each pack's are on its Screens page.

## Role clients

A staff role on a phone (a coach, the rostered team) gets a client holding only its role's
operations and its grants ([ADR 0451](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md)).

`mobile.owner: true` adds the **owner's client** (`roles/owner.ts`): only the operations the
owner's Today needs (Today, the approvals, the notice inbox, who is signed in). It is not a pack
role: any staff account may sign in with it, and the host decides every call. `createOwnerHooks`
in `@composable-os/client` gives it hooks the web and native screens share
([ADR 0872](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0872-the-owners-client.md)).


This guide is [docs/guides/client-apps-and-blocks.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/guides/client-apps-and-blocks.md), written by hand beside the code.
