---
title: "knowledge-read-status"
description: "Read status (stage 38 step 6, ADR 0708): for those who manage procedures, every published procedure staff must read with how many have confirmed its current version of how many must, and for one, everyone who must read it: who confirmed and when, who has not and since when; with an export as CSV."
editUrl: false
---

Read status (stage 38 step 6, ADR 0708): for those who manage procedures, every published procedure staff must read with how many have confirmed its current version of how many must, and for one, everyone who must read it: who confirmed and when, who has not and since when; with an export as CSV. Declared as the admin's Read status screen, gated by the pack's `readStatus` tool: admins and those granted knowledge:manage, a person only. Who may see this is the host's answer (ADR 0702 as amended by ADR 0706): the tool is refused to anyone else, and this then shows the refusal and nothing more. What it shows is only the tool's answer, kept no longer than it is on screen (`gcTime: 0` in the hook); nothing is stored or logged here, and the CSV is made from the answer on screen when the person asks for it.

<img class="cos-screen" src="/screens/knowledge-read-status.png" alt="knowledge-read-status, drawn with dummy data" width="760" height="505" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [knowledge](/packs/knowledge/screens/) |
| Add it | `cos add knowledge-read-status` |
| Files | `read-status.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-knowledge` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.knowledge.readStatus`](/packs/knowledge/tools/#readstatus)

Source: [packs/knowledge/blocks/knowledge-read-status](https://github.com/timoconnellaus/composable-os/tree/main/packs/knowledge/blocks/knowledge-read-status).
