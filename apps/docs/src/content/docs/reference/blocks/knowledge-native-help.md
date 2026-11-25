---
title: "knowledge-native-help"
description: "The help centre in the app (stage 38 step 6, ADR 0708), for members: the same as the web's, over the native base."
editUrl: false
---

The help centre in the app (stage 38 step 6, ADR 0708), for members: the same as the web's, over the native base. A search box with results as the member types, the help topics with their pages, and one page with its related pages. Help pages are public in their published wording only (ADR 0442); search is the host's `content.search` over published help pages (ADR 0700), never a procedure or a draft. The page's words are drawn by the Content pack's native renderer (`content-native-rich-text`).

<img class="cos-screen cos-screen-native" src="/screens/knowledge-native-help.png" alt="knowledge-native-help, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [knowledge](/packs/knowledge/screens/) |
| Add it | `cos add knowledge-native-help` |
| Files | `help-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/), [content-native-rich-text](/reference/blocks/content-native-rich-text/) |
| Packages | `@composable-os/pack-knowledge` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.knowledge.helpTopics`](/packs/knowledge/tools/#helptopics)
- [`content.list`](/reference/operations/content/#contentlist)
- [`content.search`](/reference/operations/content/#contentsearch)
- [`content.get`](/reference/operations/content/#contentget)

Source: [packs/knowledge/blocks/knowledge-native-help](https://github.com/timoconnellaus/composable-os/tree/main/packs/knowledge/blocks/knowledge-native-help).
