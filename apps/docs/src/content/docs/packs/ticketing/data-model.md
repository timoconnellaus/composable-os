---
title: "Ticketing: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Event (`ticketing.event`)

Something tickets are sold for: a camp, a workshop, a night.

|  |  |
| --- | --- |
| Plural | Events |
| Title field | `name` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`capacity`](/reference/behaviours/#capacity), [`public`](/reference/behaviours/#public), [`customerVia`](/reference/behaviours/#customervia) |
| Indexes | `status, startsAt`; `startsAt` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `startsAt` | `datetime` | Starts |   |   |   |
| `endsAt` | `datetime` | Ends |   |   |   |
| `timezone` | `timezone` | Time zone | yes |   | The event's own time zone, e.g. Asia/Bangkok for a camp in Thailand. Its dates are shown, and its reminders sent, on this zone's days. Empty: this deployment's zone. |
| `venue` | `text` | Venue |   |   |   |
| `taxCountry` | `text` | Country (for tax) |   |   | Two letters, e.g. AU. Needed to sell tickets while tax at checkout is on: tickets are taxed where the event is held. |
| `taxRegion` | `text` | State or region (for tax) |   |   |   |
| `taxPostcode` | `text` | Postcode (for tax) |   |   |   |
| `taxCity` | `text` | City (for tax) |   |   |   |
| `taxAddress` | `text` | Street address (for tax) |   |   |   |
| `description` | `longText` | Description |   |   |   |
| `image` | `url` | Image |   |   |   |
| `status` | `select` | Status |   | one of `draft`, `on_sale`, `ended`, `cancelled` |   |
| `places` | `number` | Places |   |   | How many people the event holds across all its ticket types. Empty: no limit beyond each ticket type's own. |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "status",
    "initial": "draft",
    "moves": [
      {
        "from": "draft",
        "to": "on_sale",
        "by": [
          "staff"
        ]
      },
      {
        "from": "on_sale",
        "to": "draft",
        "by": [
          "staff"
        ]
      },
      {
        "from": "on_sale",
        "to": "ended",
        "by": [
          "staff"
        ],
        "final": true
      },
      {
        "from": [
          "draft",
          "on_sale"
        ],
        "to": "cancelled",
        "by": [
          "staff"
        ],
        "final": true
      }
    ]
  },
  "capacity": {
    "places": "places"
  },
  "public": {
    "read": [
      "name",
      "startsAt",
      "endsAt",
      "timezone",
      "venue",
      "description",
      "image",
      "status"
    ],
    "when": {
      "field": "status",
      "in": [
        "on_sale"
      ]
    }
  },
  "customerVia": {
    "from": "ticketing.ticket",
    "field": "event",
    "read": [
      "name",
      "startsAt",
      "endsAt",
      "timezone",
      "venue",
      "status"
    ]
  }
}
```

</details>

## Ticket type (`ticketing.tickettype`)

One kind of ticket for an event, with its own price and places: a package, a room type. One ticket is one person.

|  |  |
| --- | --- |
| Plural | Ticket types |
| Title field | `name` |
| Listed in | settings |
| Behaviours | [`capacity`](/reference/behaviours/#capacity), [`agreements`](/reference/behaviours/#agreements), [`sellable`](/reference/behaviours/#sellable), [`public`](/reference/behaviours/#public), [`customerVia`](/reference/behaviours/#customervia) |
| Indexes | `event` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `event` | `relation` | Event | yes | to `ticketing.event` |   |
| `name` | `text` | Name | yes |   |   |
| `description` | `longText` | Description |   |   |   |
| `price` | `currency` | Price | yes |   |   |
| `places` | `number` | Places |   |   | How many of this ticket type there are. Empty: only the event's limit. |
| `onSaleFrom` | `datetime` | On sale from |   |   |   |
| `onSaleUntil` | `datetime` | On sale until |   |   |   |
| `maxPerOrder` | `number` | Most per order |   |   | The most one order may hold. Empty: 10. |
| `depositAmount` | `currency` | Deposit |   |   | Set with a balance due date to let buyers pay a deposit now. |
| `balanceDue` | `date` | Balance due |   |   |   |

### Relations

- `event` → `ticketing.event`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "capacity": {
    "places": "places",
    "pool": "event",
    "show": "low",
    "lowAt": 10
  },
  "agreements": {
    "point": "event",
    "label": "Buying a ticket",
    "suggests": [
      "waiver"
    ],
    "inlineStep": true
  },
  "sellable": {
    "price": "price",
    "saleWindow": {
      "from": "onSaleFrom",
      "until": "onSaleUntil"
    },
    "maxPerOrder": "maxPerOrder",
    "deposit": {
      "amount": "depositAmount",
      "balanceDue": "balanceDue"
    },
    "grants": {
      "object": "ticket",
      "set": {
        "name": "line.title",
        "tickettype": "item",
        "event": "item.event",
        "holder": "order.person",
        "order": "order",
        "code": "code"
      },
      "void": "void"
    },
    "tax": {
      "code": "txcd_50010001",
      "place": {
        "via": "event",
        "country": "taxCountry",
        "region": "taxRegion",
        "postcode": "taxPostcode",
        "city": "taxCity",
        "line1": "taxAddress"
      }
    },
    "finance": {
      "category": {
        "key": "tickets",
        "label": "Tickets"
      },
      "earned": "at_date",
      "at": "event.startsAt"
    }
  },
  "public": {
    "read": [
      "event",
      "name",
      "description",
      "price",
      "onSaleFrom",
      "onSaleUntil",
      "maxPerOrder",
      "depositAmount",
      "balanceDue"
    ],
    "when": {
      "via": "event",
      "field": "status",
      "in": [
        "on_sale"
      ]
    }
  },
  "customerVia": {
    "from": "ticketing.ticket",
    "field": "tickettype",
    "read": [
      "name"
    ]
  }
}
```

