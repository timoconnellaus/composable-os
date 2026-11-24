---
title: "courses-native-player"
description: "One lesson in the studio's app (stage 42)."
editUrl: false
---

One lesson in the studio's app (stage 42). The video player is a prop, so this block depends on no device package: the app passes its own (`expo-video`, with the signed HLS address), and an offline player can replace it later. What the lesson holds is the host's (`useLesson`), the token is the host's and is asked for again before it expires (`usePlayback`), and progress is kept by the host only while the student holds the course (`useProgress`).

|  |  |
| --- | --- |
| Skin | native |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-native-player` |
| Files | `lesson-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/), [content-native-rich-text](/reference/blocks/content-native-rich-text/) |
| Packages | `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.courses.lesson`](/packs/courses/tools/#lesson)
- [`media.play`](/reference/operations/media/#mediaplay)
- [`x.courses.progress`](/packs/courses/tools/#progress)

Source: [packs/courses/blocks/courses-native-player](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-native-player).
