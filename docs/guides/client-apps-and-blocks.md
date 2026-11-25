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

## The visitor's address

The host limits every call to a public operation, and sign-in, per client address
([ADR 0940](../adr/0940-a-rate-limit-per-client-address-for-public-operations.md)). Over the
service binding every call comes from the web app, so the web app names its visitor in the
`cos-visitor-address` header: `forVisitor(request)` from `@composable-os/client` gives the
customer's session cookie and that header together, and `visitorAddress(request.headers)` the
header alone (for a call made as the public, such as the stop route's). Every route in the
template's `src/host.ts` sends it. The host reads the header only over the binding; on the public
HTTP surface (the mobile app's) the address is the connection's and the header is ignored. A web
app that sends none, built from an older template, is counted as one shared bucket: all its
visitors share one limit (1,200 a minute per operation), so update its `src/host.ts`.

## Blocks

A block is a screen, or part of one, in a web or a native skin: a folder with a `block.json`
naming its pack, skin, operations, files and the blocks it depends on
([ADR 0424](../adr/0424-blocks-as-built.md)). `cos add <block>` copies it into a client app, where
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
can only turn that one kind off ([ADR 0675](../adr/0675-consent-to-be-contacted.md)).

## Staff screens

A shipped pack may declare staff screens: web blocks the product's admin builds in and shows to
whoever could call the tools that open them. Each pack's are on its Screens page.

## Role clients

A staff role on a phone (a coach, the rostered team) gets a client holding only its role's
operations and its grants ([ADR 0451](../adr/0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md)).

`mobile.owner: true` adds the **owner's client** (`roles/owner.ts`): only the operations the
owner's Today needs (Today, the approvals, the notice inbox, who is signed in). It is not a pack
role: any staff account may sign in with it, and the host decides every call. `createOwnerHooks`
in `@composable-os/client` gives it hooks the web and native screens share
([ADR 0872](../adr/0872-the-owners-client.md)).
