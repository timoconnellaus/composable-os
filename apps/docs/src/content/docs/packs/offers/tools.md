---
title: "Offers: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.offers.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### discounts

The business's discounts (promo codes, members' prices and customer rates): their terms, state (draft, active = live, paused, ended), and how often each was used and what it took off paid orders (in minor units, cents). Use state to narrow it ('which codes are live?'). Never shows single-use codes (they are kept as their hash). Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `state` | `"draft"`, `"active"`, `"paused"`, `"ended"` |   |   |   |
| `automatic` | boolean |   |   | Only prices that apply by themselves, or not |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `discounts` | array of object | yes |   |   |
| `discounts[].id` | string | yes |   |   |
| `discounts[].name` | string or null | yes |   |   |
| `discounts[].state` | string or null | yes |   |   |
| `discounts[].kind` | string or null | yes |   |   |
| `discounts[].percent` | number or null | yes |   |   |
| `discounts[].amount` | number or null | yes |   |   |
| `discounts[].automatic` | boolean | yes |   |   |
| `discounts[].code` | string or null | yes |   | The shared promo code, if it has one |
| `discounts[].who` | string or null | yes |   |   |
| `discounts[].appliesTo` | array of string | yes |   |   |
| `discounts[].from` | string or null | yes |   |   |
| `discounts[].until` | string or null | yes |   |   |
| `discounts[].totalUses` | number or null | yes |   |   |
| `discounts[].perPerson` | number or null | yes |   |   |
| `discounts[].minSpend` | number or null | yes |   |   |
| `discounts[].used` | number | yes |   | Orders paid with it |
| `discounts[].held` | number | yes |   | Unpaid orders holding a use of it |
| `discounts[].given` | number | yes |   | Money it took off paid orders, in the currency's minor unit |
| `truncated` | boolean | yes |   |   |

### codeBatches

