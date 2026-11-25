---
title: "native-my-agreements"
description: "My agreements (stage 44 step 5), for the mobile app: what the signed-in member and each child linked to them has agreed to (the document, the version, when, how and by whom), what is due (with a notice when a document changed), the signed PDF, and a health form's answers to update."
editUrl: false
---

My agreements (stage 44 step 5), for the mobile app: what the signed-in member and each child linked to them has agreed to (the document, the version, when, how and by whom), what is due (with a notice when a document changed), the signed PDF, and a health form's answers to update. With `personId`, one child's only. What it shows is the host's: a name typed and a signature appear only to whoever agreed, and a child sees no guardian's name or signature. The PDF needs the app's own way to open a file fetched with the session (`onDownload`): the host's route is `agreementPdfPath(id)` on the host's address, with the access token.

<img class="cos-screen cos-screen-native" src="/screens/native-my-agreements.png" alt="native-my-agreements, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-my-agreements` |
| Files | `my-agreements-screen.tsx`, `LICENSE` |
| Depends on | [native-agree](/reference/blocks/native-agree/), [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.list`](/reference/operations/me/#meagreementslist)
- [`me.agreements.get`](/reference/operations/me/#meagreementsget)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)

Source: [blocks/native-my-agreements](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-my-agreements).
