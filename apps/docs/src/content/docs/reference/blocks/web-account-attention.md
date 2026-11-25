---
title: "web-account-attention"
description: "Needs your attention (stage 48), for the web: the top of My account."
editUrl: false
---

Needs your attention (stage 48), for the web: the top of My account. What needs the signed-in customer, or a child they act for, soonest first: a document to agree to, a card payment that failed, a payment their bank waits on, the rest of a deposit, an order they started paying for, a pass about to run out or used up, a free trial about to end, a form they were asked to fill in. Each says whose it is when it is a child's, and leads to where it is dealt with: a section of the page (`onSection`; money owed on an order, the order's row in Orders, where it is paid), the provider's page for a payment to confirm (only an `https:` address, `followableUrl`), or the form (`onFillForm`, where the app has the form's page). An item goes once the host says its cause is fixed. What needs attention is the host's answer (me.attention, ADR 0711): nothing is worked out here, and where an item leads is a lookup among the sections the host lists.

<img class="cos-screen" src="/screens/web-account-attention.png" alt="web-account-attention, drawn with dummy data" width="720" height="348" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-account-attention` |
| Files | `attention.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.attention`](/reference/operations/me/#meattention)
- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)

Source: [blocks/web-account-attention](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-account-attention).
