---
title: "memberships-mine"
description: "A member's memberships and passes on the gym's site (stage 32b): what each allows, when it stops or expires, and what is left this week, this month or in all, from the host's count (`x.memberships.mine`, `allowance.get`); and their membership subscriptions, with what they can do: cancel at the period's end, keep it going, change plan (the host decides: an upgrade now, its prorated charge on the card, or a downgrade from the next period), confirm a payment that waits on them, or open the payment provider's portal for their card and invoices."
editUrl: false
---

A member's memberships and passes on the gym's site (stage 32b): what each allows, when it stops or expires, and what is left this week, this month or in all, from the host's count (`x.memberships.mine`, `allowance.get`); and their membership subscriptions, with what they can do: cancel at the period's end, keep it going, change plan (the host decides: an upgrade now, its prorated charge on the card, or a downgrade from the next period), confirm a payment that waits on them, or open the payment provider's portal for their card and invoices. Every action is the host's operation, on their own subscription only. Web only: the app shows the same and does nothing to it. While the host says a new member may cool off (stage 44 step 7, ADR 0647), "Cancel for a full refund" sits beside the ordinary cancel, with the last day of the period; the window is never worked out here. A membership ended that way stays shown, with where its refund is.

<img class="cos-screen" src="/screens/memberships-mine.png" alt="memberships-mine, drawn with dummy data" width="720" height="658" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [memberships](/packs/memberships/screens/) |
| Add it | `cos add memberships-mine` |
| Files | `mine.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/) |
| Packages | `@composable-os/pack-memberships` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.memberships.mine`](/packs/memberships/tools/#mine)
- [`x.memberships.plans`](/packs/memberships/tools/#plans)
- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)
- [`subscription.cancel`](/reference/operations/subscription/#subscriptioncancel)
- [`subscription.resume`](/reference/operations/subscription/#subscriptionresume)
- [`subscription.change`](/reference/operations/subscription/#subscriptionchange)
- [`subscription.portal`](/reference/operations/subscription/#subscriptionportal)
- [`subscription.coolingOff`](/reference/operations/subscription/#subscriptioncoolingoff)
- [`subscription.coolOff`](/reference/operations/subscription/#subscriptioncooloff)

Source: [packs/memberships/blocks/memberships-mine](https://github.com/timoconnellaus/composable-os/tree/main/packs/memberships/blocks/memberships-mine).
