---
title: "knowledge-procedures"
description: "Procedures for staff (stage 38 step 6, ADR 0708): every published procedure, by section, with search, and the reader: one procedure in the wording last published (\"Version 4, published 3 March 2026\"), never the draft, with \"I have read and understood this\" at its end when it is the reader's to confirm."
editUrl: false
---

Procedures for staff (stage 38 step 6, ADR 0708): every published procedure, by section, with search, and the reader: one procedure in the wording last published ("Version 4, published 3 March 2026"), never the draft, with "I have read and understood this" at its end when it is the reader's to confirm. Declared as the admin's Procedures screen (and, as `ProcedureScreen`, the record screen a notice's link opens), so every staff account sees it, pack roles included. The host decides everything here (ADRs 0701, 0702): what is published and its version, who must read it, whether a confirmation counts, and whether one is allowed at all. The button confirms the version on screen, the one the person was shown, never the version their list names; a refusal (a newer version published meanwhile, already confirmed) is shown, never taken as done. Rich text is drawn by the Content pack's renderer only: nothing here is HTML. A pack-role account (a coach, a cleaner) reads procedures but not section names (it is refused them; the list is then not grouped), and is not served a procedure's pictures (the host's media rule): a picture it cannot have says so in its place.

<img class="cos-screen" src="/screens/knowledge-procedures.png" alt="knowledge-procedures, drawn with dummy data" width="860" height="718" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [knowledge](/packs/knowledge/screens/) |
| Add it | `cos add knowledge-procedures` |
| Files | `procedures.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [content-rich-text](/reference/blocks/content-rich-text/) |
| Packages | `@composable-os/pack-knowledge` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`content.staffList`](/reference/operations/content/#contentstafflist)
- [`content.staffGet`](/reference/operations/content/#contentstaffget)
- [`content.search`](/reference/operations/content/#contentsearch)
- [`record.list`](/reference/operations/record/#recordlist)
- [`x.knowledge.toRead`](/packs/knowledge/tools/#toread)
- [`x.knowledge.confirm`](/packs/knowledge/tools/#confirm)

Source: [packs/knowledge/blocks/knowledge-procedures](https://github.com/timoconnellaus/composable-os/tree/main/packs/knowledge/blocks/knowledge-procedures).
