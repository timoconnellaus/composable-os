---
title: "web-my-agreements"
description: "My agreements (stage 44 step 5), for the web: what the signed-in member, and each child linked to them, has agreed to (each document, the version, when, how and by whom), what is due (with a notice when a document changed and must be agreed to again), the signed PDF, and a health form's answers to update."
editUrl: false
---

My agreements (stage 44 step 5), for the web: what the signed-in member, and each child linked to them, has agreed to (each document, the version, when, how and by whom), what is due (with a notice when a document changed and must be agreed to again), the signed PDF, and a health form's answers to update. With `personId`, one child's only: a child's agreements, for their parent. What it shows is the host's (me.agreements.list, me.agreements.due, me.agreements.get): a name typed and a signature appear only to whoever agreed, and another guardian sees only "agreed by a parent or guardian". A child signed in sees no guardian's name or signature.

<img class="cos-screen" src="/screens/web-my-agreements.png" alt="web-my-agreements, drawn with dummy data" width="720" height="988" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-my-agreements` |
| Files | `my-agreements.tsx`, `LICENSE` |
| Depends on | [web-agree](/reference/blocks/web-agree/), [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.list`](/reference/operations/me/#meagreementslist)
- [`me.agreements.get`](/reference/operations/me/#meagreementsget)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)

Source: [blocks/web-my-agreements](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-my-agreements).
