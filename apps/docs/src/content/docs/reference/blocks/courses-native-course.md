---
title: "courses-native-course"
description: "A course in the studio's app (stage 42): its summary and outline with lesson titles and minutes; \"open\" for a holder and for a free preview."
editUrl: false
---

A course in the studio's app (stage 42): its summary and outline with lesson titles and minutes; "open" for a holder and for a free preview. No price and no buy button: buying is on the web only (`noPurchase`). Whether the student holds the course is the host's (`useCourse`).

<img class="cos-screen cos-screen-native" src="/screens/courses-native-course.png" alt="courses-native-course, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-native-course` |
| Files | `course-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.courses.course`](/packs/courses/tools/#course)

Source: [packs/courses/blocks/courses-native-course](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-native-course).
