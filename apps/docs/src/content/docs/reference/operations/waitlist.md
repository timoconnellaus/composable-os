---
title: "waitlist.* operations"
description: "The core operations named waitlist.*"
sidebar:
  label: "waitlist"
editUrl: false
---

## waitlist.passOver

Platform use only (the minute cron, as the host): note on a waiter that it could not be moved in when a place was free, and why (its spend was refused). It stays waiting.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `on` | string | yes | min length 1, max length 64 |   |
| `reason` | string | yes | min length 1, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |

## waitlist.position

Where a waiting record (a booking on a class's waitlist) stands: its position (1 is next) and how many are waiting. Staff any; a signed-in customer only their own record (anyone else's is not found). Never who the others are. Null position when it is not waiting.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `position` | integer or null | yes |   |   |
| `waiting` | integer or null | yes |   |   |

## waitlist.promote

Platform use only (the minute cron, as the host): move one waiter of a waitlist into the place the waitlist holds for it, from waiting or not at all, before the cut-off. Spends what the move spends. Refused when the record is no longer waiting, the cut-off has passed (rule waitlist, reason closed), there is no place (rule capacity) or the spend is refused (rule allowance).

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `on` | string | yes | min length 1, max length 64 | The record it waits on (the class): it must still be |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `promoted` | `true` | yes |   |   |

## waitlist.release

Platform use only (the minute cron, as the host): give back to everyone the places a waitlist holds on one record (a class) that were held at or before `before` and that nobody waiting could take, or that the cut-off has reached.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 | The claimant object whose waitlist it is |
| `on` | string | yes | min length 1, max length 64 | The record whose places are held |
| `before` | string (date-time) | yes | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `on` | string | yes |   |   |
