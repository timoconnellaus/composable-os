---
title: "accounting.* operations"
description: "The core operations named accounting.*"
sidebar:
  label: "accounting"
editUrl: false
---

## accounting.map.clear

Forget which books account or tax rate one kind of host money goes to. Entries not yet sent that need it are held until it is mapped again; nothing sent changes. A person only.

|  |  |
| --- | --- |
| Permission | `accounting:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"category"`, `"tax"`, `"fees"`, `"clearing"`, `"bank"`, `"method"`, `"rounding"`, `"refunds"`, `"invoice_default"` | yes |   | What is mapped: `category` (a kind of sale, by its category key), `tax` (a tax code, to a tax rate), `fees` (the payment provider's fees), `clearing` (card money on its way to the bank), `bank` (where payouts land), `method` (a recorded-payment kind: transfer, cash, cheque, card machine, other), `rounding`, `refunds`, `invoice_default` (an invoice line with no category) |
| `hostKey` | string or null |   |   | For category, tax and method: the category key, tax code or recorded-payment kind |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `cleared` | boolean | yes |   |   |

## accounting.map.set

Choose which of the books' accounts (or, for a tax code, which tax rate) one kind of host money goes to, from the books' own lists: a category of sale, a tax code, the provider's fees, the clearing account, the bank account payouts land in, a recorded-payment kind, rounding, refunds, or an invoice line with no category. `booksName` is the name the books gave it when it was chosen. A change applies only to entries not yet sent; a person only.

|  |  |
| --- | --- |
| Permission | `accounting:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"category"`, `"tax"`, `"fees"`, `"clearing"`, `"bank"`, `"method"`, `"rounding"`, `"refunds"`, `"invoice_default"` | yes |   | What is mapped: `category` (a kind of sale, by its category key), `tax` (a tax code, to a tax rate), `fees` (the payment provider's fees), `clearing` (card money on its way to the bank), `bank` (where payouts land), `method` (a recorded-payment kind: transfer, cash, cheque, card machine, other), `rounding`, `refunds`, `invoice_default` (an invoice line with no category) |
| `hostKey` | string or null |   |   | For category, tax and method: the category key, tax code or recorded-payment kind |
| `booksRef` | string | yes | min length 1, max length 200 | The books' own id for the account or rate |
| `booksName` | string | yes | min length 1, max length 200 | Its name in the books, as read |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `changed` | boolean | yes |   |   |
| `row` | object | yes |   |   |
| `row.kind` | `"category"`, `"tax"`, `"fees"`, `"clearing"`, `"bank"`, `"method"`, `"rounding"`, `"refunds"`, `"invoice_default"` | yes |   |   |
| `row.hostKey` | string or null | yes |   |   |
| `row.target` | `"account"`, `"tax_rate"` | yes |   |   |
| `row.booksRef` | string | yes |   |   |
| `row.booksName` | string | yes |   |   |
| `row.setBy` | string | yes |   |   |
| `row.setAt` | string | yes |   |   |

## accounting.settings.get

The accounting sync's settings: the books chosen (an accounting connection and the books on it), the start date (nothing dated before it is sent), whether it is on, approval (how many days a person has approved and after how many sending is automatic), the settle delay, the mapping (which of the books' accounts and tax rates each kind of sale, tax, fee, payout and recorded payment goes to) and the accounting connections an admin may choose. Read-only.

|  |  |
| --- | --- |
| Permission | `accounting:manage` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `books` | object or null | yes |   | The accounting connection and the books on it, or null when none is chosen |
| `books.connectionId` | string | yes |   |   |
| `books.resource` | string | yes |   |   |
| `books.title` | string or null | yes |   |   |
| `books.status` | string or null | yes |   |   |
| `startDate` | string or null | yes |   | Nothing dated before it is ever sent |
| `enabled` | boolean | yes |   |   |
| `approval` | object | yes |   |   |
| `approval.approvedDays` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `approval.approveUntil` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `approval.automatic` | boolean | yes |   | Approval is over: entries go without a person approving |
| `settleDays` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `updatedBy` | string or null | yes |   |   |
| `updatedAt` | string or null | yes |   |   |
| `mapping` | array of object | yes |   |   |
| `mapping[].kind` | `"category"`, `"tax"`, `"fees"`, `"clearing"`, `"bank"`, `"method"`, `"rounding"`, `"refunds"`, `"invoice_default"` | yes |   |   |
| `mapping[].hostKey` | string or null | yes |   |   |
| `mapping[].target` | `"account"`, `"tax_rate"` | yes |   |   |
| `mapping[].booksRef` | string | yes |   |   |
| `mapping[].booksName` | string | yes |   |   |
| `mapping[].setBy` | string | yes |   |   |
| `mapping[].setAt` | string | yes |   |   |
| `choices` | array of object | yes |   |   |
| `choices[].connectionId` | string | yes |   |   |
| `choices[].vendor` | string | yes |   |   |
| `choices[].title` | string | yes |   |   |
| `choices[].status` | string | yes |   |   |
| `choices[].resources` | array of object | yes |   |   |
| `choices[].resources[].key` | string | yes |   |   |
| `choices[].resources[].url` | string or null | yes |   |   |

## accounting.settings.update

Change the accounting sync's settings (a human admin): choose the books (an accounting connection made in Settings → Integrations, and the books bound on it), the start date (nothing dated before it is ever sent; fixed once anything was sent), the number of days a person approves before sending is automatic (14 to 365), putting approval back on (`restartApproval`: the count starts again), the settle delay in days, and turning it on or off. Turning it on needs the books, an active connection and a start date; the books change only while it is off.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `books` | object or null |   |   | The books; null clears them (only while off) |
| `books.connectionId` | string | yes | min length 1, max length 64 |   |
| `books.resource` | string | yes | min length 1, max length 200 | The books' resource key on the connection |
| `startDate` | string |   |   | A date, YYYY-MM-DD |
| `approveUntil` | integer |   | ≥ 14, ≤ 365 |   |
| `restartApproval` | `true` |   |   | Put approval back on: every day waits for a person again until the count is reached |
| `settleDays` | integer |   | ≥ 1, ≤ 14 |   |
| `enabled` | boolean |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `books` | object or null | yes |   | The accounting connection and the books on it, or null when none is chosen |
| `books.connectionId` | string | yes |   |   |
| `books.resource` | string | yes |   |   |
| `books.title` | string or null | yes |   |   |
| `books.status` | string or null | yes |   |   |
| `startDate` | string or null | yes |   | Nothing dated before it is ever sent |
| `enabled` | boolean | yes |   |   |
| `approval` | object | yes |   |   |
| `approval.approvedDays` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `approval.approveUntil` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `approval.automatic` | boolean | yes |   | Approval is over: entries go without a person approving |
| `settleDays` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `updatedBy` | string or null | yes |   |   |
| `updatedAt` | string or null | yes |   |   |
