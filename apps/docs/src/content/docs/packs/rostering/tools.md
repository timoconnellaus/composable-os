---
title: "Rostering: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.rostering.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### me

Who you are on the roster and what you may do here: your name, whether you roster others, whether you handle pay, the organisation's zone and today's date there, and how long before a shift offers close.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes |   |   |
| `name` | string | yes |   |   |
| `rosters` | boolean | yes |   |   |
| `pays` | boolean | yes |   |   |
| `zone` | string | yes |   |   |
| `today` | string | yes |   |   |
| `cutoffMinutes` | number | yes |   |   |
| `uncoveredDays` | number | yes |   |   |

### week

The roster: every shift from `from` to `to` (local dates, both included, at most 62 days; a week from today when left out), classes and duty shifts alike, each with its kind, time, place and who is on it (or nobody), and its open offer. Someone who rosters also sees each shift's warnings. Shows nothing of a class's bookings or members.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `shifts` | array of object | yes |   |   |
| `shifts[].object` | string | yes |   | The kind of record: a class (bookings.class) or a duty shift |
| `shifts[].id` | string | yes |   |   |
| `shifts[].title` | string | yes |   |   |
| `shifts[].kind` | object or null | yes |   |   |
| `shifts[].kind.object` | string | yes |   |   |
| `shifts[].kind.id` | string | yes |   |   |
| `shifts[].kind.name` | string | yes |   |   |
| `shifts[].startsAt` | string | yes |   | ISO 8601, UTC: show it in `zone` |
| `shifts[].endsAt` | string or null | yes |   |   |
| `shifts[].zone` | string or null | yes |   |   |
| `shifts[].place` | string or null | yes |   |   |
| `shifts[].uncovered` | boolean | yes |   | Nobody is on it |
| `shifts[].noAccount` | boolean | yes |   | Its person has no staff account (a visiting coach) |
| `shifts[].account` | string or null | yes |   |   |
| `shifts[].name` | string or null | yes |   | Who is on it |
| `shifts[].mine` | boolean | yes |   | It is the caller's |
| `shifts[].offer` | object or null | yes |   |   |
| `shifts[].offer.id` | string | yes |   |   |
| `shifts[].offer.to` | string or null | yes |   |   |
| `shifts[].offer.from` | string or null | yes |   |   |
| `shifts[].warnings` | array of object or null | yes |   | For someone who rosters only |
| `shifts[].warnings.code` | `"unavailable"`, `"not_qualified"`, `"uncovered"`, `"outside_hours"`, `"client_busy"` | yes |   |   |
| `shifts[].warnings.object` | string | yes |   |   |
| `shifts[].warnings.id` | string | yes |   |   |
| `shifts[].warnings.account` | string or null | yes |   |   |
| `shifts[].warnings.message` | string | yes |   |   |
| `shifts[].checklist` | object or null | yes |   | Its checklist, if it has one |
| `shifts[].checklist.name` | string | yes |   |   |
| `shifts[].checklist.state` | `"not_started"`, `"in_progress"`, `"done"`, `"missed"`, `"cancelled"` or null | yes |   | For its person and whoever rosters only |
| `zone` | string | yes |   |   |
| `days` | array of object | yes |   | Each local date and its hours in the zone (23 or 25 on a clock change) |
| `days[].date` | string | yes |   |   |
| `days[].hours` | number | yes |   |   |
| `truncated` | boolean | yes |   | Cut short: more shifts than one answer holds; ask for fewer days |

### mine

Your own shifts from `from` to `to` (local dates, both included, at most 62 days; four weeks from today when left out), each with its time, place and open offer.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `shifts` | array of object | yes |   |   |
| `shifts[].object` | string | yes |   | The kind of record: a class (bookings.class) or a duty shift |
| `shifts[].id` | string | yes |   |   |
| `shifts[].title` | string | yes |   |   |
| `shifts[].kind` | object or null | yes |   |   |
| `shifts[].kind.object` | string | yes |   |   |
| `shifts[].kind.id` | string | yes |   |   |
| `shifts[].kind.name` | string | yes |   |   |
| `shifts[].startsAt` | string | yes |   | ISO 8601, UTC: show it in `zone` |
| `shifts[].endsAt` | string or null | yes |   |   |
| `shifts[].zone` | string or null | yes |   |   |
| `shifts[].place` | string or null | yes |   |   |
| `shifts[].uncovered` | boolean | yes |   | Nobody is on it |
| `shifts[].noAccount` | boolean | yes |   | Its person has no staff account (a visiting coach) |
| `shifts[].account` | string or null | yes |   |   |
| `shifts[].name` | string or null | yes |   | Who is on it |
| `shifts[].mine` | boolean | yes |   | It is the caller's |
| `shifts[].offer` | object or null | yes |   |   |
| `shifts[].offer.id` | string | yes |   |   |
| `shifts[].offer.to` | string or null | yes |   |   |
| `shifts[].offer.from` | string or null | yes |   |   |
| `shifts[].warnings` | array of object or null | yes |   | For someone who rosters only |
| `shifts[].warnings.code` | `"unavailable"`, `"not_qualified"`, `"uncovered"`, `"outside_hours"`, `"client_busy"` | yes |   |   |
| `shifts[].warnings.object` | string | yes |   |   |
| `shifts[].warnings.id` | string | yes |   |   |
| `shifts[].warnings.account` | string or null | yes |   |   |
| `shifts[].warnings.message` | string | yes |   |   |
| `shifts[].checklist` | object or null | yes |   | Its checklist, if it has one |
| `shifts[].checklist.name` | string | yes |   |   |
| `shifts[].checklist.state` | `"not_started"`, `"in_progress"`, `"done"`, `"missed"`, `"cancelled"` or null | yes |   | For its person and whoever rosters only |
| `zone` | string | yes |   |   |
| `days` | array of object | yes |   | Each local date and its hours in the zone (23 or 25 on a clock change) |
| `days[].date` | string | yes |   |   |
| `days[].hours` | number | yes |   |   |
| `truncated` | boolean | yes |   | Cut short: more shifts than one answer holds; ask for fewer days |

### offers

