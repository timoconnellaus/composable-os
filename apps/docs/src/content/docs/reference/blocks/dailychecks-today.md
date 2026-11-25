---
title: "dailychecks-today"
description: "Today's checklists (ADR 0651): the checklists done on their own (opening, closing, cleaning) that are due today and that the viewer may do, each with when it is due by and its steps."
editUrl: false
---

Today's checklists (ADR 0651): the checklists done on their own (opening, closing, cleaning) that are due today and that the viewer may do, each with when it is due by and its steps. Anyone who may do one ticks its steps (done, with a note where the step asks; not done, with why); whoever ticks the last step finishes it, and a finished one never changes. Someone who manages checklists sees every one and may tick for someone who may do it, saying why: kept, and shown, as ticked by them for that person. The host decides everything here: what is due, who may do it (`mayDo`, `canTick`), who may tick for whom, whether a step needs a note, when it is finished. This shows its answer and refusals. What someone writes on a step, why it was not done and why it was ticked for someone are private: kept only in this screen's state, sent with `forgetAfter` (never in a URL, storage or a query's key), cleared when the page is left, and read again when the browser brings it back.

<img class="cos-screen" src="/screens/dailychecks-today.png" alt="dailychecks-today, drawn with dummy data" width="720" height="1388" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [dailychecks](/packs/dailychecks/screens/) |
| Add it | `cos add dailychecks-today` |
| Files | `today.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-dailychecks` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.dailychecks.today`](/packs/dailychecks/tools/#today)
- [`x.dailychecks.day`](/packs/dailychecks/tools/#day)
- [`x.dailychecks.tick`](/packs/dailychecks/tools/#tick)
- [`x.dailychecks.done`](/packs/dailychecks/tools/#done)

Source: [packs/dailychecks/blocks/dailychecks-today](https://github.com/timoconnellaus/composable-os/tree/main/packs/dailychecks/blocks/dailychecks-today).
