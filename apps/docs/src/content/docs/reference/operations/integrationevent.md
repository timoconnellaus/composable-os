---
title: "integrationEvent.* operations"
description: "The core operations named integrationEvent.*"
sidebar:
  label: "integrationEvent"
editUrl: false
---

## integrationEvent.list

Inbound events, newest first: verified webhook deliveries (typed, e.g. github.push, invoice.paid) and sync events (email.received, email.sent, meeting.created …). Stage 5 automations will trigger on them. Filter by source and type; page with cursor. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `source` | `"webhook"`, `"sync"` |   |   |   |
| `type` | string |   | max length 200 |   |
| `connectionId` | string (starts_with) |   | max length 64, pattern `^con_.*` | Connection id (con_…) |
| `cursor` | string |   | max length 64 | The last id of the previous page |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].source` | `"webhook"`, `"sync"` | yes |   |   |
| `items[].connectionId` | string or null | yes |   |   |
| `items[].type` | string | yes |   |   |
| `items[].externalId` | string or null | yes |   |   |
| `items[].payload` | any | yes |   |   |
| `items[].occurredAt` | string | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].consumedAt` | string or null | yes |   |   |
| `nextCursor` | string or null | yes |   |   |