Shifts offered that you could take now (you are qualified for the kind of work, free then, and it is before the cut-off; `unavailable` says you said you are away then), and your own open offers.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `open` | array of object | yes |   |   |
| `open[].id` | string | yes |   |   |
| `open[].shift` | object | yes |   |   |
| `open[].shift.object` | string | yes |   |   |
| `open[].shift.id` | string | yes |   |   |
| `open[].shift.title` | string | yes |   |   |
| `open[].shift.startsAt` | string or null | yes |   |   |
| `open[].shift.endsAt` | string or null | yes |   |   |
| `open[].from` | string or null | yes |   |   |
| `open[].fromName` | string or null | yes |   |   |
| `open[].to` | string or null | yes |   |   |
| `open[].state` | `"open"`, `"taken"`, `"withdrawn"`, `"cancelled"`, `"lapsed"` | yes |   |   |
| `open[].madeAt` | string | yes |   |   |
| `open[].takenBy` | string or null | yes |   |   |
| `open[].takenAt` | string or null | yes |   |   |
| `open[].closesAt` | string or null | yes |   |   |
| `open[].unavailable` | boolean | yes |   |   |
| `mine` | array of object | yes |   |   |
| `mine[].id` | string | yes |   |   |
| `mine[].shift` | object | yes |   |   |
| `mine[].shift.object` | string | yes |   |   |
| `mine[].shift.id` | string | yes |   |   |
| `mine[].shift.title` | string | yes |   |   |
| `mine[].shift.startsAt` | string or null | yes |   |   |
| `mine[].shift.endsAt` | string or null | yes |   |   |
| `mine[].from` | string or null | yes |   |   |
| `mine[].fromName` | string or null | yes |   |   |
| `mine[].to` | string or null | yes |   |   |
| `mine[].state` | `"open"`, `"taken"`, `"withdrawn"`, `"cancelled"`, `"lapsed"` | yes |   |   |
| `mine[].madeAt` | string | yes |   |   |
| `mine[].takenBy` | string or null | yes |   |   |
| `mine[].takenAt` | string or null | yes |   |   |
| `mine[].closesAt` | string or null | yes |   |   |

### offer

Offer one of your shifts for someone else to take: to everyone who could take it, or to one named person (`to`). It stays yours, in your list and your pay, until someone takes it. Offers close at the cut-off before the shift starts. Whoever rosters may offer any shift, and one with nobody on it. A person's own act.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `to` | string |   | min length 1, max length 64 | A staff account: offer it to them only |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `offer` | object | yes |   |   |
| `offer.id` | string | yes |   |   |
| `offer.shift` | object | yes |   |   |
| `offer.shift.object` | string | yes |   |   |
| `offer.shift.id` | string | yes |   |   |
| `offer.shift.title` | string | yes |   |   |
| `offer.shift.startsAt` | string or null | yes |   |   |
| `offer.shift.endsAt` | string or null | yes |   |   |
| `offer.from` | string or null | yes |   |   |
| `offer.fromName` | string or null | yes |   |   |
| `offer.to` | string or null | yes |   |   |
| `offer.state` | `"open"`, `"taken"`, `"withdrawn"`, `"cancelled"`, `"lapsed"` | yes |   |   |
| `offer.madeAt` | string | yes |   |   |
| `offer.takenBy` | string or null | yes |   |   |
| `offer.takenAt` | string or null | yes |   |   |
| `offer.closesAt` | string or null | yes |   |   |
| `told` | number or null | yes |   |   |

### withdraw

Withdraw an open offer you made. The shift stays yours. A person's own act.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `offer` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `offer` | object | yes |   |   |
| `offer.id` | string | yes |   |   |
| `offer.shift` | object | yes |   |   |
| `offer.shift.object` | string | yes |   |   |
| `offer.shift.id` | string | yes |   |   |
| `offer.shift.title` | string | yes |   |   |
| `offer.shift.startsAt` | string or null | yes |   |   |
| `offer.shift.endsAt` | string or null | yes |   |   |
| `offer.from` | string or null | yes |   |   |
| `offer.fromName` | string or null | yes |   |   |
| `offer.to` | string or null | yes |   |   |
| `offer.state` | `"open"`, `"taken"`, `"withdrawn"`, `"cancelled"`, `"lapsed"` | yes |   |   |
| `offer.madeAt` | string | yes |   |   |
| `offer.takenBy` | string or null | yes |   |   |
| `offer.takenAt` | string or null | yes |   |   |
| `offer.closesAt` | string or null | yes |   |   |

### take

Take an offered shift: it becomes yours at once and nobody approves it, because you must be qualified for it and free then (otherwise it is refused). If you said you are away then, confirm with confirmUnavailable. Of several people taking one shift at once, one gets it; the others are told who took it. The person who offered it and whoever rosters are told. A person's own act.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `offer` | string | yes | min length 1, max length 64 |   |
| `confirmUnavailable` | boolean |   |   |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `offer` | string | yes |   |   |
| `shift` | object | yes |   |   |
| `shift.object` | string | yes |   |   |
| `shift.id` | string | yes |   |   |
| `shift.title` | string | yes |   |   |
| `shift.startsAt` | string or null | yes |   |   |
| `shift.endsAt` | string or null | yes |   |   |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"`, `"outside_hours"`, `"client_busy"` | yes |   |   |
| `warnings[].object` | string | yes |   |   |
| `warnings[].id` | string | yes |   |   |
| `warnings[].account` | string or null | yes |   |   |
| `warnings[].message` | string | yes |   |   |

### away

