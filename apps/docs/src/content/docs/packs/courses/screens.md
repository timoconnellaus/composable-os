---
title: "Courses: screens"
sidebar:
  label: "Screens"
  order: 4
editUrl: false
---

Screens a shipped pack declares are built into the admin and shown to whoever could call every tool in `opens`. Blocks are the pack's screens for client apps, copied with `cos add`.

## Staff screens

| Screen | Label | Block | Navigation | Opens | On a record |
| --- | --- | --- | --- | --- | --- |
| `builder` | Builder | [courses-builder](/reference/blocks/courses-builder/) (`CourseBuilder`) |   |  writes `courses.course` | `courses.course` |

## Blocks

| Block | Skin | What it shows |
| --- | --- | --- |
| [courses-builder](/reference/blocks/courses-builder/) | web | The course builder (stage 42), a staff block in the company's web app: sections and lessons in order (moved by buttons, so by keyboard too), each lesson's kind, video from the media library, session from a published Programs program, text, preview flag and minutes; save, then publish. |
| [courses-catalogue](/reference/blocks/courses-catalogue/) | web | The course catalogue for a studio's site (stage 42): courses by theme and level, and bundles, with their prices. |
| [courses-course](/reference/blocks/courses-course/) | web | A course's page on a studio's site (stage 42): its description, trailer and outline with lesson titles and minutes, the free previews, and either "buy" or "open". |
| [courses-my-courses](/reference/blocks/courses-my-courses/) | web | What a signed-in student holds (stage 42), with how far they are and where to carry on. |
| [courses-native-catalogue](/reference/blocks/courses-native-catalogue/) | native | The course catalogue in the studio's app (stage 42). |
| [courses-native-course](/reference/blocks/courses-native-course/) | native | A course in the studio's app (stage 42): its summary and outline with lesson titles and minutes; "open" for a holder and for a free preview. |
| [courses-native-my-courses](/reference/blocks/courses-native-my-courses/) | native | The courses a signed-in student holds, in the studio's app (stage 42), with how far they are. |
| [courses-native-player](/reference/blocks/courses-native-player/) | native | One lesson in the studio's app (stage 42). |
| [courses-native-subscription](/reference/blocks/courses-native-subscription/) | native | A member's course subscription in the studio's app (stage 32a), read only: its state, the next charge date or when it ends, and that it gives every course; and a continuation offer they have not taken yet (moving from another platform), in words, to take on the web. |
| [courses-player](/reference/blocks/courses-player/) | web | One lesson, for a holder (stage 42): a video with its captions that resumes where it was left, a page of text, a download, or a training session from Programs; mark done; the next lesson. |
| [courses-subscribe](/reference/blocks/courses-subscribe/) | web | Subscribing to every course on a studio's site (stage 32a): the course plans with the host's price per month and trial days, and a button that opens the payment provider's page. |
| [courses-subscription](/reference/blocks/courses-subscription/) | web | A member's own course subscription on the studio's site (stage 32a): its state in words, the next charge or when it ends, and what they can do: cancel at the period's end, keep it going, confirm a payment that waits on them, or open the payment provider's portal for their card and past invoices. |
