---
title: "courses-native-my-courses"
description: "The courses a signed-in student holds, in the studio's app (stage 42), with how far they are."
editUrl: false
---

The courses a signed-in student holds, in the studio's app (stage 42), with how far they are. Which they hold is the host's (`useMyCourses`); nothing here is for sale (`noPurchase`). As the Courses section of the app's My account (stage 48), their course subscription's state follows.

<img class="cos-screen cos-screen-native" src="/screens/courses-native-my-courses.png" alt="courses-native-my-courses, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-native-my-courses` |
| Files | `my-courses-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/), [native-account-subscriptions](/reference/blocks/native-account-subscriptions/) |
| Packages | `@composable-os/client`, `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.courses.myCourses`](/packs/courses/tools/#mycourses)
- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)

Source: [packs/courses/blocks/courses-native-my-courses](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-native-my-courses).
