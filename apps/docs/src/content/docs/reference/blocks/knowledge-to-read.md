---
title: "knowledge-to-read"
description: "To read (stage 38 step 6, ADR 0708): the procedures I must read and have not confirmed, oldest first, each with the version to read and since when, and what I have confirmed and when."
editUrl: false
---

To read (stage 38 step 6, ADR 0708): the procedures I must read and have not confirmed, oldest first, each with the version to read and since when, and what I have confirmed and when. One opens in the reader (knowledge-procedures), which has Confirm at its end; once confirmed it leaves the list. Declared as the admin's To read screen, for every staff account, pack roles included. What is mine to read is the host's answer (`ack.mine`, through the pack's `toRead`): who must read each procedure, which version, and whether a confirmation counts. This shows it.

<img class="cos-screen" src="/screens/knowledge-to-read.png" alt="knowledge-to-read, drawn with dummy data" width="760" height="440" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [knowledge](/packs/knowledge/screens/) |
| Add it | `cos add knowledge-to-read` |
| Files | `to-read.tsx`, `LICENSE` |
| Depends on | [knowledge-procedures](/reference/blocks/knowledge-procedures/), [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-knowledge` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.knowledge.toRead`](/packs/knowledge/tools/#toread)
- [`x.knowledge.confirm`](/packs/knowledge/tools/#confirm)
- [`content.staffGet`](/reference/operations/content/#contentstaffget)

Source: [packs/knowledge/blocks/knowledge-to-read](https://github.com/timoconnellaus/composable-os/tree/main/packs/knowledge/blocks/knowledge-to-read).
