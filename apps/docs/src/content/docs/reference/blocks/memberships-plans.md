---
title: "memberships-plans"
description: "Joining a gym on its site (stage 32b): the membership plans on sale with the host's price per month, what each allows and its trial, and a button that opens the payment provider's page."
editUrl: false
---

Joining a gym on its site (stage 32b): the membership plans on sale with the host's price per month, what each allows and its trial, and a button that opens the payment provider's page. The price is the host's (`usePlans`); whether the trial is given, and the page, are the host's (`useSubscribe`, `subscription.start`): one trial per person per plan object, signed in. The membership itself is granted by the host once the provider confirms the subscription. Web only. A guest who wants the trial confirms their address with a code here, on the plan, when the app passes `signIn` (the web sign-in block's two calls), and goes on to the provider's page signed in, with the trial (ADR 0459). Whether a new address gets a code is the host's. What must be agreed to first (stage 44: the membership terms, a waiver) is the host's answer too: when "Join" is refused with it, the documents are shown inline (the web-agree block's step) and "Join" is tried again. A visitor's agreements travel in subscription.start, held in memory until then; a member's are recorded as they agree. A minor is told a parent or guardian buys it.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [memberships](/packs/memberships/screens/) |
| Add it | `cos add memberships-plans` |
| Files | `plans.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/), [web-agree](/reference/blocks/web-agree/) |
| Packages | `@composable-os/client`, `@composable-os/pack-memberships` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.memberships.plans`](/packs/memberships/tools/#plans)
- [`subscription.start`](/reference/operations/subscription/#subscriptionstart)
- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)
- [`agreement.guestVersions`](/reference/operations/agreement/#agreementguestversions)

Source: [packs/memberships/blocks/memberships-plans](https://github.com/timoconnellaus/composable-os/tree/main/packs/memberships/blocks/memberships-plans).
