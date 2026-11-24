---
title: "teamMemory.* operations"
description: "The core operations named teamMemory.*"
sidebar:
  label: "teamMemory"
editUrl: false
---

## teamMemory.approve

Approve a proposed team line, which every assistant in the workspace then reads, or reject it, which deletes it. Needs permission to manage team memory, unless the workspace is open.

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
| `approve` | boolean | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
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

## teamMemory.propose

Save a line every assistant in the workspace reads, when the person says something holds for the whole team (how the team works, shared terms). Never customer facts. Whether it applies at once, waits for approval or is refused depends on the workspace's team memory setting: follow the message in the result.

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

## teamMemory.setGovernance

Set who can change team memory: open (anyone edits), approval (anyone proposes, people who manage settings approve) or restricted (only they propose and edit).

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `governance` | `"open"`, `"approval"`, `"restricted"` | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `governance` | `"open"`, `"approval"`, `"restricted"` | yes |   |   |

## teamMemory.update

Change a team line's words, or pause or resume it. Each change is kept in the line's history. Who may do this follows the workspace's team memory setting.

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
| `paused` | boolean |   |   |   |

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
