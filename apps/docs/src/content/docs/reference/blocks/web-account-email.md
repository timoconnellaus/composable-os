---
title: "web-account-email"
description: "Changing the sign-in address (stage 48), for the web: the signed-in customer asks with the new address, the host emails a code to it, they enter the code here, and from then on they sign in with the new address."
editUrl: false
---

Changing the sign-in address (stage 48), for the web: the signed-in customer asks with the new address, the host emails a code to it, they enter the code here, and from then on they sign in with the new address. Everything is the host's (me.email.change, me.email.confirm, ADR 0712): the code goes only to the new address, the old one is told by the host, the answer to the request is the same whatever the address, and only once the code is entered does the host say an address is already in use at the business. This block says no more than the host's answers. The host keeps it to a sign-in within the last 15 minutes. When it says `sign_in_again`, the block signs the customer in again in place (`SignInAgain`, a code to the address they sign in with now, through the app's own sign-in: `signIn`), keeps the new address they typed, and asks again. Nothing they typed is logged, put in the address bar or kept in the browser.

<img class="cos-screen" src="/screens/web-account-email.png" alt="web-account-email, drawn with dummy data" width="720" height="174" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-account-email` |
| Files | `email.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.get`](/reference/operations/me/#meget)
- [`me.email.change`](/reference/operations/me/#meemailchange)
- [`me.email.confirm`](/reference/operations/me/#meemailconfirm)

Source: [blocks/web-account-email](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-account-email).
