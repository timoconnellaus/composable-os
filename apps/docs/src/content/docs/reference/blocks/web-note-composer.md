---
title: "web-note-composer"
description: "The note composer (stage 56 step 2), for the web: a staff screen writes a note about a Person (and, beside them, a class, a session, a job): it picks a kind, fills the kind's template (or writes the note, for a kind with none) and picks who reads it from the levels the host lists for that kind."
editUrl: false
---

The note composer (stage 56 step 2), for the web: a staff screen writes a note about a Person (and, beside them, a class, a session, a job): it picks a kind, fills the kind's template (or writes the note, for a kind with none) and picks who reads it from the levels the host lists for that kind. Bookings' class list (stage 56 step 4) opens it with the Session note kind. Everything it offers is the host's (note.kinds.list), and the host checks the note again in full when it is written (activity.log): a level below the kind's lowest, a required section left empty, a note kept tighter than staff about anything but one Person are refused there, and the refusal is shown here. What a person writes stays in this block's memory until that one call.

<img class="cos-screen" src="/screens/web-note-composer.png" alt="web-note-composer, drawn with dummy data" width="640" height="745" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-note-composer` |
| Files | `note-composer.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-label](/reference/blocks/ui-label/), [ui-utils](/reference/blocks/ui-utils/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`note.kinds.list`](/reference/operations/note/#notekindslist)
- [`activity.log`](/reference/operations/activity/#activitylog)

Source: [blocks/web-note-composer](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-note-composer).
