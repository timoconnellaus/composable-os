---
title: "Shop: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Item (`shop.item`)

A thing in the shop (a club hoodie, a protein bar), with its pictures and where it is sold. What is bought and counted is its variants: an item with one version has one.

|  |  |
| --- | --- |
| Plural | Items |
| Title field | `name` |
| Listed in | main |
| Behaviours | [`publishable`](/reference/behaviours/#publishable), [`public`](/reference/behaviours/#public) |
| Indexes | `category`; `whereSold` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `slug` | `slug` | Address |   |   |   |
| `description` | `richText` | Description |   |   |   |
| `image` | `image` | Picture |   |   |   |
| `image2` | `image` | Second picture |   |   |   |
| `image3` | `image` | Third picture |   |   |   |
| `category` | `text` | Category |   |   | Drinks, clothing, supplements: how the shop and the stock list group it. |
| `whereSold` | `select` | Where sold | yes | one of `both`, `online`, `in_person`; default `"both"` | Online (posted or collected), in person (bought at the gym with Take it now), or both. A fridge drink is in person only. |
| `option1Name` | `text` | First option |   |   | What the variants' first option is called, e.g. Size. |
| `option2Name` | `text` | Second option |   |   | e.g. Colour. |
| `option3Name` | `text` | Third option |   |   | e.g. Flavour. |
| `weight` | `number` | Weight (grams) |   | min 0 | Each variant's weight unless it has its own. Not used for postage yet. |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "publishable": {
    "content": [
      "name",
      "description",
      "image",
      "image2",
      "image3",
      "category",
      "option1Name",
      "option2Name",
      "option3Name"
    ],
    "slug": "slug"
  },
  "public": {
    "read": [
      "name",
      "slug",
      "description",
      "image",
      "image2",
      "image3",
      "category",
      "whereSold",
      "option1Name",
      "option2Name",
      "option3Name",
      "publishedAt"
    ]
  }
}
```

</details>

## Variant (`shop.variant`)

One version of an item that is bought and counted (large, black), with its price, stock, reorder level and usual supplier.

|  |  |
| --- | --- |
| Plural | Variants |
| Title field | `name` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`sellable`](/reference/behaviours/#sellable), [`stock`](/reference/behaviours/#stock), [`agreements`](/reference/behaviours/#agreements), [`public`](/reference/behaviours/#public) |
| Indexes | `item`; `sku`; `barcode`; `supplier`; `state` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `item` | `relation` | Item | yes | to `shop.item` |   |
| `name` | `text` | Name | yes |   | As the buyer's order shows it, e.g. Club hoodie, Large / Black. |
| `option1` | `text` | First option value |   |   | e.g. Large. |
| `option2` | `text` | Second option value |   |   | e.g. Black. |
| `option3` | `text` | Third option value |   |   |   |
| `sku` | `text` | SKU |   |   |   |
| `barcode` | `text` | Barcode |   |   |   |
| `price` | `currency` | Price | yes | a person's to change | Including tax. An AI's change of it waits for a person. |
| `costPrice` | `currency` | Cost price |   | read-only | What one cost when it was last received from a supplier. |
| `maxPerOrder` | `number` | Most per order |   | min 1 | The most one order may hold. Empty: 10. |
| `weight` | `number` | Weight (grams) |   | min 0 | Overrides the item's weight. |
| `reorderAt` | `number` | Reorder level |   | min 0 | At or below this many on hand, the stock is low and staff are told once. |
| `reorderQty` | `number` | Reorder quantity |   | min 1 | How many to order when it is low. |
| `supplier` | `relation` | Usual supplier |   | to `organisation` |   |
| `state` | `select` | State |   | one of `active`, `retired` |   |

### Relations

- `item` → `shop.item`
- `supplier` → `organisation`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "state",
    "initial": "active",
    "moves": [
      {
        "from": "active",
        "to": "retired",
        "by": [
          "staff"
        ]
      },
      {
        "from": "retired",
        "to": "active",
        "by": [
          "staff"
        ]
      }
    ]
  },
  "sellable": {
    "price": "price",
    "maxPerOrder": "maxPerOrder",
    "goods": {
      "soldIn": "item.whereSold"
    },
    "tax": {
      "code": "txcd_99999999"
    },
    "finance": {
      "category": {
        "key": "shop",
        "label": "Shop"
      },
      "earned": "at_sale"
    }
  },
  "stock": {
    "reorderAt": "reorderAt",
    "reorderQty": "reorderQty",
    "notify": "shop:stock"
  },
  "agreements": {
    "point": "buy",
    "label": "Buying from the shop",
    "inlineStep": true
  },
  "public": {
    "read": [
      "item",
      "name",
      "option1",
      "option2",
      "option3",
      "price",
      "maxPerOrder"
    ],
    "when": [
      {
        "field": "state",
        "in": [
          "active"
        ]
      },
      {
        "via": "item"
      }
    ]
  }
}
```

</details>

## Delivery option (`shop.delivery`)

A way an order's goods reach the buyer: posted, collected, or taken now at the gym. Its price is the host's postage; a paid post or collect order gets a shipment to pack.

