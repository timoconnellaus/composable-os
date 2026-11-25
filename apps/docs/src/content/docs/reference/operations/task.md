---
title: "task.* operations"
description: "The core operations named task.*"
sidebar:
  label: "task"
editUrl: false
---

## task.complete

Mark a task done. Posts a 'Task completed' system activity on the task and on every record it links to. Completing a task that is already done changes nothing. Returns the task.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^tsk_.*` | Task id (tsk_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `notes` | string or null | yes |   |   |
| `dueAt` | string or null | yes |   |   |
| `status` | `"open"`, `"done"` | yes |   |   |
| `completedAt` | string or null | yes |   |   |
| `completedBy` | string or null | yes |   |   |
| `assigneeId` | string or null | yes |   |   |
| `assigneeName` | string or null | yes |   |   |
| `links` | array of object | yes |   |   |
| `links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |

## task.create

Create an open task with a title and optional notes, due date (YYYY-MM-DD) or due time, assignee (defaults to you) and links to the records it is about. Returns the task.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `title` | string | yes | min length 1, max length 500 |   |
| `notes` | string or null |   |   | Markdown |
| `dueAt` | string (date) or string (date-time) or null |   |   |   |
| `assigneeId` | string or null |   |   | User id (usr_…). On create, defaults to you; null leaves it unassigned. |
| `links` | array of object |   | at most 50 | Records the task is about (people, organisations); replaces the list |
| `links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `notes` | string or null | yes |   |   |
| `dueAt` | string or null | yes |   |   |
| `status` | `"open"`, `"done"` | yes |   |   |
| `completedAt` | string or null | yes |   |   |
| `completedBy` | string or null | yes |   |   |
| `assigneeId` | string or null | yes |   |   |
| `assigneeName` | string or null | yes |   |   |
| `links` | array of object | yes |   |   |
| `links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |

## task.delete

Move a task to Trash (soft delete). It disappears from task lists and search, and can be restored with task.restore for 30 days.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^tsk_.*` | Task id (tsk_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deletedAt` | string | yes |   |   |
| `restorableUntil` | string | yes |   |   |

## task.get

Get one task by id with its assignee and linked records. Deleted tasks are not found unless includeDeleted is true. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^tsk_.*` | Task id (tsk_…) |
| `includeDeleted` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `notes` | string or null | yes |   |   |
| `dueAt` | string or null | yes |   |   |
| `status` | `"open"`, `"done"` | yes |   |   |
| `completedAt` | string or null | yes |   |   |
| `completedBy` | string or null | yes |   |   |
| `assigneeId` | string or null | yes |   |   |
| `assigneeName` | string or null | yes |   |   |
| `links` | array of object | yes |   |   |
| `links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |

## task.list