Say when you cannot work: leave or another one-off time (startsAt and endsAt, local), or a regular time off (weekdays with a start and end time, from a date). Nobody approves it. Shifts you are already on stay yours: the answer lists them, to offer, and whoever rosters is told. Only you and whoever rosters ever see it. A person's own act.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |
| Kept from the audit log | `note` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"leave"`, `"other"`, `"regular"` | yes |   | leave or other: a one-off time; regular: every week |
| `note` | string |   | max length 500 |   |
| `startsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` | A one-off time's start, local |
| `endsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` | A one-off time's end, local |
| `weekdays` | array of `"mon"`, `"tue"`, `"wed"`, `"thu"`, `"fri"`, `"sat"`, `"sun"` |   | at least 1, at most 7 | A regular time's days |
| `startTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` |   |
| `endTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` |   |
| `fromDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | A regular time's first date |
| `untilDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | A regular time's last date; empty: ongoing |
| `zone` | string |   | min length 1, max length 64 | IANA zone; the organisation's if left out |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `shifts` | array of object | yes |   | Your shifts it covers, to offer |
| `shifts[].object` | string | yes |   |   |
| `shifts[].id` | string | yes |   |   |
| `shifts[].title` | string | yes |   |   |
| `shifts[].startsAt` | string or null | yes |   |   |
| `shifts[].endsAt` | string or null | yes |   |   |
| `count` | number | yes |   |   |

### back

Remove a time you said you cannot work (you are back, or it was wrong). Whoever rosters may remove anyone's. A person's own act.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |

### myAway

The times you said you cannot work, from `from` (today when left out) to `to`, with your notes (shown to you only: an assistant reading them gets no notes).

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].kind` | `"leave"`, `"regular"`, `"other"` | yes |   |   |
| `items[].note` | string or null | yes |   |   |
| `items[].startsAt` | string or null | yes |   |   |
| `items[].endsAt` | string or null | yes |   |   |
| `items[].weekdays` | array of string | yes |   |   |
| `items[].startTime` | string or null | yes |   |   |
| `items[].endTime` | string or null | yes |   |   |
| `items[].fromDate` | string or null | yes |   |   |
| `items[].untilDate` | string or null | yes |   |   |
| `items[].zone` | string | yes |   |   |

### feed

Whether you have a private calendar feed of your own shifts (for your phone's calendar), and when its address was made. The address itself is shown only once, by feedRotate.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `active` | boolean | yes |   | Whether you have a calendar feed (its address is never shown again) |
| `createdAt` | string or null | yes |   |   |

### feedRotate

A new private address for your calendar feed: your own shifts, from two weeks back to four months ahead, for a calendar app to subscribe to. Any old address stops working at once. Shown this once: anyone with it sees your shifts, so do not share it. A person's own act.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `path` | string | yes |   | The address on this host: put its origin before it (https://, or webcal:// to open it in a calendar app) |
| `createdAt` | string | yes |   |   |

### feedRevoke

Turn your calendar feed off: its address stops working (a calendar app keeps the shifts it last fetched and gets no more). An admin may turn off anyone's (account). A person's own act.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string |   | min length 1, max length 64 | Someone else's: an admin only |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes |   |   |
| `revoked` | boolean | yes |   |   |

### myPayPeriods

The pay periods you can look up your own hours for: the current one and the twelve before it, each with its dates and whether it is open or locked. A person's own read.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `count` | integer |   | ≥ 1, ≤ 12 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `set` | boolean | yes |   | False until the date a period starts is set: nothing is totalled |
| `periods` | array of object | yes |   |   |
| `periods[].start` | string | yes |   |   |
| `periods[].end` | string | yes |   |   |
| `periods[].zone` | string | yes |   |   |
| `periods[].state` | `"open"`, `"locked"` | yes |   |   |
| `periods[].ended` | boolean | yes |   |   |
| `periods[].version` | number or null | yes |   |   |

### myPay

Your own hours for a pay period (the current one when start is left out): how you are counted, your shifts and hours per kind of work, and each of your shifts with its minutes and whether it was marked not worked. Exactly what payroll is given for you: a locked period's locked figures, or a preview of an open one, which may still change. Nothing about anyone else. A person's own read.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `start` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `period` | object | yes |   |   |
| `period.start` | string | yes |   |   |
| `period.end` | string | yes |   |   |
| `period.zone` | string | yes |   |   |
| `period.ended` | boolean | yes |   |   |
| `period.locked` | boolean | yes |   |   |
| `period.preview` | boolean | yes |   |   |
| `period.version` | number or null | yes |   |   |
| `counted` | boolean | yes |   | False: you are not counted for pay then, and there are no figures |
| `basis` | `"by_time"`, `"by_class"`, `"not_counted"` | yes |   |   |
| `totals` | array of object | yes |   |   |
| `totals[].basis` | `"by_time"`, `"by_class"` | yes |   |   |
| `totals[].kind` | object or null | yes |   |   |
| `totals[].kind.object` | string | yes |   |   |
| `totals[].kind.id` | string | yes |   |   |
| `totals[].kindName` | string | yes |   |   |
| `totals[].shifts` | number | yes |   |   |
| `totals[].minutes` | number | yes |   |   |
| `totals[].hours` | string | yes |   |   |
| `totals[].notWorked` | number | yes |   |   |
| `totals[].flagged` | number | yes |   |   |
| `lines` | array of object | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].kindName` | string | yes |   |   |
| `lines[].basis` | `"by_time"`, `"by_class"` | yes |   |   |
| `lines[].place` | string or null | yes |   |   |
| `lines[].localDate` | string | yes |   |   |
| `lines[].localStart` | string | yes |   |   |
| `lines[].localEnd` | string | yes |   |   |
| `lines[].shiftMinutes` | number | yes |   |   |
| `lines[].beforeMinutes` | number | yes |   |   |
| `lines[].afterMinutes` | number | yes |   |   |
| `lines[].countedMinutes` | number | yes |   |   |
| `lines[].notWorked` | boolean | yes |   |   |
| `lines[].listTaken` | boolean or null | yes |   |   |
| `lines[].flagged` | boolean | yes |   |   |
| `lines[].clockChange` | string or null | yes |   |   |
| `minutes` | number or null | yes |   |   |
| `hours` | string or null | yes |   |   |

### assign

Put a member of staff on a shift (a class or a duty shift), or nobody (account null). Made with its warnings (away, not qualified, nobody on it), which `check` shows first; refused if they are on another shift then. A shift of a weekly pattern keeps it as its own. The people on and off it are told; its open offer is cancelled. Whoever rosters; an assistant may ask, and a person applies it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `account` | string or null | yes |   |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `shift` | object | yes |   |   |
| `shift.object` | string | yes |   |   |
| `shift.id` | string | yes |   |   |
| `shift.title` | string | yes |   |   |
| `shift.startsAt` | string or null | yes |   |   |
| `shift.endsAt` | string or null | yes |   |   |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"`, `"outside_hours"`, `"client_busy"` | yes |   |   |
| `warnings[].object` | string | yes |   |   |
| `warnings[].id` | string | yes |   |   |
| `warnings[].account` | string or null | yes |   |   |
| `warnings[].message` | string | yes |   |   |