|  |  |
| --- | --- |
| Plural | Delivery options |
| Title field | `name` |
| Listed in | settings |
| Behaviours | [`sellable`](/reference/behaviours/#sellable), [`public`](/reference/behaviours/#public) |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `kind` | `select` | Kind | yes | one of `post`, `collect`, `here` | Post (an address in its countries), collect (no address), or take it now (bought in person: nothing to pack). |
| `price` | `currency` | Price |   | a person's to change | Postage, including tax. 0 is free. A post option without one cannot be chosen. |
| `freeOver` | `currency` | Free over |   | a person's to change | No postage when the order's goods come to at least this. Empty: never free. |
| `countries` | `text` | Countries |   | a person's to change | Post only: two-letter codes separated by spaces (AU NZ), or * for everywhere no other post option names. Empty: it posts nowhere. |
| `collectAt` | `text` | Where to collect |   |   | Collect only: where the buyer picks it up, e.g. the front desk. |
| `active` | `boolean` | Active |   | default `true`; a person's to change | Off: buyers cannot choose it. |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "sellable": {
    "price": "price",
    "delivery": {
      "kind": "kind",
      "freeOver": "freeOver",
      "countries": "countries",
      "active": "active"
    },
    "tax": {
      "code": "txcd_92010001"
    },
    "grants": {
      "object": "shipment",
      "set": {
        "name": "line.title",
        "order": "order",
        "buyer": "order.person",
        "option": "item",
        "kind": "item.kind",
        "collectAt": "item.collectAt"
      },
      "void": "void"
    },
    "finance": {
      "category": {
        "key": "postage",
        "label": "Postage"
      },
      "earned": "at_sale"
    }
  },
  "public": {
    "read": [
      "name",
      "kind",
      "price",
      "freeOver",
      "countries",
      "collectAt",
      "active"
    ]
  }
}
```

</details>

## Shipment (`shop.shipment`)

What a paid order to post or collect gives staff to do: pack it, then send it or have it ready to collect. Made by the host when the order is paid; the buyer sees their own.

|  |  |
| --- | --- |
| Plural | Shipments |
| Title field | `name` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`customer`](/reference/behaviours/#customer) |
| Indexes | `state`; `order`; `buyer` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `order` | `text` | Order |   | read-only | The order that granted it, set by the host. |
| `buyer` | `relation` | Buyer |   | to `person`; read-only |   |
| `option` | `relation` | Delivery option |   | to `shop.delivery`; read-only |   |
| `kind` | `select` | Kind |   | one of `post`, `collect`; read-only |   |
| `collectAt` | `text` | Where to collect |   | read-only |   |
| `tracking` | `text` | Tracking reference |   |   |   |
| `state` | `select` | State |   | one of `to_pack`, `packed`, `sent`, `ready`, `collected`, `void` |   |
| `packedAt` | `datetime` | Packed at |   | read-only |   |
| `sentAt` | `datetime` | Sent at |   | read-only |   |
| `readyAt` | `datetime` | Ready at |   | read-only |   |
| `collectedAt` | `datetime` | Collected at |   | read-only |   |

### Relations

- `buyer` → `person`
- `option` → `shop.delivery`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "state",
    "initial": "to_pack",
    "moves": [
      {
        "from": "to_pack",
        "to": "packed",
        "by": [
          "staff"
        ]
      },
      {
        "from": "packed",
        "to": "to_pack",
        "by": [
          "staff"
        ]
      },
      {
        "from": [
          "to_pack",
          "packed"
        ],
        "to": "sent",
        "by": [
          "staff"
        ],
        "final": true
      },
      {
        "from": [
          "to_pack",
          "packed"
        ],
        "to": "ready",
        "by": [
          "staff"
        ]
      },
      {
        "from": "ready",
        "to": "collected",
        "by": [
          "staff"
        ],
        "final": true
      },
      {
        "from": [
          "to_pack",
          "packed",
          "ready"
        ],
        "to": "void",
        "by": [
          "host"
        ],
        "final": true
      }
    ]
  },
  "customer": {
    "field": "buyer",
    "read": [
      "name",
      "order",
      "option",
      "kind",
      "collectAt",
      "tracking",
      "state",
      "sentAt",
      "readyAt",
      "collectedAt"
    ],
    "write": []
  }
}
```

</details>

## Fields on other objects

### On `organisation`

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `supplier` | `boolean` | Supplier |   |   | We buy stock from this organisation. |
| `supplierAccount` | `text` | Our account number with them |   |   |   |
| `supplierEmail` | `email` | Email for orders |   |   | Where purchase orders to this supplier are sent. |
| `supplierLeadDays` | `number` | Lead time (days) |   | min 0 | How many days an order from this supplier usually takes to arrive. |
| `supplierNotes` | `longText` | Supplier notes |   |   |   |

## Views

| View | Object | Label |
| --- | --- | --- |
| `onlineShop` | `shop.item` | Sold online |
| `atTheGym` | `shop.item` | Sold in person |
| `stock` | `shop.variant` | Stock |
| `toPack` | `shop.shipment` | To pack and send |
| `readyToCollect` | `shop.shipment` | Ready to collect |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `itemVariants` | `` | Variants |
| tab | `personShipments` | `` | Shipments |
| tab | `supplierVariants` | `` | Supplies |
