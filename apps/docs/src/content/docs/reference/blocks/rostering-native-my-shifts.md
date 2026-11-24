---
title: "rostering-native-my-shifts"
description: "My shifts in the app (stage 45 step 7), for every rostered person: a cleaner with the `rostering.team` role (its role client), a coach whose role client was generated with the grant `rostering:roster`, or anyone else on the roster."
editUrl: false
---

My shifts in the app (stage 45 step 7), for every rostered person: a cleaner with the `rostering.team` role (its role client), a coach whose role client was generated with the grant `rostering:roster`, or anyone else on the roster. The next weeks' shifts day by day, each with its time in the business's zone and its place, and offering one for someone else to take or withdrawing my offer. The shared logic is the pack's headless entry, as on the web; only the screen differs. The host decides and this shows: an offered shift stays mine until taken; an offer nobody could take, one past the cut-off, or one already made is refused with its own words. Room is left for a duty shift's checklist (`shiftExtra`: rostering-native-checklist's ShiftChecklistNative) and my calendar's address (`calendar`, step 5). Under the list, My hours (my-hours-screen.tsx, the owner's decision of 2026-11-24): my own hours for a pay period, fetched only when I pick one.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-native-my-shifts` |
| Files | `my-shifts-screen.tsx`, `my-hours-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
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

Source: [packs/rostering/blocks/rostering-native-my-shifts](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-native-my-shifts).
