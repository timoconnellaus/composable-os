---
title: "knowledge-native-procedures"
description: "Procedures in the app, for staff (stage 38 step 6, ADR 0708): the same as the web's, over the native base."
editUrl: false
---

Procedures in the app, for staff (stage 38 step 6, ADR 0708): the same as the web's, over the native base. Every published procedure, by section, with search; the reader shows one in the wording last published ("Version 4, published 3 March 2026"), never the draft, with "I have read and understood this" at its end when it is the reader's to confirm. For a staff role client (ADR 0451): a coach's, a cleaner's, the door's too. The host decides everything (ADRs 0701, 0702): what is published and its version, who must read it, and whether a confirmation counts. The button confirms the version on screen, never the one the list names; a refusal (a newer version, already confirmed) is shown, never taken as done. Rich text is the Content pack's native renderer (`content-native-rich-text`). Each procedure's section is what the host gives with it (`names.section`: its id, name and order, ADR 0708). A pack-role account is not served a procedure's pictures (the host's media rule): a picture it cannot have says so in its place.

<img class="cos-screen cos-screen-native" src="/screens/knowledge-native-procedures.png" alt="knowledge-native-procedures, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [knowledge](/packs/knowledge/screens/) |
| Add it | `cos add knowledge-native-procedures` |
| Files | `procedures-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/), [content-native-rich-text](/reference/blocks/content-native-rich-text/) |
| Packages | `@composable-os/pack-knowledge` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`content.staffList`](/reference/operations/content/#contentstafflist)
- [`content.staffGet`](/reference/operations/content/#contentstaffget)
- [`content.search`](/reference/operations/content/#contentsearch)
- [`x.knowledge.toRead`](/packs/knowledge/tools/#toread)
- [`x.knowledge.confirm`](/packs/knowledge/tools/#confirm)

Source: [packs/knowledge/blocks/knowledge-native-procedures](https://github.com/timoconnellaus/composable-os/tree/main/packs/knowledge/blocks/knowledge-native-procedures).
