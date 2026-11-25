---
title: "courses-player"
description: "One lesson, for a holder (stage 42): a video with its captions that resumes where it was left, a page of text, a download, or a training session from Programs; mark done; the next lesson."
editUrl: false
---

One lesson, for a holder (stage 42): a video with its captions that resumes where it was left, a page of text, a download, or a training session from Programs; mark done; the next lesson. What the lesson holds is the host's (`useLesson`, empty without access); the video plays with a token the host signs and asks for again before it expires (`usePlayback`); progress is kept by the host only while the student holds the course (`useProgress`).

<img class="cos-screen" src="/screens/courses-player.png" alt="courses-player, drawn with dummy data" width="800" height="831" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [courses](/packs/courses/screens/) |
| Add it | `cos add courses-player` |
| Files | `player.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [content-rich-text](/reference/blocks/content-rich-text/) |
| Packages | `@composable-os/pack-courses` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.courses.lesson`](/packs/courses/tools/#lesson)
- [`media.play`](/reference/operations/media/#mediaplay)
- [`x.courses.progress`](/packs/courses/tools/#progress)

Source: [packs/courses/blocks/courses-player](https://github.com/timoconnellaus/composable-os/tree/main/packs/courses/blocks/courses-player).
