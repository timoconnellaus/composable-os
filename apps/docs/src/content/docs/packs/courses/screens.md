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

Each drawn with dummy data.

### courses-builder

Web. The course builder (stage 42), a staff block in the company's web app: sections and lessons in order (moved by buttons, so by keyboard too), each lesson's kind, video from the media library, session from a published Programs program, text, preview flag and minutes; save, then publish. [The block](/reference/blocks/courses-builder/).

<img class="cos-screen" src="/screens/courses-builder.png" alt="courses-builder, drawn with dummy data" width="880" height="1495" loading="lazy" decoding="async" />

### courses-catalogue

Web. The course catalogue for a studio's site (stage 42): courses by theme and level, and bundles, with their prices. [The block](/reference/blocks/courses-catalogue/).

<img class="cos-screen" src="/screens/courses-catalogue.png" alt="courses-catalogue, drawn with dummy data" width="1024" height="1927" loading="lazy" decoding="async" />

### courses-course

Web. A course's page on a studio's site (stage 42): its description, trailer and outline with lesson titles and minutes, the free previews, and either "buy" or "open". [The block](/reference/blocks/courses-course/).

<img class="cos-screen" src="/screens/courses-course.png" alt="courses-course, drawn with dummy data" width="800" height="714" loading="lazy" decoding="async" />

### courses-my-courses

Web. What a signed-in student holds (stage 42), with how far they are and where to carry on. [The block](/reference/blocks/courses-my-courses/).

<img class="cos-screen" src="/screens/courses-my-courses.png" alt="courses-my-courses, drawn with dummy data" width="720" height="1002" loading="lazy" decoding="async" />

### courses-native-catalogue

Native. The course catalogue in the studio's app (stage 42). [The block](/reference/blocks/courses-native-catalogue/).

<img class="cos-screen cos-screen-native" src="/screens/courses-native-catalogue.png" alt="courses-native-catalogue, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### courses-native-course

Native. A course in the studio's app (stage 42): its summary and outline with lesson titles and minutes; "open" for a holder and for a free preview. [The block](/reference/blocks/courses-native-course/).

<img class="cos-screen cos-screen-native" src="/screens/courses-native-course.png" alt="courses-native-course, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### courses-native-my-courses

Native. The courses a signed-in student holds, in the studio's app (stage 42), with how far they are. [The block](/reference/blocks/courses-native-my-courses/).

<img class="cos-screen cos-screen-native" src="/screens/courses-native-my-courses.png" alt="courses-native-my-courses, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### courses-native-player

Native. One lesson in the studio's app (stage 42). [The block](/reference/blocks/courses-native-player/).

<img class="cos-screen cos-screen-native" src="/screens/courses-native-player.png" alt="courses-native-player, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### courses-native-subscription

Native. A member's course subscription in the studio's app (stage 32a), read only: its state, the next charge date or when it ends, and that it gives every course; and a continuation offer they have not taken yet (moving from another platform), in words, to take on the web. [The block](/reference/blocks/courses-native-subscription/).

<img class="cos-screen cos-screen-native" src="/screens/courses-native-subscription.png" alt="courses-native-subscription, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### courses-player

Web. One lesson, for a holder (stage 42): a video with its captions that resumes where it was left, a page of text, a download, or a training session from Programs; mark done; the next lesson. [The block](/reference/blocks/courses-player/).

<img class="cos-screen" src="/screens/courses-player.png" alt="courses-player, drawn with dummy data" width="800" height="831" loading="lazy" decoding="async" />

### courses-subscribe

Web. Subscribing to every course on a studio's site (stage 32a): the course plans with the host's price per month and trial days, and a button that opens the payment provider's page. [The block](/reference/blocks/courses-subscribe/).

<img class="cos-screen" src="/screens/courses-subscribe.png" alt="courses-subscribe, drawn with dummy data" width="720" height="516" loading="lazy" decoding="async" />

### courses-subscription

Web. A member's own course subscription on the studio's site (stage 32a), through My account's one subscriptions part (`web-account-subscriptions`, stage 48): its state in words, the next charge or when it ends, and what they can do: cancel at the period's end, keep it going, confirm a payment that waits on them. [The block](/reference/blocks/courses-subscription/).

<img class="cos-screen" src="/screens/courses-subscription.png" alt="courses-subscription, drawn with dummy data" width="640" height="238" loading="lazy" decoding="async" />
