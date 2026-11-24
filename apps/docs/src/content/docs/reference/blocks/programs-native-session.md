---
title: "programs-native-session"
description: "One session to do, for the mobile app (stage 41): the workout logger."
editUrl: false
---

One session to do, for the mobile app (stage 41): the workout logger. Each set is a row with its numbers and a tick; one tap logs it with the numbers shown (a suggestion, greyed, until the person types), even with the keyboard open and a number half typed. A tick of a done set takes it back; typing over a done set's numbers changes it. Effort (RPE) is an optional tap. Ticking a set starts the rest timer (the set's rest time, else `defaultRest`); a timed set has a start/stop timer that fills its seconds and ticks it; an exercise folds away when its last set is ticked; the sets done show at the top; finishing says what was not ticked. A member's own session, a class's (choose the level you take), or a coach logging for a client (`personId`). Every change shows at once and goes to the host through the pack's one queue (`useSessionLog`): in order, retried when it fails, flushed when the app goes to the background and when the screen is left, and it says when something could not be saved. The app gives the buzz at the end of a rest (`onRestDone`, for example `expo-haptics`), so this block needs no device package. It holds no rules: targets, whose session it is and what may be logged are the host's, and a set it refuses is shown with its reason.

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
- [`x.programs.logRemove`](/packs/programs/tools/#logremove)
- [`x.programs.sessionComplete`](/packs/programs/tools/#sessioncomplete)

Source: [packs/programs/blocks/programs-native-session](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-native-session).
