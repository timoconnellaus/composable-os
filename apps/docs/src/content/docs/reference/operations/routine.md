---
title: "routine.* operations"
description: "The core operations named routine.*"
sidebar:
  label: "routine"
editUrl: false
---

## routine.backtest

Try an idea, or an existing one by id, on the last 30 days: how many times it would have messaged the person, examples that pass and fail, and warnings when there is no data or the trigger is very broad. Writes nothing to the CRM.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `definition` | object |   |   |   |
| `definition.name` | string | yes | min length 1, max length 80 | A short name, such as "Morning briefing" |
| `definition.what` | string | yes | min length 3, max length 300 | Finishes "I'll …": "send you your open deals with no activity for 14 days" |
| `definition.trigger` | object | yes |   | schedule { cron } in the workspace timezone, record { object, on }, fieldChanged, dateRelative or syncEvent { event } (for example email.received) |
| `definition.conditions` | any |   |   | Plain check on the record that triggered it (the view filter shape) |
| `definition.exists` | array of object |   | at least 1, at most 4 | Plain check for a schedule: at least one record matches one of these |
| `definition.exists[].object` | string | yes | min length 1, max length 80 | The record type, such as task or deals.deal |
| `definition.exists[].filter` | any | yes |   | The view filter shape; values may be $relative |
| `definition.exists[].label` | string |   | max length 120 | It in plain words, for the read-back |
| `definition.checks` | array of object |   | at most 3, default `[]` | Typed checks in the person's words over the event: "the email sounds keen" |
| `definition.checks[].question` | string | yes | min length 3, max length 200 |   |
| `definition.message` | object | yes |   |   |
| `definition.quietWhenEmpty` | boolean |   | default `true` | Send nothing when a saved card is empty |
| `id` | string |   | pattern `^rtn_[0-9A-Za-z]{10,40}$` | A routine's id (rtn_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `days` | number | yes |   |   |
| `fired` | number | yes |   |   |
| `fires` | array of boolean | yes |   |   |
| `examples` | array of object | yes |   |   |
| `examples[].text` | string | yes |   |   |
| `examples[].passed` | boolean | yes |   |   |
| `flags` | array of object | yes |   |   |
| `flags[].code` | `"no_data"`, `"broad"` | yes |   |   |
| `flags[].text` | string | yes |   |   |
| `note` | string |   |   |   |

## routine.create

Turn on what the read-back card showed. People only: this is the card's Turn on button, and a model can never do it. Pressing it twice turns it on once.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `draftId` | string | yes | pattern `^rtn_[0-9A-Za-z]{10,40}$` | A routine's id (rtn_…) |
| `definition` | object | yes |   |   |
| `definition.name` | string | yes | min length 1, max length 80 | A short name, such as "Morning briefing" |
| `definition.what` | string | yes | min length 3, max length 300 | Finishes "I'll …": "send you your open deals with no activity for 14 days" |
| `definition.trigger` | object | yes |   | schedule { cron } in the workspace timezone, record { object, on }, fieldChanged, dateRelative or syncEvent { event } (for example email.received) |
| `definition.conditions` | any |   |   | Plain check on the record that triggered it (the view filter shape) |
| `definition.exists` | array of object |   | at least 1, at most 4 | Plain check for a schedule: at least one record matches one of these |
| `definition.exists[].object` | string | yes | min length 1, max length 80 | The record type, such as task or deals.deal |
| `definition.exists[].filter` | any | yes |   | The view filter shape; values may be $relative |
| `definition.exists[].label` | string |   | max length 120 | It in plain words, for the read-back |
| `definition.checks` | array of object |   | at most 3, default `[]` | Typed checks in the person's words over the event: "the email sounds keen" |
| `definition.checks[].question` | string | yes | min length 3, max length 200 |   |
| `definition.message` | object | yes |   |   |
| `definition.quietWhenEmpty` | boolean |   | default `true` | Send nothing when a saved card is empty |
| `asked` | string |   | max length 500 |   |
| `askedAt` | string |   | max length 40 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `what` | string | yes |   |   |
| `status` | `"on"`, `"paused"`, `"failing"` | yes |   |   |
| `statusReason` | string or null | yes |   |   |
| `when` | string | yes |   |   |
| `gates` | array of string | yes |   |   |
| `checks` | array of string | yes |   |   |
| `asked` | string or null | yes |   |   |
| `askedAt` | string or null | yes |   |   |
| `pausedUntil` | string or null | yes |   |   |
| `lastRunAt` | string or null | yes |   |   |
| `lastDeliveredAt` | string or null | yes |   |   |
| `nextRunAt` | string or null | yes |   |   |
| `cron` | string or null | yes |   |   |

