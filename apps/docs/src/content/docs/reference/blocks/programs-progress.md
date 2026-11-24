---
title: "programs-progress"
description: "History and progress (stage 41): per exercise, a person's sets over time and their bests; per program, sessions done against planned."
editUrl: false
---

History and progress (stage 41): per exercise, a person's sets over time and their bests; per program, sessions done against planned. For a member (themselves) or a coach (`personId`). Built on the web base layer. The sets and the bests are worked out by the host (`useProgress`, `useHistory`); this lays them out.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [programs](/packs/programs/screens/) |
| Add it | `cos add programs-progress` |
| Files | `progress.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/) |
| Packages | `@composable-os/pack-programs` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.programs.progress`](/packs/programs/tools/#progress)
- [`x.programs.history`](/packs/programs/tools/#history)

Source: [packs/programs/blocks/programs-progress](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-progress).
