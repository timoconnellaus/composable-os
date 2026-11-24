---
title: "changeset.* operations"
description: "The core operations named changeset.*"
sidebar:
  label: "changeset"
editUrl: false
---

## changeset.begin

Start a titled change set for one task, e.g. 'Import contacts from the Acme offsite'. Everything this session queues for approval afterwards goes into it, so a person reviews the task as one unit. Call changeset.commit when the task is done. Starting a new one commits any change set you had open. Writes that apply immediately are not affected.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `title` | string | yes | min length 1, max length 200 | What the task is |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `changeSetId` | string | yes |   |   |
| `title` | string | yes |   |   |

## changeset.commit

Finish the change set this session is filling (or the one named) so it is ready for review; optionally (re)title it. Later queued actions start a new change set. Nothing is applied until a person approves it. Returns the set with its counts.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `changeSetId` | string (starts_with) |   | max length 64, pattern `^chs_.*` | Change set id (chs_…) |
| `title` | string |   | min length 1, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `sessionId` | string or null | yes |   |   |
| `clientId` | string or null | yes |   |   |
| `clientName` | string or null | yes |   |   |
| `userId` | string | yes |   |   |
| `userName` | string or null | yes |   |   |
| `actor` | string | yes |   |   |
| `explicit` | boolean | yes |   |   |
| `state` | `"open"`, `"committed"`, `"closed"` | yes |   |   |
| `status` | `"awaiting_review"`, `"done"`, `"empty"` | yes |   |   |
| `counts` | object | yes |   |   |
| `counts.pending` | number | yes |   |   |
| `counts.applied` | number | yes |   |   |
| `counts.failed` | number | yes |   |   |
| `counts.skipped` | number | yes |   |   |
| `counts.rejected` | number | yes |   |   |
| `counts.expired` | number | yes |   |   |
| `counts.total` | number | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `committedAt` | string or null | yes |   |   |
| `closedAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
