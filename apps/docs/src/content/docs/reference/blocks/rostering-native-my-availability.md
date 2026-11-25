---
title: "rostering-native-my-availability"
description: "My availability in the app (stage 45 step 7): the times I said I cannot work, adding leave or another one-off time, or a regular time off (every week on chosen days), and ending one."
editUrl: false
---

My availability in the app (stage 45 step 7): the times I said I cannot work, adding leave or another one-off time, or a regular time off (every week on chosen days), and ending one. Nobody approves it; only I and whoever rosters see it. When it covers shifts I am on, they stay mine and this offers them in one step. Dates and times are typed as the host takes them (a date YYYY-MM-DD, a time HH:MM, in the business's zone): no date picker module is needed, and the host says what is wrong with what was typed. What I write about my time off is forgotten once the call is over (`forgetAfter`) and when the screen closes; my list with its notes is kept in the app's cache no longer than it is shown.

<img class="cos-screen cos-screen-native" src="/screens/rostering-native-my-availability.png" alt="rostering-native-my-availability, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-native-my-availability` |
| Files | `my-availability-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.myAway`](/packs/rostering/tools/#myaway)
- [`x.rostering.away`](/packs/rostering/tools/#away)
- [`x.rostering.back`](/packs/rostering/tools/#back)
- [`x.rostering.offer`](/packs/rostering/tools/#offer)

Source: [packs/rostering/blocks/rostering-native-my-availability](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-native-my-availability).
