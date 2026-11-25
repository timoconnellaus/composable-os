---
title: "programs-session"
description: "One session to do (stage 41): the workout logger, built on the web base layer."
editUrl: false
---

One session to do (stage 41): the workout logger, built on the web base layer. Its plan with every target and last time's numbers; a row per set with its numbers and a tick. One tap on a tick logs the set with the numbers shown (a suggestion, greyed, until the person types; a number still being typed counts); a tick of a done set takes it back, and typing over a done set's numbers changes it. Effort (RPE) is an optional tap. A tick starts the rest timer (the set's rest, else `defaultRest`); a timed set has a start/stop timer that fills its seconds and ticks it; an exercise folds away when its last set is ticked; the sets done show at the top; finishing says what was not ticked. For a member (their own, or a class's: they choose the level they take) and for a coach logging for a client (`personId`). It is the mobile session's logic (`useSessionLog`, the pack's one queue): every change shows at once and is saved in order, retried when it fails, and flushed when the page is hidden. It holds no rules: the targets, the last numbers and whose session it is come from the host; a set is logged by the host, which takes its target from the plan, refuses a session the caller may not log on and says why it refused a set; effort's bounds are the host's too.

<img class="cos-screen" src="/screens/programs-session.png" alt="programs-session, drawn with dummy data" width="820" height="1566" loading="lazy" decoding="async" />

Drawn with dummy data.

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
- [`x.programs.logRemove`](/packs/programs/tools/#logremove)
- [`x.programs.sessionComplete`](/packs/programs/tools/#sessioncomplete)

Source: [packs/programs/blocks/programs-session](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-session).
