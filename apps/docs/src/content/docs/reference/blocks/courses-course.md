---
title: "courses-course"
description: "A course's page on a studio's site (stage 42): its description, trailer and outline with lesson titles and minutes, the free previews, and either \"buy\" or \"open\"."
editUrl: false
---

A course's page on a studio's site (stage 42): its description, trailer and outline with lesson titles and minutes, the free previews, and either "buy" or "open". Whether the visitor holds the course, and its price, are the host's (`useCourse`); buying is the host's order and the provider's page (`useBuy`); a trailer plays with a token the host signs (`usePlayback`).

|  |  |
| --- | --- |
| Skin | web |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-course` |
| Files | `course-page.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | `@composable-os/client`, `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.courses.course`](/packs/courses/tools/#course)
- [`x.courses.buy`](/packs/courses/tools/#buy)
- [`order.checkout`](/reference/operations/order/#ordercheckout)
- [`media.play`](/reference/operations/media/#mediaplay)

Source: [packs/courses/blocks/courses-course](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-course).
