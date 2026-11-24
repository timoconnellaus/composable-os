---
title: "routineMail.* operations"
description: "The core operations named routineMail.*"
sidebar:
  label: "routineMail"
editUrl: false
---

## routineMail.get

Routine email (ADR 0590): every kind the shipped packs declare (a booking's confirmation, a class reminder) with whether it is on and how many were sent on their own, waited for a person or were not sent in the last 7 days; the business's site the emails may link to; and whether the approval policy lets routine email go out on its own now. Admins only. Read-only.

|  |  |
| --- | --- |
| Permission | `audit:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `packs` | array of object | yes |   |   |
| `packs[].id` | string | yes |   |   |
| `packs[].label` | string | yes |   |   |
| `packs[].on` | boolean | yes |   | Turned on by a human admin: its kinds send without approval. Off (the default): each of its emails is an ordinary send the approval policy decides, as before routine mail |
| `kinds` | array of object | yes |   |   |
| `kinds[].id` | string | yes |   | The kind: &lt;extension&gt;.&lt;kind&gt;, e.g. bookings.reminder |
| `kinds[].extension` | string | yes |   |   |
| `kinds[].extensionLabel` | string | yes |   |   |
| `kinds[].label` | string | yes |   |   |
| `kinds[].description` | string | yes |   |   |
| `kinds[].about` | string | yes |   | The object each email is about |
| `kinds[].messages` | array of string | yes |   |   |
| `kinds[].on` | boolean | yes |   | Sent; off sends nothing and queues nothing |
| `kinds[].defaultOn` | boolean | yes |   |   |
| `kinds[].lastWeek` | object | yes |   | Emails of this kind in the last 7 days: sent on their own (or once approved), waiting for a person, not sent because the kind was off, and refused or failed |
| `kinds[].lastWeek.sent` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `kinds[].lastWeek.waiting` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `kinds[].lastWeek.off` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `kinds[].lastWeek.other` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `orgDailyCap` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Routine emails the organisation sends in a day before the rest wait for a person |
| `retentionMonths` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Months the log is kept |
| `siteOrigin` | string or null | yes |   | The business's own site: the only place a routine email links to |
| `sendsOnItsOwn` | `"auto"`, `"review"`, `"deny"` | yes |   | What the approval policy and the deploy floor do with routine mail now: auto (it sends on its own), review (each waits for a person: the Cautious policy, or a floor of review on outbound) or deny (a floor refuses outbound) |

## routineMail.log

The routine email log (ADR 0590), newest first: each email a shipped pack's automation asked for, its kind, the record it is about, who it went to and by which rule (the record's person, their guardian or a paid order's own address), what started it and who made that change, whether it went on its own or was held for a person and why, and what became of it. Filter by kind or status. Admins only. Read-only.

|  |  |
| --- | --- |
| Permission | `audit:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | string |   | max length 80 |   |
| `status` | `"off"`, `"ready"`, `"sending"`, `"sent"`, `"waiting"`, `"denied"`, `"failed"` |   |   |   |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].at` | string | yes |   |   |
| `items[].kind` | string | yes |   |   |
| `items[].message` | string | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].recordId` | string | yes |   |   |
| `items[].recipient` | string | yes |   |   |
| `items[].recipientRule` | `"person"`, `"guardian"`, `"order"` | yes |   | How the host chose the recipient: the record's person, their guardian, or a paid order's own address |
| `items[].automationId` | string | yes |   |   |
| `items[].runId` | string | yes |   |   |
| `items[].trigger` | string | yes |   | What started the run: record, fieldChanged, dateRelative, schedule, manual… |
| `items[].triggeredBy` | object or null | yes |   | Who made the change that started it; null for the clock |
| `items[].triggeredBy.actor` | string | yes |   |   |
| `items[].triggeredBy.userId` | string or null | yes |   |   |
| `items[].triggeredBy.approved` | boolean | yes |   |   |
| `items[].routine` | boolean | yes |   | Allowed to go without a person |
| `items[].heldReason` | string or null | yes |   |   |
| `items[].status` | `"off"`, `"ready"`, `"sending"`, `"sent"`, `"waiting"`, `"denied"`, `"failed"` | yes |   |   |
| `items[].pendingActionId` | string or null | yes |   |   |
| `items[].error` | string or null | yes |   |   |

## routineMail.settings.update

Turn a pack's routine email on (packs: { bookings: true }: its kinds then send without approval; off, each is an ordinary send the policy decides), turn one kind on or off (kinds: { 'bookings.reminder': false }: off sends nothing and queues nothing), or set the business's own site, the only place routine email links to (siteOrigin, an https origin; null removes the links), the organisation's daily limit (orgDailyCap) or how long the log is kept (retentionMonths). Only what you pass changes. Admins only, and only a human can call it: AI assistants, MCP clients, automations and extensions are refused.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `packs` | map of boolean |   |   |   |
| `kinds` | map of boolean |   |   |   |
| `siteOrigin` | string or null |   |   |   |
| `orgDailyCap` | integer |   | ≥ 1, ≤ 100000 |   |
| `retentionMonths` | integer |   | ≥ 1, ≤ 84 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `packs` | map of boolean | yes |   |   |
| `kinds` | map of boolean | yes |   |   |
| `siteOrigin` | string or null | yes |   |   |
| `orgDailyCap` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `retentionMonths` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
