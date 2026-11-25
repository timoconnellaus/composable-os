---
title: "courses-builder"
description: "The course builder (stage 42), a staff block in the company's web app: sections and lessons in order (moved by buttons, so by keyboard too), each lesson's kind, video from the media library, session from a published Programs program, text, preview flag and minutes; save, then publish."
editUrl: false
---

The course builder (stage 42), a staff block in the company's web app: sections and lessons in order (moved by buttons, so by keyboard too), each lesson's kind, video from the media library, session from a published Programs program, text, preview flag and minutes; save, then publish. The edits are the pack's pure `outlineEdits`, which never change a lesson's key; the host checks the outline on save (its schema, a video that is ready, a program that exists) and a person publishes (an assistant's request to publish waits for one, ADR 0480).

<img class="cos-screen" src="/screens/courses-builder.png" alt="courses-builder, drawn with dummy data" width="880" height="1495" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-builder` |
| Files | `course-builder.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`record.get`](/reference/operations/record/#recordget)
- [`record.update`](/reference/operations/record/#recordupdate)
- [`record.publish`](/reference/operations/record/#recordpublish)
- [`media.list`](/reference/operations/media/#medialist)
- [`record.list`](/reference/operations/record/#recordlist)

Source: [packs/courses/blocks/courses-builder](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-builder).
