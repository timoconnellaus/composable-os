---
title: "rostering-my-availability"
description: "My availability (stage 45 step 7), for every rostered person: the times I said I cannot work (leave and other one-off times, and regular time off such as every Wednesday afternoon), to add and to end."
editUrl: false
---

My availability (stage 45 step 7), for every rostered person: the times I said I cannot work (leave and other one-off times, and regular time off such as every Wednesday afternoon), to add and to end. Nobody approves it. Only I and whoever rosters ever see it: other staff see nothing, not even that I am away. When I add time off over shifts I am already on, they stay mine (the host lists them in its answer, and tells whoever rosters), and this offers them in one step. What I write about my time off (the note) is forgotten once the call is over and when I leave the page; it is read back only on this screen, and kept in the app's cache no longer than it is shown.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-my-availability` |
| Files | `my-availability.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.myAway`](/packs/rostering/tools/#myaway)
- [`x.rostering.away`](/packs/rostering/tools/#away)
- [`x.rostering.back`](/packs/rostering/tools/#back)
- [`x.rostering.offer`](/packs/rostering/tools/#offer)

Source: [packs/rostering/blocks/rostering-my-availability](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-my-availability).
