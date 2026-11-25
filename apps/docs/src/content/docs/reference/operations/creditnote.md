---
title: "creditNote.* operations"
description: "The core operations named creditNote.*"
sidebar:
  label: "creditNote"
editUrl: false
---

## creditNote.askRefundAgain

Ask again for what an issued credit note gives back on the payment page, where its refund was rejected, its approval expired or it failed: the same amount, on the same payment, waiting in the Approvals inbox for a person with the refund permission as before. Until then the credit note shows it as owed back. A person only, with the refund permission. Returns the credit note and the refunds waiting.

|  |  |
| --- | --- |
| Permission | `orders:refund` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The credit note's id (cn_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `number` | string or null | yes |   | Given when issued; null on a draft |
| `state` | `"draft"`, `"issued"` | yes |   |   |
| `invoiceId` | string | yes |   |   |
| `currency` | string | yes |   |   |
| `taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `reason` | string or null | yes |   |   |
| `settle` | `"reduce"`, `"refund"`, `"both"` | yes |   | reduce: take it off what is still owed; refund: give it back from what was paid (nothing may be owed); both: take off what is owed first, then give back the rest |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unit` | string or null | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].taxRate` | object or null | yes |   |   |
| `lines[].taxRate.key` | string | yes |   |   |
| `lines[].taxRate.label` | string | yes |   |   |
| `lines[].taxRate.rate` | number | yes |   |   |
| `lines[].net` | number | yes |   |   |
| `lines[].tax` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].creditsLineId` | string or null | yes |   | The invoice line it credits; null: an amount |
| `netTotal` | number | yes |   |   |
| `taxTotal` | number | yes |   |   |
| `total` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `refunds` | array of object | yes |   | What it gives back, per payment, and where each stands |
| `refunds[].paymentRef` | string | yes |   |   |
| `refunds[].method` | `"provider"`, `"recorded"` | yes |   |   |
| `refunds[].amount` | number | yes |   |   |
| `refunds[].refundId` | string or null | yes |   | The refund asked for (provider) or recorded (paid back); null: still owed |
| `refunds[].paidBackAt` | string or null | yes |   |   |
| `refunds[].attempt` | number | yes |   | 1, or how many times a provider's refund was asked for |
| `refunds[].why` | `"not_paid_back"`, `"rejected"`, `"expired"`, `"failed"`, `"unconfirmed"` or null | yes |   | Why an owed one is owed: not paid back yet (recorded), or the provider's refund was rejected, its approval expired, it failed when applied, or the provider has not confirmed it within five days |
| `refunds[].state` | `"given_back"`, `"asked"`, `"owed"` | yes |   | given_back: confirmed or recorded paid back; asked: waits for approval or the provider; owed: not given back (a person pays a recorded one back; a provider's rejected, expired or failed is asked for again with creditNote.askRefundAgain) |
| `owedBack` | number | yes |   | What it still owes back: not given back, nor waiting |
| `version` | number | yes |   |   |
| `createdAt` | string | yes |   |   |
| `pending` | array of string | yes |   | The refunds now waiting in Approvals |

## creditNote.create

Draft a credit note against an issued invoice: some of its lines (each with a quantity, or all that is left of it), or an amount at one of its tax rates (in minor units, as the invoice's amounts are typed). Its tax is worked out as the invoice's was. Never more than is left to credit of a line, a rate or the invoice. Say why, and how it settles: reduce what is still owed, give back what was paid, or both. A draft changes nothing until a person with the permission to credit issues it. Returns the draft.

|  |  |
| --- | --- |
| Permission | `invoices:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `invoiceId` | string | yes | min length 1, max length 64 | The invoice's id (inv_…) |
| `lines` | array of object |   | at least 1, at most 50 |   |
| `lines[].lineId` | string | yes | min length 1, max length 64 | The invoice line (inl_…) |
| `lines[].quantity` | number |   | &gt; 0, ≤ 10000 | How much of it: left out, all that is left to credit of it |
| `amount` | object |   |   |   |
| `amount.value` | integer | yes | ≥ 1, ≤ 100000000 | Minor units |
| `amount.taxRate` | string or null | yes |   | One of the invoice's rates' keys; null for its part without tax |
| `amount.description` | string |   | min length 1, max length 500 |   |
| `reason` | string | yes | min length 1, max length 500 | Why, as printed on the credit note |
| `settle` | `"reduce"`, `"refund"`, `"both"` |   | default `"both"` | reduce: take it off what is still owed; refund: give it back from what was paid (nothing may be owed); both: take off what is owed first, then give back the rest |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `number` | string or null | yes |   | Given when issued; null on a draft |
| `state` | `"draft"`, `"issued"` | yes |   |   |
| `invoiceId` | string | yes |   |   |
| `currency` | string | yes |   |   |
| `taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `reason` | string or null | yes |   |   |
| `settle` | `"reduce"`, `"refund"`, `"both"` | yes |   | reduce: take it off what is still owed; refund: give it back from what was paid (nothing may be owed); both: take off what is owed first, then give back the rest |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unit` | string or null | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].taxRate` | object or null | yes |   |   |
| `lines[].taxRate.key` | string | yes |   |   |
| `lines[].taxRate.label` | string | yes |   |   |
| `lines[].taxRate.rate` | number | yes |   |   |
| `lines[].net` | number | yes |   |   |
| `lines[].tax` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].creditsLineId` | string or null | yes |   | The invoice line it credits; null: an amount |
| `netTotal` | number | yes |   |   |
| `taxTotal` | number | yes |   |   |
| `total` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `refunds` | array of object | yes |   | What it gives back, per payment, and where each stands |
| `refunds[].paymentRef` | string | yes |   |   |
| `refunds[].method` | `"provider"`, `"recorded"` | yes |   |   |
| `refunds[].amount` | number | yes |   |   |
| `refunds[].refundId` | string or null | yes |   | The refund asked for (provider) or recorded (paid back); null: still owed |
| `refunds[].paidBackAt` | string or null | yes |   |   |
| `refunds[].attempt` | number | yes |   | 1, or how many times a provider's refund was asked for |
| `refunds[].why` | `"not_paid_back"`, `"rejected"`, `"expired"`, `"failed"`, `"unconfirmed"` or null | yes |   | Why an owed one is owed: not paid back yet (recorded), or the provider's refund was rejected, its approval expired, it failed when applied, or the provider has not confirmed it within five days |
| `refunds[].state` | `"given_back"`, `"asked"`, `"owed"` | yes |   | given_back: confirmed or recorded paid back; asked: waits for approval or the provider; owed: not given back (a person pays a recorded one back; a provider's rejected, expired or failed is asked for again with creditNote.askRefundAgain) |
| `owedBack` | number | yes |   | What it still owes back: not given back, nor waiting |
| `version` | number | yes |   |   |
| `createdAt` | string | yes |   |   |

## creditNote.delete

Delete a draft credit note, for good. An issued one is never deleted.

|  |  |
| --- | --- |
| Permission | `invoices:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The credit note's id (cn_…) |
| `version` | integer |   | ≥ 0, ≤ 9007199254740991 | The version you read: one changed since by someone else is refused |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deleted` | `true` | yes |   |   |

## creditNote.get

One credit note with its lines, totals, how it settles and what it gives back per payment. Amounts are integers in the currency's minor unit. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The credit note's id (cn_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `number` | string or null | yes |   | Given when issued; null on a draft |
| `state` | `"draft"`, `"issued"` | yes |   |   |
| `invoiceId` | string | yes |   |   |
| `currency` | string | yes |   |   |
| `taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `reason` | string or null | yes |   |   |
| `settle` | `"reduce"`, `"refund"`, `"both"` | yes |   | reduce: take it off what is still owed; refund: give it back from what was paid (nothing may be owed); both: take off what is owed first, then give back the rest |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unit` | string or null | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].taxRate` | object or null | yes |   |   |
| `lines[].taxRate.key` | string | yes |   |   |
| `lines[].taxRate.label` | string | yes |   |   |
| `lines[].taxRate.rate` | number | yes |   |   |
| `lines[].net` | number | yes |   |   |
| `lines[].tax` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].creditsLineId` | string or null | yes |   | The invoice line it credits; null: an amount |
| `netTotal` | number | yes |   |   |
| `taxTotal` | number | yes |   |   |
| `total` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `refunds` | array of object | yes |   | What it gives back, per payment, and where each stands |
| `refunds[].paymentRef` | string | yes |   |   |
| `refunds[].method` | `"provider"`, `"recorded"` | yes |   |   |
| `refunds[].amount` | number | yes |   |   |
| `refunds[].refundId` | string or null | yes |   | The refund asked for (provider) or recorded (paid back); null: still owed |
| `refunds[].paidBackAt` | string or null | yes |   |   |
| `refunds[].attempt` | number | yes |   | 1, or how many times a provider's refund was asked for |
| `refunds[].why` | `"not_paid_back"`, `"rejected"`, `"expired"`, `"failed"`, `"unconfirmed"` or null | yes |   | Why an owed one is owed: not paid back yet (recorded), or the provider's refund was rejected, its approval expired, it failed when applied, or the provider has not confirmed it within five days |
| `refunds[].state` | `"given_back"`, `"asked"`, `"owed"` | yes |   | given_back: confirmed or recorded paid back; asked: waits for approval or the provider; owed: not given back (a person pays a recorded one back; a provider's rejected, expired or failed is asked for again with creditNote.askRefundAgain) |
| `owedBack` | number | yes |   | What it still owes back: not given back, nor waiting |
| `version` | number | yes |   |   |
| `createdAt` | string | yes |   |   |

## creditNote.issue

Issue a draft credit note: it takes the next number of the credit note series and, in the same step, takes off what is still owed on its invoice and gives back the rest from what was paid, as it says. Money paid on the payment page goes back through the Approvals inbox, for a person with the refund permission; money taken another way is owed back until a person pays it back and records it (order.recordRefund). Never more than was paid. An invoice credited in full with nothing paid is credited, its order cancelled and its places given back. A person only, with the permission to credit invoices: AI assistants are refused. Returns the credit note, its invoice and the refunds waiting.

|  |  |
| --- | --- |
| Permission | `invoices:credit` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The credit note's id (cn_…) |
| `version` | integer | yes | ≥ 0, ≤ 9007199254740991 | The version you read (from get): required, so what is approved is what was asked; one changed since is refused |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `number` | string or null | yes |   | Given when issued; null on a draft |
| `state` | `"draft"`, `"issued"` | yes |   |   |
| `invoiceId` | string | yes |   |   |
| `currency` | string | yes |   |   |
| `taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `reason` | string or null | yes |   |   |
| `settle` | `"reduce"`, `"refund"`, `"both"` | yes |   | reduce: take it off what is still owed; refund: give it back from what was paid (nothing may be owed); both: take off what is owed first, then give back the rest |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unit` | string or null | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].taxRate` | object or null | yes |   |   |
| `lines[].taxRate.key` | string | yes |   |   |
| `lines[].taxRate.label` | string | yes |   |   |
| `lines[].taxRate.rate` | number | yes |   |   |
| `lines[].net` | number | yes |   |   |
| `lines[].tax` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].creditsLineId` | string or null | yes |   | The invoice line it credits; null: an amount |
| `netTotal` | number | yes |   |   |
| `taxTotal` | number | yes |   |   |
| `total` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `refunds` | array of object | yes |   | What it gives back, per payment, and where each stands |
| `refunds[].paymentRef` | string | yes |   |   |
| `refunds[].method` | `"provider"`, `"recorded"` | yes |   |   |
| `refunds[].amount` | number | yes |   |   |
| `refunds[].refundId` | string or null | yes |   | The refund asked for (provider) or recorded (paid back); null: still owed |
| `refunds[].paidBackAt` | string or null | yes |   |   |
| `refunds[].attempt` | number | yes |   | 1, or how many times a provider's refund was asked for |
| `refunds[].why` | `"not_paid_back"`, `"rejected"`, `"expired"`, `"failed"`, `"unconfirmed"` or null | yes |   | Why an owed one is owed: not paid back yet (recorded), or the provider's refund was rejected, its approval expired, it failed when applied, or the provider has not confirmed it within five days |
| `refunds[].state` | `"given_back"`, `"asked"`, `"owed"` | yes |   | given_back: confirmed or recorded paid back; asked: waits for approval or the provider; owed: not given back (a person pays a recorded one back; a provider's rejected, expired or failed is asked for again with creditNote.askRefundAgain) |
| `owedBack` | number | yes |   | What it still owes back: not given back, nor waiting |
| `version` | number | yes |   |   |
| `createdAt` | string | yes |   |   |
| `invoice` | object | yes |   |   |
| `invoice.id` | string | yes |   |   |
| `invoice.state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
| `invoice.number` | string or null | yes |   | Given when sent or issued; null on a draft |
| `invoice.currency` | string | yes |   |   |
| `invoice.taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `invoice.billTo` | object | yes |   |   |
| `invoice.billTo.personId` | string or null | yes |   |   |
| `invoice.billTo.organisationId` | string or null | yes |   |   |
| `invoice.billTo.printed` | object or null | yes |   | As printed, fixed when sent or issued |
| `invoice.billTo.printed.name` | string or null | yes |   |   |
| `invoice.billTo.printed.address` | string or null | yes |   |   |
| `invoice.billTo.printed.taxNumber` | string or null | yes |   |   |
| `invoice.billTo.printed.email` | string or null | yes |   |   |
| `invoice.siteAddress` | string or null | yes |   |   |
| `invoice.about` | object or null | yes |   |   |
| `invoice.about.object` | string | yes |   |   |
| `invoice.about.id` | string | yes |   |   |
| `invoice.title` | string or null | yes |   |   |
| `invoice.notes` | string or null | yes |   |   |
| `invoice.lines` | array of object | yes |   |   |
| `invoice.lines[].id` | string | yes |   |   |
| `invoice.lines[].position` | number | yes |   |   |
| `invoice.lines[].description` | string | yes |   |   |
| `invoice.lines[].quantity` | number | yes |   |   |
| `invoice.lines[].unit` | string or null | yes |   |   |
| `invoice.lines[].unitPrice` | number | yes |   | For one, in minor units, as the document's amounts are typed |
| `invoice.lines[].taxRate` | object or null | yes |   |   |
| `invoice.lines[].taxRate.key` | string | yes |   |   |
| `invoice.lines[].taxRate.label` | string | yes |   |   |
| `invoice.lines[].taxRate.rate` | number | yes |   |   |
| `invoice.lines[].discount` | object or null | yes |   |   |
| `invoice.lines[].discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `invoice.lines[].discount.value` | number | yes |   |   |
| `invoice.lines[].discount.reason` | string | yes |   |   |
| `invoice.lines[].discount.amount` | number | yes |   | What it took off, in minor units |
| `invoice.lines[].net` | number | yes |   |   |
| `invoice.lines[].tax` | number | yes |   |   |
| `invoice.lines[].total` | number | yes |   |   |
| `invoice.lines[].source` | `"record"`, `"custom"`, `"deduction"` | yes |   |   |
| `invoice.lines[].item` | object or null | yes |   |   |
| `invoice.lines[].item.object` | string | yes |   |   |
| `invoice.lines[].item.id` | string | yes |   |   |
| `invoice.netTotal` | number | yes |   |   |
| `invoice.taxTotal` | number | yes |   |   |
| `invoice.total` | number | yes |   |   |
| `invoice.taxByRate` | array of object | yes |   |   |
| `invoice.taxByRate[].key` | string | yes |   |   |
| `invoice.taxByRate[].label` | string | yes |   |   |
| `invoice.taxByRate[].rate` | number | yes |   |   |
| `invoice.taxByRate[].net` | number | yes |   |   |
| `invoice.taxByRate[].tax` | number | yes |   |   |
| `invoice.taxByRate[].total` | number | yes |   |   |
| `invoice.version` | number | yes |   | Moves with every write |
| `invoice.createdAt` | string | yes |   |   |
| `invoice.updatedAt` | string | yes |   |   |
| `invoice.kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `invoice.quoteId` | string or null | yes |   |   |
| `invoice.orderId` | string or null | yes |   |   |
| `invoice.paymentTermsDays` | number | yes |   |   |
| `invoice.issuedOn` | string or null | yes |   |   |
| `invoice.dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `invoice.allowPartPayments` | boolean | yes |   |   |
| `invoice.remindersPaused` | boolean | yes |   |   |
| `invoice.money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `invoice.money.paid` | number | yes |   |   |
| `invoice.money.credited` | number | yes |   | What credit notes took off what was owed |
| `invoice.money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `invoice.money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `invoice.money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `invoice.money.orderState` | string | yes |   |   |
| `pending` | array of string | yes |   | The refunds waiting in Approvals for a person with the refund permission |

## creditNote.list

An invoice's credit notes, drafts and issued, oldest first, without their lines (creditNote.get has them). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `invoiceId` | string | yes | min length 1, max length 64 | The invoice's id (inv_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].number` | string or null | yes |   |   |
| `items[].state` | `"draft"`, `"issued"` | yes |   |   |
| `items[].settle` | `"reduce"`, `"refund"`, `"both"` | yes |   | reduce: take it off what is still owed; refund: give it back from what was paid (nothing may be owed); both: take off what is owed first, then give back the rest |
| `items[].total` | number | yes |   |   |
| `items[].issuedOn` | string or null | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
