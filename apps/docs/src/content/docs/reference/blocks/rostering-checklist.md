---
title: "rostering-checklist"
description: "A shift's checklist (stage 45 step 4b, ADR 0650), for the `shiftExtra` slot under a shift (my shifts; a rosterer's week)."
editUrl: false
---

A shift's checklist (stage 45 step 4b, ADR 0650), for the `shiftExtra` slot under a shift (my shifts; a rosterer's week). A duty may carry a checklist: its shift's person ticks each step off, done (with a note where the step asks for one) or not done (with why), and marks it done, which is final. Whoever rosters may tick it for the person, saying why: it is kept, and shown, as ticked by them for that person. The host decides everything here: whose it is to tick (`canTick`, `onBehalf`), when (from the shift's start until 2 hours after its end), whether a step needs a note, whether every required step is ticked. This shows the host's answer and its refusals, each in its own state. What someone writes on a step, why it was not done and why it was ticked for them are private: kept only in this screen's state, sent with `forgetAfter` (never in a URL, storage or a query's key), cleared when the page is left, and read again when the browser brings it back. The checklist itself is fetched only when it is opened, and kept no longer than it is shown.

<img class="cos-screen" src="/screens/rostering-checklist.png" alt="rostering-checklist, drawn with dummy data" width="720" height="954" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-checklist` |
| Files | `checklist.tsx`, `my-shifts-with-checklist.tsx`, `LICENSE` |
| Depends on | [rostering-my-shifts](/reference/blocks/rostering-my-shifts/), [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.checklist`](/packs/rostering/tools/#checklist)
- [`x.rostering.tick`](/packs/rostering/tools/#tick)
- [`x.rostering.checklistDone`](/packs/rostering/tools/#checklistdone)
- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.mine`](/packs/rostering/tools/#mine)
- [`x.rostering.offers`](/packs/rostering/tools/#offers)
- [`x.rostering.offer`](/packs/rostering/tools/#offer)
- [`x.rostering.withdraw`](/packs/rostering/tools/#withdraw)
- [`x.rostering.myPayPeriods`](/packs/rostering/tools/#mypayperiods)
- [`x.rostering.myPay`](/packs/rostering/tools/#mypay)

Source: [packs/rostering/blocks/rostering-checklist](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-checklist).
