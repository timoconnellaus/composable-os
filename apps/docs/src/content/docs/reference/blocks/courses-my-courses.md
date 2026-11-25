---
title: "courses-my-courses"
description: "What a signed-in student holds (stage 42), with how far they are and where to carry on."
editUrl: false
---

What a signed-in student holds (stage 42), with how far they are and where to carry on. Which courses they hold, and why, is the host's (`useMyCourses`). As the Courses section of My account (stage 48, `MyCoursesSection`), their course subscription follows, through My account's one subscriptions part; its card is My account's Payment method section.

<img class="cos-screen" src="/screens/courses-my-courses.png" alt="courses-my-courses, drawn with dummy data" width="720" height="1002" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-my-courses` |
| Files | `my-courses.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/), [courses-subscription](/reference/blocks/courses-subscription/) |
| Packages | `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.courses.myCourses`](/packs/courses/tools/#mycourses)
- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)
- [`subscription.cancel`](/reference/operations/subscription/#subscriptioncancel)
- [`subscription.resume`](/reference/operations/subscription/#subscriptionresume)

Source: [packs/courses/blocks/courses-my-courses](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-my-courses).
