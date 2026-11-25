---
title: "rostering-checklists"
description: "How checklists went (stage 45 step 4b, ADR 0650), for whoever rosters: every checklist run in a range of dates, by checklist and then by date, each with its shift, its person, whether it is open, done, missed or cancelled, how many steps were ticked, how many were ticked for the person by someone else, and the steps nobody ticked when it was missed."
editUrl: false
---

How checklists went (stage 45 step 4b, ADR 0650), for whoever rosters: every checklist run in a range of dates, by checklist and then by date, each with its shift, its person, whether it is open, done, missed or cancelled, how many steps were ticked, how many were ticked for the person by someone else, and the steps nobody ticked when it was missed. A closed run takes a correction: a note kept beside it, never a change to its ticks. The host decides who sees this: the screen asks `me` first and shows nothing but a line unless the host says the reader rosters, and the host refuses anyone else anyway. The runs are kept no longer than they are shown; a correction is sent with `forgetAfter` and kept only on screen.

<img class="cos-screen" src="/screens/rostering-checklists.png" alt="rostering-checklists, drawn with dummy data" width="800" height="1602" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-checklists` |
| Files | `checklists.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.checklistRuns`](/packs/rostering/tools/#checklistruns)
- [`x.rostering.checklistCorrect`](/packs/rostering/tools/#checklistcorrect)

Source: [packs/rostering/blocks/rostering-checklists](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-checklists).
