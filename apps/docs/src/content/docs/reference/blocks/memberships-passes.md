---
title: "memberships-passes"
description: "Buying a pass on a gym's site (stage 32b): the pass types on sale (class packs, drop-ins, an intro offer) with the host's price, what each gives and how long it is valid, and a button that starts the order and opens the payment provider's page."
editUrl: false
---

Buying a pass on a gym's site (stage 32b): the pass types on sale (class packs, drop-ins, an intro offer) with the host's price, what each gives and how long it is valid, and a button that starts the order and opens the payment provider's page. The price, whether it is on sale, and the intro offer's one per person are the host's (`x.memberships.buy`, the host's order): a guest is refused an intro offer and told to sign in, and a second one is refused, whatever this shows. The pass is granted by the host once the provider confirms the payment. Web only. What must be agreed to first (stage 44: the terms, a waiver) is the host's answer too: when "Buy" is refused with it, the documents are shown inline (the web-agree block's step) and "Buy" is tried again. A visitor's agreements travel in the buying call, held in memory until then; a member's are recorded as they agree. A minor is told a parent or guardian buys it.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [memberships](/packs/memberships/screens/) |
| Add it | `cos add memberships-passes` |
| Files | `passes.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/), [web-agree](/reference/blocks/web-agree/) |
| Packages | `@composable-os/client`, `@composable-os/pack-memberships` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.memberships.passTypes`](/packs/memberships/tools/#passtypes)
- [`x.memberships.buy`](/packs/memberships/tools/#buy)
- [`order.checkout`](/reference/operations/order/#ordercheckout)
- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)
- [`agreement.guestVersions`](/reference/operations/agreement/#agreementguestversions)

Source: [packs/memberships/blocks/memberships-passes](https://github.com/timoconnellaus/composable-os/tree/main/packs/memberships/blocks/memberships-passes).
