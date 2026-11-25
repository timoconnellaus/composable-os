---
title: "web-account-subscriptions"
description: "The subscriptions part of My account (stage 48), for the web: the subscriptions the signed-in customer pays, each with its state in words, the price per period and the next charge or when it ends, and what they can do: cancel at the period's end, keep a cancelled one going, confirm a payment that waits for them."
editUrl: false
---

The subscriptions part of My account (stage 48), for the web: the subscriptions the signed-in customer pays, each with its state in words, the price per period and the next charge or when it ends, and what they can do: cancel at the period's end, keep a cancelled one going, confirm a payment that waits for them. One part for every pack's section (Memberships, Courses): a section passes its own hooks over the same operations (or the account's with `only` for its plans), and where its pack offers more, `about` (lines of its own, such as a plan change waiting) and `change` (buttons of its own, such as a change of plan). The card is the Payment method section's (web-account-payment), once for every subscription: no section has a card button. Every action is the host's operation on the customer's own subscription (subscription.*): the host refuses what does not apply, and the subscription changes once the provider confirms. Web only: the app shows a subscription and opens the website for the rest (ADR 0714).

<img class="cos-screen" src="/screens/web-account-subscriptions.png" alt="web-account-subscriptions, drawn with dummy data" width="720" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-account-subscriptions` |
| Files | `subscriptions.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)
- [`subscription.cancel`](/reference/operations/subscription/#subscriptioncancel)
- [`subscription.resume`](/reference/operations/subscription/#subscriptionresume)

Source: [blocks/web-account-subscriptions](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-account-subscriptions).
