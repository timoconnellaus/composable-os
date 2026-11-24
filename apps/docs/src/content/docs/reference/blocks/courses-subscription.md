---
title: "courses-subscription"
description: "A member's own course subscription on the studio's site (stage 32a): its state in words, the next charge or when it ends, and what they can do: cancel at the period's end, keep it going, confirm a payment that waits on them, or open the payment provider's portal for their card and past invoices."
editUrl: false
---

A member's own course subscription on the studio's site (stage 32a): its state in words, the next charge or when it ends, and what they can do: cancel at the period's end, keep it going, confirm a payment that waits on them, or open the payment provider's portal for their card and past invoices. Every action is the host's operation (`subscription.*`), on the member's own subscription only; the host refuses what does not apply, and the record changes once the provider confirms. Web only: the app shows the subscription and does nothing to it.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-subscription` |
| Files | `my-subscription.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/) |
| Packages | `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)
- [`subscription.cancel`](/reference/operations/subscription/#subscriptioncancel)
- [`subscription.resume`](/reference/operations/subscription/#subscriptionresume)
- [`subscription.portal`](/reference/operations/subscription/#subscriptionportal)

Source: [packs/courses/blocks/courses-subscription](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-subscription).