### check

What putting someone (account; null for nobody; left out for the shift as it is) on a shift would be made with: its warnings (away, not qualified, nobody on it) and the other shift it would clash with (refused). Changes nothing. Whoever rosters.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:manage` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `account` | string or null |   |   |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"`, `"outside_hours"`, `"client_busy"` | yes |   |   |
| `warnings[].object` | string | yes |   |   |
| `warnings[].id` | string | yes |   |   |
| `warnings[].account` | string or null | yes |   |   |
| `warnings[].message` | string | yes |   |   |
| `clash` | object or null | yes |   |   |
| `clash.object` | string | yes |   |   |
| `clash.id` | string | yes |   |   |
| `clash.title` | string | yes |   |   |
| `clash.startsAt` | string | yes |   |   |
| `clash.endsAt` | string | yes |   |   |

### qualify

Say whether a member of staff may do a kind of work (a class type, a duty): qualified people may take an offered shift of it without anybody approving, and putting someone else on it is warned about. Whoever rosters; an assistant may ask, and a person applies it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes | min length 1, max length 64 |   |
| `kind` | object | yes |   |   |
| `kind.object` | string | yes | min length 1, max length 81 | bookings.classtype or rostering.duty |
| `kind.id` | string | yes | min length 1, max length 64 |   |
| `qualified` | boolean |   | default `true` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes |   |   |
| `kind` | object | yes |   |   |
| `kind.object` | string | yes |   |   |
| `kind.id` | string | yes |   |   |
| `qualified` | boolean | yes |   |   |
| `changed` | boolean | yes |   |   |

### qualifications

Who may do which kind of work: everyone's, or one person's (account), or one kind of work's (kindObject). Whoever rosters.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:manage` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string |   | min length 1, max length 64 |   |
| `kindObject` | string |   | min length 1, max length 81 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].kind` | object | yes |   |   |
| `items[].kind.object` | string | yes |   |   |
| `items[].kind.id` | string | yes |   |   |
| `items[].kind.name` | string | yes |   |   |
| `items[].setBy` | string | yes |   |   |
| `items[].setAt` | string | yes |   |   |

### awayFor

Say when someone else cannot work (their leave, a regular time off), as they would themselves. Their shifts stay theirs, with a warning; the answer lists them. Whoever rosters, a person only.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:manage` |
| Who may call it | a person only (`humanOnly`) |
| Kept from the audit log | `note` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes | min length 1, max length 64 |   |
| `kind` | `"leave"`, `"other"`, `"regular"` | yes |   | leave or other: a one-off time; regular: every week |
| `note` | string |   | max length 500 |   |
| `startsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` | A one-off time's start, local |
| `endsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` | A one-off time's end, local |
| `weekdays` | array of `"mon"`, `"tue"`, `"wed"`, `"thu"`, `"fri"`, `"sat"`, `"sun"` |   | at least 1, at most 7 | A regular time's days |
| `startTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` |   |
| `endTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` |   |
| `fromDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | A regular time's first date |
| `untilDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | A regular time's last date; empty: ongoing |
| `zone` | string |   | min length 1, max length 64 | IANA zone; the organisation's if left out |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `shifts` | array of object | yes |   | Your shifts it covers, to offer |
| `shifts[].object` | string | yes |   |   |
| `shifts[].id` | string | yes |   |   |
| `shifts[].title` | string | yes |   |   |
| `shifts[].startsAt` | string or null | yes |   |   |
| `shifts[].endsAt` | string or null | yes |   |   |
| `count` | number | yes |   |   |

### awayList

Everyone's times they cannot work (or one person's, account), with their notes, from `from` (today when left out) to `to`. Whoever rosters, a person only: never read by an assistant.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:manage` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string |   | min length 1, max length 64 |   |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].kind` | `"leave"`, `"regular"`, `"other"` | yes |   |   |
| `items[].note` | string or null | yes |   |   |
| `items[].startsAt` | string or null | yes |   |   |
| `items[].endsAt` | string or null | yes |   |   |
| `items[].weekdays` | array of string | yes |   |   |
| `items[].startTime` | string or null | yes |   |   |
| `items[].endTime` | string or null | yes |   |   |
| `items[].fromDate` | string or null | yes |   |   |
| `items[].untilDate` | string or null | yes |   |   |
| `items[].zone` | string | yes |   |   |

### uncovered

Shifts with nobody on them from now for `days` days (the uncovered window, a setting, when left out; at most 62), and whether each is offered. Whoever rosters.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:manage` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `days` | integer |   | ≥ 1, ≤ 62 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].startsAt` | string or null | yes |   |   |
| `items[].endsAt` | string or null | yes |   |   |
| `items[].offered` | boolean | yes |   |   |

### markNotWorked

Mark a shift that has started as not worked, with why (nobody ran the class, they did not come in), so it counts for nothing in its pay period; notWorked false clears the mark. A shift in a locked pay period is refused until the period is reopened. Whoever rosters; an assistant may ask, and a person applies it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |
| Kept from the audit log | `reason` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `notWorked` | boolean |   | default `true` |   |
| `reason` | string |   | min length 1, max length 500 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `notWorked` | boolean | yes |   |   |
| `changed` | boolean | yes |   |   |

### candidates

