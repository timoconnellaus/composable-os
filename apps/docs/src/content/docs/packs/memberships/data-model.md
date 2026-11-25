---
title: "Memberships: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

Requires [programs](/packs/programs/), [bookings](/packs/bookings/): the host refuses to install it while one is missing.

## Membership plan (`memberships.plan`)

A membership paid every month: unlimited classes, or a number a week or a month, of the class types and times it allows. One free trial per person per plan.

|  |  |
| --- | --- |
| Plural | Membership plans |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`public`](/reference/behaviours/#public), [`sellable`](/reference/behaviours/#sellable), [`agreements`](/reference/behaviours/#agreements) |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `summary` | `text` | What it gives, in a line |   |   | Shown with the plan: "3 classes a week, off-peak". |
| `description` | `text` | Description |   |   |   |
| `price` | `currency` | Price per month | yes |   |   |
| `uses` | `number` | Classes per period |   | min 1; max 1000 | Empty: unlimited. |
| `per` | `select` | Per | yes | one of `week`, `month`; default `"week"` |   |
| `covers` | `multiSelect` | Pays for |   | one of `classes`, `sessions` | Classes, one-to-one sessions (Bookings' appointments), or both. Empty: classes only. |
| `services` | `relation` | Services |   | to `bookings.service`, many | The one-to-one sessions it pays for, when it pays for sessions. Empty: every one. |
| `classTypes` | `relation` | Class types |   | to `programs.classtype`, many | Empty: every class type. |
| `weekdays` | `multiSelect` | Days |   | one of `1`, `2`, `3`, `4`, `5`, `6`, `7` | Empty: every day. |
| `fromMinute` | `number` | Classes from (minutes after midnight) |   | min 0; max 1440 | A class must start at or after this time of day: 540 is 09:00. Empty: any. |
| `untilMinute` | `number` | Classes before (minutes after midnight) |   | min 0; max 1440 | A class must start before this time of day: 960 is 16:00. Empty: any. |
| `trialDays` | `number` | Free trial (days) |   | min 0; max 90 | Empty or 0: charged from the start. A person gets one trial on any plan. |
| `pauseMinDays` | `number` | Shortest pause (days) |   | min 1; max 366 | Staff pause a membership for at least this long. Empty: 1 day. |
| `pauseMaxDays` | `number` | Longest pause (days) |   | min 1; max 366 | And at most this long. Empty: a year. |
| `status` | `select` | Status |   | one of `draft`, `on_sale`, `retired`; default `"draft"` |   |

### Relations

- `services` → `bookings.service` (many)
- `classTypes` → `programs.classtype` (many)

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "public": {
    "read": [
      "title",
      "summary",
      "description",
      "price",
      "uses",
      "per",
      "classTypes",
      "weekdays",
      "fromMinute",
      "untilMinute",
      "trialDays"
    ],
    "when": {
      "field": "status",
      "in": [
        "on_sale"
      ]
    }
  },
  "sellable": {
    "price": "price",
    "tax": {
      "code": "txcd_50021001"
    },
    "finance": {
      "category": {
        "key": "memberships",
        "label": "Memberships"
      },
      "earned": "over_period"
    },
    "recurring": {
      "interval": "month",
      "trialDays": "trialDays",
      "pause": {
        "minDays": "pauseMinDays",
        "maxDays": "pauseMaxDays"
      },
      "coolingOff": {
        "setting": "coolingOffDays"
      },
      "grants": {
        "object": "membership",
        "set": {
          "person": "subscription.holder",
          "payer": "subscription.payer",
          "plan": "item",
          "subscription": "subscription",
          "title": "item.title",
          "uses": "item.uses",
          "per": "item.per",
          "covers": "item.covers",
          "services": "item.services",
          "classTypes": "item.classTypes",
          "weekdays": "item.weekdays",
          "fromMinute": "item.fromMinute",
          "untilMinute": "item.untilMinute"
        },
        "from": "from",
        "until": "until",
        "states": {
          "trialing": "trialing",
          "active": "active",
          "past_due": "past_due",
          "unpaid": "unpaid",
          "paused": "paused",
          "ended": "ended"
        }
      }
    }
  },
  "agreements": {
    "point": "membership",
    "label": "Buying a membership or a pass",
    "suggests": [
      "terms",
      "waiver",
      "health",
      "guardian"
    ],
    "inlineStep": true
  }
}
```

</details>

## Membership (`memberships.membership`)

A member's membership: granted by the host when their subscription to a plan starts, and moved with it (on trial, active, past due, paused, ended). What it allows is the plan's as it was at the start.

|  |  |
| --- | --- |
| Plural | Memberships |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`customer`](/reference/behaviours/#customer), [`allowance`](/reference/behaviours/#allowance) |
| Indexes | `person`; `plan`; `subscription`; `status` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Plan |   | read-only |   |
| `person` | `relation` | Member |   | to `person`; read-only |   |
| `payer` | `relation` | Paid by |   | to `person`; read-only | Who pays: the member, or someone paying for them (a parent). |
| `plan` | `relation` | Plan |   | to `memberships.plan`; read-only |   |
| `subscription` | `text` | Subscription |   | read-only |   |
| `uses` | `number` | Classes per period |   | read-only |   |
| `per` | `select` | Per |   | one of `week`, `month`; read-only |   |
| `covers` | `multiSelect` | Pays for |   | one of `classes`, `sessions`; read-only | Classes, one-to-one sessions (Bookings' appointments), or both. Empty: classes only. |
| `services` | `relation` | Services |   | to `bookings.service`, many; read-only | The one-to-one sessions it pays for, when it pays for sessions. Empty: every one. |
| `classTypes` | `relation` | Class types |   | to `programs.classtype`, many; read-only | Empty: every class type. |
| `weekdays` | `multiSelect` | Days |   | one of `1`, `2`, `3`, `4`, `5`, `6`, `7`; read-only | Empty: every day. |
| `fromMinute` | `number` | Classes from (minutes after midnight) |   | min 0; max 1440; read-only | A class must start at or after this time of day: 540 is 09:00. Empty: any. |
| `untilMinute` | `number` | Classes before (minutes after midnight) |   | min 0; max 1440; read-only | A class must start before this time of day: 960 is 16:00. Empty: any. |
| `from` | `datetime` | From |   | read-only |   |
| `until` | `datetime` | Until |   | read-only | When it stops: set when it is ending, has ended, or a payment is failing. |
| `status` | `select` | Status |   | one of `trialing`, `active`, `past_due`, `unpaid`, `paused`, `ended` |   |

### Relations

- `person` → `person`
- `payer` → `person`
- `plan` → `memberships.plan`
- `services` → `bookings.service` (many)
- `classTypes` → `programs.classtype` (many)

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "status",
    "initial": "active",
    "moves": [
      {
        "from": [
          "active",
          "past_due",
          "unpaid",
          "paused"
        ],
        "to": "trialing",
        "by": [
          "host"
        ]
      },
      {
        "from": [
          "trialing",
          "past_due",
          "unpaid",
          "paused"
        ],
        "to": "active",
        "by": [
          "host"
        ]
      },
      {
        "from": [
          "trialing",
          "active",
          "unpaid",
          "paused"
        ],
        "to": "past_due",
        "by": [
          "host"
        ]
      },
      {
        "from": [
          "trialing",
          "active",
          "past_due",
          "paused"
        ],
        "to": "unpaid",
        "by": [
          "host"
        ]
      },
      {
        "from": [
          "trialing",
          "active",
          "past_due",
          "unpaid"
        ],
        "to": "paused",
        "by": [
          "host"
        ]
      },
      {
        "from": [
          "trialing",
          "active",
          "past_due",
          "unpaid",
          "paused"
        ],
        "to": "ended",
        "by": [
          "host"
        ],
        "final": true
      }
    ]
  },
  "customer": {
    "field": "person",
    "guardians": {},
    "read": [
      "person",
      "title",
      "plan",
      "uses",
      "per",
      "classTypes",
      "weekdays",
      "fromMinute",
      "untilMinute",
      "from",
      "until",
      "status"
    ],
    "write": []
  },
  "allowance": {
    "holds": {
      "person": "person",
      "uses": "uses",
      "per": {
        "field": "per"
      },
      "from": "from",
      "until": "until",
      "live": [
        "trialing",
        "active",
        "past_due"
      ],
      "emptyIsUnlimited": true,
      "spendsOn": [
        {
          "object": "bookings.booking",
          "when": [
            {
              "value": "classes",
              "in": "covers"
            },
            {
              "field": "classType",
              "in": "classTypes"
            },
            {
              "field": "weekday",
              "in": "weekdays"
            },
            {
              "field": "minute",
              "atLeast": "fromMinute"
            },
            {
              "field": "minute",
              "below": "untilMinute"
            }
          ]
        },
        {
          "object": "bookings.appointment",
          "when": [
            {
              "value": "sessions",
              "in": "covers",
              "empty": "none"
            },
            {
              "field": "serviceId",
              "in": "services"
            },
            {
              "field": "weekday",
              "in": "weekdays"
            },
            {
              "field": "minute",
              "atLeast": "fromMinute"
            },
            {
              "field": "minute",
              "below": "untilMinute"
            }
          ]
        }
      ]
    }
  }
}
```

</details>

## Pass type (`memberships.passtype`)

A pass bought once: a class pack of N that expires, a drop-in (a pass of one), or an intro offer, one per person.

|  |  |
| --- | --- |
| Plural | Pass types |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`public`](/reference/behaviours/#public), [`sellable`](/reference/behaviours/#sellable), [`agreements`](/reference/behaviours/#agreements) |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `summary` | `text` | What it gives, in a line |   |   |   |
| `description` | `text` | Description |   |   |   |
| `price` | `currency` | Price | yes |   |   |
| `uses` | `number` | Classes | yes | min 1; max 1000 |   |
| `validDays` | `number` | Valid for (days) |   | min 1; max 3650 | From the day it is bought. Empty: it does not expire. |
| `covers` | `multiSelect` | Pays for |   | one of `classes`, `sessions` | Classes, one-to-one sessions (Bookings' appointments), or both. Empty: classes only. |
| `services` | `relation` | Services |   | to `bookings.service`, many | The one-to-one sessions it pays for, when it pays for sessions. Empty: every one. |
| `classTypes` | `relation` | Class types |   | to `programs.classtype`, many | Empty: every class type. |
| `weekdays` | `multiSelect` | Days |   | one of `1`, `2`, `3`, `4`, `5`, `6`, `7` | Empty: every day. |
| `fromMinute` | `number` | Classes from (minutes after midnight) |   | min 0; max 1440 | A class must start at or after this time of day: 540 is 09:00. Empty: any. |
| `untilMinute` | `number` | Classes before (minutes after midnight) |   | min 0; max 1440 | A class must start before this time of day: 960 is 16:00. Empty: any. |
| `onePerPerson` | `boolean` | Intro offer: one per person |   |   | A person buys one of these once, across every pass type marked so, signed in. |
| `status` | `select` | Status |   | one of `draft`, `on_sale`, `retired`; default `"draft"` |   |

### Relations

- `services` → `bookings.service` (many)
- `classTypes` → `programs.classtype` (many)

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "public": {
    "read": [
      "title",
      "summary",
      "description",
      "price",
      "uses",
      "validDays",
      "classTypes",
      "weekdays",
      "fromMinute",
      "untilMinute",
      "onePerPerson"
    ],
    "when": {
      "field": "status",
      "in": [
        "on_sale"
      ]
    }
  },
  "sellable": {
    "price": "price",
    "tax": {
      "code": "txcd_50021001"
    },
    "grants": {
      "object": "pass",
      "set": {
        "person": "order.person",
        "passtype": "item",
        "title": "line.title",
        "order": "order",
        "uses": "item.uses",
        "covers": "item.covers",
        "services": "item.services",
        "classTypes": "item.classTypes",
        "weekdays": "item.weekdays",
        "fromMinute": "item.fromMinute",
        "untilMinute": "item.untilMinute"
      },
      "void": "void",
      "valid": {
        "from": "from",
        "until": "until",
        "days": "item.validDays"
      }
    },
    "onePerPerson": "onePerPerson",
    "finance": {
      "category": {
        "key": "passes",
        "label": "Class passes"
      },
      "earned": "per_use"
    }
  },
  "agreements": {
    "point": "membership",
    "label": "Buying a membership or a pass",
    "suggests": [
      "terms",
      "waiver",
      "health",
      "guardian"
    ],
    "inlineStep": true
  }
}
```

</details>

## Pass (`memberships.pass`)

A member's pass: granted by a paid order (or given by staff), with its classes and its expiry. Voided when its order is refunded in full; classes already taken stay taken.

|  |  |
| --- | --- |
| Plural | Passes |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`agreements`](/reference/behaviours/#agreements), [`customer`](/reference/behaviours/#customer), [`allowance`](/reference/behaviours/#allowance) |
| Indexes | `person`; `passtype`; `order`; `status` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Pass |   | read-only |   |
| `person` | `relation` | Member |   | to `person`; read-only |   |
| `passtype` | `relation` | Pass type |   | to `memberships.passtype`; read-only |   |
| `order` | `text` | Order |   | read-only |   |
| `uses` | `number` | Classes |   | read-only |   |
| `covers` | `multiSelect` | Pays for |   | one of `classes`, `sessions`; read-only | Classes, one-to-one sessions (Bookings' appointments), or both. Empty: classes only. |
| `services` | `relation` | Services |   | to `bookings.service`, many; read-only | The one-to-one sessions it pays for, when it pays for sessions. Empty: every one. |
| `classTypes` | `relation` | Class types |   | to `programs.classtype`, many; read-only | Empty: every class type. |
| `weekdays` | `multiSelect` | Days |   | one of `1`, `2`, `3`, `4`, `5`, `6`, `7`; read-only | Empty: every day. |
| `fromMinute` | `number` | Classes from (minutes after midnight) |   | min 0; max 1440; read-only | A class must start at or after this time of day: 540 is 09:00. Empty: any. |
| `untilMinute` | `number` | Classes before (minutes after midnight) |   | min 0; max 1440; read-only | A class must start before this time of day: 960 is 16:00. Empty: any. |
| `from` | `datetime` | From |   | read-only |   |
| `until` | `datetime` | Expires |   | read-only |   |
| `source` | `select` | Where it came from |   | one of `purchase`, `staff`; default `"purchase"`; read-only |   |
| `reason` | `text` | Why it was given or voided |   | read-only |   |
| `status` | `select` | Status |   | one of `active`, `void` |   |

### Relations

- `person` → `person`
- `passtype` → `memberships.passtype`
- `services` → `bookings.service` (many)
- `classTypes` → `programs.classtype` (many)

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "status",
    "initial": "active",
    "moves": [
      {
        "from": "active",
        "to": "void",
        "by": [
          "host"
        ],
        "tools": [
          "voidPass"
        ],
        "final": true
      }
    ]
  },
  "agreements": {
    "point": "membership",
    "label": "Buying a membership or a pass",
    "suggests": [
      "terms",
      "waiver",
      "health",
      "guardian"
    ],
    "enter": [
      "active"
    ],
    "person": "person",
    "inlineStep": true
  },
  "customer": {
    "field": "person",
    "guardians": {},
    "read": [
      "person",
      "title",
      "passtype",
      "uses",
      "classTypes",
      "weekdays",
      "fromMinute",
      "untilMinute",
      "from",
      "until",
      "source",
      "status"
    ],
    "write": []
  },
  "allowance": {
    "holds": {
      "person": "person",
      "uses": "uses",
      "per": "total",
      "from": "from",
      "until": "until",
      "live": [
        "active"
      ],
      "spendsOn": [
        {
          "object": "bookings.booking",
          "when": [
            {
              "value": "classes",
              "in": "covers"
            },
            {
              "field": "classType",
              "in": "classTypes"
            },
            {
              "field": "weekday",
              "in": "weekdays"
            },
            {
              "field": "minute",
              "atLeast": "fromMinute"
            },
            {
              "field": "minute",
              "below": "untilMinute"
            }
          ]
        },
        {
          "object": "bookings.appointment",
          "when": [
            {
              "value": "sessions",
              "in": "covers",
              "empty": "none"
            },
            {
              "field": "serviceId",
              "in": "services"
            },
            {
              "field": "weekday",
              "in": "weekdays"
            },
            {
              "field": "minute",
              "atLeast": "fromMinute"
            },
            {
              "field": "minute",
              "below": "untilMinute"
            }
          ]
        }
      ]
    }
  }
}
```

</details>

## Views

| View | Object | Label |
| --- | --- | --- |
| `activeMembers` | `memberships.membership` | Active members |
| `onTrial` | `memberships.membership` | On trial |
| `pastDue` | `memberships.membership` | Past due |
| `paused` | `memberships.membership` | Paused |
| `endingThisMonth` | `memberships.membership` | Ending this month |
| `passesExpiringThisWeek` | `memberships.pass` | Passes expiring this week |
| `passesExpiringThisMonth` | `memberships.pass` | Passes expiring this month |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `personMemberships` | `` | Memberships |
| tab | `personPasses` | `` | Passes |
