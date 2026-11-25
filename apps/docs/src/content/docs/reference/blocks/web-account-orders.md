---
title: "web-account-orders"
description: "Orders (stage 48), for the web: the one list of the signed-in customer's orders, newest first, each with its state, its lines, tax, deposit, what was paid, what is still to pay and by when, and what was refunded."
editUrl: false
---

Orders (stage 48), for the web: the one list of the signed-in customer's orders, newest first, each with its state, its lines, tax, deposit, what was paid, what is still to pay and by when, and what was refunded. Every figure is the host's, in the currency's minor unit, shown in the order's currency (my.list on `order` and `orderLine`, through the seam: their own orders only, never a child's). A paid order's receipt is the payment provider's email until the host has a receipt document (stage 35): then `receiptUrl` is set and the row links to it. An order waiting for payment, or with the rest of a deposit to pay, has a pay button (with `useCheckoutOrder` and `returnUrl` given): it asks the host for the provider's page for this order (order.checkout, their own order only) and goes there. The host says what is charged, and only the provider's confirmation, never coming back, marks it paid. Each row's id is `account-order-<id>`, so Needs your attention opens at it.

<img class="cos-screen" src="/screens/web-account-orders.png" alt="web-account-orders, drawn with dummy data" width="720" height="1070" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-account-orders` |
| Files | `orders.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`my.list`](/reference/operations/my/#mylist)
- [`order.checkout`](/reference/operations/order/#ordercheckout)

Source: [blocks/web-account-orders](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-account-orders).
