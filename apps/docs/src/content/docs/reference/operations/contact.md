---
title: "contact.* operations"
description: "The core operations named contact.*"
sidebar:
  label: "contact"
editUrl: false
---

## contact.forPerson

A Person's contact choices: each kind of message they may get on each channel with what is in force, and the history of every choice (when, how, by whom, why). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `child` | boolean | yes |   |   |
| `lines` | array of object | yes |   |   |
| `lines[].scope` | string | yes |   |   |
| `lines[].label` | string | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].purpose` | `"account"`, `"follow_up"`, `"news_and_offers"` | yes |   |   |
| `lines[].essential` | boolean | yes |   | Its email always goes |
| `lines[].channels` | array of object | yes |   |   |
| `lines[].channels[].channel` | `"email"`, `"text"`, `"push"` | yes |   |   |
| `lines[].channels[].value` | `"on"`, `"off"`, `"yes"`, `"no"` | yes |   | What is in force (a default when unset) |
| `lines[].channels[].fixed` | boolean | yes |   | Cannot be changed here: an essential kind's email always goes |
| `lines[].channels[].stopped` | boolean | yes |   | Stopped by a stop link or a STOP reply |
| `lines[].channels[].since` | string or null | yes |   | When the choice in force was made; null: the default |
| `history` | array of object | yes |   |   |
| `history[].scope` | string | yes |   |   |
| `history[].channel` | `"email"`, `"text"`, `"push"` | yes |   |   |
| `history[].value` | `"on"`, `"off"`, `"yes"`, `"no"` | yes |   |   |
| `history[].at` | string | yes |   |   |
| `history[].how` | `"member"`, `"staff_on_request"`, `"staff_from_paper"`, `"form"`, `"checkout"`, `"stop_link"`, `"stop_reply"`, `"start_reply"`, `"import"`, `"merge"` | yes |   |   |
| `history[].by` | string or null | yes |   | The staff user or customer account who made it, if any |
| `history[].reason` | string or null | yes |   |   |
| `history[].wording` | string or null | yes |   | The words shown when they said yes |

## contact.stop

The one-tap stop in an email: turns off the one kind of message, on the one channel, that the link's token names, for the one Person it names. It can only turn something off. The answer is the same whether the token was good or not.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer`, `public` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `token` | string | yes | max length 400 | The token from the stop link (its t parameter) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `done` | `true` | yes |   |   |