The batches of single-use codes made for one discount: how many were made, how many still work and how many were used, who made them and when. Never the codes themselves, which were shown once to the person who made them. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `discountId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `batches` | array of object | yes |   |   |
| `batches[].batch` | string or null | yes |   |   |
| `batches[].made` | number | yes |   |   |
| `batches[].working` | number | yes |   | Codes not voided |
| `batches[].used` | number | yes |   | Codes used on at least one paid order |
| `batches[].usesPerCode` | number or null | yes |   |   |
| `batches[].madeBy` | string or null | yes |   |   |
| `batches[].madeAt` | string or null | yes |   |   |

### draftDiscount

Draft a discount: a promo code for a campaign (code = a word such as JANUARY26), a member's price (automatic = true, who = members, kind = price or percent, appliesTo = what it covers), a customer rate (automatic, who = organisation with organisations) or a discount for single-use codes (no code; a person then makes a batch). It is made as a draft and applies to nobody until a person makes it live with activateDiscount. The host refuses a code shorter than 6 characters or one another discount has. Returns the draft.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `offers:manage` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 120 |   |
| `kind` | `"percent"`, `"amount"`, `"price"` | yes |   | percent: a percentage off; amount: money off the order; price: a set price each |
| `percent` | number |   | ≥ 1, ≤ 100 | For percent: 1 to 100 |
| `amount` | number |   | ≥ 0 | For amount: the money off, in the currency's major unit; for price: what each costs |
| `automatic` | boolean |   |   | True: applies by itself with no code (a member's price, a customer rate) |
| `code` | string |   | max length 64 | A shared promo code anyone may type, at least 6 letters or digits (the host keeps it in capitals without spaces and refuses one another discount has) |
| `who` | `"anyone"`, `"signed_in"`, `"members"`, `"new_customers"`, `"organisation"`, `"tag"` |   |   | Who it is for. Anything but anyone needs a signed-in buyer |
| `organisations` | array of string |   | at most 50 | Organisation ids, for who = organisation |
| `tag` | string |   | max length 80 | The tag, for who = tag |
| `appliesTo` | array of `"bookings.booking"`, `"ticketing.tickettype"`, `"memberships.passtype"`, `"courses.course"`, `"courses.bundle"`, `"shop.variant"` |   | at most 6 | What it covers (drop-ins, tickets, passes, courses, goods). Empty: everything |
| `from` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | First day it applies (UTC) |
| `until` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | Last day it applies (UTC) |
| `totalUses` | integer |   | ≥ 1, ≤ 9007199254740991 | Most orders in total |
| `perPerson` | integer |   | ≥ 1, ≤ 9007199254740991 | Most orders per person |
| `minSpend` | number |   | ≥ 0 | Least the covered lines must cost |
| `note` | string |   | max length 2000 | Why it exists, for staff |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string or null | yes |   |   |
| `state` | string or null | yes |   |   |
| `kind` | string or null | yes |   |   |
| `percent` | number or null | yes |   |   |
| `amount` | number or null | yes |   |   |
| `automatic` | boolean | yes |   |   |
| `code` | string or null | yes |   | The shared promo code, if it has one |
| `who` | string or null | yes |   |   |
| `appliesTo` | array of string | yes |   |   |
| `from` | string or null | yes |   |   |
| `until` | string or null | yes |   |   |
| `totalUses` | number or null | yes |   |   |
| `perPerson` | number or null | yes |   |   |
| `minSpend` | number or null | yes |   |   |
| `open` | object | yes |   |   |
| `open.object` | string | yes |   |   |
| `open.id` | string | yes |   |   |

### changeDiscount

Change a discount's terms: what is off, what it covers, who it is for, its dates, limits or its shared promo code (null clears one). Not its state: use activateDiscount, pauseDiscount or endDiscount. A change to a live discount changes what buyers are charged from the next order, so a person makes it: the assistant's call waits for a person. Orders already started keep the deal they were priced with. Returns the discount.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `offers:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `discountId` | string | yes | min length 1, max length 64 |   |
| `name` | string |   | min length 1, max length 120 |   |
| `kind` | `"percent"`, `"amount"`, `"price"` |   |   | percent: a percentage off; amount: money off the order; price: a set price each |
| `percent` | number or null |   |   |   |
| `amount` | number or null |   |   |   |
| `automatic` | boolean |   |   | True: applies by itself with no code (a member's price, a customer rate) |
| `code` | string or null |   |   |   |
| `who` | `"anyone"`, `"signed_in"`, `"members"`, `"new_customers"`, `"organisation"`, `"tag"` |   |   | Who it is for. Anything but anyone needs a signed-in buyer |
| `organisations` | array of string or null |   |   |   |
| `tag` | string or null |   |   |   |
| `appliesTo` | array of `"bookings.booking"`, `"ticketing.tickettype"`, `"memberships.passtype"`, `"courses.course"`, `"courses.bundle"`, `"shop.variant"` or null |   |   |   |
| `from` | string or null |   |   |   |
| `until` | string or null |   |   |   |
| `totalUses` | integer or null |   |   |   |
| `perPerson` | integer or null |   |   |   |
| `minSpend` | number or null |   |   |   |
| `note` | string or null |   |   |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string or null | yes |   |   |
| `state` | string or null | yes |   |   |
| `kind` | string or null | yes |   |   |
| `percent` | number or null | yes |   |   |
| `amount` | number or null | yes |   |   |
| `automatic` | boolean | yes |   |   |
| `code` | string or null | yes |   | The shared promo code, if it has one |
| `who` | string or null | yes |   |   |
| `appliesTo` | array of string | yes |   |   |
| `from` | string or null | yes |   |   |
| `until` | string or null | yes |   |   |
| `totalUses` | number or null | yes |   |   |
| `perPerson` | number or null | yes |   |   |
| `minSpend` | number or null | yes |   |   |

### activateDiscount

Make a draft or paused discount live: from now on the host applies it to every order it covers (by its code, or by itself for a member's price). A person's decision with offers:manage: the assistant may ask, and its call waits for a person to approve. Check the terms first with discounts. Returns the discount.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `offers:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |
| Button on | `offers.discount` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `discountId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string or null | yes |   |   |
| `state` | string or null | yes |   |   |
| `kind` | string or null | yes |   |   |
| `percent` | number or null | yes |   |   |
| `amount` | number or null | yes |   |   |
| `automatic` | boolean | yes |   |   |
| `code` | string or null | yes |   | The shared promo code, if it has one |
| `who` | string or null | yes |   |   |
| `appliesTo` | array of string | yes |   |   |
| `from` | string or null | yes |   |   |
| `until` | string or null | yes |   |   |
| `totalUses` | number or null | yes |   |   |
| `perPerson` | number or null | yes |   |   |
| `minSpend` | number or null | yes |   |   |

### pauseDiscount

Pause a live discount: it applies to no new order until it is made live again. Orders already started keep their deal. A person's decision with offers:manage (the assistant's call waits for a person). Returns the discount.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `offers:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |
| Button on | `offers.discount` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `discountId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string or null | yes |   |   |
| `state` | string or null | yes |   |   |
| `kind` | string or null | yes |   |   |
| `percent` | number or null | yes |   |   |
| `amount` | number or null | yes |   |   |
| `automatic` | boolean | yes |   |   |
| `code` | string or null | yes |   | The shared promo code, if it has one |
| `who` | string or null | yes |   |   |
| `appliesTo` | array of string | yes |   |   |
| `from` | string or null | yes |   |   |
| `until` | string or null | yes |   |   |
| `totalUses` | number or null | yes |   |   |
| `perPerson` | number or null | yes |   |   |
| `minSpend` | number or null | yes |   |   |

### endDiscount

End a discount for good: it applies to no new order and cannot be made live again (draft a new one instead). Orders already started keep their deal; its codes stop working. A person's decision with offers:manage (the assistant's call waits for a person). Returns the discount.

