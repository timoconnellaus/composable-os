---
title: "native-account"
description: "My account (stage 48), for the mobile app's Account tab: the signed-in customer's own area, a list of sections, each opening on its own screen."
editUrl: false
---

My account (stage 48), for the mobile app's Account tab: the signed-in customer's own area, a list of sections, each opening on its own screen. The base sections come with it: Orders, Agreements, Family, Payment method (only for someone who pays a subscription), Your details, and Sign-in and devices. The packs' sections are passed in `sections`, each the pack's own screen, and take their place by `order` (a pack's come first). Money in the app is the website's (ADR 0490, ADR 0714): the app shows orders and subscriptions, and the card, cancelling and changing plan open the business's website account page in the browser (`websiteUrl`). No block here calls a billing operation. Which sections this customer has, in what order, and whether Payment method shows is the host's answer (me.portal, ADR 0710). `cos add native-account` copies the packs' section blocks and writes `../account-sections.gen.ts`, which names them; the tab passes them through `usePackSections(ACCOUNT_SECTIONS, react, api)`, so it names no pack. A later step adds "Needs your attention" at the top (me.attention).

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-account` |
| Files | `account-screen.tsx`, `LICENSE` |
| Depends on | [native-account-details](/reference/blocks/native-account-details/), [native-account-devices](/reference/blocks/native-account-devices/), [native-account-family](/reference/blocks/native-account-family/), [native-account-orders](/reference/blocks/native-account-orders/), [native-account-payment](/reference/blocks/native-account-payment/), [native-my-agreements](/reference/blocks/native-my-agreements/), [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.portal`](/reference/operations/me/#meportal)
- [`me.get`](/reference/operations/me/#meget)
- [`me.update`](/reference/operations/me/#meupdate)
- [`me.sessions.list`](/reference/operations/me/#mesessionslist)
- [`me.sessions.revoke`](/reference/operations/me/#mesessionsrevoke)
- [`me.family`](/reference/operations/me/#mefamily)
- [`my.list`](/reference/operations/my/#mylist)
- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)
- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.list`](/reference/operations/me/#meagreementslist)
- [`me.agreements.get`](/reference/operations/me/#meagreementsget)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)

Source: [blocks/native-account](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-account).
