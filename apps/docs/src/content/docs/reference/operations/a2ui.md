---
title: "a2ui.* operations"
description: "The core operations named a2ui.*"
sidebar:
  label: "a2ui"
editUrl: false
---

## a2ui.act

Runs the operation behind a button on a card the model or a saved producer wrote, for the person who pressed it. It runs as the assistant with that person's permissions, so the approval policy applies: anything that needs review is queued, not applied. People only: the app calls it, a model never does.

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
| `operation` | string | yes | max length 120, pattern `^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$` |   |
| `input` | map of any |   | default `{}` |   |
| `label` | string | yes | max length 60 | The button pressed |
| `threadId` | string |   | max length 80 | The thread the card is in |

### Output

No fields.

## a2ui.produce

Show a saved card: a script that reads the CRM as the viewer and returns a card with no model call, so it is fast, free and the same every time. Prefer it to show_card when one fits. Read-only: it cannot change anything or show what the viewer cannot see. Saved cards: - briefing.morningCard: Today's meetings and what is due or overdue. Input: { limit? } - pipeline.staleDealsCard: Open deals with no activity for some days. Input: { days? (14), limit? } - tasks.overdueCard: Your overdue tasks with Complete and Snooze. Input: { limit? }

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `mcp`, `automation` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `producer` | string | yes | min length 1, max length 120 | The saved card's name |
| `version` | integer |   | ≥ 1, ≤ 9007199254740991 | A version (default: the newest) |
| `input` | map of any |   | default `{}` | What the saved card takes |
| `post` | boolean |   | default `false` | Also post it in your thread, for routines and app buttons. Not for the assistant |

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
| `seq` | number |   |   |   |

## a2ui.show

