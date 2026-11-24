---
title: "Memberships: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.memberships.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### plans

The membership plans on sale: each plan's title, a line on what it gives, description, price per month (in the major unit of `currency`), classes per week or month (null: unlimited), the class types, days and times it allows, and the days of its free trial. Whether a person gets the trial is the host's, when they subscribe (subscription.start): one per person, signed in. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer`, `public` |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `plans` | array of object | yes |   |   |
| `plans[].classTypes` | array of string | yes |   | Class type ids; empty: every class type |
| `plans[].weekdays` | array of string | yes |   | 1 Monday to 7 Sunday; empty: every day |
| `plans[].fromMinute` | number or null | yes |   | Classes starting at or after, minutes after midnight |
| `plans[].untilMinute` | number or null | yes |   | Classes starting before, minutes after midnight |
| `plans[].id` | string | yes |   |   |
| `plans[].title` | string or null | yes |   |   |
| `plans[].summary` | string or null | yes |   |   |
| `plans[].description` | string or null | yes |   |   |
| `plans[].price` | number or null | yes |   | Per month, in the major unit of `currency` |
| `plans[].uses` | number or null | yes |   | Classes per period; null: unlimited |
| `plans[].per` | `"week"`, `"month"` or null | yes |   |   |
| `plans[].trialDays` | number or null | yes |   |   |
| `currency` | string or null | yes |   | The currency prices are in (ISO 4217), the deployment's one; null until it is set |

### passTypes

The passes on sale, bought once: class packs, drop-ins and intro offers. Each one's title, a line on what it gives, description, price (in the major unit of `currency`), its classes, how many days it is valid for from the day it is bought (null: it does not expire), the class types, days and times it allows, and whether it is an intro offer (one per person, bought signed in; the host refuses a second). Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer`, `public` |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `passTypes` | array of object | yes |   |   |
| `passTypes[].classTypes` | array of string | yes |   | Class type ids; empty: every class type |
| `passTypes[].weekdays` | array of string | yes |   | 1 Monday to 7 Sunday; empty: every day |
| `passTypes[].fromMinute` | number or null | yes |   | Classes starting at or after, minutes after midnight |
| `passTypes[].untilMinute` | number or null | yes |   | Classes starting before, minutes after midnight |
| `passTypes[].id` | string | yes |   |   |
| `passTypes[].title` | string or null | yes |   |   |
| `passTypes[].summary` | string or null | yes |   |   |
| `passTypes[].description` | string or null | yes |   |   |
| `passTypes[].price` | number or null | yes |   |   |
| `passTypes[].uses` | number or null | yes |   |   |
| `passTypes[].validDays` | number or null | yes |   |   |
| `passTypes[].onePerPerson` | boolean | yes |   |   |
| `currency` | string or null | yes |   | The currency prices are in (ISO 4217), the deployment's one; null until it is set |

### buy

Start an order for one pass (a class pack, a drop-in or an intro offer). A signed-in customer buys as themselves; a guest gives their email address, and may not buy an intro offer (the host refuses it: one per person, signed in). The host prices it from the pass type, refuses one not on sale, and refuses a second intro offer for the same person. Nothing is paid here: the buyer then calls order.checkout with the order's id (and a guest's token) to pay on the provider's page; the pass is granted when the provider confirms the payment. Amounts in the minor unit.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `customer`, `public` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `passTypeId` | string | yes | min length 1, max length 64 |   |
| `email` | string |   | max length 320 | A guest's email address |
| `agreements` | array of map of any |   | at most 20 | A guest only: their acceptances of what is due, passed on to the host as they are (each { versionId, typedName, signature?, answers? }); the host checks and records them. A signed-in member agrees first. |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | string | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `token` | string or null | yes |   | A guest's key to this order, shown once |

### mine

