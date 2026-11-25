---
title: "ticketing-order"
description: "The page the buyer comes back to from the payment provider (stage 27)."
editUrl: false
---

The page the buyer comes back to from the payment provider (stage 27). Coming back proves nothing: only the provider's verified word makes an order paid (ADR 0427), so this shows the order's real state from the host and keeps asking while it is pending.

<img class="cos-screen" src="/screens/ticketing-order.png" alt="ticketing-order, drawn with dummy data" width="640" height="240" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [ticketing](/packs/ticketing/screens/) |
| Add it | `cos add ticketing-order` |
| Files | `order-confirmation.tsx`, `LICENSE` |
| Depends on | nothing |
| Packages | `@composable-os/pack-ticketing` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`order.get`](/reference/operations/order/#orderget)
- [`order.view`](/reference/operations/order/#orderview)

Source: [packs/ticketing/blocks/ticketing-order](https://github.com/timoconnellaus/composable-os/tree/main/packs/ticketing/blocks/ticketing-order).