Who could be put on a shift: every member of staff with what putting them on it would be made with (warnings, or the shift it would clash with), the eligible first; who is on it; and, for a shift of a weekly pattern, the pattern's person and whether it keeps its own. Whoever rosters.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:manage` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `current` | object | yes |   |   |
| `current.account` | string or null | yes |   |   |
| `current.name` | string or null | yes |   |   |
| `pattern` | object or null | yes |   |   |
| `pattern.account` | string or null | yes |   |   |
| `pattern.name` | string or null | yes |   |   |
| `pattern.own` | boolean | yes |   |   |
| `people` | array of object | yes |   |   |
| `people[].account` | string | yes |   |   |
| `people[].name` | string | yes |   |   |
| `people[].eligible` | boolean | yes |   | Qualified, free and available: could take it |
| `people[].noProfile` | boolean | yes |   | The shift cannot name them (a class needs a coach profile) |
| `people[].warnings` | array of object | yes |   |   |
| `people[].warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"`, `"outside_hours"`, `"client_busy"` | yes |   |   |
| `people[].warnings[].object` | string | yes |   |   |
| `people[].warnings[].id` | string | yes |   |   |
| `people[].warnings[].account` | string or null | yes |   |   |
| `people[].warnings[].message` | string | yes |   |   |
| `people[].clash` | object or null | yes |   |   |
| `people[].clash.object` | string | yes |   |   |
| `people[].clash.id` | string | yes |   |   |
| `people[].clash.title` | string | yes |   |   |
| `people[].clash.startsAt` | string | yes |   |   |
| `people[].clash.endsAt` | string | yes |   |   |
| `truncated` | boolean | yes |   |   |

### checklist

A shift's checklist and how it is going: each step, its tick (who ticked it, and for whom), what was missed, and corrections; before it opens, its steps. Its person and whoever rosters only; `canTick` says whether you may tick it now. A person's own read.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `template` | object or null | yes |   |   |
| `template.id` | string | yes |   |   |
| `template.name` | string | yes |   |   |
| `run` | object or null | yes |   |   |
| `run.id` | string | yes |   |   |
| `run.object` | string | yes |   |   |
| `run.record` | string | yes |   |   |
| `run.template` | object | yes |   |   |
| `run.template.id` | string | yes |   |   |
| `run.template.name` | string | yes |   |   |
| `run.template.version` | number | yes |   |   |
| `run.state` | `"open"`, `"done"`, `"missed"`, `"cancelled"` | yes |   |   |
| `run.account` | string or null | yes |   |   |
| `run.name` | string or null | yes |   |   |
| `run.opens` | string | yes |   |   |
| `run.closes` | string | yes |   |   |
| `run.tickUntil` | string | yes |   |   |
| `run.madeAt` | string | yes |   |   |
| `run.closedAt` | string or null | yes |   |   |
| `run.closedBy` | string or null | yes |   |   |
| `run.closedByName` | string or null | yes |   |   |
| `run.closedWhy` | string or null | yes |   |   |
| `run.steps` | array of object | yes |   |   |
| `run.steps[].position` | number | yes |   |   |
| `run.steps[].text` | string | yes |   |   |
| `run.steps[].required` | boolean | yes |   |   |
| `run.steps[].asksNote` | boolean | yes |   |   |
| `run.steps[].tick` | object or null | yes |   | The latest tick |
| `run.steps[].tick.id` | string | yes |   |   |
| `run.steps[].tick.state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `run.steps[].tick.done` | boolean | yes |   |   |
| `run.steps[].tick.why` | string or null | yes |   |   |
| `run.steps[].tick.note` | string or null | yes |   |   |
| `run.steps[].tick.onBehalfWhy` | string or null | yes |   |   |
| `run.steps[].tick.withheld` | boolean | yes |   | Has words only its author and whoever rosters read |
| `run.steps[].tick.by` | string | yes |   |   |
| `run.steps[].tick.byName` | string | yes |   |   |
| `run.steps[].tick.for` | string | yes |   |   |
| `run.steps[].tick.forName` | string | yes |   |   |
| `run.steps[].tick.onBehalf` | boolean | yes |   |   |
| `run.steps[].tick.at` | string | yes |   |   |
| `run.steps[].tick.label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" |
| `run.steps[].history` | array of object | yes |   | Earlier ticks, the latest 20: all for whoever rosters, your own otherwise |
| `run.steps[].history[].id` | string | yes |   |   |
| `run.steps[].history[].state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `run.steps[].history[].done` | boolean | yes |   |   |
| `run.steps[].history[].why` | string or null | yes |   |   |
| `run.steps[].history[].note` | string or null | yes |   |   |
| `run.steps[].history[].onBehalfWhy` | string or null | yes |   |   |
| `run.steps[].history[].withheld` | boolean | yes |   | Has words only its author and whoever rosters read |
| `run.steps[].history[].by` | string | yes |   |   |
| `run.steps[].history[].byName` | string | yes |   |   |
| `run.steps[].history[].for` | string | yes |   |   |
| `run.steps[].history[].forName` | string | yes |   |   |
| `run.steps[].history[].onBehalf` | boolean | yes |   |   |
| `run.steps[].history[].at` | string | yes |   |   |
| `run.steps[].history[].label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" |
| `run.steps[].historyTruncated` | boolean | yes |   |   |
| `run.steps[].missed` | boolean | yes |   |   |
| `run.corrections` | array of object | yes |   |   |
| `run.corrections[].id` | string | yes |   |   |
| `run.corrections[].text` | string | yes |   |   |
| `run.corrections[].by` | string | yes |   |   |
| `run.corrections[].byName` | string | yes |   |   |
| `run.corrections[].at` | string | yes |   |   |
| `preview` | array of object or null | yes |   |   |
| `preview.text` | string | yes |   |   |
| `preview.required` | boolean | yes |   |   |
| `preview.asksNote` | boolean | yes |   |   |
| `opens` | string or null | yes |   |   |
| `closes` | string or null | yes |   |   |
| `tickUntil` | string or null | yes |   |   |
| `canTick` | boolean | yes |   |   |
| `onBehalf` | boolean | yes |   |   |
| `forName` | string or null | yes |   |   |
| `you` | string | yes |   |   |
| `youRoster` | boolean | yes |   |   |

### tick

Tick one step of your shift's checklist: done (with a note where the step asks for one), not done (with why), or clear your tick. Every tick is kept; the latest counts, and only whoever rosters changes a tick someone else made. From when the shift starts until 2 hours after it ends. Whoever rosters may tick someone's for them, saying why (forWhy): it is kept as ticked by them for that person. A person's own act.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |
| Kept from the audit log | `note`, `why`, `forWhy`, `state` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `step` | integer | yes | ≥ 0, ≤ 49 |   |
| `state` | `"done"`, `"not_done"`, `"clear"` | yes |   |   |
| `note` | string |   | max length 1000 |   |
| `why` | string |   | max length 500 |   |
| `forWhy` | string |   | max length 500 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `run` | string | yes |   |   |
| `step` | number | yes |   |   |
| `state` | `"done"`, `"not_done"`, `"clear"` | yes |   |   |
| `ticked` | number | yes |   |   |
| `of` | number | yes |   |   |