</details>

## Ticket (`ticketing.ticket`)

One person's ticket, granted by the host when its order was paid, with a code that is checked at the door.

|  |  |
| --- | --- |
| Plural | Tickets |
| Title field | `name` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`agreements`](/reference/behaviours/#agreements), [`customer`](/reference/behaviours/#customer) |
| Indexes | `code`; `event, state`; `holder`; `order` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `code` | `text` | Code |   | read-only | Made by the host when the ticket is granted. The QR code carries only this. |
| `tickettype` | `relation` | Ticket type | yes | to `ticketing.tickettype` |   |
| `event` | `relation` | Event | yes | to `ticketing.event` |   |
| `holder` | `relation` | Holder |   | to `person` |   |
| `order` | `text` | Order |   | read-only | The order that granted this ticket, set by the host. |
| `state` | `select` | State |   | one of `valid`, `used`, `void` |   |
| `usedAt` | `datetime` | Checked in at |   |   |   |
| `usedBy` | `user` | Checked in by |   |   |   |
| `usedByName` | `text` | Checked in by (name) |   |   | The name of whoever checked the ticket in, as it was then. |

### Relations

- `tickettype` → `ticketing.tickettype`
- `event` → `ticketing.event`
- `holder` → `person`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "state",
    "initial": "valid",
    "moves": [
      {
        "from": "valid",
        "to": "used",
        "by": [
          "staff"
        ]
      },
      {
        "from": "used",
        "to": "valid",
        "by": [
          "staff"
        ]
      },
      {
        "from": [
          "valid",
          "used"
        ],
        "to": "void",
        "by": [
          "staff",
          "host"
        ],
        "final": true
      }
    ]
  },
  "agreements": {
    "point": "event",
    "label": "Buying a ticket",
    "suggests": [
      "waiver"
    ],
    "enter": [
      "valid"
    ],
    "keeps": [
      "valid",
      "used"
    ],
    "person": "holder",
    "inlineStep": true
  },
  "customer": {
    "field": "holder",
    "read": [
      "event",
      "tickettype",
      "code",
      "state"
    ],
    "write": []
  }
}
```

</details>

## Views

| View | Object | Label |
| --- | --- | --- |
| `onSale` | `ticketing.event` | On sale |
| `thisWeek` | `ticketing.event` | This week's events |
| `unusedTickets` | `ticketing.ticket` | Unused tickets |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `personTickets` | `` | Tickets |
