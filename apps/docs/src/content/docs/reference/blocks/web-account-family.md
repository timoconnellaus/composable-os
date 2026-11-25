---
title: "web-account-family"
description: "Family (stage 48), for the web: who the signed-in customer acts for (a child linked to them) and who acts for them (a parent or guardian)."
editUrl: false
---

Family (stage 48), for the web: who the signed-in customer acts for (a child linked to them) and who acts for them (a parent or guardian). The links are the business's: staff make and end them (ADR 0540), so linking a child is a sentence here, not a form. Who is linked is the host's answer (me.family).

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-account-family` |
| Files | `family.tsx`, `LICENSE` |
| Depends on | nothing |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.family`](/reference/operations/me/#mefamily)

Source: [blocks/web-account-family](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-account-family).