List live tasks, one page at a time. Filter with structured filter JSON over task fields (e.g. { and: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'assigneeId', op: 'eq', value: 'usr_…' }, { field: 'dueAt', op: 'lt', value: '2026-12-01' }] }); linkedRecordId finds tasks about a record. Sort by a sortable field (default dueAt). Pass nextCursor back as cursor for the next page. For your own open tasks grouped by due date, use task.listMine. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filter` | any |   |   | Structured filter: { and \| or: [...] } of { field, op, value }. |
| `sort` | object |   |   | Sort field and direction. Defaults per object. |
| `sort.field` | string | yes | min length 1, max length 64 |   |
| `sort.direction` | `"asc"`, `"desc"` |   | default `"asc"` |   |
| `cursor` | string |   | max length 1000 | nextCursor from the previous page. |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |
| `fields` | array of string |   | at most 100 | Return only these fields of each item (id is always included). |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].title` | string |   |   |   |
| `items[].notes` | string or null |   |   |   |
| `items[].dueAt` | string or null |   |   |   |
| `items[].status` | `"open"`, `"done"` |   |   |   |
| `items[].completedAt` | string or null |   |   |   |
| `items[].completedBy` | string or null |   |   |   |
| `items[].assigneeId` | string or null |   |   |   |
| `items[].assigneeName` | string or null |   |   |   |
| `items[].links` | array of object |   |   |   |
| `items[].links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `items[].links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `items[].links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `items[].createdAt` | string |   |   |   |
| `items[].createdBy` | string or null |   |   |   |
| `items[].updatedAt` | string |   |   |   |
| `items[].deletedAt` | string or null |   |   |   |
| `nextCursor` | string or null | yes |   |   |

## task.listMine

Your open tasks (assigned to you), grouped by due date: overdue, today, thisWeek (through Sunday), later, and none (no due date). Pass your IANA timezone so 'today' is your today. Each group is sorted by due date; at most 500 tasks are returned. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `timezone` | string |   | max length 64, default `"UTC"` | IANA timezone for 'today', e.g. Australia/Sydney. Default UTC. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `today` | string | yes |   | Today's date in the timezone |
| `buckets` | object | yes |   |   |
| `buckets.overdue` | array of object | yes |   |   |
| `buckets.overdue[].id` | string | yes |   |   |
| `buckets.overdue[].title` | string | yes |   |   |
| `buckets.overdue[].notes` | string or null | yes |   |   |
| `buckets.overdue[].dueAt` | string or null | yes |   |   |
| `buckets.overdue[].status` | `"open"`, `"done"` | yes |   |   |
| `buckets.overdue[].completedAt` | string or null | yes |   |   |
| `buckets.overdue[].completedBy` | string or null | yes |   |   |
| `buckets.overdue[].assigneeId` | string or null | yes |   |   |
| `buckets.overdue[].assigneeName` | string or null | yes |   |   |
| `buckets.overdue[].links` | array of object | yes |   |   |
| `buckets.overdue[].links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `buckets.overdue[].links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `buckets.overdue[].links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `buckets.overdue[].createdAt` | string | yes |   |   |
| `buckets.overdue[].createdBy` | string or null | yes |   |   |
| `buckets.overdue[].updatedAt` | string | yes |   |   |
| `buckets.overdue[].deletedAt` | string or null | yes |   |   |
| `buckets.today` | array of object | yes |   |   |
| `buckets.today[].id` | string | yes |   |   |
| `buckets.today[].title` | string | yes |   |   |
| `buckets.today[].notes` | string or null | yes |   |   |
| `buckets.today[].dueAt` | string or null | yes |   |   |
| `buckets.today[].status` | `"open"`, `"done"` | yes |   |   |
| `buckets.today[].completedAt` | string or null | yes |   |   |
| `buckets.today[].completedBy` | string or null | yes |   |   |
| `buckets.today[].assigneeId` | string or null | yes |   |   |
| `buckets.today[].assigneeName` | string or null | yes |   |   |
| `buckets.today[].links` | array of object | yes |   |   |
| `buckets.today[].links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `buckets.today[].links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `buckets.today[].links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `buckets.today[].createdAt` | string | yes |   |   |
| `buckets.today[].createdBy` | string or null | yes |   |   |
| `buckets.today[].updatedAt` | string | yes |   |   |
| `buckets.today[].deletedAt` | string or null | yes |   |   |
| `buckets.thisWeek` | array of object | yes |   |   |
| `buckets.thisWeek[].id` | string | yes |   |   |
| `buckets.thisWeek[].title` | string | yes |   |   |
| `buckets.thisWeek[].notes` | string or null | yes |   |   |
| `buckets.thisWeek[].dueAt` | string or null | yes |   |   |
| `buckets.thisWeek[].status` | `"open"`, `"done"` | yes |   |   |
| `buckets.thisWeek[].completedAt` | string or null | yes |   |   |
| `buckets.thisWeek[].completedBy` | string or null | yes |   |   |
| `buckets.thisWeek[].assigneeId` | string or null | yes |   |   |
| `buckets.thisWeek[].assigneeName` | string or null | yes |   |   |
| `buckets.thisWeek[].links` | array of object | yes |   |   |
| `buckets.thisWeek[].links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `buckets.thisWeek[].links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `buckets.thisWeek[].links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `buckets.thisWeek[].createdAt` | string | yes |   |   |
| `buckets.thisWeek[].createdBy` | string or null | yes |   |   |
| `buckets.thisWeek[].updatedAt` | string | yes |   |   |
| `buckets.thisWeek[].deletedAt` | string or null | yes |   |   |
| `buckets.later` | array of object | yes |   |   |
| `buckets.later[].id` | string | yes |   |   |
| `buckets.later[].title` | string | yes |   |   |
| `buckets.later[].notes` | string or null | yes |   |   |
| `buckets.later[].dueAt` | string or null | yes |   |   |
| `buckets.later[].status` | `"open"`, `"done"` | yes |   |   |
| `buckets.later[].completedAt` | string or null | yes |   |   |
| `buckets.later[].completedBy` | string or null | yes |   |   |
| `buckets.later[].assigneeId` | string or null | yes |   |   |
| `buckets.later[].assigneeName` | string or null | yes |   |   |
| `buckets.later[].links` | array of object | yes |   |   |
| `buckets.later[].links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `buckets.later[].links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `buckets.later[].links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `buckets.later[].createdAt` | string | yes |   |   |
| `buckets.later[].createdBy` | string or null | yes |   |   |
| `buckets.later[].updatedAt` | string | yes |   |   |
| `buckets.later[].deletedAt` | string or null | yes |   |   |
| `buckets.none` | array of object | yes |   |   |
| `buckets.none[].id` | string | yes |   |   |
| `buckets.none[].title` | string | yes |   |   |
| `buckets.none[].notes` | string or null | yes |   |   |
| `buckets.none[].dueAt` | string or null | yes |   |   |
| `buckets.none[].status` | `"open"`, `"done"` | yes |   |   |
| `buckets.none[].completedAt` | string or null | yes |   |   |
| `buckets.none[].completedBy` | string or null | yes |   |   |
| `buckets.none[].assigneeId` | string or null | yes |   |   |
| `buckets.none[].assigneeName` | string or null | yes |   |   |
| `buckets.none[].links` | array of object | yes |   |   |
| `buckets.none[].links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `buckets.none[].links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `buckets.none[].links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `buckets.none[].createdAt` | string | yes |   |   |
| `buckets.none[].createdBy` | string or null | yes |   |   |
| `buckets.none[].updatedAt` | string | yes |   |   |
| `buckets.none[].deletedAt` | string or null | yes |   |   |
| `counts` | object | yes |   |   |
| `counts.overdue` | number | yes |   |   |
| `counts.today` | number | yes |   |   |
| `counts.thisWeek` | number | yes |   |   |
| `counts.later` | number | yes |   |   |
| `counts.none` | number | yes |   |   |
| `truncated` | boolean | yes |   |   |

