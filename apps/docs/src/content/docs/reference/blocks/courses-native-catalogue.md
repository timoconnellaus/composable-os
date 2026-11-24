---
title: "courses-native-catalogue"
description: "The course catalogue in the studio's app (stage 42)."
editUrl: false
---

The course catalogue in the studio's app (stage 42). Buying is on the web only (the owner's decision): this screen shows no price and no buy button, and the block lint holds it to that (`noPurchase` in block.json). What is published is the host's (`useCatalogue`).

|  |  |
| --- | --- |
| Skin | native |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-native-catalogue` |
| Files | `catalogue-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.courses.catalogue`](/packs/courses/tools/#catalogue)

Source: [packs/courses/blocks/courses-native-catalogue](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-native-catalogue).
