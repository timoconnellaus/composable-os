---
title: "programs-class-today"
description: "A class type's session for a day (stage 41): its plan with every level, for a member to choose the level they take and log their numbers, or for a coach running the class."
editUrl: false
---

A class type's session for a day (stage 41): its plan with every level, for a member to choose the level they take and log their numbers, or for a coach running the class. Built on the web base layer and the session block. Which sessions a class has, and what a member reads of them (the coach's notes left out), are the host's (`useClassToday`).

|  |  |
| --- | --- |
| Skin | web |
| Pack | [programs](/packs/programs/screens/) |
| Add it | `cos add programs-class-today` |
| Files | `class-today.tsx`, `LICENSE` |
| Depends on | [programs-session](/reference/blocks/programs-session/), [ui-input](/reference/blocks/ui-input/) |
| Packages | `@composable-os/pack-programs` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.programs.classToday`](/packs/programs/tools/#classtoday)
- [`my.list`](/reference/operations/my/#mylist)
- [`record.list`](/reference/operations/record/#recordlist)

Source: [packs/programs/blocks/programs-class-today](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-class-today).
