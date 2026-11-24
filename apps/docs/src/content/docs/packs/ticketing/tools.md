---
title: "Ticketing: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.ticketing.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### eventsOnSale

The events on sale now, soonest first, each with its ticket types (name, price and its currency, sale window, most per order, deposit) and whether places are left. Prices and deposits are in the major unit of `currency` (45.5 is 45.50). For an event page or a list of events. Only what the public may read: an event that is not on sale is not here. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer`, `public` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `event` | string |   | min length 1, max length 64 | Only this event |
| `limit` | integer |   | ≥ 1, ≤ 50, default `20` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `events` | array of object | yes |   |   |
| `events[].id` | string | yes |   |   |
| `events[].name` | string or null | yes |   |   |
| `events[].startsAt` | string or null | yes |   | When it starts (ISO 8601, UTC) |
| `events[].endsAt` | string or null | yes |   |   |
| `events[].timeZone` | string or null | yes |   | The event's IANA time zone, e.g. Asia/Bangkok: show its start and end, and count its days, in this zone. Null only for an event made before events had one. |
| `events[].venue` | string or null | yes |   |   |
| `events[].description` | string or null | yes |   |   |
| `events[].image` | string or null | yes |   |   |
| `events[].availability` | object | yes |   |   |
| `events[].availability.status` | `"available"`, `"low"`, `"sold_out"` | yes |   |   |
| `events[].availability.available` | number or null |   |   | Places left, when the type says so |
| `events[].ticketTypes` | array of object | yes |   |   |
| `events[].ticketTypes[].id` | string | yes |   |   |
| `events[].ticketTypes[].name` | string or null | yes |   |   |
| `events[].ticketTypes[].description` | string or null | yes |   |   |
| `events[].ticketTypes[].price` | number or null | yes |   |   |
| `events[].ticketTypes[].currency` | string or null | yes |   | The currency the prices are in (ISO 4217): the deployment's one currency, from the host. Null until an admin sets it, and until then nothing can be bought. |
| `events[].ticketTypes[].onSaleFrom` | string or null | yes |   |   |
| `events[].ticketTypes[].onSaleUntil` | string or null | yes |   |   |
| `events[].ticketTypes[].maxPerOrder` | number or null | yes |   |   |
| `events[].ticketTypes[].deposit` | number or null | yes |   |   |
| `events[].ticketTypes[].balanceDue` | string or null | yes |   |   |
| `events[].ticketTypes[].availability` | object | yes |   |   |
| `events[].ticketTypes[].availability.status` | `"available"`, `"low"`, `"sold_out"` | yes |   |   |
| `events[].ticketTypes[].availability.available` | number or null |   |   | Places left, when the type says so |

### orderStart

Start an order for tickets: one or more ticket types and how many of each, paid in full or by deposit when every ticket type offers one. A signed-in customer buys as themselves; a guest gives their email address. The host prices the order from the ticket types, refuses a ticket type outside its sale window, over its most per order or without enough places left (with details naming the rule), and holds the places while the order is unpaid. Nothing is paid here: the buyer then calls order.checkout with the order's id (and a guest's token) to pay on the provider's page. Amounts are in the minor unit.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `customer`, `public` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lines` | array of object | yes | at least 1, at most 20 |   |
| `lines[].ticketTypeId` | string | yes | min length 1, max length 64 | The ticket type (its record id) |
| `lines[].quantity` | integer |   | ≥ 1, ≤ 100, default `1` |   |
| `pay` | `"full"`, `"deposit"` |   | default `"full"` |   |
| `email` | string |   | max length 320 | A guest's email address. A signed-in customer passes none. |
| `agreements` | array of map of any |   | at most 20 | A guest only: their acceptances of what is due, passed on to the host as they are (each { versionId, typedName, signature?, answers? }); the host checks and records them. A signed-in member agrees first. |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | string | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   | In the currency's minor unit (cents) |
| `paid` | number | yes |   |   |
| `balance` | number | yes |   |   |
| `pay` | string | yes |   |   |
| `deposit` | number or null | yes |   |   |
| `balanceDueAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].ticketTypeId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `token` | string or null | yes |   | A guest's key to this order, shown once (order.checkout and order.view take it) |

### myTickets

The signed-in customer's own tickets: each with its event (id, name, start, end, venue and state, as they are now, whether or not the event is still on sale), its ticket type (id and name), its code and its state (valid, used or void). Only the caller's tickets exist here; a code that is not theirs finds nothing. Filter by event or by code. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `event` | string |   | min length 1, max length 64 | Only tickets for this event |
| `code` | string |   | min length 1, max length 64 | Only the ticket with this code |
| `state` | `"valid"`, `"used"`, `"void"` |   |   |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 100, default `50` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].event` | string or null | yes |   |   |
| `items[].ticketType` | string or null | yes |   |   |
| `items[].code` | string or null | yes |   |   |
| `items[].state` | string or null | yes |   |   |
| `items[].eventName` | string or null | yes |   |   |
| `items[].startsAt` | string or null | yes |   | When the event starts (ISO 8601, UTC) |
| `items[].endsAt` | string or null | yes |   |   |
| `items[].timeZone` | string or null | yes |   | The event's IANA time zone, e.g. Asia/Bangkok: show its start and end, and count its days, in this zone. Null only for an event made before events had one. |
| `items[].venue` | string or null | yes |   |   |
| `items[].eventStatus` | string or null | yes |   | The event's state now: draft, on_sale, ended or cancelled |
| `items[].ticketTypeName` | string or null | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

