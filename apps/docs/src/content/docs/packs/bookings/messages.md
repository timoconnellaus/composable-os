---
title: "Bookings: messages"
sidebar:
  label: "Messages"
  order: 5
editUrl: false
---

Routine mail is email about this pack's records that the host sends without a person's approval; an admin can turn each kind off.

## Routine message kinds

| Kind | Label | About | When and to whom | Values it fills |
| --- | --- | --- | --- | --- |
| `confirmation` | Booking confirmations | `booking` | When a booking becomes booked: made by the member, a parent or staff, a drop-in paid for, moved in from the waiting list, or moved by staff to another class. To the member and their parents or guardians, with an add-to-calendar file. | `class`, `when`, `room`, `link`, `oldClass`, `oldWhen` |
| `waitingList` | Waiting list news | `booking` | When a place came free but the first person waiting could not be moved in (nothing they hold could pay for it), and when a place is given back after the waiting list has stopped. To each person waiting and their parents or guardians. | `class`, `when`, `room`, `link`, `why` |
| `change` | Class changes | `booking` | When staff change a scheduled class's time, day, end or room (a coach swap sends nothing). To everyone booked or waiting and their parents or guardians, with an updated add-to-calendar file for those booked. | `class`, `when`, `room`, `link`, `before`, `ends`, `stays`, `moved`, `notMoved`, `endChanged`, `roomChanged`, `keep` |
| `cancellation` | Class cancellations | `booking` | When the gym cancels a class (staff, a closure, or a series ended). To everyone whose booking it cancelled and their parents or guardians: the reason, that nothing was used or that a paid drop-in's money goes back once approved, with a file that takes it off their calendar. | `class`, `when`, `room`, `link`, `reason`, `money` |
| `reminder` | Class reminders | `booking` | Before each scheduled class (3 hours by default: the class type's reminder, else the organisation's). To everyone booked and their parents or guardians, and a visitor who paid for a place staff have not yet confirmed. | `class`, `when`, `room`, `link` |
| `dropIn` | Drop-in payments and refunds | `order` | When a visitor pays for a class that staff still have to confirm, and when a paid drop-in's refund has been made. About the order: to the address that paid it, never anyone else. | `what`, `link` |

## Journey signals

| Signal | Label | Object | State |
| --- | --- | --- | --- |
| `booked` | Class booked | `booking` |   |
| `attended` | Class attended | `booking` |   |
