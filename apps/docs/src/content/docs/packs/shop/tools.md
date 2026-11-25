---
title: "Shop: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.shop.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### stockLevels

The stock of the shop's active variants: on hand, held by orders being paid for, available, the reorder level and quantity, and the usual supplier, lowest first. Use lowOnly for 'what's low?' (on hand at or below the reorder level), and category or supplierId to narrow it. Numbers are the host's, kept from the stock ledger; this changes nothing. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `shop:read`, `shop:stock` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lowOnly` | boolean |   |   | Only variants at or below their reorder level |
| `category` | string |   | max length 80 | Only items of this category |
| `supplierId` | string |   | max length 64 | Only variants this organisation supplies |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `variants` | array of object | yes |   |   |
| `variants[].variantId` | string | yes |   |   |
| `variants[].variant` | string or null | yes |   |   |
| `variants[].itemId` | string or null | yes |   |   |
| `variants[].item` | string or null | yes |   |   |
| `variants[].category` | string or null | yes |   |   |
| `variants[].onHand` | number | yes |   | On the shelf now: opening, received and returned, less sold |
| `variants[].held` | number | yes |   | Held by orders being paid for |
| `variants[].available` | number | yes |   | On hand less held: what can still be sold |
| `variants[].reorderAt` | number or null | yes |   |   |
| `variants[].reorderQty` | number or null | yes |   |   |
| `variants[].low` | boolean | yes |   | On hand is at or below the reorder level |
| `variants[].supplierId` | string or null | yes |   |   |
| `variants[].supplier` | string or null | yes |   |   |
| `truncated` | boolean | yes |   |   |

### shipmentsToSend

What paid online orders have left to do: shipments to pack, packed ones to send or have ready, and those waiting to be collected, oldest first, with the buyer's name, the kind (post or collect), where to collect and the tracking reference. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `shop:fulfil` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `state` | `"to_pack"`, `"packed"`, `"ready"` |   |   | Only shipments in this state; left out, all three |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `shipments` | array of object | yes |   |   |
| `shipments[].id` | string | yes |   |   |
| `shipments[].name` | string or null | yes |   |   |
| `shipments[].orderId` | string or null | yes |   |   |
| `shipments[].kind` | string or null | yes |   | post or collect |
| `shipments[].state` | string or null | yes |   |   |
| `shipments[].tracking` | string or null | yes |   |   |
| `shipments[].collectAt` | string or null | yes |   |   |
| `shipments[].buyerId` | string or null | yes |   |   |
| `shipments[].buyer` | string or null | yes |   | The buyer's name, if they are a Person |
| `shipments[].createdAt` | string or null | yes |   |   |

### markPacked

Mark a shipment packed: its goods are boxed and waiting to be sent or collected. Safe to call twice; two people at once: one marks it, the other is told.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `shop:fulfil` |
| Button on | `shop.shipment` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `shipmentId` | string | yes | min length 1, max length 64 | The shipment's id |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `moved` | boolean | yes |   |   |
| `message` | string | yes |   |   |
| `shipment` | object | yes |   |   |
| `shipment.id` | string | yes |   |   |
| `shipment.name` | string or null | yes |   |   |
| `shipment.orderId` | string or null | yes |   |   |
| `shipment.kind` | string or null | yes |   | post or collect |
| `shipment.state` | string or null | yes |   |   |
| `shipment.tracking` | string or null | yes |   |   |
| `shipment.collectAt` | string or null | yes |   |   |
| `shipment.buyerId` | string or null | yes |   |   |
| `shipment.buyer` | string or null | yes |   | The buyer's name, if they are a Person |
| `shipment.createdAt` | string or null | yes |   |   |

### markSent

Mark a posted shipment sent, with the carrier's tracking reference if there is one. It cannot be undone. The buyer sees the state and the reference on their own shipments.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `shop:fulfil` |
| Button on | `shop.shipment` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `shipmentId` | string | yes | min length 1, max length 64 | The shipment's id |
| `tracking` | string |   | max length 200 | The carrier's tracking reference |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `moved` | boolean | yes |   |   |
| `message` | string | yes |   |   |
| `shipment` | object | yes |   |   |
| `shipment.id` | string | yes |   |   |
| `shipment.name` | string or null | yes |   |   |
| `shipment.orderId` | string or null | yes |   |   |
| `shipment.kind` | string or null | yes |   | post or collect |
| `shipment.state` | string or null | yes |   |   |
| `shipment.tracking` | string or null | yes |   |   |
| `shipment.collectAt` | string or null | yes |   |   |
| `shipment.buyerId` | string or null | yes |   |   |
| `shipment.buyer` | string or null | yes |   | The buyer's name, if they are a Person |
| `shipment.createdAt` | string or null | yes |   |   |

### markReady

Mark a shipment to collect as ready: its goods are waiting where the buyer collects them.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `shop:fulfil` |
| Button on | `shop.shipment` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `shipmentId` | string | yes | min length 1, max length 64 | The shipment's id |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `moved` | boolean | yes |   |   |
| `message` | string | yes |   |   |
| `shipment` | object | yes |   |   |
| `shipment.id` | string | yes |   |   |
| `shipment.name` | string or null | yes |   |   |
| `shipment.orderId` | string or null | yes |   |   |
| `shipment.kind` | string or null | yes |   | post or collect |
| `shipment.state` | string or null | yes |   |   |
| `shipment.tracking` | string or null | yes |   |   |
| `shipment.collectAt` | string or null | yes |   |   |
| `shipment.buyerId` | string or null | yes |   |   |
| `shipment.buyer` | string or null | yes |   | The buyer's name, if they are a Person |
| `shipment.createdAt` | string or null | yes |   |   |

### markCollected

Mark a ready shipment collected: the buyer has picked it up. It cannot be undone.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `shop:fulfil` |
| Button on | `shop.shipment` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `shipmentId` | string | yes | min length 1, max length 64 | The shipment's id |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `moved` | boolean | yes |   |   |
| `message` | string | yes |   |   |
| `shipment` | object | yes |   |   |
| `shipment.id` | string | yes |   |   |
| `shipment.name` | string or null | yes |   |   |
| `shipment.orderId` | string or null | yes |   |   |
| `shipment.kind` | string or null | yes |   | post or collect |
| `shipment.state` | string or null | yes |   |   |
| `shipment.tracking` | string or null | yes |   |   |
| `shipment.collectAt` | string or null | yes |   |   |
| `shipment.buyerId` | string or null | yes |   |   |
| `shipment.buyer` | string or null | yes |   | The buyer's name, if they are a Person |
| `shipment.createdAt` | string or null | yes |   |   |

## Automations

None.

## Dashboards

| Dashboard | Label | Widgets |
| --- | --- | --- |
| `shopOverview` |   | 6 |

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`query.sql`](/reference/operations/query/#querysql)

Host modules it asks for: `ops`.
