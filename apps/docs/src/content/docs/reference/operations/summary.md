---
title: "summary.* operations"
description: "The core operations named summary.*"
sidebar:
  label: "summary"
editUrl: false
---

## summary.activities

Generate one-line AI summaries for up to 10 long emails or notes (a timeline's visible batch) with the summarise role, and cache them. Fresh ones are returned without a model call.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string | yes | at least 1, at most 10 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].text` | string | yes |   |   |
| `lines[].fresh` | boolean | yes |   |   |

## summary.activityLines

Cached one-line AI summaries for long emails and notes on a timeline, by activity id. `missing` lists long activities with no fresh line yet (generate them with summary.activities). Short, private and system activities have none. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string | yes | at most 50 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].text` | string | yes |   |   |
| `lines[].fresh` | boolean | yes |   |   |
| `missing` | array of string | yes |   |   |
| `available` | boolean | yes |   |   |

## summary.generate

Generate (or regenerate) the AI summary of a person, organisation or deal, a meeting's prep brief, or a change set's description with the summarise model role, and cache it. Returns the cached one without a model call when it is still fresh. When the judge is on (summary.statements), each statement is checked against the facts and any the records do not support is removed before it is stored.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `subject` | object | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"fresh"`, `"stale"`, `"missing"`, `"unavailable"` | yes |   |   |
| `text` | string or null | yes |   |   |
| `model` | string or null | yes |   |   |
| `generatedAt` | string or null | yes |   |   |
| `aiGenerated` | `true` | yes |   |   |
| `message` | string or null | yes |   |   |
| `check` | object or null | yes | default `null` |   |
| `check.status` | `"checked"`, `"unchecked"`, `"withheld"` | yes |   |   |
| `check.removed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `check.message` | string | yes |   |   |

## summary.get

Read the cached AI summary of a person, organisation or deal, a meeting's prep brief, or a change set's plain-English description, and whether it is still fresh (stale once the record, its timeline, tasks or deals change). Never calls a model. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `subject` | object | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"fresh"`, `"stale"`, `"missing"`, `"unavailable"` | yes |   |   |
| `text` | string or null | yes |   |   |
| `model` | string or null | yes |   |   |
| `generatedAt` | string or null | yes |   |   |
| `aiGenerated` | `true` | yes |   |   |
| `message` | string or null | yes |   |   |
| `check` | object or null | yes | default `null` |   |
| `check.status` | `"checked"`, `"unchecked"`, `"withheld"` | yes |   |   |
| `check.removed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `check.message` | string | yes |   |   |
