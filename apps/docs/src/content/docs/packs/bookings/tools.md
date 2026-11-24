---
title: "Bookings: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.bookings.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### timetable

The gym's timetable: its scheduled classes between two times (default: the next 7 days), soonest first, each with its name, class type, start and end in its own time zone, coach, room, notes for members and how many places are left. Filter by class type or coach. Only what the public may read: never who is booked. Booking rules (when booking opens, whether the gym books it) are the host's: book answers with them. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer`, `public` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$` | From this time (ISO 8601). Default: now |
| `to` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$` | Until this time. Default: 7 days after from |
| `classType` | string |   | min length 1, max length 64 |   |
| `coach` | string |   | min length 1, max length 64 |   |
| `limit` | integer |   | ≥ 1, ≤ 100, default `50` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `classes` | array of object | yes |   |   |
| `classes[].id` | string | yes |   |   |
| `classes[].title` | string or null | yes |   | The class's name (its class type's, unless renamed) |
| `classes[].classType` | string or null | yes |   |   |
| `classes[].startsAt` | string or null | yes |   | When it starts (ISO 8601, UTC) |
| `classes[].endsAt` | string or null | yes |   |   |
| `classes[].timeZone` | string or null | yes |   | The class's IANA time zone: show its times in this zone. |
| `classes[].room` | object or null | yes |   |   |
| `classes[].room.id` | string | yes |   |   |
| `classes[].room.name` | string or null | yes |   |   |
| `classes[].coach` | object or null and object or null | yes |   |   |
| `classes[].notes` | string or null | yes |   |   |
| `classes[].places` | object | yes |   |   |
| `classes[].places.status` | `"available"`, `"low"`, `"sold_out"` | yes |   |   |
| `classes[].places.available` | number or null |   |   | Places left; null when unlimited |

### classGet

One scheduled class of the timetable: its name, class type, start and end in its own time zone, coach, room, notes for members and how many places are left. Not found once it is not scheduled. Never who is booked. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer`, `public` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `classId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `class` | object | yes |   |   |
| `class.id` | string | yes |   |   |
| `class.title` | string or null | yes |   | The class's name (its class type's, unless renamed) |
| `class.classType` | string or null | yes |   |   |
| `class.startsAt` | string or null | yes |   | When it starts (ISO 8601, UTC) |
| `class.endsAt` | string or null | yes |   |   |
| `class.timeZone` | string or null | yes |   | The class's IANA time zone: show its times in this zone. |
| `class.room` | object or null | yes |   |   |
| `class.room.id` | string | yes |   |   |
| `class.room.name` | string or null | yes |   |   |
| `class.coach` | object or null and object or null | yes |   |   |
| `class.notes` | string or null | yes |   |   |
| `class.places` | object | yes |   |   |
| `class.places.status` | `"available"`, `"low"`, `"sold_out"` | yes |   |   |
| `class.places.available` | number or null |   |   | Places left; null when unlimited |

### book

Book the signed-in member into a class with what they already hold (a membership or a pass): the host spends one use of the one whose use would lapse first, or of `holderId` when they name one. No money moves. When the class is full they join its waitlist (unless `waitlist` is false): that spends nothing, and if a place frees before the class type's cut-off the host moves the first waiter in and spends their use then. Asked again by a member already waiting, it books them if a place is free to them (never one held for the queue), else says where they stand. Answers booked, waiting (with their position), or refused with the reason the host gave: booking not open yet (with when it opens), closed, booked by the gym only, nothing to pay with, already booked or waiting, full, or too close to the start to wait. A parent books a child the gym linked to them with forPersonId (see family): the same rules, and the child's own membership or pass pays.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `customer` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `classId` | string | yes | min length 1, max length 64 |   |
| `forPersonId` | string |   | min length 1, max length 64 | A child of theirs to book for instead (a dependant the gym linked to them; see family). The child's own membership or pass pays, never the parent's. |
| `holderId` | string |   | min length 1, max length 64 | A membership or pass of theirs to spend, when they hold several |
| `waitlist` | boolean |   | default `true` | When the class is full, join its waitlist (default) rather than be refused |

#### Output

No fields.

### buy

Pay for one class (a drop-in), on the website: for a visitor, or a member with nothing to spend on it. The host makes the booking held while it is paid for (a place kept), prices it from the class's drop-in price, and starts its order; nothing is paid here. The buyer then calls order.checkout with the order's id (and a guest's token) to pay on the provider's page: the verified payment books them; an order left unpaid expires after a few minutes and the place goes back. The same rules as booking hold (when booking opens and closes, booked by the gym only, one booking per person per class); a full class is refused (only members with a membership or pass wait for a place). A signed-in member buys as themselves, or for a child the gym linked to them (forPersonId; they pay, it is the child's booking); a guest gives their email address. Cancelled in time, or by the gym, the money goes back to the card once a member of staff approves the refund; cancelled late, it is kept. Amounts in the currency's minor unit.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `customer`, `public` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `classId` | string | yes | min length 1, max length 64 |   |
| `forPersonId` | string |   | min length 1, max length 64 | A child of theirs to book for instead (a dependant the gym linked to them; see family). The child's own membership or pass pays, never the parent's. |
| `email` | string |   | max length 320 | A guest's email address |
| `agreements` | array of map of any |   | at most 20 | A guest only: their acceptances of what is due, passed on to the host as they are (each { versionId, typedName, signature?, answers? }); the host checks and records them. A signed-in member agrees first. |

#### Output

No fields.

### cancel

Cancel one of the signed-in member's bookings. First without `confirm`: the host says whether a cancel now is in time (`cancelled`, the class's use given back) or late (`late_cancelled`, the use kept), by its clock. Then with `confirm: true` and `expect` set to that answer: cancelled as said, or refused if it has become late meanwhile, so a member never loses a use they were told they would keep. After the class starts it cannot be cancelled.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `customer` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `bookingId` | string | yes | min length 1, max length 64 |   |
| `confirm` | boolean |   | default `false` |   |
| `expect` | `"cancelled"`, `"late_cancelled"` |   |   | What the preview said; with confirm, cancel only into this state |

#### Output

No fields.

### leaveWaitlist

Take the signed-in member off a class's waitlist (one of their bookings that is waiting). Nothing was spent, so nothing is given back. Refused when it is no longer waiting (they were moved in meanwhile: cancel that booking instead).

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `customer` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `bookingId` | string | yes | min length 1, max length 64 |   |

#### Output

No fields.

### mine

The signed-in member's own bookings, soonest class first: each with its state (booked, waiting, cancelled, cancelled late…), for one waiting its place on the waitlist, the membership or pass it spent from, and its class (name, start and end in its own time zone, coach, room, whether it still runs). With personId, a child's the gym linked to them instead (see family). Only their own and their children's bookings exist here. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string |   | min length 1, max length 64 | A child of theirs (see family); left out, their own |
| `state` | `"booked"`, `"pending"`, `"waiting"`, `"cancelled"`, `"late_cancelled"`, `"left"` |   |   |   |
| `upcoming` | boolean |   | default `true` | Only classes that have not started |
| `limit` | integer |   | ≥ 1, ≤ 100, default `50` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `bookings` | array of object | yes |   |   |
| `bookings[].id` | string | yes |   |   |
| `bookings[].personId` | string or null | yes |   | Whose booking it is: theirs, or their child's |
| `bookings[].state` | string or null | yes |   |   |
| `bookings[].position` | number or null | yes |   | While waiting: their place on the waitlist (1 is next); otherwise null |
| `bookings[].holderId` | string or null | yes |   |   |
| `bookings[].dropInOrderId` | string or null | yes |   | A drop-in's order (pending: pay it with order.checkout); null otherwise |
| `bookings[].classId` | string or null | yes |   |   |
| `bookings[].title` | string or null | yes |   |   |
| `bookings[].startsAt` | string or null | yes |   |   |
| `bookings[].endsAt` | string or null | yes |   |   |
| `bookings[].timeZone` | string or null | yes |   | The class's IANA time zone: show its times in this zone. |
| `bookings[].classState` | string or null | yes |   | scheduled, cancelled or done |
| `bookings[].coach` | string or null | yes |   |   |
| `bookings[].room` | string or null | yes |   |   |

### findPeople

Staff look a person up before booking them: People on file whose name or email contains the text, at most 10, with their email. Use it at the desk before adding a walk-in, so a member is booked as themselves. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `bookings:desk` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `query` | string | yes | min length 2, max length 100 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `people` | array of object | yes |   |   |
| `people[].id` | string | yes |   |   |
| `people[].name` | string or null | yes |   |   |
| `people[].email` | string or null | yes |   |   |

### bookFor

Staff book a person into a class: someone on file (`personId`; look them up with findPeople first), or a walk-in not on file yet (`newPerson`). A walk-in and their booking are made in one batch, so a refused booking leaves nobody behind; the platform's duplicate check runs first, and a match is answered (person_exists or possible_duplicates, with who) rather than made twice: book them, or pass confirmNew when you checked it is someone else. Staff are not bound by the booking windows or by 'booked by staff only'; a class that was cancelled or is over, the places, one booking per person per class and the use it spends still hold. With `paidAtDesk` it spends no use (they paid at the desk). With `waitlist`, a person on file is put on a full class's waitlist instead of being refused (it spends nothing until the host moves them in). Audited.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `bookings:desk` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `classId` | string | yes | min length 1, max length 64 |   |
| `personId` | string |   | min length 1, max length 64 |   |
| `newPerson` | object |   |   | A walk-in who is not on file yet |
| `newPerson.givenName` | string | yes | min length 1, max length 100 |   |
| `newPerson.familyName` | string |   | max length 100 |   |
| `newPerson.email` | string (email) |   | max length 320, pattern `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$` |   |
| `confirmNew` | boolean |   | default `false` | The possible duplicates were checked: this is someone new |
| `holderId` | string |   | min length 1, max length 64 |   |
| `paidAtDesk` | boolean |   | default `false` |   |
| `waitlist` | boolean |   | default `false` | A person on file, a full class: put them on its waitlist instead |
| `note` | string |   | max length 2000 |   |

#### Output

No fields.

### cancelFor

Staff cancel a booking, decided by the host's clock as a member's own cancel is: in time (`cancelled`, the use given back) until the class type's late-cancel time, late (`late_cancelled`, the use kept) after it, not at all once the class has started. With `keepUse` it is cancelled late whatever the time. To give a use back after the late point, a person uses returnUse. The place is given back either way. Only a booked booking can be cancelled; one that has moved on is reported as changed.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `bookings:desk` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `bookingId` | string | yes | min length 1, max length 64 |   |
| `keepUse` | boolean |   | default `false` |   |
| `note` | string |   | max length 2000 |   |

#### Output

No fields.

### returnUse

A person on the staff cancels a booking and gives its use back whatever the time: after the late-cancel point, or after the class (a member who was ill, a class the coach missed). A person's own act: the assistant, MCP clients, automations and other code cannot call it. The reason is kept on the booking and in the audit log. Only a booked booking.

|  |  |
| --- | --- |
| Risk | `destructive` |
| Audiences | `staff` |
| Permission | `bookings:desk` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `bookingId` | string | yes | min length 1, max length 64 |   |
| `reason` | string | yes | min length 3, max length 2000 |   |

#### Output

No fields.

### day

Staff's day view: every class on one local date (scheduled, cancelled or done), in start order, with its class type, coach, room, places, how many are booked and held, and whether its class type is booked by staff only. For the front desk and coaches. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `bookings:coach`, `bookings:desk` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` | The local date, YYYY-MM-DD |
| `timeZone` | string |   | min length 1, max length 64, default `"UTC"` | The zone the date is in (the gym's, e.g. Australia/Sydney) |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `date` | string | yes |   |   |
| `classes` | array of object | yes |   |   |
| `classes[].id` | string | yes |   |   |
| `classes[].title` | string or null | yes |   |   |
| `classes[].classType` | object or null | yes |   |   |
| `classes[].classType.id` | string | yes |   |   |
| `classes[].classType.name` | string or null | yes |   |   |
| `classes[].startsAt` | string or null | yes |   |   |
| `classes[].endsAt` | string or null | yes |   |   |
| `classes[].timeZone` | string or null | yes |   | The class's IANA time zone: show its times in this zone. |
| `classes[].coach` | string or null | yes |   |   |
| `classes[].room` | string or null | yes |   |   |
| `classes[].places` | number or null | yes |   |   |
| `classes[].booked` | number | yes |   | Places taken |
| `classes[].held` | number | yes |   |   |
| `classes[].available` | number or null | yes |   |   |
| `classes[].state` | string or null | yes |   |   |
| `classes[].staffOnly` | boolean | yes |   | Its class type is booked by staff only |

### classList

A class's list for staff and coaches: the class (as on the day view) and every booking of it with the person's name, its state (booked, waiting, cancelled, cancelled late…), whether they paid at the desk, the membership or pass it spent from, who booked it, and for the waitlist when they were moved in or why they were passed over. Waiters are in the order they joined. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `bookings:desk` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `classId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `class` | object | yes |   |   |
| `class.id` | string | yes |   |   |
| `class.title` | string or null | yes |   |   |
| `class.classType` | object or null | yes |   |   |
| `class.classType.id` | string | yes |   |   |
| `class.classType.name` | string or null | yes |   |   |
| `class.startsAt` | string or null | yes |   |   |
| `class.endsAt` | string or null | yes |   |   |
| `class.timeZone` | string or null | yes |   | The class's IANA time zone: show its times in this zone. |
| `class.coach` | string or null | yes |   |   |
| `class.room` | string or null | yes |   |   |
| `class.places` | number or null | yes |   |   |
| `class.booked` | number | yes |   | Places taken |
| `class.held` | number | yes |   |   |
| `class.available` | number or null | yes |   |   |
| `class.state` | string or null | yes |   |   |
| `class.staffOnly` | boolean | yes |   | Its class type is booked by staff only |
| `bookings` | array of object | yes |   |   |
| `bookings[].id` | string | yes |   |   |
| `bookings[].person` | object or null | yes |   |   |
| `bookings[].person.id` | string | yes |   |   |
| `bookings[].person.name` | string or null | yes |   |   |
| `bookings[].state` | string or null | yes |   |   |
| `bookings[].paidAtDesk` | boolean | yes |   |   |
| `bookings[].holderId` | string or null | yes |   |   |
| `bookings[].bookedBy` | string or null | yes |   |   |
| `bookings[].promotedAt` | string or null | yes |   | When they were moved in from the waitlist |
| `bookings[].healthNote` | boolean or null | yes |   | A yes on their current health form: a mark only (staff who may read health answers open it from the Person page). Null when not shown. |
| `bookings[].passedOver` | string or null | yes |   | While waiting: why a free place could not be theirs (what they hold) |

### roster

A class's list for its coach: the class (as on the day view) and every booking of it with the person's name and its state (booked, ticked, not come, waiting in the order they joined, cancelled…), who marked it and when. Nothing about what anyone paid with. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `bookings:coach` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `classId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `class` | object | yes |   |   |
| `class.id` | string | yes |   |   |
| `class.title` | string or null | yes |   |   |
| `class.classType` | object or null | yes |   |   |
| `class.classType.id` | string | yes |   |   |
| `class.classType.name` | string or null | yes |   |   |
| `class.startsAt` | string or null | yes |   |   |
| `class.endsAt` | string or null | yes |   |   |
| `class.timeZone` | string or null | yes |   | The class's IANA time zone: show its times in this zone. |
| `class.coach` | string or null | yes |   |   |
| `class.room` | string or null | yes |   |   |
| `class.places` | number or null | yes |   |   |
| `class.booked` | number | yes |   | Places taken |
| `class.held` | number | yes |   |   |
| `class.available` | number or null | yes |   |   |
| `class.state` | string or null | yes |   |   |
| `class.staffOnly` | boolean | yes |   | Its class type is booked by staff only |
| `bookings` | array of object | yes |   |   |
| `bookings[].id` | string | yes |   |   |
| `bookings[].person` | object or null | yes |   |   |
| `bookings[].person.id` | string | yes |   |   |
| `bookings[].person.name` | string or null | yes |   |   |
| `bookings[].state` | string or null | yes |   |   |
| `bookings[].markedAt` | string or null | yes |   |   |
| `bookings[].markedBy` | string or null | yes |   | The name of who marked it |
| `bookings[].promotedAt` | string or null | yes |   | When they were moved in from the waitlist |
| `bookings[].healthNote` | boolean or null | yes |   | A yes on their current health form: a mark only (staff who may read health answers open it from the Person page). Null when not shown. |

### markAttended

Tick a booking on a class's list: they came. From an hour before the class, and any time after it (a late correction: a no-show ticked becomes attended). Of two coaches ticking one name at once, one tick is made and the other is told who was first. A booking that is cancelled, waiting or moved cannot be ticked. The use it spent stays spent.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `bookings:coach` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `bookingId` | string | yes | min length 1, max length 64 |   |

#### Output

No fields.

### undoAttended

Untick a booking ticked by mistake: it is booked again (and, once the class is 30 minutes over with others ticked, the host makes it a no-show). Who ticked it and when are cleared.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `bookings:coach` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `bookingId` | string | yes | min length 1, max length 64 |   |

#### Output

No fields.

### markNoShow

Mark a booked booking as not come (a no-show), once the class has started. The class stays used (no money, nothing else follows). The host does this itself for everyone still booked 30 minutes after the class ends, if anyone on the list was marked.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `bookings:coach` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `bookingId` | string | yes | min length 1, max length 64 |   |

#### Output

No fields.

### markAll

Tick everyone still booked on a class's list at once (from an hour before the class). Each name is ticked from where it is or not at all, so a name another coach ticked meanwhile is counted as already ticked, not twice.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `bookings:coach` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `classId` | string | yes | min length 1, max length 64 |   |

#### Output

No fields.

### move

Staff move a member's booking to another class, with the use it spent, in one batch: the old booking is moved (its place given back, to the waitlist first before its cut-off), a new booking is made on the other class, and the use is spent again on it from the same membership or pass. Refused whole, with nothing changed, when the other class is full (places held for its waitlist included: raise its places first), was cancelled or is over, they are already booked on it, or the use cannot be spent in that class's week or period. Only a booked booking, before its class starts. A booking paid at the desk moves paid at the desk. Audited.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `bookings:desk` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `bookingId` | string | yes | min length 1, max length 64 |   |
| `toClassId` | string | yes | min length 1, max length 64 |   |
| `note` | string |   | max length 2000 |   |

#### Output

No fields.

### cancelClass

Cancel a scheduled class that has not ended, with a reason: in the same batch every booking of it holding a place or a use (booked, waiting, held while paying, ticked as come, marked not come, cancelled late) is cancelled by the gym, each place given back and each use returned once. A person's act: the assistant, MCP clients and automations may ask, and it waits for a person to approve it. When it cannot be done (no such class, not scheduled, already ended, or it changed twice while being done) it fails with the reason, so an approved request shows it did not apply. (Emails to the members, and refunds of paid drop-ins, come in a later release.)

|  |  |
| --- | --- |
| Risk | `destructive` |
| Audiences | `staff` |
| Permission | `bookings:cancelClasses` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `classId` | string | yes | min length 1, max length 64 |   |
| `reason` | string | yes | min length 3, max length 2000 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `result` | `"cancelled"` | yes |   |   |
| `classId` | string | yes |   |   |
| `bookingsCancelled` | number | yes |   | Bookings cancelled with the class |

### family

Who the signed-in member may book for: themselves, and the children (dependants) the gym has linked to them, each with their name and id. Pass a child's id as book's forPersonId and mine's personId. Only the gym's staff link a parent to a child. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer` |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `people` | array of object | yes |   |   |
| `people[].personId` | string | yes |   |   |
| `people[].name` | string | yes |   |   |
| `people[].self` | boolean | yes |   |   |

## Automations

### bookingConfirmed

**Booking confirmed.** When a booking becomes booked (made by the member, a parent or staff; a drop-in paid for; moved in from the waiting list; or moved by staff to another class), emails the member and their parents or guardians the class, its time and room, with an add-to-calendar file (a move also takes the old class off the calendar). Routine email: Booking confirmations.

|  |  |
| --- | --- |
| Trigger | record on bookings.booking (created, updated) |
| Steps | `compose` Check the booking is still booked; `send` Email the member (and their guardians) |
| Gatekeepers | `email-send` |

### waitlistPassedOver

**Passed over on the waiting list.** When a place came free but the first person waiting could not be moved in (nothing they hold could pay for it), emails them why; they stay first on the waiting list. Routine email: Waiting list news.

|  |  |
| --- | --- |
| Trigger | fieldChanged on bookings.booking, field passedOverReason |
| Steps | `compose` Read why they were passed over; `send` Email the member (and their guardians) |
| Gatekeepers | `email-send` |

### placeFree

**A place free after the waiting list stops.** When someone gives a place back after the class's waiting list has stopped (2 hours before by default), emails everyone still waiting that a place is free: whoever books it first gets it. Several places given back within two minutes make one email. Routine email: Waiting list news.

|  |  |
| --- | --- |
| Trigger | fieldChanged on bookings.booking, field state |
| Steps | `note` Note the class has a place to tell of; `settle` ; `compose` Check the place is free and read who is waiting; `send` Email each person waiting; `release` Give up the class's turn |
| Gatekeepers | `email-send` |

### classChanged

**Class time or room changed.** When staff change a scheduled class's time, day, end or room (one class, or a series from a date), emails everyone booked or waiting what it is now, with an updated add-to-calendar file; several changes within two minutes make one email. A change of coach sends nothing. Routine email: Class changes.

|  |  |
| --- | --- |
| Trigger | record on bookings.class (updated) |
| Steps | `note` Note what changed; `settle` ; `compose` Read who is booked or waiting; `send` Email each member (and their guardians); `release` Give up the class's turn |
| Gatekeepers | `email-send` |

### classCancelled

**Class cancelled by the gym.** When the gym cancels a class (staff, a closure, or a series ended), emails everyone whose booking it cancelled: the class, the reason, that nothing was used from their membership or pass, and for a paid drop-in that the money goes back to their card once approved. Routine email: Class cancellations.

|  |  |
| --- | --- |
| Trigger | fieldChanged on bookings.class, field state |
| Steps | `compose` Read the bookings the cancel cancelled; `send` Email each member (and their guardians) |
| Gatekeepers | `email-send` |

### classReminder

**Class reminder.** Before each scheduled class (3 hours by default: the class type's reminder, else the organisation's), emails everyone booked into it a reminder of the time and room, and a visitor who paid for a place that staff have not yet confirmed. Routine email: Class reminders.

|  |  |
| --- | --- |
| Trigger | dateRelative on bookings.class, field startsAt |
| Steps | `compose` Read who is booked; `send` Email each member (and their guardians) |
| Gatekeepers | `email-send` |

### dropInOrder

**Drop-in paid or refunded.** When a visitor pays for a class that staff still have to confirm (their address matches several people on file), emails them at the order's address that their place is held; when the refund of a paid drop-in has been made, emails the person who paid that their money is back. Routine email: Drop-in payments and refunds.

|  |  |
| --- | --- |
| Trigger | fieldChanged on order, field state |
| Steps | `compose` Find the drop-in the order paid for; `send` Email the person who paid |
| Gatekeepers | `email-send` |

### noAttendanceTaken

**No attendance taken.** An hour after a class ends, when people were booked but nobody on it was ticked as come or marked as not come, tells the admins in the app, so someone takes the list (no-shows are only written for a class whose list was taken).

|  |  |
| --- | --- |
| Trigger | dateRelative on bookings.class, field endsAt |
| Steps | `check` Count who was booked and who was marked; `notify` Tell the admins |

## Dashboards

| Dashboard | Label | Widgets |
| --- | --- | --- |
| `bookings` |   | 11 |

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`order.startHeld`](/reference/operations/order/#orderstartheld)
- [`public.list`](/reference/operations/public/#publiclist)
- [`public.get`](/reference/operations/public/#publicget)
- [`capacity.get`](/reference/operations/capacity/#capacityget)
- [`duplicate.check`](/reference/operations/duplicate/#duplicatecheck)
- [`waitlist.position`](/reference/operations/waitlist/#waitlistposition)
- [`me.family`](/reference/operations/me/#mefamily)
- [`person.link.list`](/reference/operations/person/#personlinklist)
- [`order.get`](/reference/operations/order/#orderget)
- [`extensionSettings.list`](/reference/operations/extensionsettings/#extensionsettingslist)
- [`notification.send`](/reference/operations/notification/#notificationsend)
- [`agreement.listHealthNotes`](/reference/operations/agreement/#agreementlisthealthnotes)

Host modules it asks for: `ops`, `routine-mail`, `email-send`, `storage`.