### checklistDone

Mark your shift's checklist done, once every required step is ticked. Done is final: it never changes again. Whoever rosters may mark someone's done for them, saying why. A person's own act.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:team`, `rostering:roster` |
| Who may call it | a person only (`humanOnly`) |
| Kept from the audit log | `forWhy` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `forWhy` | string |   | max length 500 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `run` | string | yes |   |   |
| `state` | `"done"` | yes |   |   |

### checklistRuns

How checklists went, by checklist and date: every run from `from` to `to` (local dates, at most 62 days), with its shift, its person, whether it is open, done, missed or cancelled, the steps ticked, those missed, and ticks made for the person by someone else. Whoever rosters, a person only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:manage` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `template` | string |   | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `zone` | string | yes |   |   |
| `runs` | array of object | yes |   |   |
| `runs[].id` | string | yes |   |   |
| `runs[].object` | string | yes |   |   |
| `runs[].record` | string | yes |   |   |
| `runs[].title` | string | yes |   |   |
| `runs[].template` | object | yes |   |   |
| `runs[].template.id` | string | yes |   |   |
| `runs[].template.name` | string | yes |   |   |
| `runs[].state` | `"open"`, `"done"`, `"missed"`, `"cancelled"` | yes |   |   |
| `runs[].account` | string or null | yes |   |   |
| `runs[].name` | string or null | yes |   |   |
| `runs[].opens` | string | yes |   |   |
| `runs[].closes` | string | yes |   |   |
| `runs[].steps` | number | yes |   |   |
| `runs[].ticked` | number | yes |   |   |
| `runs[].onBehalf` | number | yes |   |   |
| `runs[].missed` | array of string | yes |   |   |
| `runs[].corrections` | number | yes |   |   |
| `truncated` | boolean | yes |   |   |

### checklistCorrect

Add a correction beside a closed checklist (done, missed or cancelled): a note kept with it, never a change to its ticks. Whoever rosters, a person only.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:manage` |
| Who may call it | a person only (`humanOnly`) |
| Kept from the audit log | `text` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `run` | string | yes | min length 1, max length 64 |   |
| `text` | string | yes | min length 1, max length 1000 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `run` | string | yes |   |   |

### follow

Put a shift of a weekly pattern back to its pattern's person: it drops its own person and follows the pattern again. Refused for a one-off shift, and if the pattern's person is on another shift then. Whoever rosters; an assistant may ask, and a person applies it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"`, `"outside_hours"`, `"client_busy"` | yes |   |   |
| `warnings[].object` | string | yes |   |   |
| `warnings[].id` | string | yes |   |   |
| `warnings[].account` | string or null | yes |   |   |
| `warnings[].message` | string | yes |   |   |

### people

The active members of staff and every kind of work a shift can be of (class types, duties), to say who may do which. Names only. Whoever rosters.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:manage` |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `people` | array of object | yes |   |   |
| `people[].account` | string | yes |   |   |
| `people[].name` | string | yes |   |   |
| `kinds` | array of object | yes |   |   |
| `kinds[].object` | string | yes |   |   |
| `kinds[].objectLabel` | string | yes |   |   |
| `kinds[].id` | string | yes |   |   |
| `kinds[].name` | string | yes |   |   |
| `truncated` | boolean | yes |   |   |

### patterns

The regular week: every class series and duty series that has not ended, with its days, time, length, dates and its regular person (or nobody). Whoever rosters.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:manage` |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `patterns` | array of object | yes |   |   |
| `patterns[].object` | string | yes |   |   |
| `patterns[].id` | string | yes |   |   |
| `patterns[].title` | string | yes |   |   |
| `patterns[].objectLabel` | string | yes |   |   |
| `patterns[].kind` | object or null | yes |   |   |
| `patterns[].kind.object` | string | yes |   |   |
| `patterns[].kind.id` | string | yes |   |   |
| `patterns[].kind.name` | string | yes |   |   |
| `patterns[].weekdays` | array of string | yes |   |   |
| `patterns[].time` | string or null | yes |   |   |
| `patterns[].length` | number or null | yes |   |   |
| `patterns[].firstDate` | string or null | yes |   |   |
| `patterns[].lastDate` | string or null | yes |   |   |
| `patterns[].zone` | string | yes |   |   |
| `patterns[].account` | string or null | yes |   |   |
| `patterns[].name` | string or null | yes |   |   |
| `patterns[].noAccount` | boolean | yes |   |   |
| `truncated` | boolean | yes |   |   |

### setPattern

Change a regular pattern's person (a class series' coach, a duty series' person), or nobody (account null), from a date (today when left out): its shifts from then follow, except those that keep their own person. Refused whole if it would put them on two shifts at once on any date, naming the dates. Whoever rosters; an assistant may ask, and a person applies it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 | bookings.series or rostering.dutyseries |
| `id` | string | yes | min length 1, max length 64 |   |
| `account` | string or null | yes |   |   |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `account` | string or null | yes |   |   |
| `from` | string | yes |   |   |

### planCheck

