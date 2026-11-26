---
title: "accounting.* operations"
description: "The core operations named accounting.*"
sidebar:
  label: "accounting"
editUrl: false
---

## accounting.approveDay

Approve one day's entries for the books (a person): while approval is on, each day's entries (its summary, transfers, contacts and documents) wait until a person approves the whole day; then they are sent. Skip an entry first to leave it out. Each day approved for the first time counts towards the days after which entries go on their own; a day nobody approved does not count.

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
| `day` | string | yes |   | The day the entries belong to, YYYY-MM-DD |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `day` | string | yes |   |   |
| `approved` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Entries now queued to send |
| `approvedDays` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `approveUntil` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `automatic` | boolean | yes |   |   |

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

## accounting.post.retry

Try a held entry again, or one waiting to retry, now (a person), once what held it is put right (a contact, an account in the books, a refusal). An entry already in the books whose reference was not found is looked up again, never sent again; any other is looked up by its reference before anything is written, so it is never in the books twice. One waiting in Approvals is decided there. An entry before the start date is never sent.

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
| `id` | string | yes | min length 1, max length 64 | The entry's id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"queued"`, `"unknown"` | yes |   |   |

## accounting.post.skip

Leave one entry out of the books for good (a person), with why: one waiting for approval, queued, held or waiting to retry. Never one being sent, sent, in the books, or whose outcome is not yet known. One waiting in Approvals is turned down there with it. Its money is listed on the log as not in the books; an entry that depends on it is held.

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
| `id` | string | yes | min length 1, max length 64 | The entry's id |
| `reason` | string | yes | min length 1, max length 500 | Why it is left out |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"skipped"` | yes |   |   |

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
