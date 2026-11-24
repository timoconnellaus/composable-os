---
title: "native-account-payment"
description: "Payment method (stage 48), for the mobile app: the card is kept by the payment provider and changed on the website (ADR 0490, ADR 0714), so this says so and opens the business's website account page in the browser (`onManage`)."
editUrl: false
---

Payment method (stage 48), for the mobile app: the card is kept by the payment provider and changed on the website (ADR 0490, ADR 0714), so this says so and opens the business's website account page in the browser (`onManage`). It calls no operation. The shell shows it only to someone who pays a subscription.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-account-payment` |
| Files | `payment.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

None.

Source: [blocks/native-account-payment](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-account-payment).
