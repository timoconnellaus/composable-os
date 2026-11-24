---
title: "staffing.* operations"
description: "The core operations named staffing.*"
sidebar:
  label: "staffing"
editUrl: false
---

## staffing.assign

Tool-only (a shipped pack's tool): put a staff account on a shift, or nobody (null). Someone who rosters; an AI's request waits for a person, who sees the warnings first (staffing.check). Made with its warnings (unavailable, not_qualified, uncovered), refused as double_booked. A shift of a series keeps it as its own (the series' later changes leave it). Its open offer is cancelled; the people on and off it are told.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `account` | string or null | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `shift` | object | yes |   |   |
| `shift.object` | string | yes |   |   |
| `shift.id` | string | yes |   |   |
| `shift.title` | string | yes |   |   |
| `shift.startsAt` | string or null | yes |   |   |
| `shift.endsAt` | string or null | yes |   |   |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"` | yes |   |   |
| `warnings[].object` | string | yes |   |   |
| `warnings[].id` | string | yes |   |   |
| `warnings[].account` | string or null | yes |   |   |
| `warnings[].message` | string | yes |   |   |

## staffing.away

Tool-only (a shipped pack's tool): say when someone cannot work: leave or another one-off time (startsAt and endsAt, local date-times in zone), or a regular time off (weekdays, a local startTime and endTime, from fromDate until untilDate). Their own, or anyone's for someone who rosters; a person's own act, never an assistant's. Nobody approves it. Shifts they are already on stay theirs, with an unavailable warning: the answer lists them (to offer in one step) and the rosterers are told. Only they and rosterers ever see it.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string |   | min length 1, max length 64 | Whose; leave out for your own |
| `kind` | `"leave"`, `"other"`, `"regular"` | yes |   |   |
| `note` | string |   | max length 500 |   |
| `startsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `endsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `weekdays` | array of `"mon"`, `"tue"`, `"wed"`, `"thu"`, `"fri"`, `"sat"`, `"sun"` |   | at least 1, at most 7 |   |
| `startTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` |   |
| `endTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` |   |
| `fromDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `untilDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `zone` | string |   | min length 1, max length 64 | IANA zone; the organisation's if left out |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `shifts` | array of object | yes |   |   |
| `shifts[].object` | string | yes |   |   |
| `shifts[].id` | string | yes |   |   |
| `shifts[].title` | string | yes |   |   |
| `shifts[].startsAt` | string or null | yes |   |   |
| `shifts[].endsAt` | string or null | yes |   |   |
| `count` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## staffing.awayList

Tool-only (a shipped pack's tool): times people said they cannot work, with their notes (to a person only: an assistant reading its person's own gets no notes), overlapping from..to (local dates; default from today). Your own; someone who rosters reads anyone's, or everyone's when account is left out, as a person. Nobody else ever sees it. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string |   | min length 1, max length 64 |   |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

### Output

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
| `items[].leaveRequest` | string or null | yes |   |   |

## staffing.back

Tool-only (a shipped pack's tool): remove a time someone said they cannot work (they are back, or it was wrong). Their own, or anyone's for someone who rosters; a person's own act. Approved leave is not removed here: cancel its leave request. Returns its id.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |

## staffing.candidates

Tool-only (a shipped pack's tool): who could be put on a shift, for someone who rosters. Every active member of staff with what putting them on it would be made with (the same dry run as staffing.check: warnings, or the other shift it would clash with), eligible people first (qualified, free and available), then the rest; who is on it now; its pattern's person (a shift of a weekly pattern) and whether it keeps its own person instead. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `current` | object | yes |   |   |
| `current.account` | string or null | yes |   |   |
| `current.name` | string or null | yes |   |   |
| `pattern` | object or null | yes |   | A shift of a weekly pattern: its pattern's person; null for a one-off |
| `pattern.account` | string or null | yes |   |   |
| `pattern.name` | string or null | yes |   |   |
| `pattern.own` | boolean | yes |   |   |
| `people` | array of object | yes |   |   |
| `people[].account` | string | yes |   |   |
| `people[].name` | string | yes |   |   |
| `people[].eligible` | boolean | yes |   |   |
| `people[].noProfile` | boolean | yes |   |   |
| `people[].warnings` | array of object | yes |   |   |
| `people[].warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"` | yes |   |   |
| `people[].warnings[].object` | string | yes |   |   |
| `people[].warnings[].id` | string | yes |   |   |
| `people[].warnings[].account` | string or null | yes |   |   |
| `people[].warnings[].message` | string | yes |   |   |
| `people[].clash` | object or null | yes |   | Their other shift then: putting them on it is refused as double_booked |
| `people[].clash.object` | string | yes |   |   |
| `people[].clash.id` | string | yes |   |   |
| `people[].clash.title` | string | yes |   |   |
| `people[].clash.startsAt` | string | yes |   |   |
| `people[].clash.endsAt` | string | yes |   |   |
| `truncated` | boolean | yes |   | More staff than one answer works out |

## staffing.check

Tool-only (a shipped pack's tool): the dry run of putting someone on a shift. For a record of an object that declares `staffed`, as it is or with `account` as its person (null: nobody), answers the warnings the write would be made with (unavailable, not_qualified, uncovered) and the other shift it would clash with (a clash is refused as double_booked). Writes nothing.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `account` | string or null |   |   | A staff account to check as the shift's person; null for nobody |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"` | yes |   |   |
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

## staffing.due

Platform use only (the minute cron, as the host): open offers past their cut-off lapse and their offerers and the rosterers are told; once a day the rosterers hear of every shift with nobody on it in the uncovered window; a time entry left open past its finish is marked finish missing and its person told. Returns what it did.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |
| Also | a host step: never queued for review when the host itself calls it (`hostStep`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lapsed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `cancelled` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `uncovered` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `finishMissing` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## staffing.feed.revoke

Tool-only (a shipped pack's tool): revoke a private calendar feed's address, which then answers as if it never existed (a calendar app subscribed to it keeps the shifts it last fetched, and gets no more). Your own; an admin may revoke anyone's (`account`). A person's own act.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string |   | min length 1, max length 64 | Someone else's (an admin only) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes |   |   |
| `revoked` | boolean | yes |   |   |

## staffing.feed.rotate

Tool-only (a shipped pack's tool): a new private address for your calendar feed (your own shifts, for a calendar app to subscribe to), replacing any old one, which stops working at once. The address is shown this once and never again: anyone who has it sees your shifts, so do not share it. A person's own act.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `path` | string | yes |   | The feed's address on this host (put the host's origin before it; webcal:// opens it in a calendar app). Shown once. |
| `createdAt` | string | yes |   |   |

## staffing.feed.status

Tool-only (a shipped pack's tool): whether you have a private calendar feed of your shifts, and when its address was made. Never the address itself: it is shown once, when made. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `active` | boolean | yes |   | Whether a feed address exists (it is never shown again) |
| `createdAt` | string or null | yes |   | When the current address was made |

## staffing.follow

Tool-only (a shipped pack's tool): put a shift of a weekly pattern back to its pattern's person ("back to the pattern"): its own person is dropped and it follows the pattern's later changes again. Someone who rosters; an AI's request waits for a person. Refused for a one-off shift, and as double_booked when the pattern's person is on another shift then.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"` | yes |   |   |
| `warnings[].object` | string | yes |   |   |
| `warnings[].id` | string | yes |   |   |
| `warnings[].account` | string or null | yes |   |   |
| `warnings[].message` | string | yes |   |   |

## staffing.hours.clear

Tool-only (a shipped pack's tool): remove an open-hours entry (weekly or extra). Their own, or anyone's for someone who rosters; an AI's removal waits for a person. Appointments already booked stay. Returns its id.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |

## staffing.hours.list

Tool-only (a shipped pack's tool): open hours, weekly and extra, that apply between from and to (local dates; default from today). Your own; someone who rosters reads anyone's, or everyone's when account is left out. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string |   | min length 1, max length 64 |   |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].kind` | `"weekly"`, `"extra"` | yes |   |   |
| `items[].weekdays` | array of string | yes |   |   |
| `items[].startTime` | string or null | yes |   |   |
| `items[].endTime` | string or null | yes |   |   |
| `items[].fromDate` | string or null | yes |   |   |
| `items[].untilDate` | string or null | yes |   |   |
| `items[].startsAt` | string or null | yes |   |   |
| `items[].endsAt` | string or null | yes |   |   |
| `items[].zone` | string | yes |   |   |
| `items[].onlyFor` | array of object | yes |   |   |
| `items[].onlyFor[].object` | string | yes |   |   |
| `items[].onlyFor[].id` | string | yes |   |   |

## staffing.hours.set

Tool-only (a shipped pack's tool): say when someone takes appointments. Weekly open hours (kind weekly: weekdays, a local startTime and endTime, from fromDate, default today, until untilDate; an end at or before the start runs overnight), or extra hours on a date (kind extra: startsAt and endsAt, local date-times in zone, at most 24 hours). onlyFor limits it to some kinds of work (a service); left out, it is open for every kind. Give id to change an entry instead of adding one. Their own, or anyone's for someone who rosters; an AI's change waits for a person. Time off is staffing.away, not this. At most 50 entries a person. Returns the entry.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string |   | min length 1, max length 64 | An entry to change; leave out to add one |
| `account` | string |   | min length 1, max length 64 | Whose; leave out for your own |
| `kind` | `"weekly"`, `"extra"` | yes |   |   |
| `weekdays` | array of `"mon"`, `"tue"`, `"wed"`, `"thu"`, `"fri"`, `"sat"`, `"sun"` |   | at least 1, at most 7 |   |
| `startTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` |   |
| `endTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` |   |
| `fromDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `untilDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `startsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `endsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `onlyFor` | array of object |   | at most 20 | Kinds of work only; empty: every kind |
| `onlyFor[].object` | string | yes | min length 1, max length 81 |   |
| `onlyFor[].id` | string | yes | min length 1, max length 64 |   |
| `zone` | string |   | min length 1, max length 64 | IANA zone; the organisation's if left out |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `item` | object | yes |   |   |
| `item.id` | string | yes |   |   |
| `item.account` | string | yes |   |   |
| `item.name` | string | yes |   |   |
| `item.kind` | `"weekly"`, `"extra"` | yes |   |   |
| `item.weekdays` | array of string | yes |   |   |
| `item.startTime` | string or null | yes |   |   |
| `item.endTime` | string or null | yes |   |   |
| `item.fromDate` | string or null | yes |   |   |
| `item.untilDate` | string or null | yes |   |   |
| `item.startsAt` | string or null | yes |   |   |
| `item.endsAt` | string or null | yes |   |   |
| `item.zone` | string | yes |   |   |
| `item.onlyFor` | array of object | yes |   |   |
| `item.onlyFor[].object` | string | yes |   |   |
| `item.onlyFor[].id` | string | yes |   |   |

## staffing.leave.adjust

Tool-only (a shipped pack's tool): add to or take from someone's balance of a leave type (a signed amount in the type's unit, say what the business worked out for a fortnight), with a note. Written as an entry of the ledger; nothing accrues. Someone who handles pay, a person at the screen. They are told (never the amount).

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes | min length 1, max length 64 |   |
| `type` | string | yes | min length 1, max length 64 |   |
| `amount` | integer | yes | ≥ -1000000, ≤ 1000000 |   |
| `note` | string | yes | min length 1, max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes |   |   |
| `type` | string | yes |   |   |
| `entry` | string | yes |   |   |

## staffing.leave.approve

Tool-only (a shipped pack's tool): approve a leave request, as asked or with amounts changed. Whoever approves leave, never their own. In one batch: the balance entry (for a type that keeps one; refused below zero for a type that refuses it, warned otherwise), the person away then (stage 45's unavailability), and the person taken off each shift it covers that has not started, each offered to everyone eligible. Answers which shifts were offered and which have nobody offered; the person and the rosterers are told.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |
| `amounts` | array of object |   | at most 62 | Each date's amount, in the type's unit (minutes for an hours type, hundredths of a day for a days type); the host's proposal where left out |
| `amounts[].date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `amounts[].amount` | integer | yes | ≥ 0, ≤ 9007199254740991 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `request` | object | yes |   |   |
| `request.id` | string | yes |   |   |
| `request.account` | string | yes |   |   |
| `request.name` | string | yes |   |   |
| `request.type` | object | yes |   |   |
| `request.type.id` | string | yes |   |   |
| `request.type.name` | string | yes |   |   |
| `request.type.unit` | `"hours"`, `"days"` | yes |   |   |
| `request.startDate` | string | yes |   |   |
| `request.endDate` | string | yes |   |   |
| `request.startTime` | string or null | yes |   |   |
| `request.endTime` | string or null | yes |   |   |
| `request.zone` | string | yes |   |   |
| `request.startsAt` | string | yes |   |   |
| `request.endsAt` | string | yes |   |   |
| `request.state` | `"requested"`, `"approved"`, `"declined"`, `"cancelled"` | yes |   |   |
| `request.note` | string or null | yes |   |   |
| `request.askedBy` | string | yes |   |   |
| `request.askedAt` | string | yes |   |   |
| `request.decidedBy` | string or null | yes |   |   |
| `request.decidedByName` | string or null | yes |   |   |
| `request.decidedAt` | string or null | yes |   |   |
| `request.why` | string or null | yes |   |   |
| `request.days` | array of object | yes |   |   |
| `request.days[].date` | string | yes |   |   |
| `request.days[].asked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `request.days[].approved` | integer or null | yes |   |   |
| `request.total` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | `"below_zero"` | yes |   |   |
| `warnings[].message` | string | yes |   |   |
| `offered` | array of object | yes |   |   |
| `offered[].object` | string | yes |   |   |
| `offered[].id` | string | yes |   |   |
| `offered[].title` | string | yes |   |   |
| `offered[].startsAt` | string | yes |   |   |
| `offered[].told` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `uncovered` | array of object | yes |   |   |
| `uncovered[].object` | string | yes |   |   |
| `uncovered[].id` | string | yes |   |   |
| `uncovered[].title` | string | yes |   |   |
| `uncovered[].startsAt` | string | yes |   |   |

## staffing.leave.balances

Tool-only (a shipped pack's tool): leave balances, each person's per type that keeps one, as the sum of what the business entered and the leave approved (nothing accrues), in the type's unit. Your own; whoever approves leave or handles pay reads anyone's, or everyone's when account is left out. With account and type, its history too. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string |   | min length 1, max length 64 |   |
| `type` | string |   | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].type` | object | yes |   |   |
| `items[].type.id` | string | yes |   |   |
| `items[].type.name` | string | yes |   |   |
| `items[].type.unit` | `"hours"`, `"days"` | yes |   |   |
| `items[].balance` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `history` | array of object or null | yes |   |   |
| `history.id` | string | yes |   |   |
| `history.amount` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `history.why` | `"set"`, `"adjust"`, `"approved"`, `"cancelled"` | yes |   |   |
| `history.request` | string or null | yes |   |   |
| `history.note` | string or null | yes |   |   |
| `history.by` | string | yes |   |   |
| `history.byName` | string | yes |   |   |
| `history.at` | string | yes |   |   |

## staffing.leave.cancel

Tool-only (a shipped pack's tool): cancel your own leave request: one still waiting, or an approved one that has not started (the balance is given back and you are no longer away; shifts it took you off are not given back). A person's own act.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `request` | object | yes |   |   |
| `request.id` | string | yes |   |   |
| `request.account` | string | yes |   |   |
| `request.name` | string | yes |   |   |
| `request.type` | object | yes |   |   |
| `request.type.id` | string | yes |   |   |
| `request.type.name` | string | yes |   |   |
| `request.type.unit` | `"hours"`, `"days"` | yes |   |   |
| `request.startDate` | string | yes |   |   |
| `request.endDate` | string | yes |   |   |
| `request.startTime` | string or null | yes |   |   |
| `request.endTime` | string or null | yes |   |   |
| `request.zone` | string | yes |   |   |
| `request.startsAt` | string | yes |   |   |
| `request.endsAt` | string | yes |   |   |
| `request.state` | `"requested"`, `"approved"`, `"declined"`, `"cancelled"` | yes |   |   |
| `request.note` | string or null | yes |   |   |
| `request.askedBy` | string | yes |   |   |
| `request.askedAt` | string | yes |   |   |
| `request.decidedBy` | string or null | yes |   |   |
| `request.decidedByName` | string or null | yes |   |   |
| `request.decidedAt` | string or null | yes |   |   |
| `request.why` | string or null | yes |   |   |
| `request.days` | array of object | yes |   |   |
| `request.days[].date` | string | yes |   |   |
| `request.days[].asked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `request.days[].approved` | integer or null | yes |   |   |
| `request.total` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## staffing.leave.cancelApproved

Tool-only (a shipped pack's tool): cancel someone's approved leave, saying why, while its pay period is open: the balance is given back and they are no longer away; shifts it took them off are not given back (reassign them). Whoever approves leave, never their own. They and the rosterers are told.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |
| `why` | string | yes | min length 1, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `request` | object | yes |   |   |
| `request.id` | string | yes |   |   |
| `request.account` | string | yes |   |   |
| `request.name` | string | yes |   |   |
| `request.type` | object | yes |   |   |
| `request.type.id` | string | yes |   |   |
| `request.type.name` | string | yes |   |   |
| `request.type.unit` | `"hours"`, `"days"` | yes |   |   |
| `request.startDate` | string | yes |   |   |
| `request.endDate` | string | yes |   |   |
| `request.startTime` | string or null | yes |   |   |
| `request.endTime` | string or null | yes |   |   |
| `request.zone` | string | yes |   |   |
| `request.startsAt` | string | yes |   |   |
| `request.endsAt` | string | yes |   |   |
| `request.state` | `"requested"`, `"approved"`, `"declined"`, `"cancelled"` | yes |   |   |
| `request.note` | string or null | yes |   |   |
| `request.askedBy` | string | yes |   |   |
| `request.askedAt` | string | yes |   |   |
| `request.decidedBy` | string or null | yes |   |   |
| `request.decidedByName` | string or null | yes |   |   |
| `request.decidedAt` | string or null | yes |   |   |
| `request.why` | string or null | yes |   |   |
| `request.days` | array of object | yes |   |   |
| `request.days[].date` | string | yes |   |   |
| `request.days[].asked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `request.days[].approved` | integer or null | yes |   |   |
| `request.total` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## staffing.leave.decline

Tool-only (a shipped pack's tool): decline a leave request, saying why (seen by them and whoever approves leave). Whoever approves leave, never their own. The person is told.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |
| `why` | string | yes | min length 1, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `request` | object | yes |   |   |
| `request.id` | string | yes |   |   |
| `request.account` | string | yes |   |   |
| `request.name` | string | yes |   |   |
| `request.type` | object | yes |   |   |
| `request.type.id` | string | yes |   |   |
| `request.type.name` | string | yes |   |   |
| `request.type.unit` | `"hours"`, `"days"` | yes |   |   |
| `request.startDate` | string | yes |   |   |
| `request.endDate` | string | yes |   |   |
| `request.startTime` | string or null | yes |   |   |
| `request.endTime` | string or null | yes |   |   |
| `request.zone` | string | yes |   |   |
| `request.startsAt` | string | yes |   |   |
| `request.endsAt` | string | yes |   |   |
| `request.state` | `"requested"`, `"approved"`, `"declined"`, `"cancelled"` | yes |   |   |
| `request.note` | string or null | yes |   |   |
| `request.askedBy` | string | yes |   |   |
| `request.askedAt` | string | yes |   |   |
| `request.decidedBy` | string or null | yes |   |   |
| `request.decidedByName` | string or null | yes |   |   |
| `request.decidedAt` | string or null | yes |   |   |
| `request.why` | string or null | yes |   |   |
| `request.days` | array of object | yes |   |   |
| `request.days[].date` | string | yes |   |   |
| `request.days[].asked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `request.days[].approved` | integer or null | yes |   |   |
| `request.total` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## staffing.leave.mine

Tool-only (a shipped pack's tool): your own leave requests ending on or after `from` (a local date; all of them when left out), newest first, with each date's amounts and its state. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].type` | object | yes |   |   |
| `items[].type.id` | string | yes |   |   |
| `items[].type.name` | string | yes |   |   |
| `items[].type.unit` | `"hours"`, `"days"` | yes |   |   |
| `items[].startDate` | string | yes |   |   |
| `items[].endDate` | string | yes |   |   |
| `items[].startTime` | string or null | yes |   |   |
| `items[].endTime` | string or null | yes |   |   |
| `items[].zone` | string | yes |   |   |
| `items[].startsAt` | string | yes |   |   |
| `items[].endsAt` | string | yes |   |   |
| `items[].state` | `"requested"`, `"approved"`, `"declined"`, `"cancelled"` | yes |   |   |
| `items[].note` | string or null | yes |   |   |
| `items[].askedBy` | string | yes |   |   |
| `items[].askedAt` | string | yes |   |   |
| `items[].decidedBy` | string or null | yes |   |   |
| `items[].decidedByName` | string or null | yes |   |   |
| `items[].decidedAt` | string or null | yes |   |   |
| `items[].why` | string or null | yes |   |   |
| `items[].days` | array of object | yes |   |   |
| `items[].days[].date` | string | yes |   |   |
| `items[].days[].asked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].days[].approved` | integer or null | yes |   |   |
| `items[].total` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## staffing.leave.pending

Tool-only (a shipped pack's tool): leave requests waiting for a decision, soonest first (at most 50), each with the balance after it and the shifts it covers that have not started (three named, and how many). Whoever approves leave. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].type` | object | yes |   |   |
| `items[].type.id` | string | yes |   |   |
| `items[].type.name` | string | yes |   |   |
| `items[].type.unit` | `"hours"`, `"days"` | yes |   |   |
| `items[].startDate` | string | yes |   |   |
| `items[].endDate` | string | yes |   |   |
| `items[].startTime` | string or null | yes |   |   |
| `items[].endTime` | string or null | yes |   |   |
| `items[].zone` | string | yes |   |   |
| `items[].startsAt` | string | yes |   |   |
| `items[].endsAt` | string | yes |   |   |
| `items[].state` | `"requested"`, `"approved"`, `"declined"`, `"cancelled"` | yes |   |   |
| `items[].note` | string or null | yes |   |   |
| `items[].askedBy` | string | yes |   |   |
| `items[].askedAt` | string | yes |   |   |
| `items[].decidedBy` | string or null | yes |   |   |
| `items[].decidedByName` | string or null | yes |   |   |
| `items[].decidedAt` | string or null | yes |   |   |
| `items[].why` | string or null | yes |   |   |
| `items[].days` | array of object | yes |   |   |
| `items[].days[].date` | string | yes |   |   |
| `items[].days[].asked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].days[].approved` | integer or null | yes |   |   |
| `items[].total` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].balanceAfter` | integer or null | yes |   |   |
| `items[].shifts` | array of object | yes |   |   |
| `items[].shifts[].object` | string | yes |   |   |
| `items[].shifts[].id` | string | yes |   |   |
| `items[].shifts[].title` | string | yes |   |   |
| `items[].shifts[].startsAt` | string | yes |   |   |
| `items[].shiftCount` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## staffing.leave.request

Tool-only (a shipped pack's tool): ask for leave of a type the business sets: whole days (startDate to endDate), or part of one day (startDate, startTime, endTime), local in the organisation's zone. The host proposes each date's amount from your rostered minutes that day (an hours type) or one day each (a days type); give amounts to change them. Answers the balance after and the shifts it covers; preview writes nothing. Refused into a locked pay period, over your own other leave, and below zero for a type that refuses it. Your own, a person's own act; whoever approves leave is told.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `type` | string | yes | min length 1, max length 64 |   |
| `startDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `endDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | The last whole day; leave out for one day |
| `startTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` | Part of one day: its local start |
| `endTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` | Part of one day: its local end |
| `amounts` | array of object |   | at most 62 | Each date's amount, in the type's unit (minutes for an hours type, hundredths of a day for a days type); the host's proposal where left out |
| `amounts[].date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `amounts[].amount` | integer | yes | ≥ 0, ≤ 9007199254740991 |   |
| `note` | string |   | max length 500 | Seen by you and whoever approves leave only |
| `preview` | boolean |   |   | Answer the proposed amounts, balance after and shifts covered; write nothing |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `request` | object or null | yes |   |   |
| `request.id` | string | yes |   |   |
| `request.account` | string | yes |   |   |
| `request.name` | string | yes |   |   |
| `request.type` | object | yes |   |   |
| `request.type.id` | string | yes |   |   |
| `request.type.name` | string | yes |   |   |
| `request.type.unit` | `"hours"`, `"days"` | yes |   |   |
| `request.startDate` | string | yes |   |   |
| `request.endDate` | string | yes |   |   |
| `request.startTime` | string or null | yes |   |   |
| `request.endTime` | string or null | yes |   |   |
| `request.zone` | string | yes |   |   |
| `request.startsAt` | string | yes |   |   |
| `request.endsAt` | string | yes |   |   |
| `request.state` | `"requested"`, `"approved"`, `"declined"`, `"cancelled"` | yes |   |   |
| `request.note` | string or null | yes |   |   |
| `request.askedBy` | string | yes |   |   |
| `request.askedAt` | string | yes |   |   |
| `request.decidedBy` | string or null | yes |   |   |
| `request.decidedByName` | string or null | yes |   |   |
| `request.decidedAt` | string or null | yes |   |   |
| `request.why` | string or null | yes |   |   |
| `request.days` | array of object | yes |   |   |
| `request.days[].date` | string | yes |   |   |
| `request.days[].asked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `request.days[].approved` | integer or null | yes |   |   |
| `request.total` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `proposed` | array of object | yes |   |   |
| `proposed[].date` | string | yes |   |   |
| `proposed[].amount` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `balance` | integer or null | yes |   |   |
| `balanceAfter` | integer or null | yes |   |   |
| `shifts` | array of object | yes |   |   |
| `shifts[].object` | string | yes |   |   |
| `shifts[].id` | string | yes |   |   |
| `shifts[].title` | string | yes |   |   |
| `shifts[].startsAt` | string | yes |   |   |
| `shiftCount` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | `"below_zero"` | yes |   |   |
| `warnings[].message` | string | yes |   |   |

## staffing.leave.requestFor

Tool-only (a shipped pack's tool): ask for leave for someone else (as staffing.leave.request takes it), and with approve, record it already approved in the same step (a sick day phoned in), with everything approving does. Whoever approves leave, never for themselves.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes | min length 1, max length 64 |   |
| `type` | string | yes | min length 1, max length 64 |   |
| `startDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `endDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | The last whole day; leave out for one day |
| `startTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` | Part of one day: its local start |
| `endTime` | string |   | pattern `^[0-2]\d:[0-5]\d$` | Part of one day: its local end |
| `amounts` | array of object |   | at most 62 | Each date's amount, in the type's unit (minutes for an hours type, hundredths of a day for a days type); the host's proposal where left out |
| `amounts[].date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `amounts[].amount` | integer | yes | ≥ 0, ≤ 9007199254740991 |   |
| `note` | string |   | max length 500 | Seen by you and whoever approves leave only |
| `preview` | boolean |   |   | Answer the proposed amounts, balance after and shifts covered; write nothing |
| `approve` | boolean |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `request` | object or null | yes |   |   |
| `request.id` | string | yes |   |   |
| `request.account` | string | yes |   |   |
| `request.name` | string | yes |   |   |
| `request.type` | object | yes |   |   |
| `request.type.id` | string | yes |   |   |
| `request.type.name` | string | yes |   |   |
| `request.type.unit` | `"hours"`, `"days"` | yes |   |   |
| `request.startDate` | string | yes |   |   |
| `request.endDate` | string | yes |   |   |
| `request.startTime` | string or null | yes |   |   |
| `request.endTime` | string or null | yes |   |   |
| `request.zone` | string | yes |   |   |
| `request.startsAt` | string | yes |   |   |
| `request.endsAt` | string | yes |   |   |
| `request.state` | `"requested"`, `"approved"`, `"declined"`, `"cancelled"` | yes |   |   |
| `request.note` | string or null | yes |   |   |
| `request.askedBy` | string | yes |   |   |
| `request.askedAt` | string | yes |   |   |
| `request.decidedBy` | string or null | yes |   |   |
| `request.decidedByName` | string or null | yes |   |   |
| `request.decidedAt` | string or null | yes |   |   |
| `request.why` | string or null | yes |   |   |
| `request.days` | array of object | yes |   |   |
| `request.days[].date` | string | yes |   |   |
| `request.days[].asked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `request.days[].approved` | integer or null | yes |   |   |
| `request.total` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `proposed` | array of object | yes |   |   |
| `proposed[].date` | string | yes |   |   |
| `proposed[].amount` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `balance` | integer or null | yes |   |   |
| `balanceAfter` | integer or null | yes |   |   |
| `shifts` | array of object | yes |   |   |
| `shifts[].object` | string | yes |   |   |
| `shifts[].id` | string | yes |   |   |
| `shifts[].title` | string | yes |   |   |
| `shifts[].startsAt` | string | yes |   |   |
| `shiftCount` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | `"below_zero"` | yes |   |   |
| `warnings[].message` | string | yes |   |   |
| `offered` | array of object | yes |   |   |
| `offered[].object` | string | yes |   |   |
| `offered[].id` | string | yes |   |   |
| `offered[].title` | string | yes |   |   |
| `offered[].startsAt` | string | yes |   |   |
| `offered[].told` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `uncovered` | array of object | yes |   |   |
| `uncovered[].object` | string | yes |   |   |
| `uncovered[].id` | string | yes |   |   |
| `uncovered[].title` | string | yes |   |   |
| `uncovered[].startsAt` | string | yes |   |   |

## staffing.leave.saveType

Tool-only (a shipped pack's tool): add a kind of leave (leave out id) or change one. Someone who handles pay; an AI's draft waits for them. A type's unit never changes once leave or a balance is recorded in it; a type no longer offered is made inactive, never removed. Which types a business must offer is for it to confirm with its accountant or lawyer.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string |   | min length 1, max length 64 |   |
| `name` | string | yes | min length 1, max length 80 |   |
| `unit` | `"hours"`, `"days"` | yes |   |   |
| `keepsBalance` | boolean | yes |   |   |
| `belowZero` | `"warn"`, `"refuse"` |   | default `"warn"` |   |
| `paid` | boolean | yes |   |   |
| `active` | boolean |   | default `true` |   |
| `position` | integer |   | ≥ 0, ≤ 1000, default `0` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `type` | object | yes |   |   |
| `type.id` | string | yes |   |   |
| `type.name` | string | yes |   |   |
| `type.unit` | `"hours"`, `"days"` | yes |   |   |
| `type.keepsBalance` | boolean | yes |   |   |
| `type.belowZero` | `"warn"`, `"refuse"` | yes |   |   |
| `type.paid` | boolean | yes |   |   |
| `type.active` | boolean | yes |   |   |
| `type.position` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `created` | boolean | yes |   |   |

## staffing.leave.setBalance

Tool-only (a shipped pack's tool): set someone's balance of a leave type to an amount (an opening balance), in the type's unit (minutes for an hours type, hundredths of a day for a days type), with a note. Written as an entry of the ledger; nothing accrues. Someone who handles pay, a person at the screen. They are told (never the amount).

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes | min length 1, max length 64 |   |
| `type` | string | yes | min length 1, max length 64 |   |
| `amount` | integer | yes | ≥ -1000000, ≤ 1000000 |   |
| `note` | string | yes | min length 1, max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes |   |   |
| `type` | string | yes |   |   |
| `entry` | string | yes |   |   |

## staffing.leave.types

Tool-only (a shipped pack's tool): the kinds of leave the business offers (none ship), in order: each one's name, unit (hours or days), whether it keeps a balance and what a balance below zero does (warn or refuse), and whether it is paid. Inactive ones only when asked. Anyone on the team reads them. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `inactive` | boolean |   |   | Include types no longer offered |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].unit` | `"hours"`, `"days"` | yes |   |   |
| `items[].keepsBalance` | boolean | yes |   |   |
| `items[].belowZero` | `"warn"`, `"refuse"` | yes |   |   |
| `items[].paid` | boolean | yes |   |   |
| `items[].active` | boolean | yes |   |   |
| `items[].position` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## staffing.markNotWorked

Tool-only (a shipped pack's tool): mark a shift that has started as not worked, with why (nobody ran the class), so it counts for nothing in its pay period; or clear the mark (notWorked false). Someone who rosters; an AI's request waits for a person. A shift inside a locked pay period is refused until the period is reopened.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `notWorked` | boolean |   | default `true` |   |
| `reason` | string |   | min length 1, max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `notWorked` | boolean | yes |   |   |
| `changed` | boolean | yes |   |   |

## staffing.me

Tool-only (a shipped pack's tool): who is reading the roster and what the host lets them do: their account and name, whether they roster others, whether they handle pay, the organisation's zone and today's local date there, and the offer cut-off in minutes. A screen shows the rosterers' and pay controls from this answer, never by guessing. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes |   |   |
| `name` | string | yes |   |   |
| `rosters` | boolean | yes |   | May put people on shifts and see the warnings |
| `pays` | boolean | yes |   | Handles pay (a person only) |
| `zone` | string | yes |   |   |
| `today` | string | yes |   | Today's local date in the organisation's zone |
| `cutoffMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `uncoveredDays` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## staffing.myPay

Tool-only (a shipped pack's tool): the caller's own totals for one pay period (the current one when start is left out): how they are counted (by time, by class, or not counted), their shifts and hours per kind of work, and their own lines, each with its minutes and whether it was marked not worked. Worked out exactly as the pay totals are: a locked period's locked lines, or a preview of an open one, which may still change. Nothing about anyone else. The person themselves only, never an assistant. Read-only; audited as a read, without its figures.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `start` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | The period's first day |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `period` | object | yes |   |   |
| `period.start` | string | yes |   |   |
| `period.end` | string | yes |   |   |
| `period.zone` | string | yes |   |   |
| `period.ended` | boolean | yes |   |   |
| `period.locked` | boolean | yes |   |   |
| `period.preview` | boolean | yes |   | Not locked: worked out now, and may still change |
| `period.version` | integer or null | yes |   |   |
| `counted` | boolean | yes |   |   |
| `basis` | `"by_time"`, `"by_class"`, `"not_counted"` | yes |   | How they are counted: on the period's last day, or today while it runs |
| `totals` | array of object | yes |   |   |
| `totals[].basis` | `"by_time"`, `"by_class"` | yes |   |   |
| `totals[].kind` | object or null | yes |   |   |
| `totals[].kind.object` | string | yes |   |   |
| `totals[].kind.id` | string | yes |   |   |
| `totals[].kindName` | string | yes |   |   |
| `totals[].shifts` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `totals[].minutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `totals[].hours` | string | yes |   | Minutes ÷ 60, rounded half up to two places |
| `totals[].notWorked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `totals[].flagged` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
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
| `lines[].shiftMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `lines[].beforeMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `lines[].afterMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `lines[].countedMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `lines[].notWorked` | boolean | yes |   | Marked not worked by whoever rosters: it counts for nothing |
| `lines[].listTaken` | boolean or null | yes |   | Null: this kind of shift keeps no list |
| `lines[].flagged` | boolean | yes |   | Someone other than you took its list: whoever handles pay checks it |
| `lines[].clockChange` | string or null | yes |   | It crosses a clock change: its minutes are the time worked |
| `minutes` | integer or null | yes |   |   |
| `hours` | string or null | yes |   |   |

## staffing.myPay.periods

Tool-only (a shipped pack's tool): the pay periods a person may look up their own hours for: the current one and the twelve before it (fewer with count), each with its dates and whether it is open or locked. Nothing about who is counted. The person themselves only, never an assistant. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `count` | integer |   | ≥ 1, ≤ 12 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `set` | boolean | yes |   |   |
| `periods` | array of object | yes |   |   |
| `periods[].start` | string | yes |   |   |
| `periods[].end` | string | yes |   |   |
| `periods[].zone` | string | yes |   |   |
| `periods[].state` | `"open"`, `"locked"` | yes |   |   |
| `periods[].ended` | boolean | yes |   |   |
| `periods[].version` | integer or null | yes |   | The locked version; null when open |

## staffing.offer

Tool-only (a shipped pack's tool): offer a shift for someone else to take, to everyone eligible (qualified for its kind, free and available) or to one named person. The shift's person offers their own; someone who rosters may offer anyone's, and an uncovered one. A person's own act. Until it is taken the shift stays its person's. Offers close at the cut-off (the Rostering setting, 60 minutes before the shift starts by default). Eligible people are told.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `to` | string |   | min length 1, max length 64 | Offer it to this person only |

### Output

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
| `told` | integer or null | yes |   |   |

## staffing.offers

Tool-only (a shipped pack's tool): the open offers you could take now (qualified, free, before the cut-off; `unavailable` says you said you are away then), and your own open offers. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

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

## staffing.patterns

Tool-only (a shipped pack's tool): the regular week, for someone who rosters: every series that makes shifts (class series, duty series) that has not ended, with its weekdays, local time, length, dates, zone, kind of work and its regular person (or nobody). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `patterns` | array of object | yes |   |   |
| `patterns[].object` | string | yes |   | The series' object: a class series or a duty series |
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
| `patterns[].noAccount` | boolean | yes |   | Its person has no staff account (a visiting coach) |
| `truncated` | boolean | yes |   |   |

## staffing.payBases

Tool-only (a shipped pack's tool): who is counted for pay and how, by time, by class or not counted, today and from which dates; everyone with a basis set (account: one person). Someone who handles pay, a person only. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string |   | min length 1, max length 64 |   |
| `everyone` | boolean |   |   | Also every active member of staff with no basis set (not counted) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `today` | string | yes |   |   |
| `items` | array of object | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].basis` | `"by_time"`, `"by_class"`, `"not_counted"` | yes |   | In force today |
| `items[].history` | array of object | yes |   |   |
| `items[].history[].from` | string | yes |   |   |
| `items[].history[].basis` | `"by_time"`, `"by_class"`, `"not_counted"` | yes |   |   |
| `items[].history[].setBy` | string | yes |   |   |
| `items[].history[].setAt` | string | yes |   |   |
| `truncated` | boolean | yes |   | More than 2,000 rows: ask for one person's (account) |

## staffing.payBasis

Tool-only (a shipped pack's tool): say how a member of staff is counted for pay from a local date on (today when left out): by_time (their hours), by_class (their classes and shifts), or not_counted (salaried; the default for everyone). No rates are held. Someone who handles pay, a person only. A date inside a locked pay period is refused.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes | min length 1, max length 64 |   |
| `basis` | `"by_time"`, `"by_class"`, `"not_counted"` | yes |   |   |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | In force from this local date; today when left out |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes |   |   |
| `from` | string | yes |   |   |
| `changed` | boolean | yes |   |   |

## staffing.payPeriod.export

Tool-only (a shipped pack's tool): a pay period as a CSV file for payroll: a summary, one row per person and kind of work (period start and end, name, staff email, basis, kind, shifts, hours as a decimal and in minutes), then one row per shift (date, start, end, kind, place, minutes counted, why not worked, the list's evidence). From the locked version, or a preview of an open period, marked as such. No rates and no money. Someone who handles pay, a person only; audited as a read, without its figures.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `start` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` | The period's first day |
| `version` | integer |   | ≥ 1, ≤ 9007199254740991 | A locked or reopened version |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filename` | string | yes |   |   |
| `contentType` | `"text/csv"` | yes |   |   |
| `csv` | string | yes |   |   |
| `locked` | boolean | yes |   |   |
| `version` | integer or null | yes |   |   |

## staffing.payPeriod.list

Tool-only (a shipped pack's tool): the pay periods, from the setting (weekly, fortnightly by default, or monthly, in the organisation's zone): the current one and the `count` before it (6 when left out), each open or locked, with its locked and reopened versions. Someone who handles pay, a person only. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `count` | integer |   | ≥ 1, ≤ 60 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `setting` | object | yes |   |   |
| `setting.period` | `"weekly"`, `"fortnightly"`, `"monthly"` | yes |   |   |
| `setting.start` | string or null | yes |   |   |
| `setting.day` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `setting.zone` | string | yes |   |   |
| `set` | boolean | yes |   |   |
| `periods` | array of object | yes |   |   |
| `periods[].start` | string | yes |   |   |
| `periods[].end` | string | yes |   |   |
| `periods[].zone` | string | yes |   |   |
| `periods[].state` | `"open"`, `"locked"` | yes |   |   |
| `periods[].ended` | boolean | yes |   |   |
| `periods[].versions` | array of object | yes |   |   |
| `periods[].versions[].id` | string | yes |   |   |
| `periods[].versions[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `periods[].versions[].state` | `"locked"`, `"reopened"` | yes |   |   |
| `periods[].versions[].lockedBy` | string | yes |   |   |
| `periods[].versions[].lockedByName` | string | yes |   |   |
| `periods[].versions[].lockedAt` | string | yes |   |   |
| `periods[].versions[].reopenedBy` | string or null | yes |   |   |
| `periods[].versions[].reopenedAt` | string or null | yes |   |   |
| `periods[].versions[].reopenReason` | string or null | yes |   |   |

## staffing.payPeriod.lock

Tool-only (a shipped pack's tool): lock a pay period that has ended: its lines and totals are written as the roster stands now (correct it first: reassign, mark not worked) and never change; a change to a shift inside it is refused until it is reopened. Locking a reopened period again makes a new version and keeps the old. Someone who handles pay, a person only. Refused when anything it read changed meanwhile.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `start` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` | The period's first day |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `start` | string | yes |   |   |
| `end` | string | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## staffing.payPeriod.reopen

Tool-only (a shipped pack's tool): reopen a locked pay period, with why: its shifts can be corrected again, and its locked version is kept as it was. Lock it again for a new version. Someone who handles pay, a person only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `start` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` | The period's first day |
| `reason` | string | yes | min length 1, max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `start` | string | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## staffing.payPeriod.totals

Tool-only (a shipped pack's tool): one pay period's totals, per counted person and kind of work (shifts, and hours as whole minutes), and its lines, one per shift, with the evidence beside each (its list taken and by whom, flagged when not by its person). A locked period gives its locked lines; an open one is worked out from the roster as it stands (a preview, which may still change). Someone who handles pay, a person only. Read-only; audited as a read, without its figures.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `start` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` | The period's first day |
| `version` | integer |   | ≥ 1, ≤ 9007199254740991 | A locked or reopened version |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `period` | object | yes |   |   |
| `period.start` | string | yes |   |   |
| `period.end` | string | yes |   |   |
| `period.zone` | string | yes |   |   |
| `period.locked` | boolean | yes |   |   |
| `period.preview` | boolean | yes |   | Not locked: worked out now, and may still change |
| `period.version` | object or null | yes |   |   |
| `period.version.id` | string | yes |   |   |
| `period.version.version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
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
| `totals[].shifts` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `totals[].minutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `totals[].hours` | string | yes |   | Minutes ÷ 60, rounded half up to two places |
| `totals[].notWorked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `totals[].flagged` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
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
| `lines[].shiftMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `lines[].beforeMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `lines[].afterMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `lines[].countedMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `lines[].counted` | boolean | yes |   |   |
| `lines[].notWorkedReason` | string or null | yes |   |   |
| `lines[].listTaken` | boolean or null | yes |   | Null: this kind of shift keeps no list |
| `lines[].markedBy` | string or null | yes |   | Who took its list |
| `lines[].flagged` | boolean | yes |   | Someone other than its person took its list: review it |
| `minutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `hours` | string | yes |   |   |

## staffing.people

Tool-only (a shipped pack's tool): the active members of staff, and every kind of work a shift can be of (each class type, each duty), for someone who rosters to say who may do which. Names only. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

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

## staffing.planCheck

Tool-only (a shipped pack's tool): the dry run of rostering patterns and one-off shifts before they are made (`cos rostering import`), for someone who rosters. For each plan (a weekly pattern from its first date to the horizon, or one dated shift), the dates it would make and, for its person, each date that would clash with a shift they are on or with an earlier plan in the same check (title and start; `ended` when both have ended: reported, never refused), and the dates they would be warned about (away, not qualified). The same clash check the writes and the reconcile make. Writes nothing.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `plans` | array of object | yes | at least 1, at most 1000 |   |
| `plans[].key` | string |   | max length 80 | The caller's name for it (a CSV row) |
| `plans[].kind` | object or null |   |   |   |
| `plans[].kind.object` | string | yes | min length 1, max length 81 |   |
| `plans[].kind.id` | string | yes | min length 1, max length 64 |   |
| `plans[].account` | string or null | yes |   |   |
| `plans[].weekdays` | array of `"mon"`, `"tue"`, `"wed"`, `"thu"`, `"fri"`, `"sat"`, `"sun"` |   | at least 1, at most 7 | A weekly pattern's days |
| `plans[].date` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | A one-off shift's local date |
| `plans[].time` | string | yes | pattern `^[0-2]\d:[0-5]\d$` |   |
| `plans[].length` | integer | yes | ≥ 1, ≤ 1440 |   |
| `plans[].firstDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `plans[].lastDate` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `plans[].zone` | string |   | min length 1, max length 64 |   |
| `horizonDays` | integer |   | ≥ 1, ≤ 366 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `plans` | array of object | yes |   |   |
| `plans[].key` | string or null | yes |   |   |
| `plans[].dates` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `plans[].clashes` | array of object | yes |   |   |
| `plans[].clashes[].date` | string | yes |   |   |
| `plans[].clashes[].startsAt` | string | yes |   |   |
| `plans[].clashes[].other` | object | yes |   |   |
| `plans[].clashes[].other.title` | string | yes |   |   |
| `plans[].clashes[].other.startsAt` | string | yes |   |   |
| `plans[].clashes[].other.endsAt` | string | yes |   |   |
| `plans[].clashes[].ended` | boolean | yes |   |   |
| `plans[].away` | array of string | yes |   | Dates the person said they are away |
| `plans[].notQualified` | boolean | yes |   |   |
| `plans[].first` | object or null | yes |   | Its first dated shift, as the host places it in its zone |
| `plans[].first.date` | string | yes |   |   |
| `plans[].first.startsAt` | string | yes |   |   |
| `plans[].first.endsAt` | string | yes |   |   |
| `truncated` | boolean | yes |   |   |

## staffing.qualifications

Tool-only (a shipped pack's tool): who may do which kind of work. Someone who rosters reads anyone's (all of them when account is left out); anyone else reads only their own. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string |   | min length 1, max length 64 |   |
| `kindObject` | string |   | min length 1, max length 81 |   |

### Output

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

## staffing.qualify

Tool-only (a shipped pack's tool): say whether a staff account may do a kind of work (a class type, a duty). Only someone who rosters; an AI's request waits for a person. A qualified person may take an offered shift of that kind without anybody approving; rostering someone not qualified is made with a not_qualified warning. Returns whether it changed anything.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes | min length 1, max length 64 |   |
| `kind` | object | yes |   |   |
| `kind.object` | string | yes | min length 1, max length 81 |   |
| `kind.id` | string | yes | min length 1, max length 64 |   |
| `qualified` | boolean |   | default `true` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes |   |   |
| `kind` | object | yes |   |   |
| `kind.object` | string | yes |   |   |
| `kind.id` | string | yes |   |   |
| `qualified` | boolean | yes |   |   |
| `changed` | boolean | yes |   |   |

## staffing.setPattern

Tool-only (a shipped pack's tool): change a weekly pattern's regular person (a class series' coach, a duty series' person), or nobody (null), from a local date (today when left out). Someone who rosters; an AI's request waits for a person. The shifts from that date follow, except those that keep their own person; refused whole when it would put the person on two shifts at once on any date (double_booked, naming the dates). Returns the series.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 | The series' object (bookings.series, rostering.dutyseries) |
| `id` | string | yes | min length 1, max length 64 |   |
| `account` | string or null | yes |   |   |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `account` | string or null | yes |   |   |
| `from` | string | yes |   |   |

## staffing.take

Tool-only (a shipped pack's tool): take an offered shift. Nobody approves it, because the taker must be qualified for its kind (refused otherwise), free (refused as double_booked) and taking it before the cut-off; someone away then is told and confirms with confirmUnavailable. A person's own act. Exactly one of several takes at once wins; the others are told who took it. The shift becomes the taker's, its offerer and the rosterers are told.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `offer` | string | yes | min length 1, max length 64 |   |
| `confirmUnavailable` | boolean |   |   | You said you are not available then and take it anyway |

### Output

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
| `warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"` | yes |   |   |
| `warnings[].object` | string | yes |   |   |
| `warnings[].id` | string | yes |   |   |
| `warnings[].account` | string or null | yes |   |   |
| `warnings[].message` | string | yes |   |   |

## staffing.time.approve

Tool-only (a shipped pack's tool): approve time entries that wait (ids, up to 100), as they are or, for those named in `changes`, changed: startsAt and endsAt (local date-times in zone, the entry's own if left out) and the break minutes. The times as recorded are kept beside the approved ones. Whoever approves time, never their own entries. All or none: an entry changed meanwhile fails the whole call. The person is told when their time was approved changed. Returns the approved entries.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string | yes | at least 1, at most 100 |   |
| `changes` | array of object |   | at most 100 |   |
| `changes[].id` | string | yes | min length 1, max length 64 |   |
| `changes[].startsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `changes[].endsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `changes[].zone` | string |   | min length 1, max length 64 |   |
| `changes[].breakMinutes` | integer |   | ≥ 0, ≤ 600 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `approved` | array of object | yes |   |   |
| `approved[].id` | string | yes |   |   |
| `approved[].account` | string | yes |   |   |
| `approved[].state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `approved[].how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `approved[].startsAt` | string | yes |   |   |
| `approved[].endsAt` | string or null | yes |   |   |
| `approved[].breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `approved[].minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `approved[].zone` | string | yes |   |   |
| `approved[].localDate` | string | yes |   |   |
| `approved[].against` | object or null | yes |   | A shift, a job, or null for other work |
| `approved[].against.object` | string | yes |   |   |
| `approved[].against.id` | string | yes |   |   |
| `approved[].against.title` | string | yes |   |   |
| `approved[].against.shift` | boolean | yes |   |   |
| `approved[].finishMissing` | boolean | yes |   |   |
| `approved[].note` | string or null | yes |   |   |
| `approved[].rejectedWhy` | string or null | yes |   |   |
| `approved[].approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `approved[].approval.by` | `"host"`, `"approver"` | yes |   |   |
| `approved[].approval.at` | string | yes |   |   |
| `approved[].recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `approved[].recorded.startsAt` | string | yes |   |   |
| `approved[].recorded.endsAt` | string | yes |   |   |
| `approved[].recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `approved[].reopenedWhy` | string or null | yes |   |   |

## staffing.time.clockIn

Tool-only (a shipped pack's tool): start recording the time you work, now (the host's clock; no time is taken from the request). against: one of your own shifts, a job (a record that declares workedOn) or null for other work; left out, your own shift under way or starting within 60 minutes is proposed (the answer says so, to show 'not this shift'). One open entry at a time. key: an idempotency key, so a start retried on a weak connection makes one entry. A person's own act, never an assistant's. Returns the entry.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `against` | object or null |   |   |   |
| `against.object` | string | yes | min length 1, max length 81 |   |
| `against.id` | string | yes | min length 1, max length 64 |   |
| `key` | string |   | pattern `^[A-Za-z0-9._:-]{16,128}$` | An idempotency key: the same key returns the entry it made |
| `note` | string |   | max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `entry` | object | yes |   |   |
| `entry.id` | string | yes |   |   |
| `entry.account` | string | yes |   |   |
| `entry.state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `entry.how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `entry.startsAt` | string | yes |   |   |
| `entry.endsAt` | string or null | yes |   |   |
| `entry.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `entry.zone` | string | yes |   |   |
| `entry.localDate` | string | yes |   |   |
| `entry.against` | object or null | yes |   | A shift, a job, or null for other work |
| `entry.against.object` | string | yes |   |   |
| `entry.against.id` | string | yes |   |   |
| `entry.against.title` | string | yes |   |   |
| `entry.against.shift` | boolean | yes |   |   |
| `entry.finishMissing` | boolean | yes |   |   |
| `entry.note` | string or null | yes |   |   |
| `entry.rejectedWhy` | string or null | yes |   |   |
| `entry.approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `entry.approval.by` | `"host"`, `"approver"` | yes |   |   |
| `entry.approval.at` | string | yes |   |   |
| `entry.recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `entry.recorded.startsAt` | string | yes |   |   |
| `entry.recorded.endsAt` | string | yes |   |   |
| `entry.recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.reopenedWhy` | string or null | yes |   |   |
| `proposed` | boolean | yes |   |   |
| `replayed` | boolean | yes |   |   |

## staffing.time.clockOut

Tool-only (a shipped pack's tool): finish the entry you started, now (the host's clock), with the unpaid break minutes you took. Approved by the host when it matches your shift within the tolerance (5 minutes by default); otherwise it waits for an approver. For an entry whose finish is missing (you forgot), enter the time you finished with staffing.time.edit instead. A person's own act. Returns the entry.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `breakMinutes` | integer |   | ≥ 0, ≤ 600 |   |
| `note` | string |   | max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `entry` | object | yes |   |   |
| `entry.id` | string | yes |   |   |
| `entry.account` | string | yes |   |   |
| `entry.state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `entry.how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `entry.startsAt` | string | yes |   |   |
| `entry.endsAt` | string or null | yes |   |   |
| `entry.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `entry.zone` | string | yes |   |   |
| `entry.localDate` | string | yes |   |   |
| `entry.against` | object or null | yes |   | A shift, a job, or null for other work |
| `entry.against.object` | string | yes |   |   |
| `entry.against.id` | string | yes |   |   |
| `entry.against.title` | string | yes |   |   |
| `entry.against.shift` | boolean | yes |   |   |
| `entry.finishMissing` | boolean | yes |   |   |
| `entry.note` | string or null | yes |   |   |
| `entry.rejectedWhy` | string or null | yes |   |   |
| `entry.approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `entry.approval.by` | `"host"`, `"approver"` | yes |   |   |
| `entry.approval.at` | string | yes |   |   |
| `entry.recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `entry.recorded.startsAt` | string | yes |   |   |
| `entry.recorded.endsAt` | string | yes |   |   |
| `entry.recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.reopenedWhy` | string or null | yes |   |   |

## staffing.time.differences

Tool-only (a shipped pack's tool): the roster beside what was recorded, from `from` to `to` (local dates of each start, at most 62 days): each entry with the minutes it started and finished early or late against its shift and whether that is within the tolerance; unrostered entries (a job, other work); entries over 12 hours; and each past shift of someone counted by time with nothing recorded on it (not recorded). An approver reads everyone's (or one account's); anyone else reads their own only. Nothing about why. A person at the screen. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `account` | string |   | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string | yes |   |   |
| `to` | string | yes |   |   |
| `tolerance` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items` | array of object | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].entry` | object or null | yes |   | null for a shift with nothing recorded |
| `items[].entry.id` | string | yes |   |   |
| `items[].entry.account` | string | yes |   |   |
| `items[].entry.state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `items[].entry.how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `items[].entry.startsAt` | string | yes |   |   |
| `items[].entry.endsAt` | string or null | yes |   |   |
| `items[].entry.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].entry.minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `items[].entry.zone` | string | yes |   |   |
| `items[].entry.localDate` | string | yes |   |   |
| `items[].entry.against` | object or null | yes |   | A shift, a job, or null for other work |
| `items[].entry.against.object` | string | yes |   |   |
| `items[].entry.against.id` | string | yes |   |   |
| `items[].entry.against.title` | string | yes |   |   |
| `items[].entry.against.shift` | boolean | yes |   |   |
| `items[].entry.finishMissing` | boolean | yes |   |   |
| `items[].entry.approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `items[].entry.approval.by` | `"host"`, `"approver"` | yes |   |   |
| `items[].entry.approval.at` | string | yes |   |   |
| `items[].entry.recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `items[].entry.recorded.startsAt` | string | yes |   |   |
| `items[].entry.recorded.endsAt` | string | yes |   |   |
| `items[].entry.recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].shift` | object or null | yes |   | The shift as rostered, or null for time with no live shift of theirs |
| `items[].shift.object` | string | yes |   |   |
| `items[].shift.id` | string | yes |   |   |
| `items[].shift.title` | string | yes |   |   |
| `items[].shift.startsAt` | string | yes |   |   |
| `items[].shift.endsAt` | string | yes |   |   |
| `items[].startMinutes` | integer or null | yes |   | Whole minutes it started after the shift (negative: before) |
| `items[].finishMinutes` | integer or null | yes |   | Whole minutes it finished after the shift (negative: before) |
| `items[].matches` | boolean | yes |   | Within the tolerance at both ends |
| `items[].notRecorded` | boolean | yes |   | A past shift of someone counted by time with no entry |
| `items[].unrostered` | boolean | yes |   | An entry with no live shift of theirs: a job or other work |
| `items[].long` | boolean | yes |   | An entry over 12 hours |

## staffing.time.edit

Tool-only (a shipped pack's tool): correct one of your own entries before it is approved (open, waiting or rejected): what it was against (null: other work), the break minutes, the note, and for a finished entry its startsAt and endsAt (local date-times in zone). For an open entry whose finish is missing, endsAt enters the time you finished. A rejected entry corrected waits for an approver again (or is approved by the host when it now matches its shift). Changing a clocked entry's times makes it entered. A person's own act. Returns the entry.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |
| `startsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `endsAt` | string |   | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `zone` | string |   | min length 1, max length 64 |   |
| `breakMinutes` | integer |   | ≥ 0, ≤ 600 |   |
| `against` | object or null |   |   |   |
| `against.object` | string | yes | min length 1, max length 81 |   |
| `against.id` | string | yes | min length 1, max length 64 |   |
| `note` | string or null |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `entry` | object | yes |   |   |
| `entry.id` | string | yes |   |   |
| `entry.account` | string | yes |   |   |
| `entry.state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `entry.how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `entry.startsAt` | string | yes |   |   |
| `entry.endsAt` | string or null | yes |   |   |
| `entry.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `entry.zone` | string | yes |   |   |
| `entry.localDate` | string | yes |   |   |
| `entry.against` | object or null | yes |   | A shift, a job, or null for other work |
| `entry.against.object` | string | yes |   |   |
| `entry.against.id` | string | yes |   |   |
| `entry.against.title` | string | yes |   |   |
| `entry.against.shift` | boolean | yes |   |   |
| `entry.finishMissing` | boolean | yes |   |   |
| `entry.note` | string or null | yes |   |   |
| `entry.rejectedWhy` | string or null | yes |   |   |
| `entry.approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `entry.approval.by` | `"host"`, `"approver"` | yes |   |   |
| `entry.approval.at` | string | yes |   |   |
| `entry.recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `entry.recorded.startsAt` | string | yes |   |   |
| `entry.recorded.endsAt` | string | yes |   |   |
| `entry.recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.reopenedWhy` | string or null | yes |   |   |

## staffing.time.enter

Tool-only (a shipped pack's tool): enter time you worked afterwards (you forgot, or had no signal on a site): startsAt and endsAt, local date-times in zone (the organisation's if left out), the unpaid break minutes, and what it was against (one of your own shifts, a job, or null for other work). Up to the setting's days back (14 by default), never in a locked pay period, never overlapping another of your entries. Approved by the host when it matches your shift within the tolerance; otherwise it waits for an approver. A person's own act. Returns the entry.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `startsAt` | string | yes | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `endsAt` | string | yes | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `zone` | string |   | min length 1, max length 64 |   |
| `breakMinutes` | integer |   | ≥ 0, ≤ 600 |   |
| `against` | object or null |   |   |   |
| `against.object` | string | yes | min length 1, max length 81 |   |
| `against.id` | string | yes | min length 1, max length 64 |   |
| `note` | string |   | max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `entry` | object | yes |   |   |
| `entry.id` | string | yes |   |   |
| `entry.account` | string | yes |   |   |
| `entry.state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `entry.how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `entry.startsAt` | string | yes |   |   |
| `entry.endsAt` | string or null | yes |   |   |
| `entry.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `entry.zone` | string | yes |   |   |
| `entry.localDate` | string | yes |   |   |
| `entry.against` | object or null | yes |   | A shift, a job, or null for other work |
| `entry.against.object` | string | yes |   |   |
| `entry.against.id` | string | yes |   |   |
| `entry.against.title` | string | yes |   |   |
| `entry.against.shift` | boolean | yes |   |   |
| `entry.finishMissing` | boolean | yes |   |   |
| `entry.note` | string or null | yes |   |   |
| `entry.rejectedWhy` | string or null | yes |   |   |
| `entry.approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `entry.approval.by` | `"host"`, `"approver"` | yes |   |   |
| `entry.approval.at` | string | yes |   |   |
| `entry.recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `entry.recorded.startsAt` | string | yes |   |   |
| `entry.recorded.endsAt` | string | yes |   |   |
| `entry.recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.reopenedWhy` | string or null | yes |   |   |

## staffing.time.enterFor

Tool-only (a shipped pack's tool): enter time someone else worked (they forgot, or have no phone), saying why: account, startsAt and endsAt (local date-times in zone, the organisation's if left out), the unpaid break minutes, and what it was against (one of their shifts, a job, or null for other work). Up to the setting's days back, never in a locked pay period. It waits, never approved by the host on a match; whoever entered it may approve it (it is not their own time). Whoever approves time. Returns the entry.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `account` | string | yes | min length 1, max length 64 |   |
| `startsAt` | string | yes | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `endsAt` | string | yes | pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$` |   |
| `zone` | string |   | min length 1, max length 64 |   |
| `breakMinutes` | integer |   | ≥ 0, ≤ 600 |   |
| `against` | object or null |   |   |   |
| `against.object` | string | yes | min length 1, max length 81 |   |
| `against.id` | string | yes | min length 1, max length 64 |   |
| `note` | string |   | max length 500 |   |
| `why` | string | yes | min length 1, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `entry` | object | yes |   |   |
| `entry.id` | string | yes |   |   |
| `entry.account` | string | yes |   |   |
| `entry.state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `entry.how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `entry.startsAt` | string | yes |   |   |
| `entry.endsAt` | string or null | yes |   |   |
| `entry.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `entry.zone` | string | yes |   |   |
| `entry.localDate` | string | yes |   |   |
| `entry.against` | object or null | yes |   | A shift, a job, or null for other work |
| `entry.against.object` | string | yes |   |   |
| `entry.against.id` | string | yes |   |   |
| `entry.against.title` | string | yes |   |   |
| `entry.against.shift` | boolean | yes |   |   |
| `entry.finishMissing` | boolean | yes |   |   |
| `entry.note` | string or null | yes |   |   |
| `entry.rejectedWhy` | string or null | yes |   |   |
| `entry.approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `entry.approval.by` | `"host"`, `"approver"` | yes |   |   |
| `entry.approval.at` | string | yes |   |   |
| `entry.recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `entry.recorded.startsAt` | string | yes |   |   |
| `entry.recorded.endsAt` | string | yes |   |   |
| `entry.recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.reopenedWhy` | string or null | yes |   |   |

## staffing.time.mine

Tool-only (a shipped pack's tool): your own time: the entry you have open, the shift a start would propose now, and your entries from `from` to `to` (local dates of their start, default the last 14 days; at most 62 days). Yours only. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `open` | object or null | yes |   |   |
| `open.id` | string | yes |   |   |
| `open.account` | string | yes |   |   |
| `open.state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `open.how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `open.startsAt` | string | yes |   |   |
| `open.endsAt` | string or null | yes |   |   |
| `open.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `open.minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `open.zone` | string | yes |   |   |
| `open.localDate` | string | yes |   |   |
| `open.against` | object or null | yes |   | A shift, a job, or null for other work |
| `open.against.object` | string | yes |   |   |
| `open.against.id` | string | yes |   |   |
| `open.against.title` | string | yes |   |   |
| `open.against.shift` | boolean | yes |   |   |
| `open.finishMissing` | boolean | yes |   |   |
| `open.note` | string or null | yes |   |   |
| `open.rejectedWhy` | string or null | yes |   |   |
| `open.approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `open.approval.by` | `"host"`, `"approver"` | yes |   |   |
| `open.approval.at` | string | yes |   |   |
| `open.recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `open.recorded.startsAt` | string | yes |   |   |
| `open.recorded.endsAt` | string | yes |   |   |
| `open.recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `open.reopenedWhy` | string or null | yes |   |   |
| `proposed` | object or null | yes |   |   |
| `proposed.object` | string | yes |   |   |
| `proposed.id` | string | yes |   |   |
| `proposed.title` | string | yes |   |   |
| `proposed.startsAt` | string | yes |   |   |
| `proposed.endsAt` | string | yes |   |   |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `items[].how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `items[].startsAt` | string | yes |   |   |
| `items[].endsAt` | string or null | yes |   |   |
| `items[].breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `items[].zone` | string | yes |   |   |
| `items[].localDate` | string | yes |   |   |
| `items[].against` | object or null | yes |   | A shift, a job, or null for other work |
| `items[].against.object` | string | yes |   |   |
| `items[].against.id` | string | yes |   |   |
| `items[].against.title` | string | yes |   |   |
| `items[].against.shift` | boolean | yes |   |   |
| `items[].finishMissing` | boolean | yes |   |   |
| `items[].note` | string or null | yes |   |   |
| `items[].rejectedWhy` | string or null | yes |   |   |
| `items[].approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `items[].approval.by` | `"host"`, `"approver"` | yes |   |   |
| `items[].approval.at` | string | yes |   |   |
| `items[].recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `items[].recorded.startsAt` | string | yes |   |   |
| `items[].recorded.endsAt` | string | yes |   |   |
| `items[].recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].reopenedWhy` | string or null | yes |   |   |

## staffing.time.reject

Tool-only (a shipped pack's tool): send back a time entry that waits, saying why (seen by the person and whoever approves time). The person is told, corrects it and it waits again. Whoever approves time, never their own entries. Returns the entry.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |
| `why` | string | yes | min length 1, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `entry` | object | yes |   |   |
| `entry.id` | string | yes |   |   |
| `entry.account` | string | yes |   |   |
| `entry.state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `entry.how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `entry.startsAt` | string | yes |   |   |
| `entry.endsAt` | string or null | yes |   |   |
| `entry.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `entry.zone` | string | yes |   |   |
| `entry.localDate` | string | yes |   |   |
| `entry.against` | object or null | yes |   | A shift, a job, or null for other work |
| `entry.against.object` | string | yes |   |   |
| `entry.against.id` | string | yes |   |   |
| `entry.against.title` | string | yes |   |   |
| `entry.against.shift` | boolean | yes |   |   |
| `entry.finishMissing` | boolean | yes |   |   |
| `entry.note` | string or null | yes |   |   |
| `entry.rejectedWhy` | string or null | yes |   |   |
| `entry.approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `entry.approval.by` | `"host"`, `"approver"` | yes |   |   |
| `entry.approval.at` | string | yes |   |   |
| `entry.recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `entry.recorded.startsAt` | string | yes |   |   |
| `entry.recorded.endsAt` | string | yes |   |   |
| `entry.recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.reopenedWhy` | string or null | yes |   |   |

## staffing.time.reopen

Tool-only (a shipped pack's tool): reopen an approved time entry, saying why, while its pay period is open: it waits again (the host does not approve it on a match while reopened). Whoever approves time, never their own entries. Returns the entry.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |
| `why` | string | yes | min length 1, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `entry` | object | yes |   |   |
| `entry.id` | string | yes |   |   |
| `entry.account` | string | yes |   |   |
| `entry.state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `entry.how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `entry.startsAt` | string | yes |   |   |
| `entry.endsAt` | string or null | yes |   |   |
| `entry.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `entry.zone` | string | yes |   |   |
| `entry.localDate` | string | yes |   |   |
| `entry.against` | object or null | yes |   | A shift, a job, or null for other work |
| `entry.against.object` | string | yes |   |   |
| `entry.against.id` | string | yes |   |   |
| `entry.against.title` | string | yes |   |   |
| `entry.against.shift` | boolean | yes |   |   |
| `entry.finishMissing` | boolean | yes |   |   |
| `entry.note` | string or null | yes |   |   |
| `entry.rejectedWhy` | string or null | yes |   |   |
| `entry.approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `entry.approval.by` | `"host"`, `"approver"` | yes |   |   |
| `entry.approval.at` | string | yes |   |   |
| `entry.recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `entry.recorded.startsAt` | string | yes |   |   |
| `entry.recorded.endsAt` | string | yes |   |   |
| `entry.recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entry.reopenedWhy` | string or null | yes |   |   |

## staffing.time.waiting

Tool-only (a shipped pack's tool): time entries waiting for an approver, dated from `from` to `to` (local dates, default the last 62 days; at most 62), each beside its shift: minutes started and finished early or late, within the tolerance or not, unrostered (a job, other work), over 12 hours. An approver reads everyone's (or one account's); anyone else reads their own only. A person at the screen. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `account` | string |   | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string | yes |   |   |
| `to` | string | yes |   |   |
| `tolerance` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items` | array of object | yes |   |   |
| `items[].account` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].entry` | object or null | yes |   |   |
| `items[].entry.id` | string | yes |   |   |
| `items[].entry.account` | string | yes |   |   |
| `items[].entry.state` | `"open"`, `"waiting"`, `"approved"`, `"rejected"` | yes |   |   |
| `items[].entry.how` | `"clocked"`, `"entered"`, `"by_approver"` | yes |   |   |
| `items[].entry.startsAt` | string | yes |   |   |
| `items[].entry.endsAt` | string or null | yes |   |   |
| `items[].entry.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].entry.minutes` | integer or null | yes |   | Whole minutes worked less the break |
| `items[].entry.zone` | string | yes |   |   |
| `items[].entry.localDate` | string | yes |   |   |
| `items[].entry.against` | object or null | yes |   | A shift, a job, or null for other work |
| `items[].entry.against.object` | string | yes |   |   |
| `items[].entry.against.id` | string | yes |   |   |
| `items[].entry.against.title` | string | yes |   |   |
| `items[].entry.against.shift` | boolean | yes |   |   |
| `items[].entry.finishMissing` | boolean | yes |   |   |
| `items[].entry.note` | string or null | yes |   |   |
| `items[].entry.rejectedWhy` | string or null | yes |   |   |
| `items[].entry.approval` | object or null | yes |   | host: it matched its shift within the tolerance |
| `items[].entry.approval.by` | `"host"`, `"approver"` | yes |   |   |
| `items[].entry.approval.at` | string | yes |   |   |
| `items[].entry.recorded` | object or null | yes |   | The times as recorded, when an approver approved it changed |
| `items[].entry.recorded.startsAt` | string | yes |   |   |
| `items[].entry.recorded.endsAt` | string | yes |   |   |
| `items[].entry.recorded.breakMinutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].entry.reopenedWhy` | string or null | yes |   |   |
| `items[].shift` | object or null | yes |   | The shift as rostered, or null for time with no live shift of theirs |
| `items[].shift.object` | string | yes |   |   |
| `items[].shift.id` | string | yes |   |   |
| `items[].shift.title` | string | yes |   |   |
| `items[].shift.startsAt` | string | yes |   |   |
| `items[].shift.endsAt` | string | yes |   |   |
| `items[].startMinutes` | integer or null | yes |   | Whole minutes it started after the shift (negative: before) |
| `items[].finishMinutes` | integer or null | yes |   | Whole minutes it finished after the shift (negative: before) |
| `items[].matches` | boolean | yes |   | Within the tolerance at both ends |
| `items[].notRecorded` | boolean | yes |   | A past shift of someone counted by time with no entry |
| `items[].unrostered` | boolean | yes |   | An entry with no live shift of theirs: a job or other work |
| `items[].long` | boolean | yes |   | An entry over 12 hours |

## staffing.time.withdraw

Tool-only (a shipped pack's tool): withdraw one of your own entries before it is approved (waiting or rejected, or open with its finish missing): it is removed. An open entry is otherwise finished first. Never in a locked pay period. A person's own act. Returns its id.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |

## staffing.uncovered

Tool-only (a shipped pack's tool): live shifts with nobody on them from now for `days` days (default the uncovered window, a Rostering setting: 14 days unless changed; at most 62), and whether each is offered. Someone who rosters. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `days` | integer |   | ≥ 1, ≤ 62 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].startsAt` | string or null | yes |   |   |
| `items[].endsAt` | string or null | yes |   |   |
| `items[].offered` | boolean | yes |   |   |

## staffing.week

Tool-only (a shipped pack's tool): the roster, every live shift of every kind (classes, duty shifts) from `from` to `to` (local dates in the organisation's zone, both included; at most 62 days), in order of start: its kind, title, times, place, who is on it (and whether it is you), whether it has nobody on it, and its open offer (`truncated` when more than 1,000 of one kind fall in the range). `mine` keeps your own shifts, `account` one person's. Someone who rosters also gets each shift's warnings. A shift whose title may name a client (an appointment) shows its kind as its title, except to its own person and those who roster. Never a class's bookings, places or list, nor any member. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `mine` | boolean |   |   | Only your own shifts |
| `account` | string |   | min length 1, max length 64 | Only this person's shifts |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `shifts` | array of object | yes |   |   |
| `shifts[].object` | string | yes |   |   |
| `shifts[].id` | string | yes |   |   |
| `shifts[].title` | string | yes |   |   |
| `shifts[].kind` | object or null | yes |   |   |
| `shifts[].kind.object` | string | yes |   |   |
| `shifts[].kind.id` | string | yes |   |   |
| `shifts[].kind.name` | string | yes |   |   |
| `shifts[].startsAt` | string | yes |   |   |
| `shifts[].endsAt` | string or null | yes |   |   |
| `shifts[].zone` | string or null | yes |   |   |
| `shifts[].place` | string or null | yes |   |   |
| `shifts[].uncovered` | boolean | yes |   | Nobody is on it |
| `shifts[].noAccount` | boolean | yes |   | Its person has no staff account (a visiting coach): covered, on nobody's roster |
| `shifts[].account` | string or null | yes |   |   |
| `shifts[].name` | string or null | yes |   |   |
| `shifts[].mine` | boolean | yes |   | Its person is the reader |
| `shifts[].offer` | object or null | yes |   |   |
| `shifts[].offer.id` | string | yes |   |   |
| `shifts[].offer.to` | string or null | yes |   |   |
| `shifts[].offer.from` | string or null | yes |   |   |
| `shifts[].warnings` | array of object or null | yes |   | Someone who rosters only (null otherwise): unavailable, not_qualified, uncovered |
| `shifts[].warnings.code` | `"unavailable"`, `"not_qualified"`, `"uncovered"` | yes |   |   |
| `shifts[].warnings.object` | string | yes |   |   |
| `shifts[].warnings.id` | string | yes |   |   |
| `shifts[].warnings.account` | string or null | yes |   |   |
| `shifts[].warnings.message` | string | yes |   |   |
| `shifts[].checklist` | object or null | yes |   | Its checklist, if it has one |
| `shifts[].checklist.name` | string | yes |   |   |
| `shifts[].checklist.state` | `"not_started"`, `"in_progress"`, `"done"`, `"missed"`, `"cancelled"` or null | yes |   | Its person and those who roster only, at the screen (null otherwise) |
| `zone` | string | yes |   |   |
| `days` | array of object | yes |   | Each local date in the range and how many hours it has in the zone: 23 or 25 on a clock change |
| `days[].date` | string | yes |   |   |
| `days[].hours` | number | yes |   |   |
| `truncated` | boolean | yes |   | More shifts than one answer holds (1,000 of a kind): ask for fewer days |

## staffing.withdraw

Tool-only (a shipped pack's tool): withdraw an open offer of a shift. Whoever made it, or someone who rosters; a person's own act. The shift stays its person's. Returns the offer.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `offer` | string | yes | min length 1, max length 64 |   |

### Output

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