## task.reopen

Reopen a done task (status back to open, completion cleared). Reopening an open task changes nothing. Returns the task.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^tsk_.*` | Task id (tsk_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `notes` | string or null | yes |   |   |
| `dueAt` | string or null | yes |   |   |
| `status` | `"open"`, `"done"` | yes |   |   |
| `completedAt` | string or null | yes |   |   |
| `completedBy` | string or null | yes |   |   |
| `assigneeId` | string or null | yes |   |   |
| `assigneeName` | string or null | yes |   |   |
| `links` | array of object | yes |   |   |
| `links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |

## task.restore

Restore a task from Trash. Returns the restored task.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^tsk_.*` | Task id (tsk_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `notes` | string or null | yes |   |   |
| `dueAt` | string or null | yes |   |   |
| `status` | `"open"`, `"done"` | yes |   |   |
| `completedAt` | string or null | yes |   |   |
| `completedBy` | string or null | yes |   |   |
| `assigneeId` | string or null | yes |   |   |
| `assigneeName` | string or null | yes |   |   |
| `links` | array of object | yes |   |   |
| `links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |

## task.update

Update a task's title, notes, due date, assignee or links. Only the fields you pass change; pass null to clear notes, due date or assignee. links replaces the whole list. Use task.complete and task.reopen to change the status. Returns the updated task.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^tsk_.*` | Task id (tsk_…) |
| `title` | string |   | min length 1, max length 500 |   |
| `notes` | string or null |   |   | Markdown |
| `dueAt` | string (date) or string (date-time) or null |   |   |   |
| `assigneeId` | string or null |   |   | User id (usr_…). On create, defaults to you; null leaves it unassigned. |
| `links` | array of object |   | at most 50 | Records the task is about (people, organisations); replaces the list |
| `links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `notes` | string or null | yes |   |   |
| `dueAt` | string or null | yes |   |   |
| `status` | `"open"`, `"done"` | yes |   |   |
| `completedAt` | string or null | yes |   |   |
| `completedBy` | string or null | yes |   |   |
| `assigneeId` | string or null | yes |   |   |
| `assigneeName` | string or null | yes |   |   |
| `links` | array of object | yes |   |   |
| `links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
