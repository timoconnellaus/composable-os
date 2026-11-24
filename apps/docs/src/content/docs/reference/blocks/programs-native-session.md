---
title: "programs-native-session"
description: "One session to do, for the mobile app (stage 41): targets, last time's numbers, a row per set to log what was done and how hard it felt, a rest timer, and marking it done."
editUrl: false
---

One session to do, for the mobile app (stage 41): targets, last time's numbers, a row per set to log what was done and how hard it felt, a rest timer, and marking it done. A member's own session, a class's (choose the level you take), or a coach logging for a client (`personId`). The app gives the buzz at the end of a rest (`onRestDone`, for example `expo-haptics`), so this block needs no device package. It holds no rules: targets, whose session it is and what may be logged are the host's.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [programs](/packs/programs/screens/) |
| Add it | `cos add programs-native-session` |
| Files | `session-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-programs` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.programs.sessionGet`](/packs/programs/tools/#sessionget)
- [`x.programs.logAdd`](/packs/programs/tools/#logadd)
- [`x.programs.logUpdate`](/packs/programs/tools/#logupdate)
- [`x.programs.sessionComplete`](/packs/programs/tools/#sessioncomplete)

Source: [packs/programs/blocks/programs-native-session](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-native-session).
