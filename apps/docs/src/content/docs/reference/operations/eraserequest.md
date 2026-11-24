---
title: "eraseRequest.* operations"
description: "The core operations named eraseRequest.*"
sidebar:
  label: "eraseRequest"
editUrl: false
---

## eraseRequest.decline

Decline an open erase request with a reason (a record the org must keep). Closes the request and emails the reason to the person through the org's email connection. The account stays disabled. Admins only, humans only.

|  |  |
| --- | --- |
| Permission | `records:erase` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Erase request id (erq_…) from eraseRequest.list |
| `reason` | string | yes | min length 1, max length 2000 | Why the data must be kept |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `status` | `"declined"` | yes |   |   |
| `email` | `"sent"`, `"pending"`, `"not_sent"` | yes |   |   |
| `problem` | string |   |   |   |

## eraseRequest.list

List open erase requests: customers who deleted their account and asked to be erased, soonest due first, with when each was asked, when it is due and whether it is overdue. Action one with person.erase, or eraseRequest.decline with a reason. Admins only. Read-only.

|  |  |
| --- | --- |
| Permission | `audit:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].personId` | string | yes |   |   |
| `items[].personName` | string or null | yes |   |   |
| `items[].requestedAt` | string | yes |   |   |
| `items[].dueAt` | string | yes |   |   |
| `items[].overdue` | boolean | yes |   |   |
