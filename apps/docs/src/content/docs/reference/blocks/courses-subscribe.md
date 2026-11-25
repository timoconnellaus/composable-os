---
title: "courses-subscribe"
description: "Subscribing to every course on a studio's site (stage 32a): the course plans with the host's price per month and trial days, and a button that opens the payment provider's page."
editUrl: false
---

Subscribing to every course on a studio's site (stage 32a): the course plans with the host's price per month and trial days, and a button that opens the payment provider's page. The price is the host's (`usePlans`); whether the trial is given, and the page, are the host's (`useSubscribe`, `subscription.start`): one trial per person, signed in. Web only. A guest who wants the trial confirms their address with a code here, on the plan, when the app passes `signIn` (the same two calls as the web sign-in block), and goes on to the provider's page signed in, with the trial (ADR 0459). Whether a new address gets a code is the host's: with "anyone starting a subscription" on and a plan on sale, it does. A signed-in member moving from another platform sees their continuation offer in place of the trial ("continue, free until &lt;date&gt;", `useMyOffers`); taking it is the host's too (`offerId`): only its own person can (ADR 0491). A guest who confirms a code and turns out to have an offer is shown the offer, never sent on to the trial. What must be agreed to first (stage 44: the course terms) is the host's answer too: when "Subscribe" is refused with it, the documents are shown inline (the web-agree block's step) and "Subscribe" is tried again (issue #292). A visitor's agreements travel in subscription.start, held in memory until then; a member's are recorded as they agree. A minor is told a parent or guardian buys it.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-subscribe` |
| Files | `subscribe.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/), [web-agree](/reference/blocks/web-agree/) |
| Packages | `@composable-os/client`, `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.courses.plans`](/packs/courses/tools/#plans)
- [`subscription.start`](/reference/operations/subscription/#subscriptionstart)
- [`subscription.offer.mine`](/reference/operations/subscription/#subscriptionoffermine)
- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)
- [`agreement.guestVersions`](/reference/operations/agreement/#agreementguestversions)

Source: [packs/courses/blocks/courses-subscribe](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-subscribe).
