---
title: "rostering-week"
description: "The roster week (stage 45 step 7): a week grid, days across on a wide screen and one under another on a phone, each day's shifts in order of start with the kind of work, the place and who is on it; shifts with nobody on them marked, my own highlighted, an open offer shown."
editUrl: false
---

The roster week (stage 45 step 7): a week grid, days across on a wide screen and one under another on a phone, each day's shifts in order of start with the kind of work, the place and who is on it; shifts with nobody on them marked, my own highlighted, an open offer shown. For the team it is read only. For someone who rosters (the host's `me.rosters`, never guessed here) each shift opens the assign panel beside it, and the roster carries each shift's warnings, which the host gives to rosterers only. Times are the host's: each shift's start and end are shown in the business's zone (the roster's `zone`), never the device's, and each day's length comes from the host's `days` (a clock-change day says so). Nothing here works out who may be on a shift: the assign panel shows the host's answer. A duty shift with a checklist (step 4b) shows its name, and how it is going when the host says the reader may see it; `shiftExtra` takes the checklist itself (rostering-checklist).

<img class="cos-screen" src="/screens/rostering-week.png" alt="rostering-week, drawn with dummy data" width="1440" height="908" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-week` |
| Files | `week.tsx`, `assign.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.week`](/packs/rostering/tools/#week)
- [`x.rostering.candidates`](/packs/rostering/tools/#candidates)
- [`x.rostering.assign`](/packs/rostering/tools/#assign)
- [`x.rostering.follow`](/packs/rostering/tools/#follow)
- [`x.rostering.offer`](/packs/rostering/tools/#offer)
- [`x.rostering.markNotWorked`](/packs/rostering/tools/#marknotworked)

Source: [packs/rostering/blocks/rostering-week](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-week).
