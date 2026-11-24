---
title: "stock.* operations"
description: "The core operations named stock.*"
sidebar:
  label: "stock"
editUrl: false
---

## stock.adjust

Corrects how many of a record there are, by a signed quantity with a reason (found two more, one broken in the stockroom). Written in the ledger as `adjusted` at the default place. Refused when it would leave fewer on hand than unpaid orders hold, with the numbers. Not for deliveries, counts or write-offs, which are records of their own. Needs stock:adjust. An assistant's or MCP client's call always waits for a person who holds it too.

|  |  |
| --- | --- |
| Permission | `stock:adjust` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `mcp` |
| Also | always reviewed |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An extension object that declares stock |
| `id` | string | yes | min length 1, max length 64 |   |
| `quantity` | integer | yes | ≥ -1000000, ≤ 1000000 | Signed: positive adds, negative removes |
| `reason` | string | yes | min length 1, max length 500 | Why: kept in the ledger |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `movementId` | string | yes |   |   |
| `onHand` | number | yes |   | On hand once the movement is written |

## stock.get

How many of a thing in stock there are (a variant of an item in a shop). Staff get on hand (sold ones gone), held (by orders being paid for), available (on hand less held) and the reorder level, and the last five movements. Customers and the public get only what the object shows: in stock or sold out, a low-stock warning, or the number available. Read-only; holds nothing.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An extension object that declares stock |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `status` | `"in_stock"`, `"low"`, `"sold_out"` | yes |   | `low` only when the object shows a low-stock warning and few are left |
| `available` | number |   |   | How many can be bought now. Shown to outsiders only when `show` allows |
| `onHand` | number |   |   | Staff only: how many there are, sold ones gone |
| `held` | number |   |   | Staff only: how many unpaid orders hold |
| `reorderAt` | number or null |   |   |   |
| `reorderQty` | number or null |   |   |   |
| `atReorderLevel` | boolean |   |   |   |
| `show` | `"exact"`, `"low"`, `"availability"` |   |   |   |
| `lowAt` | number or null |   |   |   |
| `recent` | array of object |   |   | Staff only: the last five movements, newest first; the rest is stock.movements |
| `recent[].id` | string | yes |   |   |
| `recent[].kind` | string | yes |   |   |
| `recent[].quantity` | number | yes |   |   |
| `recent[].place` | string | yes |   |   |
| `recent[].at` | string | yes |   |   |
| `recent[].note` | string or null | yes |   |   |

## stock.movements

The stock ledger of one record, newest first: every movement with its kind (opening, received, sold, returned, written_off, counted, adjusted, used), signed quantity, place, what made it (an order line, a record or a person), who and when. Movements are never changed or deleted. Staff only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An extension object that declares stock |
| `id` | string | yes | min length 1, max length 64 |   |
| `limit` | integer |   | ≥ 1, ≤ 100, default `50` |   |
| `before` | string |   | max length 64 | A movement id from the last page: the movements older than it |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].place` | string | yes |   |   |
| `items[].quantity` | number | yes |   | Signed: in is positive, out negative |
| `items[].kind` | `"opening"`, `"received"`, `"sold"`, `"returned"`, `"written_off"`, `"counted"`, `"adjusted"`, `"used"` | yes |   |   |
| `items[].sourceType` | string | yes |   |   |
| `items[].sourceId` | string | yes |   |   |
| `items[].by` | string or null | yes |   | The staff account; null when the host made it |
| `items[].at` | string | yes |   |   |
| `items[].note` | string or null | yes |   |   |
| `items[].unitCost` | number or null | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## stock.opening

Records a record's opening stock: how many there are when it is first counted (also by an import). Once per record; a later change is stock.adjust, a delivery a receipt. Written in the ledger as `opening` at the default place. Needs stock:adjust. An assistant's or MCP client's call always waits for a person who holds it too.

|  |  |
| --- | --- |
| Permission | `stock:adjust` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `mcp` |
| Also | always reviewed |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An extension object that declares stock |
| `id` | string | yes | min length 1, max length 64 |   |
| `quantity` | integer | yes | ≥ 1, ≤ 1000000 |   |
| `note` | string |   | max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `movementId` | string | yes |   |   |
| `onHand` | number | yes |   | On hand once the movement is written |
