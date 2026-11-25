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

Each drawn with dummy data.

### bookings-class-list

Web. A class's list, for its coach (stage 31a step 7): who is booked, ticked, not come and waiting, and a button to tick each name. [The block](/reference/blocks/bookings-class-list/).

<img class="cos-screen" src="/screens/bookings-class-list.png" alt="bookings-class-list, drawn with dummy data" width="720" height="476" loading="lazy" decoding="async" />

### bookings-desk

Web. The front desk, for staff (stage 31a): one day's classes, and booking someone into one, a member on file or a walk-in. [The block](/reference/blocks/bookings-desk/).

<img class="cos-screen" src="/screens/bookings-desk.png" alt="bookings-desk, drawn with dummy data" width="720" height="728" loading="lazy" decoding="async" />

### bookings-drop-in

Web. Paying for one class on a gym's site (stage 31a step 8, a drop-in): the week's classes for a visitor, each with "Pay for this class". [The block](/reference/blocks/bookings-drop-in/).

<img class="cos-screen" src="/screens/bookings-drop-in.png" alt="bookings-drop-in, drawn with dummy data" width="720" height="700" loading="lazy" decoding="async" />

### bookings-native-class-list

Native. The coach's class list in the gym's app (stage 31a step 9, decision 10): today's classes, and for the one picked, who is booked, ticked, not come and waiting, with a button to tick each name, untick it, or mark them as not come. [The block](/reference/blocks/bookings-native-class-list/).

<img class="cos-screen cos-screen-native" src="/screens/bookings-native-class-list.png" alt="bookings-native-class-list, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### bookings-native-timetable

Native. The timetable in the gym's app (stage 31a, decision 9): book and cancel with the membership or pass a member already holds. [The block](/reference/blocks/bookings-native-timetable/).

<img class="cos-screen cos-screen-native" src="/screens/bookings-native-timetable.png" alt="bookings-native-timetable, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### bookings-timetable

Web. The timetable for a gym's site (stage 31a): the week's classes, and for a signed-in member a Book or Cancel button on each. [The block](/reference/blocks/bookings-timetable/).

<img class="cos-screen" src="/screens/bookings-timetable.png" alt="bookings-timetable, drawn with dummy data" width="720" height="777" loading="lazy" decoding="async" />
