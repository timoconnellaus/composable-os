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

The host limits calls to public operations, and sign-in, per client address for floods
([ADR 0940](../adr/0940-a-rate-limit-per-client-address-for-public-operations.md)). Over the
service binding every call comes from the web app, so the web app names its visitor:
`forVisitor(request)` from `@composable-os/client` gives the customer's session cookie and the
`cos-visitor-address` header (made from Cloudflare's `cf-connecting-ip` on the browser's request)
together, and `visitorAddress(request.headers)` the header alone (for a call made as the public,
such as the stop route's). Every route in the template's `src/host.ts` sends it.

- **Never pass the browser's request headers on as they came** (`env.HOST.fetch(request)`, or
  copying every header): a `cos-visitor-address` the browser sent would then reach the host. The
  host reads a forwarded `cf-connecting-ip` before the header, so such a proxy still counts the real
  visitor, but build your headers afresh as the template does.
- On the public HTTP surface (the mobile app's) the address is the connection's and the header is
  ignored.
- A web app that sends no address, built from an older template, puts all its visitors in one
  shared bucket (6,000 calls a minute per operation, never locked out of promo codes), and the
  admins are told once a day. Update its `src/host.ts` (`cos upgrade` replaces an unedited one).

## Blocks

A block is a screen, or part of one, in a web or a native skin: a folder with a `block.json`
naming its pack, skin, operations, files and the blocks it depends on
([ADR 0424](../adr/0424-blocks-as-built.md)). `cos add <block>` copies it into a client app, where
it is the app's own; `cos diff <block>` shows upstream changes. A block holds no rules: the block
lint refuses one that does. Web and native share logic (the hooks), not screens. Every block is in
the [reference](/reference/blocks/).

## My account

`cos add web-account` (or `native-account`) copies the customer's own area: **Needs your
attention** at the top (`me.attention`: each item says whose it is, a child's by name, and leads to
the section that deals with it), then the sections the host lists for the customer (`me.portal`):
each installed pack's (bookings, memberships and passes, courses, tickets, training), then orders,
agreements, family, payment method, your details (with changing the sign-in address), contact
preferences, sign-in and devices, and **Delete my account**. The page names no pack:
`account-sections.gen.ts` lists the packs' copied section blocks.

The shell takes `signIn`, the app's own sign-in by code (`requestCode`, `confirm`). Changing the
sign-in address and deleting the account need a sign-in within the last 15 minutes; when the host
answers `sign_in_again`, the block signs the customer in again in place and carries on. Deleting
first shows the host's preview in full, and confirms only that preview once the customer types
DELETE. Once the host has deleted the account, the hooks forget everything the app's query cache
holds (make them with `createAccountHooks({ useQuery, useMutation, useQueryClient }, api)`), and
the native shell's `endSession` (the app's `session.signOut`) forgets the device's tokens at once;
`onDeleted` is where the app goes after (the web: its home page; the app: its sign-in). Memberships
and Courses show their subscriptions through one subscriptions part; the card is Payment method's
alone. The rest of an order to pay leads to that order in Orders: on the web its row pays it on the
provider's page (`order.checkout`, coming back to the shell's `returnUrl`). In the mobile app the
shell gives a pack's screen `onManage`: money, an order to pay included, opens the business's
website account page ([ADR 0714](../adr/0714-the-app-shows-money-and-opens-the-website.md),
[ADR 0715](../adr/0715-the-account-blocks-signing-in-again-in-place-and-one-subscriptions-part.md)).
A `form_to_fill` item opens through the shell's `onFillForm(linkId)`: an app with Forms opens
Forms' `LinkedFormBlock` (`LinkedFormScreen` in the app) with that id.

The template mobile app's Account tab is the native shell already: `cos create --with-mobile`
copies it with its sections. After `cos upgrade`, a pack's section whose copied block is older than
the release's (it lacks the export the section now names) is left out of the wiring, so the app
still compiles, and named with `cos diff <block>`; the upgrade also lists every copied block that
changed upstream.

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
