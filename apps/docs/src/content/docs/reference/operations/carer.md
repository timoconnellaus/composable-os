---
title: "carer.* operations"
description: "The core operations named carer.*"
sidebar:
  label: "carer"
editUrl: false
---

## carer.end

End a looks-after row (carer.list gives its id): from the next read the account no longer reads the person's notes kept to their coaches, except the ones it wrote. The row is kept, ended, with who ended it. Only a person on the staff with people:link can do this. Audited.

|  |  |
| --- | --- |
| Permission | `people:link` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The row (pcr_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `personId` | string | yes |   |   |
| `user` | object | yes |   |   |
| `user.id` | string | yes |   |   |
| `user.name` | string or null | yes |   |   |
| `startedAt` | string | yes |   |   |
| `setBy` | string | yes |   |   |
| `endedAt` | string or null | yes |   |   |
| `endedBy` | string or null | yes |   |   |

## carer.list

Who looks after a person (their coaches): the staff accounts that read the person's notes kept to their coaches, with who set each and when, live ones first, and (with ended) the rows that have ended. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 | The person (per_…) |
| `ended` | boolean |   | default `false` | Include rows that have ended |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].personId` | string | yes |   |   |
| `items[].user` | object | yes |   |   |
| `items[].user.id` | string | yes |   |   |
| `items[].user.name` | string or null | yes |   |   |
| `items[].startedAt` | string | yes |   |   |
| `items[].setBy` | string | yes |   |   |
| `items[].endedAt` | string or null | yes |   |   |
| `items[].endedBy` | string or null | yes |   |   |

## carer.set

Say that a staff account looks after a person (their coach): from then on it reads the person's notes kept to their coaches, and stops when the row is ended with carer.end. Choose it on the person's page; it is never worked out from bookings. Refused when the account already looks after them. Only a person on the staff with people:link can do this: never the assistant, an MCP client or code. Audited.

|  |  |
| --- | --- |
| Permission | `people:link` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 | The person (per_…) |
| `userId` | string | yes | min length 1, max length 64 | The staff account (usr_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `personId` | string | yes |   |   |
| `user` | object | yes |   |   |
| `user.id` | string | yes |   |   |
| `user.name` | string or null | yes |   |   |
| `startedAt` | string | yes |   |   |
| `setBy` | string | yes |   |   |
| `endedAt` | string or null | yes |   |   |
| `endedBy` | string or null | yes |   |   |
