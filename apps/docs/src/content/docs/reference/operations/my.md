---
title: "my.* operations"
description: "The core operations named my.*"
sidebar:
  label: "my"
editUrl: false
---

## my.create

From a tool called by a customer: create a record that belongs to that customer. The customer field is set by the host to the caller and cannot be given; with forPersonId it is set to that Person instead, only when they are a live dependant of the caller (a child staff linked to them) and the object lets guardians write its records; anyone else is not found. Other values must be fields the object lists as writable by its customer, or that the tool lists in customerFields. Returns the record as the customer may see it.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | called only from a tool's run (`toolOnly`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object that declares a customer, e.g. `shop.order` |
| `values` | map of any |   | default `{}` | Field values by name. Only fields the customer, or this tool, may set. |
| `forPersonId` | string |   | min length 1, max length 64 | A dependant of the caller to make it for (ADR 0540); left out, it is the caller's own |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `values` | map of any | yes |   |   |

## my.delete

From a tool called by a customer: put one of that customer's own records in the Trash, where its object lets its customer remove their own (`customer.delete`). A record that is not theirs, or of an object that does not allow it, is reported as not found or refused. Staff can restore it from the Trash. Returns the id.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | called only from a tool's run (`toolOnly`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object that declares a customer, e.g. `shop.order` |
| `id` | string | yes | min length 1, max length 64 | Record id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |

## my.get

One of your own records (or one that a record of yours points to, such as your ticket's event), as a signed-in customer, with only the fields you may see. A record that is not yours is not found. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | The object, e.g. `person` or an extension object such as `shop.order` |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `values` | map of any | yes |   |   |
| `currency` | string or null |   |   | For an object that is for sale: the currency every price of it is in (the deployment's one currency), or null until one is set. Absent for any other object. |

## my.list

A page of your own records of an object, as a signed-in customer (and the records every signed-in customer may read, where the object shares some, and the ones a record of yours points to, such as your ticket's event): only the records that are yours and only the fields you may see. Filter and sort on those fields; pass nextCursor back as cursor for the next page. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | The object, e.g. `person` or an extension object such as `shop.order` |
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

## my.update

From a tool called by a customer: change one of that customer's own records. A record that is not theirs is reported as not found. Values must be fields the object lists as writable by its customer, or that the tool lists in customerFields; whose record it is can never change. Returns the record as the customer may see it.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | called only from a tool's run (`toolOnly`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object that declares a customer, e.g. `shop.order` |
| `id` | string | yes | min length 1, max length 64 | Record id |
| `values` | map of any | yes |   | Field values by name. Only fields the customer, or this tool, may set. |
| `from` | string |   | min length 1, max length 64 | Only move the record if it is still in this state, and move it out of it (ADR 0437): refused as a conflict when it has left it. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `values` | map of any | yes |   |   |
