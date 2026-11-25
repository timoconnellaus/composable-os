---
title: "native-agreements-due"
description: "\"Before you go on\" (stage 44 step 5), for the mobile app: after sign-in, when the host says something is due (me.agreements.due), each due document in turn, the member's own first, then each child's; \"Not now\" goes on to the app."
editUrl: false
---

"Before you go on" (stage 44 step 5), for the mobile app: after sign-in, when the host says something is due (me.agreements.due), each due document in turn, the member's own first, then each child's; "Not now" goes on to the app. A convenience only: the host refuses a booking while anything it needs is due, whatever this screen did.

<img class="cos-screen cos-screen-native" src="/screens/native-agreements-due.png" alt="native-agreements-due, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-agreements-due` |
| Files | `before-you-go-on-screen.tsx`, `LICENSE` |
| Depends on | [native-agree](/reference/blocks/native-agree/), [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)

Source: [blocks/native-agreements-due](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-agreements-due).
