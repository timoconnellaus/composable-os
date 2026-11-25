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
| `kinds[].host` | boolean | yes |   | Declared by the host itself (asked for by host code), not a pack |
| `kinds[].channels` | array of object | yes |   | The channels the kind declares, and which are on |
| `kinds[].channels[].channel` | `"email"`, `"text"`, `"push"` | yes |   |   |
| `kinds[].channels[].on` | boolean | yes |   | Email follows the kind's switch; text and push are switched on one by one |
| `kinds[].essential` | boolean | yes |   | Its email always goes: a person cannot turn it off (text and push they can) |
| `kinds[].purpose` | `"account"`, `"follow_up"` | yes |   |   |
| `kinds[].urgent` | boolean | yes |   | May go during quiet hours when waiting would make it late (a short-notice cancellation) |
| `kinds[].lastWeek` | object | yes |   | Emails of this kind in the last 7 days (texts and pushes are not counted here): sent on their own (or once approved), waiting for a person, not sent because the kind was off, and refused or failed |
| `kinds[].lastWeek.sent` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `kinds[].lastWeek.waiting` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `kinds[].lastWeek.off` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `kinds[].lastWeek.other` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `orgDailyCap` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Routine emails the organisation sends in a day before the rest wait for a person |
| `retentionMonths` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Months the log is kept |
| `receiptDailyCap` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Receipts the organisation sends in a day, apart from the routine email limit |
| `siteOrigin` | string or null | yes |   | The business's own site: the only place a routine email links to |
| `textOnlyWithoutApp` | boolean | yes |   | A member reached by a push on the business's app is not also texted |
| `quietHours` | object | yes |   | When texts and pushes wait, in quietZone; emails always go at once |
| `quietHours.start` | string | yes | pattern `^([01]\d\|2[0-3]):[0-5]\d$` |   |
| `quietHours.end` | string | yes | pattern `^([01]\d\|2[0-3]):[0-5]\d$` |   |
| `quietZone` | string or null | yes |   | The time zone quiet hours are read in; no text or push goes until it is set |
| `senderName` | string or null | yes |   | The name every text begins with; no text goes until it is set |
| `textLimitMinor` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The month's text limit in minor units of the business's currency; 0 sends no texts |
| `textSegmentPriceMinor` | integer or null | yes |   | What one text segment costs, in minor units; no text goes until it is set |
| `textCountries` | array of `"AU"`, `"NZ"`, `"GB"`, `"IE"`, `"US"`, `"CA"` | yes |   | The countries texts may go to, the business's own first; none sends no texts |
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
| `status` | `"off"`, `"ready"`, `"sending"`, `"sent"`, `"delivered"`, `"waiting"`, `"held"`, `"denied"`, `"failed"`, `"stopped"`, `"expired"`, `"over_limit"`, `"no_channel"` |   |   |   |
| `channel` | `"email"`, `"text"`, `"push"` |   |   |   |
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
| `items[].channel` | `"email"`, `"text"`, `"push"` | yes |   |   |
| `items[].recipient` | string | yes |   | The address an email went to; always empty for a text or push |
| `items[].recipientRule` | `"person"`, `"guardian"`, `"order"` | yes |   | How the host chose the recipient: the record's person, their guardian, or a paid order's own address |
| `items[].automationId` | string or null | yes |   | Null for a host kind's message |
| `items[].runId` | string or null | yes |   |   |
| `items[].trigger` | string | yes |   | What started the run: record, fieldChanged, dateRelative, schedule, manual… |
| `items[].triggeredBy` | object or null | yes |   | Who made the change that started it; null for the clock |
| `items[].triggeredBy.actor` | string | yes |   |   |
| `items[].triggeredBy.userId` | string or null | yes |   |   |
| `items[].triggeredBy.approved` | boolean | yes |   |   |
| `items[].routine` | boolean | yes |   | Allowed to go without a person |
| `items[].heldReason` | string or null | yes |   |   |
| `items[].status` | `"off"`, `"ready"`, `"sending"`, `"sent"`, `"delivered"`, `"waiting"`, `"held"`, `"denied"`, `"failed"`, `"stopped"`, `"expired"`, `"over_limit"`, `"no_channel"` | yes |   | sent, delivered (a text the provider confirmed), waiting (for a person, or for quiet hours to end: waitUntil), off, denied, failed, stopped, expired (its moment passed while it waited), over_limit (the month's text limit), no_channel (no address, textable number or app device) |
| `items[].waitUntil` | string or null | yes |   | Quiet hours: when a waiting text or push goes |
| `items[].pendingActionId` | string or null | yes |   |   |
| `items[].error` | string or null | yes |   |   |

## routineMail.settings.update

Turn a pack's routine email on (packs: { bookings: true }: its kinds then send without approval; off, each is an ordinary send the policy decides), turn one kind on or off (kinds: { 'bookings.reminder': false }: off sends nothing and queues nothing), or set the business's own site, the only place routine email links to (siteOrigin, an https origin; null removes the links), the organisation's daily limit (orgDailyCap), the receipts' own daily limit (receiptDailyCap) or how long the log is kept (retentionMonths). Switch a kind's text or push on (channels: { 'bookings.reminder': { push: true } }, only channels the kind declares), whether a member reached by push is also texted (textOnlyWithoutApp), or quiet hours, when texts and pushes wait (quietHours: { start: '21:00', end: '07:00' }; the same start and end: none) and the time zone they are read in (quietZone, e.g. 'Europe/London'), or the name every text begins with (senderName, at most 30 characters). A text or push cannot be switched on until quietZone is set, nor a text until senderName is. Texts: the month's limit (textLimitMinor, in minor units of the business's currency; 0 sends none), what one segment costs (textSegmentPriceMinor, from the provider's price list), and the countries texts may go to (textCountries, ISO codes, the business's own first). Only what you pass changes. Admins only, and only a human can call it: AI assistants, MCP clients, automations and extensions are refused.

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
| `packs` | map of boolean |   |   |   |
| `kinds` | map of boolean |   |   |   |
| `siteOrigin` | string or null |   |   |   |
| `orgDailyCap` | integer |   | ≥ 1, ≤ 100000 |   |
| `receiptDailyCap` | integer |   | ≥ 1, ≤ 100000 |   |
| `retentionMonths` | integer |   | ≥ 1, ≤ 84 |   |
| `channels` | map of object |   |   |   |
| `textOnlyWithoutApp` | boolean |   |   |   |
| `quietHours` | object |   |   |   |
| `quietHours.start` | string | yes | pattern `^([01]\d\|2[0-3]):[0-5]\d$` |   |
| `quietHours.end` | string | yes | pattern `^([01]\d\|2[0-3]):[0-5]\d$` |   |
| `quietZone` | string or null |   |   |   |
| `senderName` | string or null |   |   |   |
| `textLimitMinor` | integer |   | ≥ 0, ≤ 100000000 |   |
| `textSegmentPriceMinor` | integer or null |   |   |   |
| `textCountries` | array of `"AU"`, `"NZ"`, `"GB"`, `"IE"`, `"US"`, `"CA"` |   | at most 6 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `packs` | map of boolean | yes |   |   |
| `kinds` | map of boolean | yes |   |   |
| `siteOrigin` | string or null | yes |   |   |
| `orgDailyCap` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `receiptDailyCap` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `retentionMonths` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `channels` | map of object | yes |   |   |
| `textOnlyWithoutApp` | boolean | yes |   |   |
| `quietHours` | object | yes |   |   |
| `quietHours.start` | string | yes | pattern `^([01]\d\|2[0-3]):[0-5]\d$` |   |
| `quietHours.end` | string | yes | pattern `^([01]\d\|2[0-3]):[0-5]\d$` |   |
| `quietZone` | string or null | yes |   |   |
| `senderName` | string or null | yes |   |   |
| `textLimitMinor` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `textSegmentPriceMinor` | integer or null | yes |   |   |
| `textCountries` | array of `"AU"`, `"NZ"`, `"GB"`, `"IE"`, `"US"`, `"CA"` | yes |   |   |
