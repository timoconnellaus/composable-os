---
title: "bookings-native-class-list"
description: "The coach's class list in the gym's app (stage 31a step 9, decision 10): today's classes, and for the one picked, who is booked, ticked, not come and waiting, with a button to tick each name, untick it, or mark them as not come."
editUrl: false
---

The coach's class list in the gym's app (stage 31a step 9, decision 10): today's classes, and for the one picked, who is booked, ticked, not come and waiting, with a button to tick each name, untick it, or mark them as not come. For a staff account holding the Bookings coach role (its role client, never the staff client): the role reaches today's classes only, and no money, no other people, no booking or cancelling. When the list opens, whether a name can be marked and who marked it first when two coaches tick at once are the host's answers, shown as they come. Nothing here shows what anyone paid with.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [bookings](/packs/bookings/screens/) |
| Add it | `cos add bookings-native-class-list` |
| Files | `class-list-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-bookings` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.bookings.day`](/packs/bookings/tools/#day)
- [`x.bookings.roster`](/packs/bookings/tools/#roster)
- [`x.bookings.markAttended`](/packs/bookings/tools/#markattended)
- [`x.bookings.undoAttended`](/packs/bookings/tools/#undoattended)
- [`x.bookings.markNoShow`](/packs/bookings/tools/#marknoshow)

Source: [packs/bookings/blocks/bookings-native-class-list](https://github.com/timoconnellaus/composable-os/tree/main/packs/bookings/blocks/bookings-native-class-list).
