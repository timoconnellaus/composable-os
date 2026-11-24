---
title: "dailychecks-history"
description: "How each day went (ADR 0651), for those who manage checklists: every checklist done on its own, day by day, done (by whom, for whom, when, and whether after its due time) or missed (with the steps nobody ticked)."
editUrl: false
---

How each day went (ADR 0651), for those who manage checklists: every checklist done on its own, day by day, done (by whom, for whom, when, and whether after its due time) or missed (with the steps nobody ticked). Opening a day shows its steps and who ticked each and when. Read-only: a finished or missed day never changes, and today's is ticked on Today's checklists. The host decides who reads this (checklists:write); anyone else is refused and sees that state. What someone wrote on a step is kept no longer than it is on screen (`gcTime: 0`).

|  |  |
| --- | --- |
| Skin | web |
| Pack | [dailychecks](/packs/dailychecks/screens/) |
| Add it | `cos add dailychecks-history` |
| Files | `history.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-dailychecks` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.dailychecks.history`](/packs/dailychecks/tools/#history)
- [`x.dailychecks.day`](/packs/dailychecks/tools/#day)

Source: [packs/dailychecks/blocks/dailychecks-history](https://github.com/timoconnellaus/composable-os/tree/main/packs/dailychecks/blocks/dailychecks-history).