The signed-in member's own memberships and passes: each one's title, state, what it allows (classes per week or month, or in all; class types, days and times), when it started and when it stops or expires, and the host's count for now: classes used and left this week, this month or in all (left null: unlimited). With personId, a child's the gym linked to them instead (their parent or guardian reads what the child has left). Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string |   | min length 1, max length 64 | A child linked to them; left out, their own |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `holdings` | array of object | yes |   |   |
| `holdings[].classTypes` | array of string | yes |   | Class type ids; empty: every class type |
| `holdings[].weekdays` | array of string | yes |   | 1 Monday to 7 Sunday; empty: every day |
| `holdings[].fromMinute` | number or null | yes |   | Classes starting at or after, minutes after midnight |
| `holdings[].untilMinute` | number or null | yes |   | Classes starting before, minutes after midnight |
| `holdings[].id` | string | yes |   |   |
| `holdings[].kind` | `"membership"`, `"pass"` | yes |   |   |
| `holdings[].title` | string or null | yes |   |   |
| `holdings[].status` | string | yes |   | The record's own state, as the host keeps it |
| `holdings[].uses` | number or null | yes |   | Per period for a membership, in all for a pass; null: unlimited |
| `holdings[].per` | `"total"`, `"week"`, `"month"` | yes |   |   |
| `holdings[].from` | string or null | yes |   |   |
| `holdings[].until` | string or null | yes |   | When it stops or expires |
| `holdings[].live` | boolean | yes |   | It can pay for a class now (the host's answer) |
| `holdings[].period` | object or null | yes |   | This week, this month or in all, as the host counts it |
| `holdings[].period.key` | string | yes |   |   |
| `holdings[].period.startsAt` | string | yes |   |   |
| `holdings[].period.endsAt` | string | yes |   |   |
| `holdings[].period.used` | number | yes |   |   |
| `holdings[].period.left` | number or null | yes |   | Null: unlimited |

### holdings

For staff: one person's memberships and passes, with their state, what each allows, when it stops or expires, and the classes used and left now, as the host counts them. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `holdings` | array of object | yes |   |   |
| `holdings[].classTypes` | array of string | yes |   | Class type ids; empty: every class type |
| `holdings[].weekdays` | array of string | yes |   | 1 Monday to 7 Sunday; empty: every day |
| `holdings[].fromMinute` | number or null | yes |   | Classes starting at or after, minutes after midnight |
| `holdings[].untilMinute` | number or null | yes |   | Classes starting before, minutes after midnight |
| `holdings[].id` | string | yes |   |   |
| `holdings[].kind` | `"membership"`, `"pass"` | yes |   |   |
| `holdings[].title` | string or null | yes |   |   |
| `holdings[].status` | string | yes |   | The record's own state, as the host keeps it |
| `holdings[].uses` | number or null | yes |   | Per period for a membership, in all for a pass; null: unlimited |
| `holdings[].per` | `"total"`, `"week"`, `"month"` | yes |   |   |
| `holdings[].from` | string or null | yes |   |   |
| `holdings[].until` | string or null | yes |   | When it stops or expires |
| `holdings[].live` | boolean | yes |   | It can pay for a class now (the host's answer) |
| `holdings[].period` | object or null | yes |   | This week, this month or in all, as the host counts it |
| `holdings[].period.key` | string | yes |   |   |
| `holdings[].period.startsAt` | string | yes |   |   |
| `holdings[].period.endsAt` | string | yes |   |   |
| `holdings[].period.used` | number | yes |   |   |
| `holdings[].period.left` | number or null | yes |   | Null: unlimited |

### givePass

Give a person a pass by hand, free, with the reason: a pass type's classes, or fewer if given (never more), valid from now for the type's days, as the host works them out for a pass bought. An intro offer given this way is the person's one: refused if they have had it. Recorded as given by staff, with who gave it and why. A person on the staff only (never the assistant or an automation), with the memberships:passes permission. Returns the pass.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `memberships:passes` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 |   |
| `passTypeId` | string | yes | min length 1, max length 64 |   |
| `reason` | string | yes | min length 3, max length 500 |   |
| `uses` | integer |   | ≥ 1, ≤ 1000 | Fewer classes than the pass type gives; default: the type's |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `passId` | string | yes |   |   |
| `status` | string | yes |   |   |
| `source` | string | yes |   |   |

### voidPass

Void a pass by hand, with the reason: it pays for no more classes; classes already booked with it stay booked. For a pass bought, refund its order instead (a full refund voids it). A person on the staff only, with the memberships:passes permission. Returns the pass.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `memberships:passes` |
| Who may call it | a person only (`humanOnly`) |
| Button on | `memberships.pass` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `passId` | string | yes | min length 1, max length 64 |   |
| `reason` | string | yes | min length 3, max length 500 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `passId` | string | yes |   |   |
| `status` | string | yes |   |   |
| `source` | string | yes |   |   |

## Automations

None.

## Dashboards

| Dashboard | Label | Widgets |
| --- | --- | --- |
| `memberships` |   | 12 |

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`public.list`](/reference/operations/public/#publiclist)
- [`allowance.list`](/reference/operations/allowance/#allowancelist)
- [`order.start`](/reference/operations/order/#orderstart)
- [`me.family`](/reference/operations/me/#mefamily)

Host modules it asks for: `ops`.
