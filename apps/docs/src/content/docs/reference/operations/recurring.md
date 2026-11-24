---
title: "recurring.* operations"
description: "The core operations named recurring.*"
sidebar:
  label: "recurring"
editUrl: false
---

## recurring.change

Change a series of a recurring schedule (a timetable line) when the change moves or cancels future records that have places taken: record.update refuses that change and says how many (rule recurring_confirm, count). Pass the same values and confirm with that count; the records nobody edited move to the new time, and dates no longer in the series are cancelled. With from (a local date), the change applies to records from that date on; earlier ones keep the series as it was. Refused again if the count has changed. Returns the series.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `values` | map of any | yes |   |   |
| `confirm` | integer | yes | ≥ 1, ≤ 9007199254740991 | How many records with places taken the change moves or cancels. |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | The local date (YYYY-MM-DD) the change applies from; default today. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `values` | map of any | yes |   |   |

## recurring.close

Add a closure (a date range, such as holidays) to a recurring schedule, or change one's dates, when it cancels future records that have places taken: record.create and record.update refuse that and say how many (rule recurring_confirm, count). Pass the same values and confirm with that count; every record it newly covers is cancelled. Omit id to add one. Returns the closure.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string |   | min length 1, max length 64 |   |
| `values` | map of any | yes |   |   |
| `confirm` | integer | yes | ≥ 1, ≤ 9007199254740991 | How many records with places taken the closure cancels. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `values` | map of any | yes |   |   |

## recurring.exceptions

Read what a record made by a recurring schedule (a class from its timetable line) keeps as its own instead of following its series: the fields changed by hand on it (a coach swapped for that date), with who changed each and when, and whether it is detached from its series whole (its time or state was changed by hand). A later change to the series still reaches every other field of it. A one-off record answers generated false.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `generated` | boolean | yes |   |   |
| `series` | object or null | yes |   |   |
| `series.object` | string | yes |   |   |
| `series.id` | string | yes |   |   |
| `series.date` | string | yes |   |   |
| `detached` | boolean | yes |   |   |
| `fields` | array of object | yes |   |   |
| `fields[].field` | string | yes |   |   |
| `fields[].setBy` | string | yes |   |   |
| `fields[].setAt` | string | yes |   |   |

## recurring.follow

Make fields of a record made by a recurring schedule (a class) follow its series again: each named field (default every field the series sets: its coach, room, places) takes the series' value now and follows later changes to it. A record detached from its series whole follows it again too, provided its time is still the series' for its date (refused with rule recurring_moved otherwise); the fields not named that differ from the series stay its own. Refused for a past, cancelled or finished record. Returns the fields that follow the series and those kept.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `fields` | array of string |   | at least 1, at most 50 | The fields to follow the series again (at least one); leave it out for every field the series sets. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `followed` | array of string | yes |   |   |
| `kept` | array of string | yes |   |   |
| `reattached` | boolean | yes |   |   |

## recurring.generate

Platform use only: make one series' records that are due, up to its horizon, as the host (the minute cron). Dates already made, in a closure or past are not made. Returns how many were made and whether more are due.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `limit` | integer |   | ≥ 1, ≤ 25, default `25` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `made` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `more` | boolean | yes |   |   |
