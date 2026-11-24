---
title: "native-account-family"
description: "Family (stage 48), for the mobile app: who the signed-in customer acts for and who acts for them."
editUrl: false
---

Family (stage 48), for the mobile app: who the signed-in customer acts for and who acts for them. Staff make and end the links (ADR 0540), so linking a child is a sentence here, not a form. Who is linked is the host's answer (me.family).

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-account-family` |
| Files | `family.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.family`](/reference/operations/me/#mefamily)

Source: [blocks/native-account-family](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-account-family).
