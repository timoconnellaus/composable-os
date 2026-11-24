---
title: "programs-session"
description: "One session to do (stage 41): its plan with every target, last time's numbers at each exercise, a row per set to log what was done and how hard it felt, a rest timer after each set, and marking the session done."
editUrl: false
---

One session to do (stage 41): its plan with every target, last time's numbers at each exercise, a row per set to log what was done and how hard it felt, a rest timer after each set, and marking the session done. For a member (their own, or a class's: they choose the level they take) and for a coach logging for a client (`personId`). Built on the web base layer. It holds no rules: the targets, the last numbers and whose session it is come from the host (`useSession`); a set is logged by the host, which takes its target from the plan and refuses a session the caller may not log on; effort's bounds are the host's too.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [programs](/packs/programs/screens/) |
| Add it | `cos add programs-session` |
| Files | `session-view.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/), [ui-input](/reference/blocks/ui-input/) |
| Packages | `@composable-os/pack-programs` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.programs.sessionGet`](/packs/programs/tools/#sessionget)
- [`x.programs.logAdd`](/packs/programs/tools/#logadd)
- [`x.programs.logUpdate`](/packs/programs/tools/#logupdate)
- [`x.programs.sessionComplete`](/packs/programs/tools/#sessioncomplete)

Source: [packs/programs/blocks/programs-session](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-session).
