---
title: "ticketing-checkout"
description: "Choosing tickets and paying, for a site (stage 27): quantities per ticket type, pay in full or by deposit when every chosen type offers one, then the payment provider's page."
editUrl: false
---

Choosing tickets and paying, for a site (stage 27): quantities per ticket type, pay in full or by deposit when every chosen type offers one, then the payment provider's page. And paying what is still owed on a part-paid order. The host prices the order, holds the places, refuses what cannot be bought and decides what may be charged; this asks and shows what it answers. What must be agreed to first (stage 44: a waiver on the event) is the host's answer too: when "Pay" is refused with it, the documents are shown inline (the web-agree block's step) and "Pay" is tried again (issue #292). A visitor's agreements travel in the buying call, held in memory until then; a member's are recorded as they agree. A minor is told a parent or guardian buys it.

<img class="cos-screen" src="/screens/ticketing-checkout.png" alt="ticketing-checkout, drawn with dummy data" width="560" height="508" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [ticketing](/packs/ticketing/screens/) |
| Add it | `cos add ticketing-checkout` |
| Files | `ticket-picker.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/), [web-agree](/reference/blocks/web-agree/) |
| Packages | `@composable-os/client`, `@composable-os/pack-ticketing` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.ticketing.orderStart`](/packs/ticketing/tools/#orderstart)
- [`order.checkout`](/reference/operations/order/#ordercheckout)
- [`order.get`](/reference/operations/order/#orderget)
- [`order.view`](/reference/operations/order/#orderview)
- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)
- [`agreement.guestVersions`](/reference/operations/agreement/#agreementguestversions)

Source: [packs/ticketing/blocks/ticketing-checkout](https://github.com/timoconnellaus/composable-os/tree/main/packs/ticketing/blocks/ticketing-checkout).
