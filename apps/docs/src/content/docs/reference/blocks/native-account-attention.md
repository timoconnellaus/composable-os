---
title: "native-account-attention"
description: "Needs your attention (stage 48), for the mobile app: the top of the Account tab."
editUrl: false
---

Needs your attention (stage 48), for the mobile app: the top of the Account tab. What needs the signed-in customer, or a child they act for, soonest first, each saying whose it is when it is a child's, and opening where it is dealt with: a section of My account (`onSection`), the form they were asked to fill in (`onFillForm`, where the app has the form's screen), or, for a payment their bank waits on and for the rest of an order to pay, the business's website (`onManage`): money in the app opens the website, never the payment provider's page (ADR 0714). What needs attention is the host's answer (me.attention, ADR 0711); where an item leads is a lookup among the host's sections.

<img class="cos-screen cos-screen-native" src="/screens/native-account-attention.png" alt="native-account-attention, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-account-attention` |
| Files | `attention.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.attention`](/reference/operations/me/#meattention)
- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)

Source: [blocks/native-account-attention](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-account-attention).