## routine.delete

Delete one of your routines and its run history. Messages it already sent stay in your chat. People only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^rtn_[0-9A-Za-z]{10,40}$` | A routine's id (rtn_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `deleted` | `true` | yes |   |   |

## routine.draft

Offer to do something for the person on their own schedule or when something happens: a morning briefing, a weekly summary, telling them when an email comes in. It tries the idea on the last 30 days and shows a read-back card; the person turns it on with a button, so it does nothing until they do. Say what you would do in outcomes ("Do you want me to send you a morning briefing?"). After it, add at most one short sentence. definition: - name: "Morning briefing". what: finishes "I'll …", such as "send you your open deals with no activity for 14 days". - trigger: { type: "schedule", cron: "0 8 * * 1-5" } (5 fields, in the workspace timezone, at least 15 minutes apart), or { type: "record", object, on: ["created"] }, { type: "fieldChanged", object, field, to }, { type: "dateRelative", object, field, offsetDays }, { type: "syncEvent", event: "email.received" }. - conditions: plain check on the triggering record, the view filter shape. exists: for a schedule, [{ object, filter }]: it runs only when at least one record matches. Filter values may be { "$relative": "me" | "now" | "today" | "tomorrow" }. - checks: [{ question }]: a check in the person's words over the event, such as "the email sounds keen to go ahead", for what a filter cannot say. Refused where they are not available: then use plain checks. - message: { kind: "producer", producer, input } for a saved card (fastest, no model), { kind: "skill", skill } or { kind: "turn", prompt } for a short written message. - replaces: pass a routine's id to change it instead of adding one.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `definition` | object | yes |   |   |
| `definition.name` | string | yes | min length 1, max length 80 | A short name, such as "Morning briefing" |
| `definition.what` | string | yes | min length 3, max length 300 | Finishes "I'll …": "send you your open deals with no activity for 14 days" |
| `definition.trigger` | object | yes |   | schedule { cron } in the workspace timezone, record { object, on }, fieldChanged, dateRelative or syncEvent { event } (for example email.received) |
| `definition.conditions` | any |   |   | Plain check on the record that triggered it (the view filter shape) |
| `definition.exists` | array of object |   | at least 1, at most 4 | Plain check for a schedule: at least one record matches one of these |
| `definition.exists[].object` | string | yes | min length 1, max length 80 | The record type, such as task or deals.deal |
| `definition.exists[].filter` | any | yes |   | The view filter shape; values may be $relative |
| `definition.exists[].label` | string |   | max length 120 | It in plain words, for the read-back |
| `definition.checks` | array of object |   | at most 3, default `[]` | Typed checks in the person's words over the event: "the email sounds keen" |
| `definition.checks[].question` | string | yes | min length 3, max length 200 |   |
| `definition.message` | object | yes |   |   |
| `definition.quietWhenEmpty` | boolean |   | default `true` | Send nothing when a saved card is empty |
| `replaces` | string |   | pattern `^rtn_[0-9A-Za-z]{10,40}$` | A routine's id (rtn_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"a2ui_card"` | yes |   |   |
| `part` | object | yes |   |   |
| `part.type` | `"a2ui"` | yes |   |   |
| `part.source` | `"model"`, `"producer"`, `"host"` | yes |   |   |
| `part.producer` | string |   | max length 200 |   |
| `part.document` | any or null | yes |   |   |
| `part.fallback` | string | yes |   |   |
| `part.problems` | array of string |   |   |   |
| `backtest` | object | yes |   |   |
| `backtest.days` | number | yes |   |   |
| `backtest.fired` | number | yes |   |   |
| `backtest.fires` | array of boolean | yes |   |   |
| `backtest.examples` | array of object | yes |   |   |
| `backtest.examples[].text` | string | yes |   |   |
| `backtest.examples[].passed` | boolean | yes |   |   |
| `backtest.flags` | array of object | yes |   |   |
| `backtest.flags[].code` | `"no_data"`, `"broad"` | yes |   |   |
| `backtest.flags[].text` | string | yes |   |   |
| `backtest.note` | string |   |   |   |

