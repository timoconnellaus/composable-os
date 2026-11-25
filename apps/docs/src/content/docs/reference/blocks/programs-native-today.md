---
title: "programs-native-today"
description: "A member's day, for the mobile app (stage 41): their own sessions on a date; pressing one opens it (the app's navigation, `onOpen`)."
editUrl: false
---

A member's day, for the mobile app (stage 41): their own sessions on a date; pressing one opens it (the app's navigation, `onOpen`). Which sessions are theirs is the host's (`useToday`). Sets logged in a session and not saved yet (no connection in the gym) are said here too, and sent again when the app comes back or goes to the background (`useUnsavedSets`).

<img class="cos-screen cos-screen-native" src="/screens/programs-native-today.png" alt="programs-native-today, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [programs](/packs/programs/screens/) |
| Add it | `cos add programs-native-today` |
| Files | `today-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-programs` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.programs.today`](/packs/programs/tools/#today)

Source: [packs/programs/blocks/programs-native-today](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-native-today).
