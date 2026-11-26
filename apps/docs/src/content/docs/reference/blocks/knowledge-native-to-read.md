---
title: "knowledge-native-to-read"
description: "To read in the app (stage 38 step 6, ADR 0708): the same as the web's, over the native base."
editUrl: false
---

To read in the app (stage 38 step 6, ADR 0708): the same as the web's, over the native base. The procedures I must read and have not confirmed, oldest first, with the version to read and since when, and what I have confirmed; one opens in the reader (knowledge-native-procedures), which has Confirm at its end, and once confirmed it leaves the list. For a staff role client (ADR 0451), a coach's and a cleaner's too. What is mine to read is the host's answer.

<img class="cos-screen cos-screen-native" src="/screens/knowledge-native-to-read.png" alt="knowledge-native-to-read, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [knowledge](/packs/knowledge/screens/) |
| Add it | `cos add knowledge-native-to-read` |
| Files | `to-read-screen.tsx`, `LICENSE` |
| Depends on | [knowledge-native-procedures](/reference/blocks/knowledge-native-procedures/), [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-knowledge` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.knowledge.toRead`](/packs/knowledge/tools/#toread)
- [`x.knowledge.confirm`](/packs/knowledge/tools/#confirm)
- [`content.staffGet`](/reference/operations/content/#contentstaffget)

Source: [packs/knowledge/blocks/knowledge-native-to-read](https://github.com/timoconnellaus/composable-os/tree/main/packs/knowledge/blocks/knowledge-native-to-read).
