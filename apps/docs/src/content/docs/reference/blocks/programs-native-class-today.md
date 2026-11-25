---
title: "programs-native-class-today"
description: "A class type's sessions for a day, for the mobile app (stage 41): pick the class, open its session to choose the level taken and log (`onOpen`, the app's navigation, to the session screen)."
editUrl: false
---

A class type's sessions for a day, for the mobile app (stage 41): pick the class, open its session to choose the level taken and log (`onOpen`, the app's navigation, to the session screen). Which sessions a class has, and what a member reads of them, are the host's.

<img class="cos-screen cos-screen-native" src="/screens/programs-native-class-today.png" alt="programs-native-class-today, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [programs](/packs/programs/screens/) |
| Add it | `cos add programs-native-class-today` |
| Files | `class-today-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-programs` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.programs.classToday`](/packs/programs/tools/#classtoday)
- [`my.list`](/reference/operations/my/#mylist)
- [`record.list`](/reference/operations/record/#recordlist)

Source: [packs/programs/blocks/programs-native-class-today](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-native-class-today).
