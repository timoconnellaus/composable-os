---
title: "bookings-native-timetable"
description: "The timetable in the gym's app (stage 31a, decision 9): book and cancel with the membership or pass a member already holds."
editUrl: false
---

The timetable in the gym's app (stage 31a, decision 9): book and cancel with the membership or pass a member already holds. Nothing is bought here: a member with nothing to spend is told so by the host, and buys on the website. Whether booking is open, the places left and whether a cancel is in time are the host's answers, shown as they come. A parent the gym linked to a child picks who they are booking for (ADR 0540); the child's own membership or pass pays. What must be agreed to first (stage 44) is the host's answer too: when "Book" is refused with it, the documents are shown in the class's place (the native-agree block's step), agreed to one by one, and "Book" is tried again.

<img class="cos-screen cos-screen-native" src="/screens/bookings-native-timetable.png" alt="bookings-native-timetable, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [bookings](/packs/bookings/screens/) |
| Add it | `cos add bookings-native-timetable` |
| Files | `timetable-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/), [native-agree](/reference/blocks/native-agree/) |
| Packages | `@composable-os/client`, `@composable-os/pack-bookings` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.bookings.timetable`](/packs/bookings/tools/#timetable)
- [`x.bookings.mine`](/packs/bookings/tools/#mine)
- [`me.family`](/reference/operations/me/#mefamily)
- [`x.bookings.book`](/packs/bookings/tools/#book)
- [`x.bookings.cancel`](/packs/bookings/tools/#cancel)
- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)

Source: [packs/bookings/blocks/bookings-native-timetable](https://github.com/timoconnellaus/composable-os/tree/main/packs/bookings/blocks/bookings-native-timetable).