Show the person a card in the chat: tasks with checkboxes, records, deals, numbers, a form or choices, instead of a long list in words. Buttons call operations with the person's permissions, under the approval policy. The app draws only the components below; a card it cannot draw shows your text instead, and the result says why. The result gives you the card's text, numbered, so you can refer to "the second task". Writes nothing. A card is { "a2ui": 1, "root": component }, and a component is { "type": name, ...props }. Action: { kind: "operation", label, operation, input, confirm?, done? } | { kind: "open", label, href } | { kind: "reply", label, text }. Record: { object, id, label, subtitle? }. Links are paths such as /people/per_… or https URLs. Components: - card {title?:string, subtitle?:string, icon?:string, badge?:{text:string, tone?:neutral|info|success|warning|danger}, tone?:default|pending|ok|blocked, actions?:[Action]} + children:[component]: A card: title, optional subtitle and badge, children, up to 4 buttons - stack {} + children:[component]: Components one under another, without a frame - text {text:string, muted?:boolean}: A paragraph of Markdown (emphasis, links to records) - heading {text:string}: A small heading inside a card - divider {}: A line between parts of a card - keyValue {items:[{label:string, value:string, record?:Record}]}: Label and value pairs (Owner: Maya, Stage: Proposal) - badge {text:string, tone?:neutral|info|success|warning|danger}: A status pill: stage, priority, pending, overdue - recordChip {record:Record}: A person, organisation or deal as a clickable chip - list {ordered?:boolean, items:[{text:string, secondary?:string, record?:Record}]}: A plain or numbered list - table {columns:[{key:string, label:string, align?:start|end}], rows:[{…}], viewAll?:{label?:string, href:string}}: A small table (at most 20 rows), sortable columns, View all link - actions {actions:[Action]}: Up to 4 buttons; each calls an operation, opens a page or sends a reply - link {label:string, href:string}: A link to a record, view, dashboard or allowed external URL - image {src:string, alt:string, width?:number}: An image from the app's own storage (a path starting with /) - progress {label:string, value:number, max?:number, status?:running|done|failed|stopped, detail?:string}: A long-running job's progress - emptyState {title:string, text?:string, action?:Action}: Nothing to show, with one suggested action - recordCard {record:Record, facts?:[{label:string, value:string, record?:Record}], actions?:[Action]}: A person, organisation, deal or custom record: key facts and owner - recordList {title:string, columns:[string], rows:[{record:Record, values:[string]}], total?:number, bulkActions?:[Action], viewAll?:string}: A filtered set of records with 2 or 3 columns, bulk actions and View all - recordDiff {title:string, record?:Record, changes:[{field:string, before:string|null, after:string|null}], actions?:[Action]}: What a change will do, before and after - searchResults {query:string, groups:[{label:string, hits:[{…}]}], refine?:Action}: Search hits grouped by type, matched by meaning or by text - relatedRecords {title:string, record?:Record, groups:[{label:string, records:[Record]}]}: Records linked to one record (people at an organisation, a person's deals) - taskList {title:string, tasks:[{id:string, title:string, done?:boolean, dueAt?:string, dueLabel?:string, overdue?:boolean, record?:Record, assignee?:{id:string, name:string}, notes?:string}], total?:number, viewAll?:string}: Due or overdue tasks with checkboxes: Complete, Snooze, Reassign, Open - taskCard {task:{id:string, title:string, done?:boolean, dueAt?:string, dueLabel?:string, overdue?:boolean, record?:Record, assignee?:{id:string, name:string}, notes?:string}}: One task with notes and its linked record: Complete, Edit, Snooze - timeline {title?:string, record?:Record, entries:[{kind:note|call|email|meeting|task|system, title:string, when:string, text?:string}], actions?:[Action]}: Recent notes, calls, emails and meetings on a record - emailPreview {subject:string, from:{name:string, email?:string, record?:Record}, when:string, snippet:string, actions?:[Action]}: A received email: subject, snippet, sender: Reply, Open thread, Create task - emailDraft {to:[{name:string, email?:string, record?:Record}], cc?:[{name:string, email?:string, record?:Record}], subject:string, body:string, attachments?:[string], send:{operation:string, input?:{…}, subjectField?:string, bodyField?:string}, actions?:[Action]}: An AI-written draft, editable inline; Send is an operation that goes through outbound approval - logger {kind:call|note, record:Record, subject?:string, body?:string}: A quick form to log a call or a note on a record (activity.log) - dealCard {deal:Record, value?:string, stage:string, stageIndex?:number, stageCount?:number, facts?:[{label:string, value:string, record?:Record}], actions?:[Action]}: A deal: stage track, value, close date, days in stage, last activity - dealList {title:string, summary?:string, deals:[{deal:Record, value?:string, detail?:string}], actions?:[Action]}: Deals with plain facts (days since activity): follow-up tasks, Open, Snooze - pipelineSnapshot {title:string, summary?:string, stages:[{label:string, count:number, value:number, valueLabel?:string}], open?:string}: Counts and value per stage as mini bars - stageMoveConfirm {deal:Record, from:string, to:string, fields?:[{name:string, label:string, kind:text|textarea|number|money|date|select|user|record|checkbox, required?:boolean, value?:string|number|boolean|null, valueLabel?:string, placeholder?:string, options?:[{…}], object?:string, help?:string}], submit:{label:string, operation:string, input?:{…}, done?:string}}: Moving a deal to a stage, with the fields that stage requires - meetingCard {title:string, when:string, where?:string, attendees?:[Record], records?:[Record], joinUrl?:string, actions?:[Action]}: A meeting: time, attendees, linked organisation and deals - meetingPrep {title:string, when:string, where?:string, attendees?:[Record], records?:[Record], joinUrl?:string, summary?:string, checked?:boolean, recent?:[string], open?:[string], actions?:[Action]}: Meeting prep: attendees, summary, recent activity, open deals and tasks - availabilitySlots {title:string, slots:[{start:string, label:string}], pick:{operation:string, input?:{…}, field?:string}}: A few free times; picking one calls an operation (an invite draft for approval) - kpi {title:string, value:number, previous?:number, format?:number|currency|percent, currency?:string, open?:string}: One number with the previous period (plain facts, no scores) - chart {title:string, chart:bar|line|donut|funnel, rows:[{…}], x:string, y:string|[string], orientation?:vertical|horizontal, stacked?:boolean, format?:number|currency|percent, currency?:string, open?:string}: A small bar, line, donut or funnel chart over rows, drawn like a dashboard widget - leaderboard {title:string, rows:[{label:string, value:number}], format?:number|currency|percent, currency?:string}: Top N by a measure - recordForm {title:string, object:string, fields:[{name:string, label:string, kind:text|textarea|number|money|date|select|user|record|checkbox, required?:boolean, value?:string|number|boolean|null, valueLabel?:string, placeholder?:string, options?:[{…}], object?:string, help?:string}], submit:{label:string, operation:string, input?:{…}, done?:string}}: Create or edit a record; submits as an operation (a change set where review applies) - form {title:string, text?:string, fields:[{name:string, label:string, kind:text|textarea|number|money|date|select|user|record|checkbox, required?:boolean, value?:string|number|boolean|null, valueLabel?:string, placeholder?:string, options?:[{…}], object?:string, help?:string}], submit:{label:string, operation:string, input?:{…}, done?:string}}: A form of text, number, date, select, user and record fields for skills and plugins - choice {question?:string, multiple?:boolean, options:[{label:string, reply?:string}]}: Single or multiple choice to answer the assistant (sends the choice as a reply) - confirm {title:string, consequences:[string], confirm:Action, cancelLabel?:string}: Yes or no, with the consequences spelled out (destructive actions) - fileUpload {title:string, record?:Record, accept?:string, href:string}: Attach a file (a CSV for import, a document for a record) Example: { "a2ui": 1, "root": { "type": "taskList", "title": "Due this week", "tasks": [{ "id": "tsk_…", "title": "Send order form", "dueLabel": "Due Fri 7 Nov" }], "viewAll": "/tasks" } }

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `assistant` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `card` | any | yes |   | The card: { a2ui, root } |
| `text` | string | yes | min length 1, max length 4000 | The same answer in plain words, shown if the card cannot be drawn |

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
| `seq` | number |   |   |   |