Before an import makes patterns or shifts: for each plan (a weekly pattern, or one dated shift, with its person), the dates it would make, the dates it would clash with a shift they are on or an earlier plan (title and start; `ended` when both are over), the dates they said they are away and whether they are not qualified. Changes nothing. Whoever rosters, a person only (it reads people's time off).

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:manage` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `plans` | array of object | yes | at least 1, at most 1000 |   |
| `plans[].key` | string |   | max length 80 |   |
| `plans[].kind` | object or null |   |   |   |
| `plans[].kind.object` | string | yes | min length 1, max length 81 |   |
| `plans[].kind.id` | string | yes | min length 1, max length 64 |   |
| `plans[].account` | string or null | yes |   |   |
| `plans[].weekdays` | array of `"mon"`, `"tue"`, `"wed"`, `"thu"`, `"fri"`, `"sat"`, `"sun"` |   | at least 1, at most 7 |   |
| `plans[].date` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `plans[].time` | string | yes | pattern `^[0-2]\d:[0-5]\d$` |   |
| `plans[].length` | integer | yes | ≥ 1, ≤ 1440 |   |
| `plans[].firstDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `plans[].lastDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `plans[].zone` | string |   | min length 1, max length 64 |   |
| `horizonDays` | integer |   | ≥ 1, ≤ 366 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `plans` | array of object | yes |   |   |
| `plans[].key` | string or null | yes |   |   |
| `plans[].dates` | number | yes |   |   |
| `plans[].clashes` | array of object | yes |   |   |
| `plans[].clashes[].date` | string | yes |   |   |
| `plans[].clashes[].startsAt` | string | yes |   |   |
| `plans[].clashes[].other` | object | yes |   |   |
| `plans[].clashes[].other.title` | string | yes |   |   |
| `plans[].clashes[].other.startsAt` | string | yes |   |   |
| `plans[].clashes[].other.endsAt` | string | yes |   |   |
| `plans[].clashes[].ended` | boolean | yes |   |   |
| `plans[].away` | array of string | yes |   |   |
| `plans[].notQualified` | boolean | yes |   |   |
| `plans[].first` | object or null | yes |   |   |
| `plans[].first.date` | string | yes |   |   |
| `plans[].first.startsAt` | string | yes |   |   |
| `plans[].first.endsAt` | string | yes |   |   |
| `truncated` | boolean | yes |   |   |

### payBasis

Say how a member of staff is counted for pay from a date on (today when left out): by_time (their hours), by_class (their classes and shifts) or not_counted (salaried, the default). No rates are kept: payroll applies them. Whoever handles pay, a person only.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:pay` |
| Who may call it | a person only (`humanOnly`) |
| Kept from the audit log | `basis` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes | min length 1, max length 64 |   |
| `basis` | `"by_time"`, `"by_class"`, `"not_counted"` | yes |   |   |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes |   |   |
| `from` | string | yes |   |   |
| `changed` | boolean | yes |   |   |

### payBases

Who is counted for pay and how (by time, by class, not counted), today and from which dates; with everyone, every member of staff. Whoever handles pay, a person only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:pay` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string |   | min length 1, max length 64 |   |
| `everyone` | boolean |   |   | Also every active member of staff with no basis set yet (not counted) |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `today` | string | yes |   |   |
| `items` | array of object | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].basis` | `"by_time"`, `"by_class"`, `"not_counted"` | yes |   |   |
| `items[].history` | array of object | yes |   |   |
| `items[].history[].from` | string | yes |   |   |
| `items[].history[].basis` | `"by_time"`, `"by_class"`, `"not_counted"` | yes |   |   |
| `items[].history[].setBy` | string | yes |   |   |
| `items[].history[].setAt` | string | yes |   |   |
| `truncated` | boolean | yes |   | Cut short: ask for one person's (account) |

### periods

The pay periods (the pay period setting: fortnightly by default): the current one and the `count` before it, each open or locked, with its versions. Whoever handles pay, a person only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:pay` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `count` | integer |   | ≥ 1, ≤ 60 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `setting` | object | yes |   |   |
| `setting.period` | `"weekly"`, `"fortnightly"`, `"monthly"` | yes |   |   |
| `setting.start` | string or null | yes |   |   |
| `setting.day` | number | yes |   |   |
| `setting.zone` | string | yes |   |   |
| `set` | boolean | yes |   | False until the date a period starts is set: nothing is totalled |
| `periods` | array of object | yes |   |   |
| `periods[].start` | string | yes |   |   |
| `periods[].end` | string | yes |   |   |
| `periods[].zone` | string | yes |   |   |
| `periods[].state` | `"open"`, `"locked"` | yes |   |   |
| `periods[].ended` | boolean | yes |   |   |
| `periods[].versions` | array of object | yes |   |   |
| `periods[].versions[].id` | string | yes |   |   |
| `periods[].versions[].version` | number | yes |   |   |
| `periods[].versions[].state` | `"locked"`, `"reopened"` | yes |   |   |
| `periods[].versions[].lockedBy` | string | yes |   |   |
| `periods[].versions[].lockedByName` | string | yes |   |   |
| `periods[].versions[].lockedAt` | string | yes |   |   |
| `periods[].versions[].reopenedBy` | string or null | yes |   |   |
| `periods[].versions[].reopenedAt` | string or null | yes |   |   |
| `periods[].versions[].reopenReason` | string or null | yes |   |   |

### periodTotals

One pay period's totals: per counted person and kind of work, the shifts and the hours (whole minutes, and hours to two places), and one line per shift with its evidence (its class list taken, by whom, flagged for review when not by its person). A locked period's are its locked lines; an open one's are a preview from the roster as it stands. Whoever handles pay, a person only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:pay` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `start` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `version` | integer |   | ≥ 1, ≤ 9007199254740991 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `period` | object | yes |   |   |
| `period.start` | string | yes |   |   |
| `period.end` | string | yes |   |   |
| `period.zone` | string | yes |   |   |
| `period.locked` | boolean | yes |   |   |
| `period.preview` | boolean | yes |   |   |
| `period.version` | object or null | yes |   |   |
| `period.version.id` | string | yes |   |   |
| `period.version.version` | number | yes |   |   |
| `period.version.state` | `"locked"`, `"reopened"` | yes |   |   |
| `period.version.lockedBy` | string | yes |   |   |
| `period.version.lockedByName` | string | yes |   |   |
| `period.version.lockedAt` | string | yes |   |   |
| `period.version.reopenedBy` | string or null | yes |   |   |
| `period.version.reopenedAt` | string or null | yes |   |   |
| `period.version.reopenReason` | string or null | yes |   |   |
| `totals` | array of object | yes |   |   |
| `totals[].account` | string | yes |   |   |
| `totals[].name` | string | yes |   |   |
| `totals[].email` | string | yes |   |   |
| `totals[].basis` | `"by_time"`, `"by_class"` | yes |   |   |
| `totals[].kind` | object or null | yes |   |   |
| `totals[].kind.object` | string | yes |   |   |
| `totals[].kind.id` | string | yes |   |   |
| `totals[].kindName` | string | yes |   |   |
| `totals[].shifts` | number | yes |   |   |
| `totals[].minutes` | number | yes |   |   |
| `totals[].hours` | string | yes |   |   |
| `totals[].notWorked` | number | yes |   |   |
| `totals[].flagged` | number | yes |   |   |
| `lines` | array of object | yes |   |   |
| `lines[].account` | string | yes |   |   |
| `lines[].name` | string | yes |   |   |
| `lines[].email` | string | yes |   |   |
| `lines[].basis` | `"by_time"`, `"by_class"` | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].kind` | object or null | yes |   |   |
| `lines[].kind.object` | string | yes |   |   |
| `lines[].kind.id` | string | yes |   |   |
| `lines[].kindName` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].place` | string or null | yes |   |   |
| `lines[].localDate` | string | yes |   |   |
| `lines[].localStart` | string | yes |   |   |
| `lines[].localEnd` | string | yes |   |   |
| `lines[].shiftMinutes` | number | yes |   |   |
| `lines[].beforeMinutes` | number | yes |   |   |
| `lines[].afterMinutes` | number | yes |   |   |
| `lines[].countedMinutes` | number | yes |   |   |
| `lines[].counted` | boolean | yes |   |   |
| `lines[].notWorkedReason` | string or null | yes |   |   |
| `lines[].listTaken` | boolean or null | yes |   |   |
| `lines[].markedBy` | string or null | yes |   |   |
| `lines[].flagged` | boolean | yes |   |   |
| `minutes` | number | yes |   |   |
| `hours` | string | yes |   |   |

