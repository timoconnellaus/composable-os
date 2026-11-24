---
title: "Bookings: screens"
sidebar:
  label: "Screens"
  order: 4
editUrl: false
---

Screens a shipped pack declares are built into the admin and shown to whoever could call every tool in `opens`. Blocks are the pack's screens for client apps, copied with `cos add`.

## Staff screens

| Screen | Label | Block | Navigation | Opens | On a record |
| --- | --- | --- | --- | --- | --- |
| `desk` | Front desk | [bookings-desk](/reference/blocks/bookings-desk/) (`FrontDesk`) | Bookings, 10 | [findPeople](/packs/bookings/tools/#findpeople), [bookFor](/packs/bookings/tools/#bookfor) |   |
| `classList` | Class list | [bookings-class-list](/reference/blocks/bookings-class-list/) (`TodayClassList`) | Bookings, 20 | [roster](/packs/bookings/tools/#roster), [markAttended](/packs/bookings/tools/#markattended) | `bookings.class` |

## Blocks

| Block | Skin | What it shows |
| --- | --- | --- |
| [bookings-class-list](/reference/blocks/bookings-class-list/) | web | A class's list, for its coach (stage 31a step 7): who is booked, ticked, not come and waiting, and a button to tick each name. |
| [bookings-desk](/reference/blocks/bookings-desk/) | web | The front desk, for staff (stage 31a): one day's classes, and booking someone into one, a member on file or a walk-in. |
| [bookings-drop-in](/reference/blocks/bookings-drop-in/) | web | Paying for one class on a gym's site (stage 31a step 8, a drop-in): the week's classes for a visitor, each with "Pay for this class". |
| [bookings-native-class-list](/reference/blocks/bookings-native-class-list/) | native | The coach's class list in the gym's app (stage 31a step 9, decision 10): today's classes, and for the one picked, who is booked, ticked, not come and waiting, with a button to tick each name, untick it, or mark them as not come. |
| [bookings-native-timetable](/reference/blocks/bookings-native-timetable/) | native | The timetable in the gym's app (stage 31a, decision 9): book and cancel with the membership or pass a member already holds. |
| [bookings-timetable](/reference/blocks/bookings-timetable/) | web | The timetable for a gym's site (stage 31a): the week's classes, and for a signed-in member a Book or Cancel button on each. |
