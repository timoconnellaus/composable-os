---
title: "audit.* operations"
description: "The core operations named audit.*"
sidebar:
  label: "audit"
editUrl: false
---

## audit.list

The admin audit log: every write, every refusal and every failed non-human read, newest first (successful reads by AI and automations are counted per hour in audit.readCounts). Filter by userId, actor (human, assistant, mcp, automation, extension, customer, public), operation (exact name, or a prefix ending in '.*' such as 'person.*'), outcome, a record (object + recordId), a pending action (pendingActionId: its queued request and applied result) and a date range (from inclusive, to exclusive). Each entry includes its field diffs. Admins only. Read-only.

|  |  |
| --- | --- |
| Permission | `audit:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `userId` | string |   | max length 64 |   |
| `actor` | `"human"`, `"assistant"`, `"mcp"`, `"automation"`, `"extension"`, `"customer"`, `"public"` |   |   |   |
| `operation` | string |   | max length 100, pattern `^[a-zA-Z0-9.]+(\.\*)?$` |   |
| `outcome` | `"ok"`, `"forbidden"`, `"denied"`, `"review"`, `"error"` |   |   |   |
| `object` | string |   | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `recordId` | string |   | max length 64 |   |
| `pendingActionId` | string (starts_with) |   | max length 64, pattern `^pac_.*` |   |
| `from` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `to` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].at` | string | yes |   |   |
| `items[].operation` | string | yes |   |   |
| `items[].risk` | string | yes |   |   |
| `items[].actor` | string | yes |   |   |
| `items[].userId` | string or null | yes |   |   |
| `items[].userName` | string or null | yes |   |   |
| `items[].origin` | map of any | yes |   |   |
| `items[].input` | any | yes |   |   |
| `items[].result` | any | yes |   |   |
| `items[].gateDecision` | string | yes |   |   |
| `items[].outcome` | string | yes |   |   |
| `items[].error` | any | yes |   |   |
| `items[].pendingActionId` | string or null | yes |   |   |
| `items[].changes` | array of object | yes |   |   |
| `items[].changes[].object` | string | yes |   |   |
| `items[].changes[].recordId` | string | yes |   |   |
| `items[].changes[].action` | string | yes |   |   |
| `items[].changes[].diff` | map of object | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## audit.listForRecord

A record's change history (the History tab): who changed which fields, when and through which operation, newest first, with before/after values per field. Covers creates, updates, deletes, restores and merges. Pass nextCursor back as cursor for the next page. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `recordId` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 100, default `25` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].changeId` | number | yes |   |   |
| `items[].auditId` | string | yes |   |   |
| `items[].at` | string | yes |   |   |
| `items[].operation` | string | yes |   |   |
| `items[].actor` | string | yes |   |   |
| `items[].userId` | string or null | yes |   |   |
| `items[].userName` | string or null | yes |   |   |
| `items[].action` | string | yes |   |   |
| `items[].diff` | map of object | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## audit.purge

One round of the audit retention purge: deletes the oldest audit rows from before the retention cutoff (with their field diffs and redaction markers), and read counts from before it, through the sanctioned purge path. Does nothing while retention is forever. Run by the daily cron as an automation. Returns what was deleted and whether more is due.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer |   | ≥ 1, ≤ 2000, default `2000` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `years` | `1` or `2` or `7` or null | yes |   | Years to keep write audits; null keeps them forever |
| `cutoff` | string or null | yes |   |   |
| `auditRows` | number | yes |   |   |
| `changeRows` | number | yes |   |   |
| `redactions` | number | yes |   |   |
| `readCountRows` | number | yes |   |   |
| `more` | boolean | yes |   | True when more is due; call again |

## audit.readCounts

Reads by AI assistants, MCP clients, extensions and automations, counted per hour, actor, user, caller (connected app, extension or automation) and operation, newest hour first. Successful non-human reads are counted here instead of getting an audit.list entry each; failed or refused reads are still in audit.list. Filter by actor, userId, operation and an hour range (from inclusive, to exclusive). Admins only. Read-only.

|  |  |
| --- | --- |
| Permission | `audit:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `actor` | `"human"`, `"assistant"`, `"mcp"`, `"automation"`, `"extension"` |   |   |   |
| `userId` | string |   | max length 64 |   |
| `operation` | string |   | max length 100 |   |
| `from` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `to` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 500, default `100` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].hour` | string | yes |   |   |
| `items[].actor` | string | yes |   |   |
| `items[].userId` | string | yes |   |   |
| `items[].userName` | string or null | yes |   |   |
| `items[].caller` | string | yes |   | Connected app (cap_…), extension or automation id, or '' |
| `items[].operation` | string | yes |   |   |
| `items[].count` | number | yes |   |   |
| `items[].simulated` | number | yes |   | How many saw the session's pending changes simulated |
| `items[].firstAt` | string | yes |   |   |
| `items[].lastAt` | string | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## audit.retention

How long the audit log keeps write audits: forever (years null, the default) or 1, 2 or 7 years, and the cutoff that implies today. Only a human admin can change it. Read-only.

|  |  |
| --- | --- |
| Permission | `audit:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `years` | `1` or `2` or `7` or null | yes |   | Years to keep write audits; null keeps them forever |
| `cutoff` | string or null | yes |   | Write audits from before this are purged by the daily cron; null: kept forever |

## audit.setRetention

Set how long write audits are kept: null keeps them forever; 1, 2 or 7 years lets the daily cron delete older audit rows, their field diffs and read counts for good. Admins only, and only a person in the app: AI assistants, MCP clients and automations are refused. The change and every purge are themselves audited.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `years` | `1` or `2` or `7` or null | yes |   | Years to keep write audits; null keeps them forever |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `years` | `1` or `2` or `7` or null | yes |   | Years to keep write audits; null keeps them forever |
| `cutoff` | string or null | yes |   | Write audits from before this are purged by the daily cron; null: kept forever |
| `previousYears` | `1` or `2` or `7` or null | yes |   | Years to keep write audits; null keeps them forever |
