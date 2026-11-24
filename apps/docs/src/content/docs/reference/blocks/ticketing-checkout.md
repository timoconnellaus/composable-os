---
title: "ticketing-checkout"
description: "Choosing tickets and paying, for a site (stage 27): quantities per ticket type, pay in full or by deposit when every chosen type offers one, then the payment provider's page."
editUrl: false
---

Choosing tickets and paying, for a site (stage 27): quantities per ticket type, pay in full or by deposit when every chosen type offers one, then the payment provider's page. And paying what is still owed on a part-paid order. The host prices the order, holds the places, refuses what cannot be bought and decides what may be charged; this asks and shows what it answers.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [ticketing](/packs/ticketing/screens/) |
| Add it | `cos add ticketing-checkout` |
| Files | `ticket-picker.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | `@composable-os/client`, `@composable-os/pack-ticketing` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.ticketing.orderStart`](/packs/ticketing/tools/#orderstart)
- [`order.checkout`](/reference/operations/order/#ordercheckout)
- [`order.get`](/reference/operations/order/#orderget)
- [`order.view`](/reference/operations/order/#orderview)

Source: [packs/ticketing/blocks/ticketing-checkout](https://github.com/timoconnellaus/composable-os/tree/main/packs/ticketing/blocks/ticketing-checkout).
