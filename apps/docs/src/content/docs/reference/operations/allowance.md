---
title: "allowance.* operations"
description: "The core operations named allowance.*"
sidebar:
  label: "allowance"
editUrl: false
---

## allowance.get

How many uses a pass, membership or other allowance holder has spent and has left, in the period containing `at` (default now): this week or month (from Monday, or the 1st, in its time zone), or in all for a pass of N. Staff also get its uses per period (null is unlimited), whether it can be spent (live), and the dates it is valid between; a signed-in customer reads their own only, with the terms their own record shows them. Anyone else's is not found. Read-only: uses are spent by booking.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 | An extension object that holds an allowance |
| `id` | string | yes | min length 1, max length 64 |   |
| `at` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` | The time to read the period of (a class's start), ISO 8601; default now |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `personId` | string or null |   |   | Staff only |
| `uses` | number or null |   |   | Uses per period; null is unlimited. Left out when the caller may not read it |
| `per` | `"total"`, `"week"`, `"month"` |   |   |   |
| `zone` | string |   |   | The time zone weeks and months are counted in |
| `validFrom` | string or null |   |   |   |
| `validUntil` | string or null |   |   | A spender's time must be before this |
| `live` | boolean |   |   | Its state lets it be spent (not paused, used up, ended or void) |
| `at` | string | yes |   | The time the period was read for |
| `payable` | boolean | yes |   | It can pay for something at `at`: live, out of the Trash and within its dates (uses aside) |
| `period` | object | yes |   |   |
| `period.key` | string | yes |   | total, week:&lt;Monday's local date&gt; or month:&lt;YYYY-MM&gt; |
| `period.startsAt` | string | yes |   |   |
| `period.endsAt` | string | yes |   |   |
| `period.used` | number | yes |   |   |
| `period.left` | number or null | yes |   | Uses that can still be spent in it; 0 when the holder cannot pay then, null when unlimited |

## allowance.list

allowance.get for up to 50 holders of one object at once (a member's passes): each one's numbers in the period containing `at` (default now), and whether it can pay then. Staff any; a signed-in customer their own only: an id they cannot see is left out. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 | An extension object that holds an allowance |
| `ids` | array of string | yes | at least 1, at most 50 |   |
| `at` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].personId` | string or null |   |   | Staff only |
| `items[].uses` | number or null |   |   | Uses per period; null is unlimited. Left out when the caller may not read it |
| `items[].per` | `"total"`, `"week"`, `"month"` |   |   |   |
| `items[].zone` | string |   |   | The time zone weeks and months are counted in |
| `items[].validFrom` | string or null |   |   |   |
| `items[].validUntil` | string or null |   |   | A spender's time must be before this |
| `items[].live` | boolean |   |   | Its state lets it be spent (not paused, used up, ended or void) |
| `items[].at` | string | yes |   | The time the period was read for |
| `items[].payable` | boolean | yes |   | It can pay for something at `at`: live, out of the Trash and within its dates (uses aside) |
| `items[].period` | object | yes |   |   |
| `items[].period.key` | string | yes |   | total, week:&lt;Monday's local date&gt; or month:&lt;YYYY-MM&gt; |
| `items[].period.startsAt` | string | yes |   |   |
| `items[].period.endsAt` | string | yes |   |   |
| `items[].period.used` | number | yes |   |   |
| `items[].period.left` | number or null | yes |   | Uses that can still be spent in it; 0 when the holder cannot pay then, null when unlimited |
