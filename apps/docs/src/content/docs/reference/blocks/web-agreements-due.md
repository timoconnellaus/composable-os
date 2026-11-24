---
title: "web-agreements-due"
description: "\"Before you go on\" (stage 44 step 5), for the web: shown after sign-in when the host says something is due (me.agreements.due)."
editUrl: false
---

"Before you go on" (stage 44 step 5), for the web: shown after sign-in when the host says something is due (me.agreements.due). Each due document in turn, the member's own first, then each child's linked to them; "Not now" goes on to their account. It is a convenience: the host refuses a booking or a purchase while anything it needs is due, whatever this screen did.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-agreements-due` |
| Files | `before-you-go-on.tsx`, `LICENSE` |
| Depends on | [web-agree](/reference/blocks/web-agree/), [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)

Source: [blocks/web-agreements-due](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-agreements-due).