## routine.list

The person's standing requests, with status, schedule, what it checks first, and last and next run. Read-only. In chat, describe them by what they do.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human`, `assistant` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `routines` | array of object | yes |   |   |
| `routines[].id` | string | yes |   |   |
| `routines[].name` | string | yes |   |   |
| `routines[].what` | string | yes |   |   |
| `routines[].status` | `"on"`, `"paused"`, `"failing"` | yes |   |   |
| `routines[].statusReason` | string or null | yes |   |   |
| `routines[].when` | string | yes |   |   |
| `routines[].gates` | array of string | yes |   |   |
| `routines[].checks` | array of string | yes |   |   |
| `routines[].asked` | string or null | yes |   |   |
| `routines[].askedAt` | string or null | yes |   |   |
| `routines[].pausedUntil` | string or null | yes |   |   |
| `routines[].lastRunAt` | string or null | yes |   |   |
| `routines[].lastDeliveredAt` | string or null | yes |   |   |
| `routines[].nextRunAt` | string or null | yes |   |   |
| `routines[].cron` | string or null | yes |   |   |
| `minIntervalMinutes` | number | yes |   |   |

## routine.offer

Offer the person a morning briefing, as a read-back card they can turn on with a button. Use it when the context block says this is your first chat. Takes nothing. Say it in outcomes: "Do you want me to send you a morning briefing?".

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant` |
| Also | bookkeeping, never queued for review |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"a2ui_card"` | yes |   |   |
| `part` | object | yes |   |   |
| `part.type` | `"a2ui"` | yes |   |   |
| `part.source` | `"model"`, `"producer"`, `"host"` | yes |   |   |
| `part.producer` | string |   | max length 200 |   |
| `part.document` | any or null | yes |   |   |
| `part.fallback` | string | yes |   |   |
| `part.problems` | array of string |   |   |   |
| `backtest` | object | yes |   |   |
| `backtest.days` | number | yes |   |   |
| `backtest.fired` | number | yes |   |   |
| `backtest.fires` | array of boolean | yes |   |   |
| `backtest.examples` | array of object | yes |   |   |
| `backtest.examples[].text` | string | yes |   |   |
| `backtest.examples[].passed` | boolean | yes |   |   |
| `backtest.flags` | array of object | yes |   |   |
| `backtest.flags[].code` | `"no_data"`, `"broad"` | yes |   |   |
| `backtest.flags[].text` | string | yes |   |   |
| `backtest.note` | string |   |   |   |

## routine.pause

