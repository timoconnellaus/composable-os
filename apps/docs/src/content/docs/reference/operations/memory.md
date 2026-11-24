---
title: "memory.* operations"
description: "The core operations named memory.*"
sidebar:
  label: "memory"
editUrl: false
---

## memory.delete

Delete a memory line when the person asks you to forget it. It stops being sent at once. Their own lines only: team lines change on What your assistant remembers.

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
| `id` | string | yes | pattern `^mem_[0-9A-Za-z]{10,40}$` | A memory line's id (mem_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deleted` | `true` | yes |   |   |

## memory.list

What your assistant remembers: your lines with their conditions, source messages and dates, the team's lines, whether memory is paused, and how team memory is governed. Read-only.

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
| `paused` | boolean | yes |   |   |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].kind` | `"personal"`, `"shortcut"`, `"style"`, `"conditional"`, `"team"` | yes |   |   |
| `lines[].text` | string | yes |   |   |
| `lines[].status` | `"active"`, `"proposed"`, `"paused"` | yes |   |   |
| `lines[].condition` | any or null | yes |   |   |
| `lines[].conditionLabel` | string or null | yes |   |   |
| `lines[].source` | object or null | yes |   |   |
| `lines[].source.threadId` | string | yes |   |   |
| `lines[].source.messageSeq` | number | yes |   |   |
| `lines[].authorId` | string or null | yes |   |   |
| `lines[].authorName` | string or null | yes |   |   |
| `lines[].history` | array of any | yes |   |   |
| `lines[].activeSince` | string or null | yes |   |   |
| `lines[].createdAt` | string | yes |   |   |
| `lines[].updatedAt` | string | yes |   |   |
| `team` | array of object | yes |   |   |
| `team[].id` | string | yes |   |   |
| `team[].kind` | `"personal"`, `"shortcut"`, `"style"`, `"conditional"`, `"team"` | yes |   |   |
| `team[].text` | string | yes |   |   |
| `team[].status` | `"active"`, `"proposed"`, `"paused"` | yes |   |   |
| `team[].condition` | any or null | yes |   |   |
| `team[].conditionLabel` | string or null | yes |   |   |
| `team[].source` | object or null | yes |   |   |
| `team[].source.threadId` | string | yes |   |   |
| `team[].source.messageSeq` | number | yes |   |   |
| `team[].authorId` | string or null | yes |   |   |
| `team[].authorName` | string or null | yes |   |   |
| `team[].history` | array of any | yes |   |   |
| `team[].activeSince` | string or null | yes |   |   |
| `team[].createdAt` | string | yes |   |   |
| `team[].updatedAt` | string | yes |   |   |
| `governance` | `"open"`, `"approval"`, `"restricted"` | yes |   |   |
| `canManageTeam` | boolean | yes |   |   |
| `canEditTeam` | boolean | yes |   |   |

## memory.pause

Pause or resume your assistant's memory: one line (give id) or all of it. While all of it is paused, nothing is read or saved; the lines are kept.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string |   | pattern `^mem_[0-9A-Za-z]{10,40}$` | One line; all of your memory when absent |
| `paused` | boolean | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `paused` | boolean | yes |   |   |
| `line` | object or null | yes |   |   |
| `line.id` | string | yes |   |   |
| `line.kind` | `"personal"`, `"shortcut"`, `"style"`, `"conditional"`, `"team"` | yes |   |   |
| `line.text` | string | yes |   |   |
| `line.status` | `"active"`, `"proposed"`, `"paused"` | yes |   |   |
| `line.condition` | any or null | yes |   |   |
| `line.conditionLabel` | string or null | yes |   |   |
| `line.source` | object or null | yes |   |   |
| `line.source.threadId` | string | yes |   |   |
| `line.source.messageSeq` | number | yes |   |   |
| `line.authorId` | string or null | yes |   |   |
| `line.authorName` | string or null | yes |   |   |
| `line.history` | array of any | yes |   |   |
| `line.activeSince` | string or null | yes |   |   |
| `line.createdAt` | string | yes |   |   |
| `line.updatedAt` | string | yes |   |   |

## memory.propose

Save a line to your memory of the person, during the chat, when they tell you a preference, a habit, how they like their writing, what they mean by a phrase, or a rule for how to help them. Never for facts about customers, deals or other records: those are refused and go on the record as a note. kind: personal (default), shortcut ("when I say 'the pipeline' I mean my open deals over $5k"), style (how they like their writing, such as "no exclamation marks"), or conditional (holds only on some records: give condition { object, filter } with the filter shape views use, from what they said, and the line is read back for them to confirm). To change what you remember, pass the old line's id as replaces (memory.list gives ids). Follow the message in the result: it says whether the line was saved.

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
| `text` | string | yes | min length 1, max length 500 | The line, in the person's own terms, as one short sentence |
| `kind` | `"personal"`, `"shortcut"`, `"style"`, `"conditional"` |   | default `"personal"` |   |
| `condition` | object |   |   | For kind conditional: the records the line holds on |
| `condition.object` | string | yes | min length 1, max length 100 | The record type, e.g. organisation or person |
| `condition.filter` | any | yes |   | A view filter: { field, op, value } or { and \| or: [...] }, with the object's field names |
| `replaces` | string |   | pattern `^mem_[0-9A-Za-z]{10,40}$` | A line this one replaces, deleted when this is saved |
| `restore` | object |   |   | Set by the app when the person brings a line back with Redo. Not for the model |
| `restore.id` | string | yes | pattern `^mem_[0-9A-Za-z]{10,40}$` | A memory line's id (mem_…) |
| `restore.sourceSeq` | integer |   | ≥ 1, ≤ 9007199254740991 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `result` | `"saved"`, `"confirm"`, `"awaiting_approval"`, `"customer"`, `"duplicate"`, `"mismatch"`, `"paused"` | yes |   |   |
| `line` | object or null | yes |   |   |
| `line.id` | string | yes |   |   |
| `line.kind` | `"personal"`, `"shortcut"`, `"style"`, `"conditional"`, `"team"` | yes |   |   |
| `line.text` | string | yes |   |   |
| `line.status` | `"active"`, `"proposed"`, `"paused"` | yes |   |   |
| `line.condition` | any or null | yes |   |   |
| `line.conditionLabel` | string or null | yes |   |   |
| `line.source` | object or null | yes |   |   |
| `line.source.threadId` | string | yes |   |   |
| `line.source.messageSeq` | number | yes |   |   |
| `line.authorId` | string or null | yes |   |   |
| `line.authorName` | string or null | yes |   |   |
| `line.history` | array of any | yes |   |   |
| `line.activeSince` | string or null | yes |   |   |
| `line.createdAt` | string | yes |   |   |
| `line.updatedAt` | string | yes |   |   |
| `checked` | `"judge"`, `"deterministic"`, `"person"` | yes |   |   |
| `message` | string | yes |   |   |

## memory.reset

Delete everything your assistant remembers about you: all of your own lines, including writing style. Team lines stay. This cannot be undone.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `deleted` | number | yes |   |   |

## memory.update

Change one of your memory lines: its words, its condition, or save a line that was read back (confirm). The assistant reads the change from its next turn.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^mem_[0-9A-Za-z]{10,40}$` | A memory line's id (mem_…) |
| `text` | string |   | min length 1, max length 500 | The line, in the person's own terms, as one short sentence |
| `condition` | object |   |   | A conditional line's new condition |
| `condition.object` | string | yes | min length 1, max length 100 | The record type, e.g. organisation or person |
| `condition.filter` | any | yes |   | A view filter: { field, op, value } or { and \| or: [...] }, with the object's field names |
| `confirm` | `true` |   |   | Save a line that is waiting to be confirmed |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"personal"`, `"shortcut"`, `"style"`, `"conditional"`, `"team"` | yes |   |   |
| `text` | string | yes |   |   |
| `status` | `"active"`, `"proposed"`, `"paused"` | yes |   |   |
| `condition` | any or null | yes |   |   |
| `conditionLabel` | string or null | yes |   |   |
| `source` | object or null | yes |   |   |
| `source.threadId` | string | yes |   |   |
| `source.messageSeq` | number | yes |   |   |
| `authorId` | string or null | yes |   |   |
| `authorName` | string or null | yes |   |   |
| `history` | array of any | yes |   |   |
| `activeSince` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
