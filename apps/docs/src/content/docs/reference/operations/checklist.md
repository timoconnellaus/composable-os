---
title: "checklist.* operations"
description: "The core operations named checklist.*"
sidebar:
  label: "checklist"
editUrl: false
---

## checklist.complete

Tool-only (a shipped pack's tool): mark a shift's checklist done, once every required step is ticked (done, or not done with why). Done is final: nothing of it changes again, for anyone (a correction is a note someone who rosters adds beside it). The shift's person marks their own; someone who rosters may for them, with why. A person's own act.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 | The record's object, e.g. rostering.shift |
| `id` | string | yes | min length 1, max length 64 |   |
| `forWhy` | string |   | max length 500 | Marking it for someone else: why |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `run` | string | yes |   |   |
| `state` | `"done"` | yes |   |   |

## checklist.correct

Tool-only (a shipped pack's tool): add a correction beside a closed checklist run (done, missed or cancelled): a note kept with it, never a change to its ticks. Someone who rosters. A person's own act.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `run` | string | yes | min length 1, max length 64 |   |
| `text` | string | yes | min length 1, max length 1000 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `run` | string | yes |   |   |

## checklist.day

Tool-only (a shipped pack's tool): one checklist done on its own, on one day: its steps, each step's latest tick (who ticked it, and for whom, and when), whether it is done (by whom, when) or missed, and whether the caller may tick it now. Today's for whoever may do it; any day's for someone who manages checklists, with the people who may do it (to tick for one of them). What someone wrote on a tick only to its author and those who manage checklists. To anyone else it is not there. A person's own read. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `template` | string | yes | min length 1, max length 64 | The checklist |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` | Its day (YYYY-MM-DD, the business's): today, to tick it |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `item` | object | yes |   |   |
| `item.template` | object | yes |   |   |
| `item.template.id` | string | yes |   |   |
| `item.template.name` | string | yes |   |   |
| `item.template.purpose` | string or null | yes |   |   |
| `item.date` | string | yes |   |   |
| `item.who` | object | yes |   | Who may do it |
| `item.who.kind` | `"staff"`, `"role"`, `"grant"` | yes |   |   |
| `item.who.value` | string or null | yes |   |   |
| `item.dueBy` | string or null | yes |   | The local time it is due by |
| `item.dueAt` | string or null | yes |   |   |
| `item.opens` | string | yes |   |   |
| `item.closes` | string | yes |   | The end of its day: not finished by then, it is missed |
| `item.state` | `"not_started"`, `"open"`, `"done"`, `"missed"` | yes |   |   |
| `item.late` | boolean | yes |   |   |
| `item.run` | object or null | yes |   |   |
| `item.run.id` | string | yes |   |   |
| `item.run.object` | string | yes |   |   |
| `item.run.record` | string | yes |   |   |
| `item.run.template` | object | yes |   |   |
| `item.run.template.id` | string | yes |   |   |
| `item.run.template.name` | string | yes |   |   |
| `item.run.template.version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `item.run.state` | `"open"`, `"done"`, `"missed"`, `"cancelled"` | yes |   |   |
| `item.run.account` | string or null | yes |   |   |
| `item.run.name` | string or null | yes |   |   |
| `item.run.opens` | string | yes |   |   |
| `item.run.closes` | string | yes |   |   |
| `item.run.tickUntil` | string | yes |   |   |
| `item.run.madeAt` | string | yes |   |   |
| `item.run.closedAt` | string or null | yes |   |   |
| `item.run.closedBy` | string or null | yes |   |   |
| `item.run.closedByName` | string or null | yes |   |   |
| `item.run.closedWhy` | string or null | yes |   |   |
| `item.run.steps` | array of object | yes |   |   |
| `item.run.steps[].position` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `item.run.steps[].text` | string | yes |   |   |
| `item.run.steps[].required` | boolean | yes |   |   |
| `item.run.steps[].asksNote` | boolean | yes |   |   |
| `item.run.steps[].tick` | object or null | yes |   | The step's latest tick |
| `item.run.steps[].tick.id` | string | yes |   |   |
| `item.run.steps[].tick.state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `item.run.steps[].tick.done` | boolean | yes |   |   |
| `item.run.steps[].tick.why` | string or null | yes |   |   |
| `item.run.steps[].tick.note` | string or null | yes |   |   |
| `item.run.steps[].tick.onBehalfWhy` | string or null | yes |   |   |
| `item.run.steps[].tick.withheld` | boolean | yes |   | It has words only its author and those who roster read (a note, why) |
| `item.run.steps[].tick.by` | string | yes |   |   |
| `item.run.steps[].tick.byName` | string | yes |   |   |
| `item.run.steps[].tick.for` | string | yes |   |   |
| `item.run.steps[].tick.forName` | string | yes |   |   |
| `item.run.steps[].tick.onBehalf` | boolean | yes |   | Ticked by someone who rosters for the run's person |
| `item.run.steps[].tick.at` | string | yes |   |   |
| `item.run.steps[].tick.label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" for a tick on someone's behalf |
| `item.run.steps[].history` | array of object | yes |   | Its earlier ticks, the latest 20: every one for someone who rosters, your own otherwise |
| `item.run.steps[].history[].id` | string | yes |   |   |
| `item.run.steps[].history[].state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `item.run.steps[].history[].done` | boolean | yes |   |   |
| `item.run.steps[].history[].why` | string or null | yes |   |   |
| `item.run.steps[].history[].note` | string or null | yes |   |   |
| `item.run.steps[].history[].onBehalfWhy` | string or null | yes |   |   |
| `item.run.steps[].history[].withheld` | boolean | yes |   | It has words only its author and those who roster read (a note, why) |
| `item.run.steps[].history[].by` | string | yes |   |   |
| `item.run.steps[].history[].byName` | string | yes |   |   |
| `item.run.steps[].history[].for` | string | yes |   |   |
| `item.run.steps[].history[].forName` | string | yes |   |   |
| `item.run.steps[].history[].onBehalf` | boolean | yes |   | Ticked by someone who rosters for the run's person |
| `item.run.steps[].history[].at` | string | yes |   |   |
| `item.run.steps[].history[].label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" for a tick on someone's behalf |
| `item.run.steps[].historyTruncated` | boolean | yes |   | Earlier ticks were left out |
| `item.run.steps[].missed` | boolean | yes |   |   |
| `item.run.corrections` | array of object | yes |   |   |
| `item.run.corrections[].id` | string | yes |   |   |
| `item.run.corrections[].text` | string | yes |   |   |
| `item.run.corrections[].by` | string | yes |   |   |
| `item.run.corrections[].byName` | string | yes |   |   |
| `item.run.corrections[].at` | string | yes |   |   |
| `item.preview` | array of object or null | yes |   | Its steps as they are now, before today's run is made |
| `item.preview.text` | string | yes |   |   |
| `item.preview.required` | boolean | yes |   |   |
| `item.preview.asksNote` | boolean | yes |   |   |
| `item.mayDo` | boolean | yes |   | The caller may do it themselves |
| `item.canTick` | boolean | yes |   | The caller may tick it now (themselves, or for someone) |
| `zone` | string | yes |   |   |
| `doers` | array of object or null | yes |   | Who may do it (at most 200), for someone who manages checklists |
| `doers.id` | string | yes |   |   |
| `doers.name` | string | yes |   |   |
| `you` | string | yes |   |   |
| `youManage` | boolean | yes |   |   |

## checklist.dayDone

Tool-only (a shipped pack's tool): finish today's run of a checklist done on its own when optional steps are left, once every required step is ticked (done, or not done with why). Finished is final: it never changes again. Anyone who may do it; someone who manages checklists for someone who may, with why. A person's own act.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `template` | string | yes | min length 1, max length 64 | The checklist |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` | Its day (YYYY-MM-DD, the business's): today, to tick it |
| `for` | string |   | min length 1, max length 64 | Someone who manages checklists ticking for someone who may do it: their account |
| `forWhy` | string |   | max length 500 | Ticking for someone else: why |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `run` | string | yes |   |   |
| `state` | `"done"` | yes |   |   |

## checklist.days

Tool-only (a shipped pack's tool): how the checklists done on their own went, day by day, from `from` to `to` (local dates, both included, at most 62 days): each day's run, whether it is open, done (by whom, for whom, when, and whether after its due time) or missed (with the steps nobody ticked), how many steps were ticked and how many for someone by someone else. For those who manage checklists (checklists:write), a person's own read. Read-only.

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
| `template` | string |   | min length 1, max length 64 | Only this checklist's days |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `zone` | string | yes |   |   |
| `days` | array of object | yes |   |   |
| `days[].run` | string | yes |   |   |
| `days[].template` | object | yes |   |   |
| `days[].template.id` | string | yes |   |   |
| `days[].template.name` | string | yes |   |   |
| `days[].date` | string | yes |   |   |
| `days[].state` | `"open"`, `"done"`, `"missed"` | yes |   |   |
| `days[].dueAt` | string or null | yes |   |   |
| `days[].late` | boolean | yes |   |   |
| `days[].finishedAt` | string or null | yes |   |   |
| `days[].finishedBy` | string or null | yes |   | Who finished it |
| `days[].finishedFor` | string or null | yes |   | Finished for someone by someone who manages checklists: whom |
| `days[].steps` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `days[].ticked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `days[].onBehalf` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Ticks made for someone by someone else |
| `days[].missed` | array of string | yes |   | The steps nobody ticked, when it was missed |
| `truncated` | boolean | yes |   |   |

## checklist.dayTick

Tool-only (a shipped pack's tool): tick one step of today's run of a checklist done on its own: done (with a note where the step asks for one), not done (with why), or clear it. Anyone who may do it ticks as themselves; someone who manages checklists may tick for someone who may (`for`), with why (`forWhy`), kept as ticked by them for that person. Every tick is kept, the latest counts, and only someone who manages checklists changes a tick someone else made. Whoever ticks the last step finishes it, and a finished checklist never changes. On its own day only. A person's own act, never an assistant's.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `template` | string | yes | min length 1, max length 64 | The checklist |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` | Its day (YYYY-MM-DD, the business's): today, to tick it |
| `step` | integer | yes | ≥ 0, ≤ 49 | The step's position, from 0 |
| `state` | `"done"`, `"not_done"`, `"clear"` | yes |   |   |
| `note` | string |   | max length 1000 | What was found or done |
| `why` | string |   | max length 500 | Why it was not done |
| `for` | string |   | min length 1, max length 64 | Someone who manages checklists ticking for someone who may do it: their account |
| `forWhy` | string |   | max length 500 | Ticking for someone else: why |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `run` | string | yes |   |   |
| `step` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `state` | `"done"`, `"not_done"`, `"clear"` | yes |   |   |
| `ticked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Steps ticked now, as this call saw them |
| `of` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `finished` | boolean | yes |   | This tick finished it (every step ticked) |

## checklist.due

Platform use only (the minute cron, as the host), in two steps, each its own call: `close` keeps open runs with their shift's person and times and closes those past their close and grace (missed, and the rosterers are told; or cancelled); `make` makes checklist runs for shifts opening within a day. Returns what it did.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |
| Also | a host step: never queued for review when the host itself calls it (`hostStep`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `step` | `"close"`, `"make"` | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `made` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `missed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `cancelled` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `moved` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## checklist.forRecord

Tool-only (a shipped pack's tool): a shift's checklist and how it is going, for its person or someone who rosters: each step, its latest tick (who ticked it, and for whom), what was missed, and corrections; what someone wrote on a tick only to its author and those who roster. Before its run is made, the checklist's steps as they are now. `canTick` says whether the caller may tick it now (its person, or someone who rosters for them, from when it opens until 2 hours after it closes). To anyone else it is not there. A person's own read, never an assistant's. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 | The record's object, e.g. rostering.shift |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

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
| `run.template.version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
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
| `run.steps[].position` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `run.steps[].text` | string | yes |   |   |
| `run.steps[].required` | boolean | yes |   |   |
| `run.steps[].asksNote` | boolean | yes |   |   |
| `run.steps[].tick` | object or null | yes |   | The step's latest tick |
| `run.steps[].tick.id` | string | yes |   |   |
| `run.steps[].tick.state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `run.steps[].tick.done` | boolean | yes |   |   |
| `run.steps[].tick.why` | string or null | yes |   |   |
| `run.steps[].tick.note` | string or null | yes |   |   |
| `run.steps[].tick.onBehalfWhy` | string or null | yes |   |   |
| `run.steps[].tick.withheld` | boolean | yes |   | It has words only its author and those who roster read (a note, why) |
| `run.steps[].tick.by` | string | yes |   |   |
| `run.steps[].tick.byName` | string | yes |   |   |
| `run.steps[].tick.for` | string | yes |   |   |
| `run.steps[].tick.forName` | string | yes |   |   |
| `run.steps[].tick.onBehalf` | boolean | yes |   | Ticked by someone who rosters for the run's person |
| `run.steps[].tick.at` | string | yes |   |   |
| `run.steps[].tick.label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" for a tick on someone's behalf |
| `run.steps[].history` | array of object | yes |   | Its earlier ticks, the latest 20: every one for someone who rosters, your own otherwise |
| `run.steps[].history[].id` | string | yes |   |   |
| `run.steps[].history[].state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `run.steps[].history[].done` | boolean | yes |   |   |
| `run.steps[].history[].why` | string or null | yes |   |   |
| `run.steps[].history[].note` | string or null | yes |   |   |
| `run.steps[].history[].onBehalfWhy` | string or null | yes |   |   |
| `run.steps[].history[].withheld` | boolean | yes |   | It has words only its author and those who roster read (a note, why) |
| `run.steps[].history[].by` | string | yes |   |   |
| `run.steps[].history[].byName` | string | yes |   |   |
| `run.steps[].history[].for` | string | yes |   |   |
| `run.steps[].history[].forName` | string | yes |   |   |
| `run.steps[].history[].onBehalf` | boolean | yes |   | Ticked by someone who rosters for the run's person |
| `run.steps[].history[].at` | string | yes |   |   |
| `run.steps[].history[].label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" for a tick on someone's behalf |
| `run.steps[].historyTruncated` | boolean | yes |   | Earlier ticks were left out |
| `run.steps[].missed` | boolean | yes |   |   |
| `run.corrections` | array of object | yes |   |   |
| `run.corrections[].id` | string | yes |   |   |
| `run.corrections[].text` | string | yes |   |   |
| `run.corrections[].by` | string | yes |   |   |
| `run.corrections[].byName` | string | yes |   |   |
| `run.corrections[].at` | string | yes |   |   |
| `preview` | array of object or null | yes |   | The steps as they are now, before the run is made |
| `preview.text` | string | yes |   |   |
| `preview.required` | boolean | yes |   |   |
| `preview.asksNote` | boolean | yes |   |   |
| `opens` | string or null | yes |   |   |
| `closes` | string or null | yes |   |   |
| `tickUntil` | string or null | yes |   |   |
| `canTick` | boolean | yes |   |   |
| `onBehalf` | boolean | yes |   |   |
| `forName` | string or null | yes |   | Whose run it is now |
| `you` | string | yes |   | The reader's account |
| `youRoster` | boolean | yes |   | The reader rosters: they may change anyone's tick |

## checklist.get

One checklist with its steps in order: each step's text, whether it is required and whether it asks for a note. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `purpose` | string or null | yes |   |   |
| `active` | boolean | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `steps` | array of object | yes |   |   |
| `steps[].text` | string | yes |   |   |
| `steps[].required` | boolean | yes |   |   |
| `steps[].note` | boolean | yes |   |   |
| `schedule` | object or null | yes |   | Its standing schedule, when it is done on its own (not only on a duty) |
| `schedule.days` | array of integer | yes |   |   |
| `schedule.dueBy` | string or null | yes |   |   |
| `schedule.who` | object | yes |   |   |
| `schedule.who.kind` | `"staff"`, `"role"`, `"grant"` | yes |   |   |
| `schedule.who.value` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `updatedBy` | string | yes |   |   |

## checklist.list

The business's checklists (templates of steps staff tick off on a duty: a close-down clean, opening up), each with its purpose, whether it is in use (`active`: only an active one can be picked), its version and how many steps it has, and its standing schedule if it is done on its own (the days it is due, the time it is due by, who may do it). Not how any checklist went. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `active` | boolean |   |   | Only active ones (true) or inactive ones (false) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].purpose` | string or null | yes |   |   |
| `items[].active` | boolean | yes |   |   |
| `items[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].steps` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].schedule` | object or null | yes |   | Its standing schedule, when it is done on its own (not only on a duty) |
| `items[].schedule.days` | array of integer | yes |   |   |
| `items[].schedule.dueBy` | string or null | yes |   |   |
| `items[].schedule.who` | object | yes |   |   |
| `items[].schedule.who.kind` | `"staff"`, `"role"`, `"grant"` | yes |   |   |
| `items[].schedule.who.value` | string or null | yes |   |   |
| `items[].updatedAt` | string | yes |   |   |

## checklist.runs

Tool-only (a shipped pack's tool): how checklists went, by checklist and date: every run opening from `from` to `to` (local dates, both included, at most 62 days), each with its shift, its person, whether it is open, done, missed or cancelled, how many steps were ticked, which were missed, and how many were ticked for the person by someone else. Someone who rosters only; a person's own read. Read-only.

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
| `template` | string |   | min length 1, max length 64 | Only this checklist's runs |

### Output

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
| `runs[].steps` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `runs[].ticked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `runs[].onBehalf` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Ticks made for the person by someone who rosters |
| `runs[].missed` | array of string | yes |   | The steps nobody ticked, when it was missed |
| `runs[].corrections` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `truncated` | boolean | yes |   |   |

## checklist.save

Write a checklist: a new one (no `id`), or a change to one (its name, purpose, whether it is in use, and its steps, given whole and in order; at most 50). Shifts already given a run of it keep the steps as they were; later runs copy the new ones. A standing `schedule` makes it a checklist done on its own (ADR 0651): due on those days of the week in the business's time zone, by a time, by whoever it names (everyone on staff, a role or pack role, or a grant); each due day gets one run, opened at the start of the day and missed if not finished by its end. Left out, a change keeps the schedule; null removes it. Needs checklists:write. An assistant's or MCP client's write always waits for a person who holds it too, so staff are only ever asked to follow a checklist a person approved.

|  |  |
| --- | --- |
| Permission | `checklists:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `mcp` |
| Also | always reviewed when called by `assistant`, `mcp` (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string |   | min length 1, max length 64 | The checklist to change; empty: a new one |
| `name` | string | yes | min length 1, max length 120 |   |
| `purpose` | string or null |   |   |   |
| `active` | boolean |   | default `true` |   |
| `steps` | array of object | yes | at least 1, at most 50 |   |
| `steps[].text` | string | yes | min length 1, max length 300 | What to do, in a line |
| `steps[].required` | boolean |   | default `true` | Must be ticked (done or not done with why) |
| `steps[].note` | boolean |   | default `false` | Asks for a note: ticking it done needs one |
| `schedule` | object or null |   |   |   |
| `schedule.days` | array of integer | yes | at least 1, at most 7 | The days of the week it is due, 1 Monday to 7 Sunday, in the business's time zone |
| `schedule.dueBy` | string or null |   |   | The local time it is due by |
| `schedule.who` | object | yes |   | Who may do it: everyone on staff, the people with a role, or those granted a permission |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `changed` | boolean | yes |   |   |

## checklist.tick

Tool-only (a shipped pack's tool): tick one step of a shift's checklist: done (with a note where the step asks for one), not done (with why), or clear it. Every tick is kept: a later one of the same step is added, and the latest counts. The shift's person ticks their own and changes only their own ticks; someone who rosters may tick for them, with why (`forWhy`), kept as ticked by them for that person, never as the person's own. From when the shift starts until 2 hours after it ends; a checklist marked done never changes. A person's own act, never an assistant's.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 | The record's object, e.g. rostering.shift |
| `id` | string | yes | min length 1, max length 64 |   |
| `step` | integer | yes | ≥ 0, ≤ 49 | The step's position, from 0 |
| `state` | `"done"`, `"not_done"`, `"clear"` | yes |   |   |
| `note` | string |   | max length 1000 | What was found or done |
| `why` | string |   | max length 500 | Why it was not done |
| `forWhy` | string |   | max length 500 | Ticking for someone else: why |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `run` | string | yes |   |   |
| `step` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `state` | `"done"`, `"not_done"`, `"clear"` | yes |   |   |
| `ticked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Steps ticked now |
| `of` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## checklist.today

Tool-only (a shipped pack's tool): the checklists due today in the business's time zone (the ones with a standing schedule, done on their own, not a shift's) that the caller may do, and for someone who manages checklists every one: each with when it is due by, who may do it, its steps and their ticks (who ticked each and when), or a preview before today's run is made, and whether the caller may tick it now. A person's own read, never an assistant's. Read-only.

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
| `zone` | string | yes |   |   |
| `date` | string | yes |   |   |
| `items` | array of object | yes |   |   |
| `items[].template` | object | yes |   |   |
| `items[].template.id` | string | yes |   |   |
| `items[].template.name` | string | yes |   |   |
| `items[].template.purpose` | string or null | yes |   |   |
| `items[].date` | string | yes |   |   |
| `items[].who` | object | yes |   | Who may do it |
| `items[].who.kind` | `"staff"`, `"role"`, `"grant"` | yes |   |   |
| `items[].who.value` | string or null | yes |   |   |
| `items[].dueBy` | string or null | yes |   | The local time it is due by |
| `items[].dueAt` | string or null | yes |   |   |
| `items[].opens` | string | yes |   |   |
| `items[].closes` | string | yes |   | The end of its day: not finished by then, it is missed |
| `items[].state` | `"not_started"`, `"open"`, `"done"`, `"missed"` | yes |   |   |
| `items[].late` | boolean | yes |   |   |
| `items[].run` | object or null | yes |   |   |
| `items[].run.id` | string | yes |   |   |
| `items[].run.object` | string | yes |   |   |
| `items[].run.record` | string | yes |   |   |
| `items[].run.template` | object | yes |   |   |
| `items[].run.template.id` | string | yes |   |   |
| `items[].run.template.name` | string | yes |   |   |
| `items[].run.template.version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].run.state` | `"open"`, `"done"`, `"missed"`, `"cancelled"` | yes |   |   |
| `items[].run.account` | string or null | yes |   |   |
| `items[].run.name` | string or null | yes |   |   |
| `items[].run.opens` | string | yes |   |   |
| `items[].run.closes` | string | yes |   |   |
| `items[].run.tickUntil` | string | yes |   |   |
| `items[].run.madeAt` | string | yes |   |   |
| `items[].run.closedAt` | string or null | yes |   |   |
| `items[].run.closedBy` | string or null | yes |   |   |
| `items[].run.closedByName` | string or null | yes |   |   |
| `items[].run.closedWhy` | string or null | yes |   |   |
| `items[].run.steps` | array of object | yes |   |   |
| `items[].run.steps[].position` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].run.steps[].text` | string | yes |   |   |
| `items[].run.steps[].required` | boolean | yes |   |   |
| `items[].run.steps[].asksNote` | boolean | yes |   |   |
| `items[].run.steps[].tick` | object or null | yes |   | The step's latest tick |
| `items[].run.steps[].tick.id` | string | yes |   |   |
| `items[].run.steps[].tick.state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `items[].run.steps[].tick.done` | boolean | yes |   |   |
| `items[].run.steps[].tick.why` | string or null | yes |   |   |
| `items[].run.steps[].tick.note` | string or null | yes |   |   |
| `items[].run.steps[].tick.onBehalfWhy` | string or null | yes |   |   |
| `items[].run.steps[].tick.withheld` | boolean | yes |   | It has words only its author and those who roster read (a note, why) |
| `items[].run.steps[].tick.by` | string | yes |   |   |
| `items[].run.steps[].tick.byName` | string | yes |   |   |
| `items[].run.steps[].tick.for` | string | yes |   |   |
| `items[].run.steps[].tick.forName` | string | yes |   |   |
| `items[].run.steps[].tick.onBehalf` | boolean | yes |   | Ticked by someone who rosters for the run's person |
| `items[].run.steps[].tick.at` | string | yes |   |   |
| `items[].run.steps[].tick.label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" for a tick on someone's behalf |
| `items[].run.steps[].history` | array of object | yes |   | Its earlier ticks, the latest 20: every one for someone who rosters, your own otherwise |
| `items[].run.steps[].history[].id` | string | yes |   |   |
| `items[].run.steps[].history[].state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `items[].run.steps[].history[].done` | boolean | yes |   |   |
| `items[].run.steps[].history[].why` | string or null | yes |   |   |
| `items[].run.steps[].history[].note` | string or null | yes |   |   |
| `items[].run.steps[].history[].onBehalfWhy` | string or null | yes |   |   |
| `items[].run.steps[].history[].withheld` | boolean | yes |   | It has words only its author and those who roster read (a note, why) |
| `items[].run.steps[].history[].by` | string | yes |   |   |
| `items[].run.steps[].history[].byName` | string | yes |   |   |
| `items[].run.steps[].history[].for` | string | yes |   |   |
| `items[].run.steps[].history[].forName` | string | yes |   |   |
| `items[].run.steps[].history[].onBehalf` | boolean | yes |   | Ticked by someone who rosters for the run's person |
| `items[].run.steps[].history[].at` | string | yes |   |   |
| `items[].run.steps[].history[].label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" for a tick on someone's behalf |
| `items[].run.steps[].historyTruncated` | boolean | yes |   | Earlier ticks were left out |
| `items[].run.steps[].missed` | boolean | yes |   |   |
| `items[].run.corrections` | array of object | yes |   |   |
| `items[].run.corrections[].id` | string | yes |   |   |
| `items[].run.corrections[].text` | string | yes |   |   |
| `items[].run.corrections[].by` | string | yes |   |   |
| `items[].run.corrections[].byName` | string | yes |   |   |
| `items[].run.corrections[].at` | string | yes |   |   |
| `items[].preview` | array of object or null | yes |   | Its steps as they are now, before today's run is made |
| `items[].preview.text` | string | yes |   |   |
| `items[].preview.required` | boolean | yes |   |   |
| `items[].preview.asksNote` | boolean | yes |   |   |
| `items[].mayDo` | boolean | yes |   | The caller may do it themselves |
| `items[].canTick` | boolean | yes |   | The caller may tick it now (themselves, or for someone) |
| `you` | string | yes |   |   |
| `youManage` | boolean | yes |   | The reader manages checklists: tick for anyone, see every day |

## checklist.whoChoices

Who a checklist done on its own can be for (ADR 0651), for the form that writes one: the roles (admins, members, and the fixed roles installed packs give, such as a cleaner's or a coach's) and the permissions an admin can grant one by one, each with its label. Names no account. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `roles` | array of object | yes |   |   |
| `roles[].role` | string | yes |   |   |
| `roles[].label` | string | yes |   |   |
| `grants` | array of object | yes |   |   |
| `grants[].permission` | string | yes |   |   |
| `grants[].label` | string | yes |   |   |
