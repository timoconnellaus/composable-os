---
title: "knowledge-help-centre"
description: "The help centre (stage 38 step 6, ADR 0708), for a business's own website: a search box with results as the visitor types, and the help topics with their pages; a topic's own page."
editUrl: false
---

The help centre (stage 38 step 6, ADR 0708), for a business's own website: a search box with results as the visitor types, and the help topics with their pages; a topic's own page. Anyone reads it, signed in or not: help pages are public in their published wording only (ADR 0442), and search is the host's `content.search` over published words (ADR 0700), asked for help pages, so it never returns a procedure or a draft. The visitor's words go to the host only as the query and are kept nowhere here. A search box calls the host as the visitor types: the template's operation route passes each call with the visitor's address (`forVisitor`), and the host limits public calls per address. Allow `x.knowledge.helpTopics`, `content.list` and `content.search` on that route.

<img class="cos-screen" src="/screens/knowledge-help-centre.png" alt="knowledge-help-centre, drawn with dummy data" width="860" height="708" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [knowledge](/packs/knowledge/screens/) |
| Add it | `cos add knowledge-help-centre` |
| Files | `help-centre.tsx`, `LICENSE` |
| Depends on | [ui-input](/reference/blocks/ui-input/) |
| Packages | `@composable-os/pack-knowledge` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.knowledge.helpTopics`](/packs/knowledge/tools/#helptopics)
- [`content.list`](/reference/operations/content/#contentlist)
- [`content.search`](/reference/operations/content/#contentsearch)

Source: [packs/knowledge/blocks/knowledge-help-centre](https://github.com/timoconnellaus/composable-os/tree/main/packs/knowledge/blocks/knowledge-help-centre).
