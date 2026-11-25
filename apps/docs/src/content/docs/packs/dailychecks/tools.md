---
title: "Daily checklists: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.dailychecks.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### today

Today's checklists (the ones done on their own, not a shift's): each one you may do, and every one if you manage checklists, with when it is due by, its steps and who ticked each and when, and whether you may tick it now. A person's own read.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Who may call it | a person only (`humanOnly`) |
| Staff | every staff account (`anyStaff`) |

#### Input

No fields.

#### Output

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
| `items[].who` | object | yes |   |   |
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
| `items[].run.template.version` | number | yes |   |   |
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
| `items[].run.steps[].position` | number | yes |   |   |
| `items[].run.steps[].text` | string | yes |   |   |
| `items[].run.steps[].required` | boolean | yes |   |   |
| `items[].run.steps[].asksNote` | boolean | yes |   |   |
| `items[].run.steps[].tick` | object or null | yes |   | The latest tick |
| `items[].run.steps[].tick.id` | string | yes |   |   |
| `items[].run.steps[].tick.state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `items[].run.steps[].tick.done` | boolean | yes |   |   |
| `items[].run.steps[].tick.why` | string or null | yes |   |   |
| `items[].run.steps[].tick.note` | string or null | yes |   |   |
| `items[].run.steps[].tick.onBehalfWhy` | string or null | yes |   |   |
| `items[].run.steps[].tick.withheld` | boolean | yes |   | Has words only its author and those who manage checklists read |
| `items[].run.steps[].tick.by` | string | yes |   |   |
| `items[].run.steps[].tick.byName` | string | yes |   |   |
| `items[].run.steps[].tick.for` | string | yes |   |   |
| `items[].run.steps[].tick.forName` | string | yes |   |   |
| `items[].run.steps[].tick.onBehalf` | boolean | yes |   |   |
| `items[].run.steps[].tick.at` | string | yes |   |   |
| `items[].run.steps[].tick.label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" |
| `items[].run.steps[].history` | array of object | yes |   | Earlier ticks, the latest 20 |
| `items[].run.steps[].history[].id` | string | yes |   |   |
| `items[].run.steps[].history[].state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `items[].run.steps[].history[].done` | boolean | yes |   |   |
| `items[].run.steps[].history[].why` | string or null | yes |   |   |
| `items[].run.steps[].history[].note` | string or null | yes |   |   |
| `items[].run.steps[].history[].onBehalfWhy` | string or null | yes |   |   |
| `items[].run.steps[].history[].withheld` | boolean | yes |   | Has words only its author and those who manage checklists read |
| `items[].run.steps[].history[].by` | string | yes |   |   |
| `items[].run.steps[].history[].byName` | string | yes |   |   |
| `items[].run.steps[].history[].for` | string | yes |   |   |
| `items[].run.steps[].history[].forName` | string | yes |   |   |
| `items[].run.steps[].history[].onBehalf` | boolean | yes |   |   |
| `items[].run.steps[].history[].at` | string | yes |   |   |
| `items[].run.steps[].history[].label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" |
| `items[].run.steps[].historyTruncated` | boolean | yes |   |   |
| `items[].run.steps[].missed` | boolean | yes |   |   |
| `items[].run.corrections` | array of object | yes |   |   |
| `items[].run.corrections[].id` | string | yes |   |   |
| `items[].run.corrections[].text` | string | yes |   |   |
| `items[].run.corrections[].by` | string | yes |   |   |
| `items[].run.corrections[].byName` | string | yes |   |   |
| `items[].run.corrections[].at` | string | yes |   |   |
| `items[].preview` | array of object or null | yes |   |   |
| `items[].preview.text` | string | yes |   |   |
| `items[].preview.required` | boolean | yes |   |   |
| `items[].preview.asksNote` | boolean | yes |   |   |
| `items[].mayDo` | boolean | yes |   | You may do it yourself |
| `items[].canTick` | boolean | yes |   | You may tick it now (yourself, or for someone) |
| `you` | string | yes |   |   |
| `youManage` | boolean | yes |   |   |

### day

