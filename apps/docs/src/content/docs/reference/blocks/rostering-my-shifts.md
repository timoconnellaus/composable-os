---
title: "rostering-my-shifts"
description: "My shifts (stage 45 step 7), for every rostered person: my shifts over the next weeks, day by day, each with its time in the business's zone, its place, and a button to offer it to everyone who could take it, or to withdraw my open offer."
editUrl: false
---

My shifts (stage 45 step 7), for every rostered person: my shifts over the next weeks, day by day, each with its time in the business's zone, its place, and a button to offer it to everyone who could take it, or to withdraw my open offer. An offered shift stays mine (in my list and my pay) until someone takes it; the host says so, and refuses an offer it would not let through (nobody else qualified, past the cut-off, already offered), each with its own state here. Room is left for what later steps add: a duty shift's checklist under the shift (`shiftExtra`, step 4b) and my calendar's address above the list (`calendar`, step 5). Under the list, My hours (my-hours.tsx, the owner's decision of 2026-11-24): my own hours for a pay period, fetched only when I pick one.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-my-shifts` |
| Files | `my-shifts.tsx`, `my-hours.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.mine`](/packs/rostering/tools/#mine)
- [`x.rostering.offers`](/packs/rostering/tools/#offers)
- [`x.rostering.offer`](/packs/rostering/tools/#offer)
- [`x.rostering.withdraw`](/packs/rostering/tools/#withdraw)
- [`x.rostering.myPayPeriods`](/packs/rostering/tools/#mypayperiods)
- [`x.rostering.myPay`](/packs/rostering/tools/#mypay)

Source: [packs/rostering/blocks/rostering-my-shifts](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-my-shifts).
