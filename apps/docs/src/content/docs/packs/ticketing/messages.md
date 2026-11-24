---
title: "Ticketing: messages"
sidebar:
  label: "Messages"
  order: 5
editUrl: false
---

Routine mail is email about this pack's records that the host sends without a person's approval; an admin can turn each kind off.

## Routine message kinds

| Kind | Label | About | When and to whom | Values it fills |
| --- | --- | --- | --- | --- |
| `tickets` | Tickets by email | `order` | When an order is first paid (in full, or its deposit): the buyer's tickets, one line per ticket with its code, and the page where they can show them. To the order's own address. | `events`, `tickets`, `link` |
| `eventReminder` | Event reminders | `ticket` | The day before an event on sale starts, counted in the event's own time zone: its time and venue. To each holder of a valid ticket, once however many tickets they hold. | `event`, `when`, `venue`, `count`, `time`, `place`, `short` |
| `balance` | Balance reminders | `order` | Every morning, for a part-paid ticket order whose balance is due in a week or tomorrow: how much is owed, when, and the page to pay it. To the order's own address. | `balance`, `due`, `link` |

## Journey signals

| Signal | Label | Object | State |
| --- | --- | --- | --- |
| `ticketBought` | Ticket bought | `ticket` |   |
| `checkedIn` | Checked in at an event | `ticket` |   |
