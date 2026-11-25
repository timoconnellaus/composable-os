---
title: "native-account-email"
description: "Changing the sign-in address (stage 48), for the mobile app: the same flow as the web's (`web-account-email`), in the app (ADR 0714: it is not money, so it works here)."
editUrl: false
---

Changing the sign-in address (stage 48), for the mobile app: the same flow as the web's (`web-account-email`), in the app (ADR 0714: it is not money, so it works here). The signed-in customer asks with the new address, the host emails a code to it, they enter it, and from then on they sign in with the new address. Everything is the host's (me.email.change, me.email.confirm, ADR 0712): the code goes only to the new address, the old one is told by the host, the request answers the same whatever the address, and only once the code is entered does the host say an address is already in use. When the host says `sign_in_again` (a sign-in more than 15 minutes ago), the block signs the customer in again in place (`SignInAgain`, through the app's session: `signIn`), keeps what they typed, and carries on. Nothing they typed is logged or stored on the device.

<img class="cos-screen cos-screen-native" src="/screens/native-account-email.png" alt="native-account-email, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-account-email` |
| Files | `email.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.get`](/reference/operations/me/#meget)
- [`me.email.change`](/reference/operations/me/#meemailchange)
- [`me.email.confirm`](/reference/operations/me/#meemailconfirm)

Source: [blocks/native-account-email](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-account-email).