### salesSummary

How one event is selling, per ticket type: places sold (taken), held by orders being paid, remaining (null when unlimited), and revenue (the line totals of orders paid in full or by deposit, in the currency's minor unit), with the event's totals and the currency. Prices are in the major unit. For the dashboard and for questions such as 'how are sales going'. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `eventId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `event` | object | yes |   |   |
| `event.id` | string | yes |   |   |
| `event.name` | string or null | yes |   |   |
| `event.status` | string or null | yes |   |   |
| `currency` | string or null | yes |   | The currency the prices are in (ISO 4217): the deployment's one currency, from the host. Null until an admin sets it, and until then nothing can be bought. |
| `ticketTypes` | array of object | yes |   |   |
| `ticketTypes[].id` | string | yes |   |   |
| `ticketTypes[].name` | string or null | yes |   |   |
| `ticketTypes[].price` | number or null | yes |   |   |
| `ticketTypes[].sold` | number | yes |   |   |
| `ticketTypes[].held` | number | yes |   |   |
| `ticketTypes[].remaining` | number or null | yes |   |   |
| `ticketTypes[].revenue` | number | yes |   |   |
| `totals` | object | yes |   |   |
| `totals.sold` | number | yes |   |   |
| `totals.held` | number | yes |   |   |
| `totals.remaining` | number or null | yes |   |   |
| `totals.revenue` | number | yes |   |   |

### checkIn

Check a ticket in at the door by its code. A valid ticket is marked used and accepted; a used one is refused with who checked it in and when; a void (cancelled or refunded) one and an unknown code are refused with their own reasons. A ticket whose order still has a balance owing is accepted, and the result says how much. Safe to call twice: the second scan reports the first. Two scanners at once: one is accepted, the other told.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `ticketing:checkin` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `code` | string | yes | min length 1, max length 64 | The code on the ticket, as scanned |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `result` | `"accepted"`, `"already_used"`, `"void"`, `"unknown"` | yes |   | accepted: let them in. already_used: this code was checked in before (see usedAt and usedBy). void: the ticket was cancelled or refunded. unknown: no ticket has this code. |
| `accepted` | boolean | yes |   |   |
| `message` | string | yes |   |   |
| `ticket` | object or null | yes |   |   |
| `ticket.id` | string | yes |   |   |
| `ticket.name` | string or null | yes |   |   |
| `ticket.event` | string or null | yes |   |   |
| `ticket.ticketType` | string or null | yes |   |   |
| `ticket.holder` | object or null | yes |   |   |
| `ticket.holder.id` | string | yes |   |   |
| `ticket.holder.name` | string or null | yes |   |   |
| `ticket.state` | string or null | yes |   |   |
| `ticket.usedAt` | string or null | yes |   |   |
| `ticket.usedBy` | object or null | yes |   |   |
| `ticket.usedBy.id` | string | yes |   |   |
| `ticket.usedBy.name` | string or null | yes |   |   |
| `balanceOwing` | object or null | yes |   | Set when the ticket's order still has a balance to pay. It does not refuse entry. |
| `balanceOwing.amount` | number | yes |   | In the currency's minor unit |
| `balanceOwing.currency` | string | yes |   |   |
| `balanceOwing.dueAt` | string or null | yes |   |   |

### undoCheckIn

Undo a check-in made by mistake: a used ticket becomes valid again and its check-in time and person are cleared. A ticket that is not used is left as it is and the result says why.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `ticketing:checkin` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ticketId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `undone` | boolean | yes |   |   |
| `message` | string | yes |   |   |
| `ticket` | object | yes |   |   |
| `ticket.id` | string | yes |   |   |
| `ticket.name` | string or null | yes |   |   |
| `ticket.event` | string or null | yes |   |   |
| `ticket.ticketType` | string or null | yes |   |   |
| `ticket.holder` | object or null | yes |   |   |
| `ticket.holder.id` | string | yes |   |   |
| `ticket.holder.name` | string or null | yes |   |   |
| `ticket.state` | string or null | yes |   |   |
| `ticket.usedAt` | string or null | yes |   |   |
| `ticket.usedBy` | object or null | yes |   |   |
| `ticket.usedBy.id` | string | yes |   |   |
| `ticket.usedBy.name` | string or null | yes |   |   |

## Automations

### ticketsByEmail

**Tickets by email.** When an order is first paid (in full, or its deposit), emails the buyer their tickets: one line per ticket with its code, and the page where they can show them. Routine email: Tickets by email.

|  |  |
| --- | --- |
| Trigger | fieldChanged on order, field state |
| Steps | `findTickets` Find the order's tickets; `sendTickets` Email the buyer their tickets |
| Gatekeepers | `email-send` |

### eventReminder

**Event reminder.** The day before an event on sale starts, counted in the event's own time zone, emails each holder of a valid ticket a reminder with the time (in that zone) and the venue. Routine email: Event reminders.

|  |  |
| --- | --- |
| Trigger | dateRelative on ticketing.event, field startsAt |
| Steps | `findHolders` Find the holders of valid tickets; `sendReminders` Email each holder |
| Gatekeepers | `email-send` |

### eventEnded

**Event ended.** The day after an event on sale ends, counted in the event's own time zone, moves it to ended.

|  |  |
| --- | --- |
| Trigger | dateRelative on ticketing.event, field endsAt |
| Steps | `markEnded` Move the event to ended |

### balanceReminders

**Balance reminders.** Every morning, emails the buyer of a part-paid ticket order whose balance is due in a week or tomorrow: how much is owed, when, and the link to pay. Routine email: Balance reminders.

|  |  |
| --- | --- |
| Trigger | schedule, 0 9 * * * |
| Steps | `findDue` Find part-paid orders due in a week or tomorrow; `sendReminders` Email each buyer the balance and the link to pay |
| Gatekeepers | `email-send` |

## Dashboards

| Dashboard | Label | Widgets |
| --- | --- | --- |
| `ticketSales` |   | 6 |

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`order.start`](/reference/operations/order/#orderstart)
- [`order.get`](/reference/operations/order/#orderget)
- [`query.sql`](/reference/operations/query/#querysql)
- [`public.list`](/reference/operations/public/#publiclist)
- [`capacity.get`](/reference/operations/capacity/#capacityget)
- [`extensionSettings.list`](/reference/operations/extensionsettings/#extensionsettingslist)
- [`order.settings.get`](/reference/operations/order/#ordersettingsget)

Host modules it asks for: `ops`, `routine-mail`, `email-send`.
