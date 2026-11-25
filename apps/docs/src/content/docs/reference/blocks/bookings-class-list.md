---
title: "bookings-class-list"
description: "A class's list, for its coach (stage 31a step 7): who is booked, ticked, not come and waiting, and a button to tick each name."
editUrl: false
---

A class's list, for its coach (stage 31a step 7): who is booked, ticked, not come and waiting, and a button to tick each name. When the list opens, whether a name can be ticked, and who ticked it first when two coaches tick at once are the host's; this shows its answers. Nothing here shows what anyone paid with. "Health note" marks a yes on someone's current health form (stage 44, decision 18): the host gives the mark only, never the form, and only to a person.

<img class="cos-screen" src="/screens/bookings-class-list.png" alt="bookings-class-list, drawn with dummy data" width="720" height="476" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [bookings](/packs/bookings/screens/) |
| Add it | `cos add bookings-class-list` |
| Files | `class-list.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-bookings` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.bookings.day`](/packs/bookings/tools/#day)
- [`x.bookings.roster`](/packs/bookings/tools/#roster)
- [`x.bookings.markAttended`](/packs/bookings/tools/#markattended)
- [`x.bookings.undoAttended`](/packs/bookings/tools/#undoattended)

Source: [packs/bookings/blocks/bookings-class-list](https://github.com/timoconnellaus/composable-os/tree/main/packs/bookings/blocks/bookings-class-list).