### lock

Lock a pay period that has ended: its totals are written from the roster as it stands and never change; shifts inside it can no longer be changed until it is reopened. Correct the roster first (reassign, mark not worked). Whoever handles pay, a person only.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:pay` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `start` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `start` | string | yes |   |   |
| `end` | string | yes |   |   |
| `version` | number | yes |   |   |

### reopen

Reopen a locked pay period, saying why, to correct its shifts; its locked version is kept. Lock it again for a new version. Whoever handles pay, a person only.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `rostering:pay` |
| Who may call it | a person only (`humanOnly`) |
| Kept from the audit log | `reason` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `start` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `reason` | string | yes | min length 1, max length 500 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `start` | string | yes |   |   |
| `version` | number | yes |   |   |

### export

A pay period as a CSV file for payroll: a summary row per person and kind of work (shifts, hours as a decimal and in minutes), then a row per shift. From its locked version, or a preview of an open period, marked as such. No rates and no money. Whoever handles pay, a person only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `rostering:pay` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `start` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `version` | integer |   | ≥ 1, ≤ 9007199254740991 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filename` | string | yes |   |   |
| `contentType` | `"text/csv"` | yes |   |   |
| `csv` | string | yes |   |   |
| `locked` | boolean | yes |   |   |
| `version` | number or null | yes |   |   |

## Automations

None.

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`staffing.week`](/reference/operations/staffing/#staffingweek)
- [`staffing.check`](/reference/operations/staffing/#staffingcheck)
- [`staffing.assign`](/reference/operations/staffing/#staffingassign)
- [`staffing.offer`](/reference/operations/staffing/#staffingoffer)
- [`staffing.withdraw`](/reference/operations/staffing/#staffingwithdraw)
- [`staffing.take`](/reference/operations/staffing/#staffingtake)
- [`staffing.offers`](/reference/operations/staffing/#staffingoffers)
- [`staffing.away`](/reference/operations/staffing/#staffingaway)
- [`staffing.back`](/reference/operations/staffing/#staffingback)
- [`staffing.awayList`](/reference/operations/staffing/#staffingawaylist)
- [`staffing.qualify`](/reference/operations/staffing/#staffingqualify)
- [`staffing.qualifications`](/reference/operations/staffing/#staffingqualifications)
- [`staffing.uncovered`](/reference/operations/staffing/#staffinguncovered)
- [`staffing.markNotWorked`](/reference/operations/staffing/#staffingmarknotworked)
- [`staffing.payBasis`](/reference/operations/staffing/#staffingpaybasis)
- [`staffing.payBases`](/reference/operations/staffing/#staffingpaybases)
- [`staffing.payPeriod.list`](/reference/operations/staffing/#staffingpayperiodlist)
- [`staffing.payPeriod.totals`](/reference/operations/staffing/#staffingpayperiodtotals)
- [`staffing.payPeriod.lock`](/reference/operations/staffing/#staffingpayperiodlock)
- [`staffing.payPeriod.reopen`](/reference/operations/staffing/#staffingpayperiodreopen)
- [`staffing.payPeriod.export`](/reference/operations/staffing/#staffingpayperiodexport)
- [`staffing.myPay.periods`](/reference/operations/staffing/#staffingmypayperiods)
- [`staffing.myPay`](/reference/operations/staffing/#staffingmypay)
- [`staffing.me`](/reference/operations/staffing/#staffingme)
- [`staffing.candidates`](/reference/operations/staffing/#staffingcandidates)
- [`staffing.people`](/reference/operations/staffing/#staffingpeople)
- [`staffing.patterns`](/reference/operations/staffing/#staffingpatterns)
- [`staffing.setPattern`](/reference/operations/staffing/#staffingsetpattern)
- [`staffing.follow`](/reference/operations/staffing/#staffingfollow)
- [`staffing.planCheck`](/reference/operations/staffing/#staffingplancheck)
- [`staffing.feed.status`](/reference/operations/staffing/#staffingfeedstatus)
- [`staffing.feed.rotate`](/reference/operations/staffing/#staffingfeedrotate)
- [`staffing.feed.revoke`](/reference/operations/staffing/#staffingfeedrevoke)
- [`checklist.forRecord`](/reference/operations/checklist/#checklistforrecord)
- [`checklist.tick`](/reference/operations/checklist/#checklisttick)
- [`checklist.complete`](/reference/operations/checklist/#checklistcomplete)
- [`checklist.runs`](/reference/operations/checklist/#checklistruns)
- [`checklist.correct`](/reference/operations/checklist/#checklistcorrect)

Host modules it asks for: `ops`.
