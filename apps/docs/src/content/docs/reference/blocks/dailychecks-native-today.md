---
title: "dailychecks-native-today"
description: "Today's checklists in the app (ADR 0651): the same as the web's, over the native base."
editUrl: false
---

Today's checklists in the app (ADR 0651): the same as the web's, over the native base. The checklists done on their own that are due today and that the viewer may do; anyone who may do one ticks its steps (done, with a note where the step asks; not done, with why), and whoever ticks the last step finishes it, which is final. The host decides what is due, who may do it and when it is finished: this shows its answer and its refusals. Ticking for someone else is on the web (those who manage checklists use the admin). What someone writes on a step is private: kept only in this screen's state, sent with `forgetAfter`, and cleared when the app goes to the background (so the app switcher's snapshot never shows it). Today's checklists are kept no longer than they are shown.

<img class="cos-screen cos-screen-native" src="/screens/dailychecks-native-today.png" alt="dailychecks-native-today, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [dailychecks](/packs/dailychecks/screens/) |
| Add it | `cos add dailychecks-native-today` |
| Files | `today-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-dailychecks` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.dailychecks.today`](/packs/dailychecks/tools/#today)
- [`x.dailychecks.tick`](/packs/dailychecks/tools/#tick)
- [`x.dailychecks.done`](/packs/dailychecks/tools/#done)

Source: [packs/dailychecks/blocks/dailychecks-native-today](https://github.com/timoconnellaus/composable-os/tree/main/packs/dailychecks/blocks/dailychecks-native-today).
