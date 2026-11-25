---
title: "courses-subscription"
description: "A member's own course subscription on the studio's site (stage 32a), through My account's one subscriptions part (`web-account-subscriptions`, stage 48): its state in words, the next charge or when it ends, and what they can do: cancel at the period's end, keep it going, confirm a payment that waits on them."
editUrl: false
---

A member's own course subscription on the studio's site (stage 32a), through My account's one subscriptions part (`web-account-subscriptions`, stage 48): its state in words, the next charge or when it ends, and what they can do: cancel at the period's end, keep it going, confirm a payment that waits on them. The card and past invoices are My account's Payment method section, once for every subscription: this block has no card button. Every action is the host's operation (`subscription.*`), on the member's own subscription only; the host refuses what does not apply, and the record changes once the provider confirms. Web only: the app shows the subscription and does nothing to it.

<img class="cos-screen" src="/screens/courses-subscription.png" alt="courses-subscription, drawn with dummy data" width="640" height="238" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-subscription` |
| Files | `my-subscription.tsx`, `LICENSE` |
| Depends on | [web-account-subscriptions](/reference/blocks/web-account-subscriptions/) |
| Packages | `@composable-os/client`, `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)
- [`subscription.cancel`](/reference/operations/subscription/#subscriptioncancel)
- [`subscription.resume`](/reference/operations/subscription/#subscriptionresume)

Source: [packs/courses/blocks/courses-subscription](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-subscription).
