---
title: "rostering-native-roster"
description: "The roster in the app (stage 45 step 7), for every rostered person: the week as a day-by-day list on a phone, each day's shifts in order of start with the kind of work, the place and who is on it, shifts with nobody on them marked and my own marked as mine."
editUrl: false
---

The roster in the app (stage 45 step 7), for every rostered person: the week as a day-by-day list on a phone, each day's shifts in order of start with the kind of work, the place and who is on it, shifts with nobody on them marked and my own marked as mine. Read only; a rosterer rosters on the web. Each shift's time is shown in the business's zone, and each day's length is the host's (a clock-change day says so), never worked out from the phone's own zone.

<img class="cos-screen cos-screen-native" src="/screens/rostering-native-roster.png" alt="rostering-native-roster, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-native-roster` |
| Files | `roster-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.week`](/packs/rostering/tools/#week)

Source: [packs/rostering/blocks/rostering-native-roster](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-native-roster).
