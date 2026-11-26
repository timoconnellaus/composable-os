---
title: "Equipment: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Item (`equipment.item`)

One thing the business owns and looks after: a machine, a rack, a tool, a van. In service, out of service (why, since when) or retired. Its tag is the code on its sticker, unique in the register.

|  |  |
| --- | --- |
| Plural | Equipment |
| Title field | `name` |
| Listed in | main |
| Behaviours | [`unique`](/reference/behaviours/#unique), [`states`](/reference/behaviours/#states) |
| Indexes | `state, category`; `category`; `keeper`; `warrantyUntil` |
| Owner field | `keeper` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `category` | `select` | Category |   | one of `cardio`, `strength`, `free_weights`, `studio`, `wet_area`, `tool`, `test_gear`, `vehicle`, `other` |   |
| `place` | `text` | Place |   |   | Where it is: a room, an area of the floor, a van. |
| `tag` | `text` | Tag |   |   | The code on its sticker. No two items in the register share one; an import matches on it. It does not change while the item is out of service. |
| `make` | `text` | Make |   |   |   |
| `model` | `text` | Model |   |   |   |
| `serial` | `text` | Serial number |   |   |   |
| `boughtOn` | `date` | Bought on |   |   |   |
| `cost` | `currency` | Cost |   | min 0 | What it cost to buy, in the base currency. Seen by every staff member. |
| `supplier` | `relation` | Supplier |   | to `organisation` | Who supplied it, and who services it under warranty. |
| `warrantyUntil` | `date` | Warranty until |   |   |   |
| `warrantyNotes` | `longText` | Warranty notes |   |   |   |
| `photo` | `image` | Photo |   |   |   |
| `keeper` | `user` | Keeper |   |   | Who looks after it. Empty: the managers. |
| `issuedTo` | `user` | Who has it |   |   | Who has it now (a tool or a van out with someone). |
| `renewalDue` | `date` | Renewal due |   |   | A date it must be renewed by (a van's registration). |
| `listForMembers` | `select` | Listed for members |   | one of `listed`, `not_listed`; default `"not_listed"` | Whether members may see it in the out-of-order list. Not listed until someone chooses; retiring an item unlists it. |
| `state` | `select` | State |   | one of `in_service`, `out_of_service`, `retired`; default `"in_service"` |   |
| `outSince` | `datetime` | Out of service since |   | read-only | When it was taken out of service. Set when it is taken out, cleared when put back. |
| `outReason` | `text` | Why out of service |   | read-only | Why it must not be used. Given when it is taken out; written only by the tools (a manager corrects it with correctOutReason), cleared when it is put back. |
| `notes` | `longText` | Notes |   |   |   |
| `retiredFlag` | `formula` | Retired |   |   | True once retired: no fault is reported on it any more. |

### Relations

- `supplier` → `organisation`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "unique": [
    {
      "fields": [
        "tag"
      ],
      "states": [
        "in_service",
        "out_of_service"
      ],
      "fold": true
    }
  ],
  "states": {
    "field": "state",
    "initial": "in_service",
    "moves": [
      {
        "from": "in_service",
        "to": "out_of_service",
        "by": [
          "host"
        ],
        "tools": [
          "takeOut",
          "reportFault"
        ],
        "requires": [
          "outReason"
        ]
      },
      {
        "from": "out_of_service",
        "to": "in_service",
        "by": [
          "host"
        ],
        "tools": [
          "putBack"
        ]
      },
      {
        "from": [
          "in_service",
          "out_of_service"
        ],
        "to": "retired",
        "by": [
          "host"
        ],
        "tools": [
          "retire"
        ],
        "requires": [
          "notes"
        ],
        "final": true
      }
    ]
  }
}
```

</details>

## Fault (`equipment.fault`)

A report that something is wrong with an item: what is wrong and how bad. Reported by staff, then acknowledged and closed as fixed, not a fault or a duplicate by a manager.

|  |  |
| --- | --- |
| Plural | Faults |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`unique`](/reference/behaviours/#unique), [`states`](/reference/behaviours/#states) |
| Indexes | `item, state`; `state, severity` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title |   |   |   |
| `item` | `relation` | Item |   | to `equipment.item`; read-only |   |
| `description` | `longText` | What is wrong |   | read-only | What is wrong with it. Do not describe an injury here. |
| `severity` | `select` | How bad |   | one of `safety_risk`, `not_working`, `worn`; default `"not_working"`; read-only |   |
| `photo` | `image` | Photo |   |   |   |
| `reportedBy` | `user` | Reported by |   | read-only | The staff member who reported it, set by the report. |
| `reportedByName` | `text` | Reported by (name) |   | read-only |   |
| `reportKey` | `text` | Report key |   | read-only | Set by the report: the same report again, or a retry, finds this fault while it is open. |
| `state` | `select` | State |   | one of `reported`, `acknowledged`, `fixed`, `not_a_fault`, `duplicate`; default `"reported"` |   |
| `closedWhy` | `text` | Closed because |   |   | Why it was closed: what fixed it, or why it is not a fault. |

### Relations

- `item` → `equipment.item`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "unique": [
    {
      "fields": [
        "reportKey"
      ],
      "states": [
        "reported",
        "acknowledged"
      ]
    }
  ],
  "states": {
    "field": "state",
    "initial": "reported",
    "create": {
      "closed": "item.retiredFlag",
      "requires": [
        "item"
      ]
    },
    "holds": "item",
    "moves": [
      {
        "from": "reported",
        "to": "acknowledged",
        "by": [
          "host"
        ],
        "tools": [
          "triage"
        ]
      },
      {
        "from": [
          "reported",
          "acknowledged"
        ],
        "to": "fixed",
        "by": [
          "host"
        ],
        "tools": [
          "triage"
        ],
        "requires": [
          "closedWhy"
        ],
        "final": true
      },
      {
        "from": [
          "reported",
          "acknowledged"
        ],
        "to": "not_a_fault",
        "by": [
          "host"
        ],
        "tools": [
          "triage"
        ],
        "requires": [
          "closedWhy"
        ],
        "final": true
      },
      {
        "from": [
          "reported",
          "acknowledged"
        ],
        "to": "duplicate",
        "by": [
          "host"
        ],
        "tools": [
          "triage"
        ],
        "requires": [
          "closedWhy"
        ],
        "final": true
      }
    ]
  }
}
```

</details>

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `itemFaults` | `` | Faults |