One checklist on one day: its steps and ticks, whether it is done (by whom, when) or missed. Today's for whoever may do it; any day's, with who may do it, for someone who manages checklists. A person's own read.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Who may call it | a person only (`humanOnly`) |
| Staff | every staff account (`anyStaff`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `template` | string | yes | min length 1, max length 64 |   |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `item` | object | yes |   |   |
| `item.template` | object | yes |   |   |
| `item.template.id` | string | yes |   |   |
| `item.template.name` | string | yes |   |   |
| `item.template.purpose` | string or null | yes |   |   |
| `item.date` | string | yes |   |   |
| `item.who` | object | yes |   |   |
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
| `item.run.template.version` | number | yes |   |   |
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
| `item.run.steps[].position` | number | yes |   |   |
| `item.run.steps[].text` | string | yes |   |   |
| `item.run.steps[].required` | boolean | yes |   |   |
| `item.run.steps[].asksNote` | boolean | yes |   |   |
| `item.run.steps[].tick` | object or null | yes |   | The latest tick |
| `item.run.steps[].tick.id` | string | yes |   |   |
| `item.run.steps[].tick.state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `item.run.steps[].tick.done` | boolean | yes |   |   |
| `item.run.steps[].tick.why` | string or null | yes |   |   |
| `item.run.steps[].tick.note` | string or null | yes |   |   |
| `item.run.steps[].tick.onBehalfWhy` | string or null | yes |   |   |
| `item.run.steps[].tick.withheld` | boolean | yes |   | Has words only its author and those who manage checklists read |
| `item.run.steps[].tick.by` | string | yes |   |   |
| `item.run.steps[].tick.byName` | string | yes |   |   |
| `item.run.steps[].tick.for` | string | yes |   |   |
| `item.run.steps[].tick.forName` | string | yes |   |   |
| `item.run.steps[].tick.onBehalf` | boolean | yes |   |   |
| `item.run.steps[].tick.at` | string | yes |   |   |
| `item.run.steps[].tick.label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" |
| `item.run.steps[].history` | array of object | yes |   | Earlier ticks, the latest 20 |
| `item.run.steps[].history[].id` | string | yes |   |   |
| `item.run.steps[].history[].state` | `"done"`, `"not_done"`, `"cleared"` | yes |   |   |
| `item.run.steps[].history[].done` | boolean | yes |   |   |
| `item.run.steps[].history[].why` | string or null | yes |   |   |
| `item.run.steps[].history[].note` | string or null | yes |   |   |
| `item.run.steps[].history[].onBehalfWhy` | string or null | yes |   |   |
| `item.run.steps[].history[].withheld` | boolean | yes |   | Has words only its author and those who manage checklists read |
| `item.run.steps[].history[].by` | string | yes |   |   |
| `item.run.steps[].history[].byName` | string | yes |   |   |
| `item.run.steps[].history[].for` | string | yes |   |   |
| `item.run.steps[].history[].forName` | string | yes |   |   |
| `item.run.steps[].history[].onBehalf` | boolean | yes |   |   |
| `item.run.steps[].history[].at` | string | yes |   |   |
| `item.run.steps[].history[].label` | string | yes |   | "Ticked by X", or "Ticked by X for Y" |
| `item.run.steps[].historyTruncated` | boolean | yes |   |   |
| `item.run.steps[].missed` | boolean | yes |   |   |
| `item.run.corrections` | array of object | yes |   |   |
| `item.run.corrections[].id` | string | yes |   |   |
| `item.run.corrections[].text` | string | yes |   |   |
| `item.run.corrections[].by` | string | yes |   |   |
| `item.run.corrections[].byName` | string | yes |   |   |
| `item.run.corrections[].at` | string | yes |   |   |
| `item.preview` | array of object or null | yes |   |   |
| `item.preview.text` | string | yes |   |   |
| `item.preview.required` | boolean | yes |   |   |
| `item.preview.asksNote` | boolean | yes |   |   |
| `item.mayDo` | boolean | yes |   | You may do it yourself |
| `item.canTick` | boolean | yes |   | You may tick it now (yourself, or for someone) |
| `zone` | string | yes |   |   |
| `doers` | array of object or null | yes |   |   |
| `doers.id` | string | yes |   |   |
| `doers.name` | string | yes |   |   |
| `you` | string | yes |   |   |
| `youManage` | boolean | yes |   |   |

### tick

Tick one step of today's checklist: done (with a note where the step asks for one), not done (with why), or clear your tick. Whoever ticks the last step finishes it, and a finished checklist never changes. Someone who manages checklists may tick for someone who may do it (`for`), saying why (`forWhy`). A person's own act.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Who may call it | a person only (`humanOnly`) |
| Staff | every staff account (`anyStaff`) |
| Kept from the audit log | `note`, `why`, `forWhy`, `state` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `template` | string | yes | min length 1, max length 64 |   |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `step` | integer | yes | ≥ 0, ≤ 49 |   |
| `state` | `"done"`, `"not_done"`, `"clear"` | yes |   |   |
| `note` | string |   | max length 1000 |   |
| `why` | string |   | max length 500 |   |
| `for` | string |   | min length 1, max length 64 | Ticking for someone who may do it |
| `forWhy` | string |   | max length 500 | Ticking for someone else: why |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `run` | string | yes |   |   |
| `step` | number | yes |   |   |
| `state` | `"done"`, `"not_done"`, `"clear"` | yes |   |   |
| `ticked` | number | yes |   |   |
| `of` | number | yes |   |   |
| `finished` | boolean | yes |   |   |

### done

Finish today's checklist with optional steps left, once every required step is ticked. Finished is final. Someone who manages checklists may finish it for someone who may do it, saying why. A person's own act.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Who may call it | a person only (`humanOnly`) |
| Staff | every staff account (`anyStaff`) |
| Kept from the audit log | `forWhy` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `template` | string | yes | min length 1, max length 64 |   |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `for` | string |   | min length 1, max length 64 | Ticking for someone who may do it |
| `forWhy` | string |   | max length 500 | Ticking for someone else: why |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `run` | string | yes |   |   |
| `state` | `"done"` | yes |   |   |

### history

How each day went, from `from` to `to` (local dates, at most 62 days): every checklist done on its own, whether it was done (by whom, for whom, when, late or not, and how many steps were ticked not done) or missed (with the steps nobody ticked). Those who manage checklists, a person only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Core permission | `checklists:write` |
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
| `days[].finishedBy` | string or null | yes |   |   |
| `days[].finishedFor` | string or null | yes |   |   |
| `days[].steps` | number | yes |   |   |
| `days[].ticked` | number | yes |   |   |
| `days[].notDone` | number | yes |   |   |
| `days[].onBehalf` | number | yes |   |   |
| `days[].missed` | array of string | yes |   |   |
| `truncated` | boolean | yes |   |   |

## Automations

None.

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`checklist.today`](/reference/operations/checklist/#checklisttoday)
- [`checklist.day`](/reference/operations/checklist/#checklistday)
- [`checklist.dayTick`](/reference/operations/checklist/#checklistdaytick)
- [`checklist.dayDone`](/reference/operations/checklist/#checklistdaydone)
- [`checklist.days`](/reference/operations/checklist/#checklistdays)

Host modules it asks for: `ops`.
