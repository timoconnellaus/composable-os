---
title: "native-account-subscriptions"
description: "The subscriptions part of My account (stage 48), for the mobile app, read only: the subscriptions the signed-in customer pays, each with its state in words (trial until, next charge on, ending on, a payment to confirm), and \"Manage on the website\", which opens the business's website account page in the browser (`onManage`)."
editUrl: false
---

The subscriptions part of My account (stage 48), for the mobile app, read only: the subscriptions the signed-in customer pays, each with its state in words (trial until, next charge on, ending on, a payment to confirm), and "Manage on the website", which opens the business's website account page in the browser (`onManage`). Cancelling, keeping it going, changing plan and the card are the website's (ADR 0490, ADR 0714): this block calls no billing operation and shows no price (`noPurchase`). One part for every pack's section (Memberships, Courses): a section passes its own hooks over `subscription.list` (or the account's with `only` for its plans), and `about` for words of its own (a plan change, a cooling off).

<img class="cos-screen cos-screen-native" src="/screens/native-account-subscriptions.png" alt="native-account-subscriptions, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-account-subscriptions` |
| Files | `subscriptions.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)

Source: [blocks/native-account-subscriptions](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-account-subscriptions).
