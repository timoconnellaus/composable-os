---
title: "rostering-native-checklist"
description: "A shift's checklist in the app (stage 45 step 4b, ADR 0650), for the native my-shifts' `shiftExtra` slot: the same as the web's, over the native base."
editUrl: false
---

A shift's checklist in the app (stage 45 step 4b, ADR 0650), for the native my-shifts' `shiftExtra` slot: the same as the web's, over the native base. The shift's person ticks each step off (done, with a note where the step asks for one; not done, with why) and marks it done, which is final; whoever rosters may tick it for them, saying why, kept as ticked by them for that person. The host decides whose it is, when it may be ticked and whether it is complete: this shows its answer and its refusals. What someone writes on a step is private: kept only in this screen's state, sent with `forgetAfter`, and cleared when the app goes to the background (so the app switcher's snapshot never shows it). The checklist is fetched only when opened, and kept no longer than it is shown.

<img class="cos-screen cos-screen-native" src="/screens/rostering-native-checklist.png" alt="rostering-native-checklist, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-native-checklist` |
| Files | `checklist-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.checklist`](/packs/rostering/tools/#checklist)
- [`x.rostering.tick`](/packs/rostering/tools/#tick)
- [`x.rostering.checklistDone`](/packs/rostering/tools/#checklistdone)

Source: [packs/rostering/blocks/rostering-native-checklist](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-native-checklist).
