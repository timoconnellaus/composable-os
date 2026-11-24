---
title: "rostering-qualifications"
description: "Qualifications (stage 45 step 7), for someone who rosters: people down, kinds of work across (each class type, each duty), a tick each."
editUrl: false
---

Qualifications (stage 45 step 7), for someone who rosters: people down, kinds of work across (each class type, each duty), a tick each. A ticked person may take an offered shift of that kind without anybody approving; putting someone unticked on one is made with a warning. Who is qualified is the host's (`qualifications`), and each tick is the host's write (`qualify`). Shown only when the host says the reader rosters (`me.rosters`). On a phone the grid scrolls sideways inside its own box; the page does not.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-qualifications` |
| Files | `qualifications.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.people`](/packs/rostering/tools/#people)
- [`x.rostering.qualifications`](/packs/rostering/tools/#qualifications)
- [`x.rostering.qualify`](/packs/rostering/tools/#qualify)

Source: [packs/rostering/blocks/rostering-qualifications](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-qualifications).
