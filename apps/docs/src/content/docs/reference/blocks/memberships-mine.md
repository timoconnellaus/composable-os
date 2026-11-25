---
title: "memberships-mine"
description: "A member's memberships and passes on the gym's site (stage 32b), and their section of My account (stage 48): what each allows, when it stops or expires, and what is left this week, this month or in all, from the host's count (`x.memberships.mine`, `allowance.get`); a child's the gym linked to them too (decision 8: a parent sees a child's memberships and passes), each under the child's name; and their membership subscriptions, through My account's one subscriptions part (`web-account-subscriptions`): cancel at the period's end, keep it going, confirm a payment that waits on them, and here a change of plan (the host decides: an upgrade now, its prorated charge on the card, or a downgrade from the next period)."
editUrl: false
---

A member's memberships and passes on the gym's site (stage 32b), and their section of My account (stage 48): what each allows, when it stops or expires, and what is left this week, this month or in all, from the host's count (`x.memberships.mine`, `allowance.get`); a child's the gym linked to them too (decision 8: a parent sees a child's memberships and passes), each under the child's name; and their membership subscriptions, through My account's one subscriptions part (`web-account-subscriptions`): cancel at the period's end, keep it going, confirm a payment that waits on them, and here a change of plan (the host decides: an upgrade now, its prorated charge on the card, or a downgrade from the next period). The card is My account's Payment method section, once for every subscription: this block has no card button. While the host says a new member may cool off (stage 44 step 7, ADR 0647), "Cancel for a full refund" sits beside the ordinary cancel, with the last day of the period; the window is never worked out here. A membership ended that way stays shown, with where its refund is. Every action is the host's operation, on their own subscription only. Web only: the app shows the same and does nothing to it.

<img class="cos-screen" src="/screens/memberships-mine.png" alt="memberships-mine, drawn with dummy data" width="720" height="832" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [memberships](/packs/memberships/screens/) |
| Add it | `cos add memberships-mine` |
| Files | `mine.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/), [web-account-subscriptions](/reference/blocks/web-account-subscriptions/) |
| Packages | `@composable-os/client`, `@composable-os/pack-memberships` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.memberships.mine`](/packs/memberships/tools/#mine)
- [`x.memberships.plans`](/packs/memberships/tools/#plans)
- [`me.family`](/reference/operations/me/#mefamily)
- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)
- [`subscription.cancel`](/reference/operations/subscription/#subscriptioncancel)
- [`subscription.resume`](/reference/operations/subscription/#subscriptionresume)
- [`subscription.change`](/reference/operations/subscription/#subscriptionchange)
- [`subscription.coolingOff`](/reference/operations/subscription/#subscriptioncoolingoff)
- [`subscription.coolOff`](/reference/operations/subscription/#subscriptioncooloff)

Source: [packs/memberships/blocks/memberships-mine](https://github.com/timoconnellaus/composable-os/tree/main/packs/memberships/blocks/memberships-mine).
