---
title: "public.* operations"
description: "The core operations named public.*"
sidebar:
  label: "public"
editUrl: false
---

## public.get

From a tool called by the public or a customer: one record the public may read, with only the fields it declares. A record that is not public now is not found. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer`, `public` |
| Also | called only from a tool's run (`toolOnly`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object that declares what the public may read, e.g. `ticketing.event` |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `values` | map of any | yes |   |   |
| `currency` | string or null |   |   | For an object that is for sale: the currency every price of it is in (the deployment's one currency), or null until one is set. Absent for any other object. |

## public.list

From a tool called by the public or a customer: a page of the records of an object that the public may read (an event while it is on sale), with only the fields it declares. Filter and sort on those fields; pass nextCursor back as cursor. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer`, `public` |
| Also | called only from a tool's run (`toolOnly`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object that declares what the public may read, e.g. `ticketing.event` |
| `filter` | any |   |   |   |
| `sort` | object |   |   |   |
| `sort.field` | string | yes | min length 1, max length 64 |   |
| `sort.direction` | `"asc"`, `"desc"` |   | default `"asc"` |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].values` | map of any | yes |   |   |
| `nextCursor` | string or null | yes |   |   |
| `currency` | string or null |   |   | For an object that is for sale: the currency every price of it is in (the deployment's one currency), or null until one is set. Absent for any other object. |
