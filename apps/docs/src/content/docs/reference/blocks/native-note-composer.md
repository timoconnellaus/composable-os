---
title: "native-note-composer"
description: "The note composer (stage 56 step 2), for the staff app: a coach writes a note about a Person (and, beside them, the class it was in): picks a kind, fills the kind's template (or writes the note, for a kind with none) and picks who reads it from the levels the host lists for that kind."
editUrl: false
---

The note composer (stage 56 step 2), for the staff app: a coach writes a note about a Person (and, beside them, the class it was in): picks a kind, fills the kind's template (or writes the note, for a kind with none) and picks who reads it from the levels the host lists for that kind. The coach's class list (stage 56 step 4) opens it with the Session note kind. Everything it offers is the host's (note.kinds.list), and the host checks the note again in full when it is written (activity.log); its refusal is shown here. What a person writes stays in this screen's memory until that one call. Writing a note needs signal: nothing is queued.

<img class="cos-screen cos-screen-native" src="/screens/native-note-composer.png" alt="native-note-composer, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-note-composer` |
| Files | `note-composer-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`note.kinds.list`](/reference/operations/note/#notekindslist)
- [`activity.log`](/reference/operations/activity/#activitylog)

Source: [blocks/native-note-composer](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-note-composer).