Stop one of the person's standing requests for now, or start it again with resume. Give until for a snooze (it starts again by itself). call_operation routine.list gives ids.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^rtn_[0-9A-Za-z]{10,40}$` | A routine's id (rtn_…) |
| `resume` | boolean |   | default `false` |   |
| `until` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$` | Snooze until this time |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `what` | string | yes |   |   |
| `status` | `"on"`, `"paused"`, `"failing"` | yes |   |   |
| `statusReason` | string or null | yes |   |   |
| `when` | string | yes |   |   |
| `gates` | array of string | yes |   |   |
| `checks` | array of string | yes |   |   |
| `asked` | string or null | yes |   |   |
| `askedAt` | string or null | yes |   |   |
| `pausedUntil` | string or null | yes |   |   |
| `lastRunAt` | string or null | yes |   |   |
| `lastDeliveredAt` | string or null | yes |   |   |
| `nextRunAt` | string or null | yes |   |   |
| `cron` | string or null | yes |   |   |

## routine.recordDelivery

Record what became of a delivery: sent, nothing to send, or failed. Called by the thread itself after it delivers.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^rtn_[0-9A-Za-z]{10,40}$` | A routine's id (rtn_…) |
| `outcome` | `"delivered"`, `"quiet"`, `"failed"` | yes |   |   |
| `error` | string |   | max length 300 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ok` | `true` | yes |   |   |

## routine.test

Try one of your routines now: run its checks and, when they pass, send the message to your chat, marked as a test. For a routine that waits for an event it uses the newest record of that kind. People only: it can cost a model call.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^rtn_[0-9A-Za-z]{10,40}$` | A routine's id (rtn_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sent` | boolean | yes |   |   |
| `checks` | array of object | yes |   |   |
| `checks[].text` | string | yes |   |   |
| `checks[].passed` | boolean | yes |   |   |
| `reason` | string or null | yes |   |   |

## routine.update

Change one of your routines: its whole definition (from a read-back's Save changes), or its name or schedule (from My routines). People only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^rtn_[0-9A-Za-z]{10,40}$` | A routine's id (rtn_…) |
| `definition` | object |   |   |   |
| `definition.name` | string | yes | min length 1, max length 80 | A short name, such as "Morning briefing" |
| `definition.what` | string | yes | min length 3, max length 300 | Finishes "I'll …": "send you your open deals with no activity for 14 days" |
| `definition.trigger` | object | yes |   | schedule { cron } in the workspace timezone, record { object, on }, fieldChanged, dateRelative or syncEvent { event } (for example email.received) |
| `definition.conditions` | any |   |   | Plain check on the record that triggered it (the view filter shape) |
| `definition.exists` | array of object |   | at least 1, at most 4 | Plain check for a schedule: at least one record matches one of these |
| `definition.exists[].object` | string | yes | min length 1, max length 80 | The record type, such as task or deals.deal |
| `definition.exists[].filter` | any | yes |   | The view filter shape; values may be $relative |
| `definition.exists[].label` | string |   | max length 120 | It in plain words, for the read-back |
| `definition.checks` | array of object |   | at most 3, default `[]` | Typed checks in the person's words over the event: "the email sounds keen" |
| `definition.checks[].question` | string | yes | min length 3, max length 200 |   |
| `definition.message` | object | yes |   |   |
| `definition.quietWhenEmpty` | boolean |   | default `true` | Send nothing when a saved card is empty |
| `name` | string |   | min length 1, max length 80 |   |
| `cron` | string |   | min length 9, max length 100 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `what` | string | yes |   |   |
| `status` | `"on"`, `"paused"`, `"failing"` | yes |   |   |
| `statusReason` | string or null | yes |   |   |
| `when` | string | yes |   |   |
| `gates` | array of string | yes |   |   |
| `checks` | array of string | yes |   |   |
| `asked` | string or null | yes |   |   |
| `askedAt` | string or null | yes |   |   |
| `pausedUntil` | string or null | yes |   |   |
| `lastRunAt` | string or null | yes |   |   |
| `lastDeliveredAt` | string or null | yes |   |   |
| `nextRunAt` | string or null | yes |   |   |
| `cron` | string or null | yes |   |   |

## routine.updateSettings

Set how often people's routines may run on a schedule. Admins. It applies to new and changed schedules.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `minIntervalMinutes` | integer | yes | ≥ 15, ≤ 1440 | The shortest gap between a schedule's runs, in minutes |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `minIntervalMinutes` | integer | yes | ≥ 15, ≤ 1440 | The shortest gap between a schedule's runs, in minutes |