|  |  |
| --- | --- |
| Risk | `destructive` |
| Audiences | `staff` |
| Permission | `offers:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |
| Button on | `offers.discount` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `discountId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string or null | yes |   |   |
| `state` | string or null | yes |   |   |
| `kind` | string or null | yes |   |   |
| `percent` | number or null | yes |   |   |
| `amount` | number or null | yes |   |   |
| `automatic` | boolean | yes |   |   |
| `code` | string or null | yes |   | The shared promo code, if it has one |
| `who` | string or null | yes |   |   |
| `appliesTo` | array of string | yes |   |   |
| `from` | string or null | yes |   |   |
| `until` | string or null | yes |   |   |
| `totalUses` | number or null | yes |   |   |
| `perPerson` | number or null | yes |   |   |
| `minSpend` | number or null | yes |   |   |

### generateCodes

Make a batch of up to 500 random single-use codes for a discount, each good for usesPerCode orders (1 by default), and show them once, in this answer, to export or send. The host keeps only each code's hash, so they cannot be shown again: keep the list. A person only, with offers:manage, at the discount's page; the assistant cannot make codes. The discount still applies only once it is live. If the batch stops part way, the answer says so and holds the codes that were made.

|  |  |
| --- | --- |
| Risk | `bulk-write` |
| Audiences | `staff` |
| Permission | `offers:manage` |
| Who may call it | a person only (`humanOnly`) |
| Button on | `offers.discount` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `discountId` | string | yes | min length 1, max length 64 |   |
| `count` | integer |   | ≥ 1, ≤ 500, default `50` |   |
| `usesPerCode` | integer |   | ≥ 1, ≤ 1000, default `1` |   |
| `batch` | string |   | min length 1, max length 60 | A name for the batch |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `discountId` | string | yes |   |   |
| `batch` | string | yes |   |   |
| `made` | number | yes |   |   |
| `complete` | boolean | yes |   | False: the batch stopped part way; see problem |
| `problem` | string or null | yes |   |   |
| `codes` | array of string | yes |   | The codes, shown once: the host keeps only their hash |

### voidCodes

Stop single-use codes working: the codes given (as typed, for a code that leaked), or a whole batch, of one discount; at most 200 a call (call again while remaining is more than 0). Orders already started keep their deal. A person's decision with offers:manage (the assistant's call waits for a person). Returns how many were voided.

|  |  |
| --- | --- |
| Risk | `bulk-write` |
| Audiences | `staff` |
| Permission | `offers:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |
| Kept from the audit log | `codes` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `discountId` | string | yes | min length 1, max length 64 |   |
| `batch` | string |   | min length 1, max length 60 |   |
| `codes` | array of string |   | at least 1, at most 50 | Codes as typed |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `voided` | number | yes |   |   |
| `remaining` | number | yes |   |   |

## Automations

None.

## Dashboards

| Dashboard | Label | Widgets |
| --- | --- | --- |
| `offersOverview` |   | 6 |

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`query.sql`](/reference/operations/query/#querysql)

Host modules it asks for: `ops`.
