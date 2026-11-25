---
title: "Offers: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Discount (`offers.discount`)

Money off: a percentage, an amount or a set price, on what it covers, for whom, when and how often. Applied by a promo code or by itself (a member's price). Made as a draft and made live by a person.

|  |  |
| --- | --- |
| Plural | Discounts |
| Title field | `name` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`discount`](/reference/behaviours/#discount) |
| Indexes | `state`; `automatic, state` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   | What staff and the buyer's order call it (January sale, Members' drop-in). |
| `note` | `longText` | Note |   |   | Why it exists, for staff. |
| `kind` | `select` | What is off | yes | one of `percent`, `amount`, `price`; default `"percent"` |   |
| `percent` | `number` | Percentage off |   | min 1; max 100 | For a percentage: 1 to 100. Rounded down on each line by the host. |
| `amount` | `currency` | Amount |   | min 0 | For an amount off: the money off the order, spread over what it covers. For a set price: what each one costs (never more than its own price). |
| `automatic` | `boolean` | Applies by itself |   | default `false` | On: it applies with no code to everyone it is for (a member's price, a customer rate). Off: only with a code. |
| `code` | `text` | Promo code |   |   | One word anyone may type (JANUARY26), at least 6 letters or digits. Kept in capitals without spaces; no two discounts share one. For single-use codes, make a batch. |
| `who` | `select` | Who it is for |   | one of `anyone`, `signed_in`, `members`, `new_customers`, `organisation`, `tag`; default `"anyone"` | Anyone includes a guest. Every other choice needs a buyer who signed in (or staff buying for a person): a guest never gets it. |
| `organisations` | `relation` | Organisations |   | to `organisation`, many | For an organisation's people: a customer rate. |
| `tag` | `text` | Tag |   |   | For people with this tag. |
| `appliesTo` | `multiSelect` | Applies to |   | one of `bookings.booking`, `ticketing.tickettype`, `memberships.passtype`, `courses.course`, `courses.bundle`, `shop.variant` | What it takes money off. Empty: everything but postage. |
| `from` | `date` | From |   |   | From the start of this day (UTC). |
| `until` | `date` | Until |   |   | To the end of this day (UTC). |
| `totalUses` | `number` | Uses in total |   | min 1 | The most orders it may be used on, across everyone. Empty: no limit. |
| `perPerson` | `number` | Uses per person |   | min 1 | The most orders one person may use it on (addresses with a +tag count as one). A guest never gets a discount with this limit. Empty: no limit. |
| `minSpend` | `currency` | Minimum spend |   | min 0 | The least what it covers must cost on the order. Empty: none. |
| `state` | `select` | State |   | one of `draft`, `active`, `paused`, `ended`; default `"draft"` |   |

### Relations

- `organisations` → `organisation` (many)

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "state",
    "initial": "draft",
    "moves": [
      {
        "from": [
          "draft",
          "paused"
        ],
        "to": "active",
        "by": [
          "host"
        ],
        "tools": [
          "activateDiscount"
        ]
      },
      {
        "from": "active",
        "to": "paused",
        "by": [
          "host"
        ],
        "tools": [
          "pauseDiscount"
        ]
      },
      {
        "from": [
          "draft",
          "active",
          "paused"
        ],
        "to": "ended",
        "by": [
          "host"
        ],
        "tools": [
          "endDiscount"
        ],
        "final": true
      }
    ]
  },
  "discount": {
    "kind": "kind",
    "percent": "percent",
    "amount": "amount",
    "live": [
      "active"
    ],
    "automatic": "automatic",
    "code": "code",
    "codes": {
      "object": "code",
      "discount": "discount",
      "word": "word",
      "uses": "uses",
      "active": "active",
      "hashed": true
    },
    "who": "who",
    "organisations": "organisations",
    "tag": "tag",
    "objects": "appliesTo",
    "from": "from",
    "until": "until",
    "totalUses": "totalUses",
    "perPerson": "perPerson",
    "minSpend": "minSpend"
  }
}
```

</details>

## Single-use code (`offers.code`)

One of a batch of codes made for a discount, each good for a set number of orders (one, by default). Kept as its hash: the codes are shown once, to the person who makes them.

|  |  |
| --- | --- |
| Plural | Single-use codes |
| Title field | `label` |
| Listed in | none |
| Indexes | `discount, batch` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `label` | `text` | Label |   | read-only | The batch and the code's number in it. |
| `discount` | `relation` | Discount |   | to `offers.discount`; read-only |   |
| `batch` | `text` | Batch |   | read-only |   |
| `word` | `text` | Code (its hash) |   | read-only | What the host keeps of the code: its hash, never the code. |
| `uses` | `number` | Orders per code |   | min 1; read-only | The most orders this code may be used on. |
| `active` | `boolean` | Works |   | default `true` | Off: the code is void. Switched off by voidCodes or by a person. |
| `madeBy` | `text` | Made by |   | read-only |   |

### Relations

- `discount` → `offers.discount`

## Views

| View | Object | Label |
| --- | --- | --- |
| `liveDiscounts` | `offers.discount` | Live |
| `draftDiscounts` | `offers.discount` | Drafts |
| `memberPrices` | `offers.discount` | Members' prices and customer rates |
| `promoCodes` | `offers.discount` | Promo codes |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `discountCodes` | `` | Single-use codes |
