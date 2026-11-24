---
title: "courses-native-subscription"
description: "A member's course subscription in the studio's app (stage 32a), read only: its state, the next charge date or when it ends, and that it gives every course; and a continuation offer they have not taken yet (moving from another platform), in words, to take on the web."
editUrl: false
---

A member's course subscription in the studio's app (stage 32a), read only: its state, the next charge date or when it ends, and that it gives every course; and a continuation offer they have not taken yet (moving from another platform), in words, to take on the web. Starting, cancelling, resuming and the card are on the web only (`noPurchase`: the block lint refuses a subscription operation or a price here). What the subscription gives is the host's; this only says what the host reports.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-native-subscription` |
| Files | `subscription-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)
- [`subscription.offer.mine`](/reference/operations/subscription/#subscriptionoffermine)

Source: [packs/courses/blocks/courses-native-subscription](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-native-subscription).
