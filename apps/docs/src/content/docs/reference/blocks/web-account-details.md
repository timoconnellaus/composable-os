---
title: "web-account-details"
description: "Your details (stage 48), for the web: the signed-in customer's name and phone, to change, and the address they sign in with."
editUrl: false
---

Your details (stage 48), for the web: the signed-in customer's name and phone, to change, and the address they sign in with. What is saved, and what the business sees, is the host's (me.get, me.update): only what changed is sent, and the host checks it again.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-account-details` |
| Files | `details.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.get`](/reference/operations/me/#meget)
- [`me.update`](/reference/operations/me/#meupdate)

Source: [blocks/web-account-details](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-account-details).
