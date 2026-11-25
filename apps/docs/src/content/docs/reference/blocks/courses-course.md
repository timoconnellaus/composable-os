---
title: "courses-course"
description: "A course's page on a studio's site (stage 42): its description, trailer and outline with lesson titles and minutes, the free previews, and either \"buy\" or \"open\"."
editUrl: false
---

A course's page on a studio's site (stage 42): its description, trailer and outline with lesson titles and minutes, the free previews, and either "buy" or "open". Whether the visitor holds the course, and its price, are the host's (`useCourse`); buying is the host's order and the provider's page (`useBuy`); a trailer plays with a token the host signs (`usePlayback`). What must be agreed to first (stage 44: the course's terms) is the host's answer too: when "Buy" is refused with it, the documents are shown inline (the web-agree block's step) and "Buy" is tried again (issue #292). A visitor's agreements travel in the buying call, held in memory until then; a member's are recorded as they agree. A minor is told a parent or guardian buys it.

<img class="cos-screen" src="/screens/courses-course.png" alt="courses-course, drawn with dummy data" width="800" height="714" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-course` |
| Files | `course-page.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/), [web-agree](/reference/blocks/web-agree/) |
| Packages | `@composable-os/client`, `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.courses.course`](/packs/courses/tools/#course)
- [`x.courses.buy`](/packs/courses/tools/#buy)
- [`order.checkout`](/reference/operations/order/#ordercheckout)
- [`media.play`](/reference/operations/media/#mediaplay)
- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)
- [`agreement.guestVersions`](/reference/operations/agreement/#agreementguestversions)

Source: [packs/courses/blocks/courses-course](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-course).
