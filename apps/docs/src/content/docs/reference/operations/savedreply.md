---
title: "savedReply.* operations"
description: "The core operations named savedReply.*"
sidebar:
  label: "savedReply"
editUrl: false
---

## savedReply.archive

Archive a saved reply (archived: true, the default): it is kept, and no longer offered in the reply box; or bring an archived one back (archived: false). Who may: as for savedReply.update. People only. Returns the saved reply.

|  |  |
| --- | --- |
| Permission | `inbox:work` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^svr_.*` | Saved reply id (svr_…) |
| `archived` | boolean |   | default `true` |   |
| `version` | integer |   | ≥ 0, ≤ 9007199254740991 | The version you read: the write is refused if the saved reply changed since |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `body` | string | yes |   | Its words, with slots written {{person.firstName}} |
| `channels` | array of `"email"`, `"chat"` | yes |   | The channels it fits |
| `shared` | boolean | yes |   | Shared by the whole inbox; false: the caller's own |
| `owner` | object or null | yes |   | Whose own it is; null for a shared one |
| `owner.id` | string | yes |   |   |
| `owner.name` | string or null | yes |   |   |
| `slots` | array of `"person.firstName"`, `"staff.firstName"`, `"business.name"` | yes |   |   |
| `archived` | boolean | yes |   |   |
| `archivedAt` | string or null | yes |   |   |
| `canEdit` | boolean | yes |   | The caller may change or archive it |
| `updatedAt` | string | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Pass back to a write to refuse it if this changed since |

## savedReply.create

Save a reply: a title, its words (plain text, with only the fixed slots {{person.firstName}}, {{staff.firstName}} and {{business.name}}) and the channels it fits. shared: true makes it the whole inbox's (admins only); otherwise it is the caller's own. People only. Returns the saved reply.

|  |  |
| --- | --- |
| Permission | `inbox:work` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `title` | string | yes | min length 1, max length 120 |   |
| `body` | string | yes | min length 1, max length 10000 | Its words, plain text. Slots: {{person.firstName}}, {{staff.firstName}}, {{business.name}} |
| `channels` | array of `"email"`, `"chat"` |   | at least 1, at most 2, default `["email","chat"]` | The channels it fits |
| `shared` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `body` | string | yes |   | Its words, with slots written {{person.firstName}} |
| `channels` | array of `"email"`, `"chat"` | yes |   | The channels it fits |
| `shared` | boolean | yes |   | Shared by the whole inbox; false: the caller's own |
| `owner` | object or null | yes |   | Whose own it is; null for a shared one |
| `owner.id` | string | yes |   |   |
| `owner.name` | string or null | yes |   |   |
| `slots` | array of `"person.firstName"`, `"staff.firstName"`, `"business.name"` | yes |   |   |
| `archived` | boolean | yes |   |   |
| `archivedAt` | string or null | yes |   |   |
| `canEdit` | boolean | yes |   | The caller may change or archive it |
| `updatedAt` | string | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Pass back to a write to refuse it if this changed since |

## savedReply.fill

A saved reply's words for one conversation, its slots filled by the host: the person's first name, the caller's first name and the business's name. missing lists the slots that had no value (left empty, to fix before sending). Refused when it does not fit the conversation's channel, or is archived. Read-only: it sends nothing.

|  |  |
| --- | --- |
| Permission | `inbox:work` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^svr_.*` | Saved reply id (svr_…) |
| `conversationId` | string (starts_with) | yes | max length 64, pattern `^cnv_.*` | Conversation id (cnv_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `title` | string | yes |   |   |
| `body` | string | yes |   | Plain text, slots filled |
| `missing` | array of string | yes |   | Slots with no value, left empty |

## savedReply.list

The inbox's saved replies the caller may use: the shared ones and their own (never another staff member's own), by title, one page at a time. scope: 'all' (default), 'shared' or 'mine'. channel: only those that fit it. archived: true lists the archived ones instead. Each says its slots and whether the caller may change it. Pass nextCursor back as cursor for the next page. Read-only.

|  |  |
| --- | --- |
| Permission | `inbox:work` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `scope` | `"all"`, `"shared"`, `"mine"` |   | default `"all"` |   |
| `channel` | `"email"`, `"chat"` |   |   |   |
| `archived` | boolean |   | default `false` |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 100, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].body` | string | yes |   | Its words, with slots written {{person.firstName}} |
| `items[].channels` | array of `"email"`, `"chat"` | yes |   | The channels it fits |
| `items[].shared` | boolean | yes |   | Shared by the whole inbox; false: the caller's own |
| `items[].owner` | object or null | yes |   | Whose own it is; null for a shared one |
| `items[].owner.id` | string | yes |   |   |
| `items[].owner.name` | string or null | yes |   |   |
| `items[].slots` | array of `"person.firstName"`, `"staff.firstName"`, `"business.name"` | yes |   |   |
| `items[].archived` | boolean | yes |   |   |
| `items[].archivedAt` | string or null | yes |   |   |
| `items[].canEdit` | boolean | yes |   | The caller may change or archive it |
| `items[].updatedAt` | string | yes |   |   |
| `items[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Pass back to a write to refuse it if this changed since |
| `nextCursor` | string or null | yes |   |   |

## savedReply.update

Change a saved reply's title, words or channels. One's own may be changed by its owner; a shared one by an admin. Only what you pass changes. People only. Returns the saved reply.

|  |  |
| --- | --- |
| Permission | `inbox:work` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^svr_.*` | Saved reply id (svr_…) |
| `title` | string |   | min length 1, max length 120 |   |
| `body` | string |   | min length 1, max length 10000 | Its words, plain text. Slots: {{person.firstName}}, {{staff.firstName}}, {{business.name}} |
| `channels` | array of `"email"`, `"chat"` |   | at least 1, at most 2 | The channels it fits |
| `version` | integer |   | ≥ 0, ≤ 9007199254740991 | The version you read: the write is refused if the saved reply changed since |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `body` | string | yes |   | Its words, with slots written {{person.firstName}} |
| `channels` | array of `"email"`, `"chat"` | yes |   | The channels it fits |
| `shared` | boolean | yes |   | Shared by the whole inbox; false: the caller's own |
| `owner` | object or null | yes |   | Whose own it is; null for a shared one |
| `owner.id` | string | yes |   |   |
| `owner.name` | string or null | yes |   |   |
| `slots` | array of `"person.firstName"`, `"staff.firstName"`, `"business.name"` | yes |   |   |
| `archived` | boolean | yes |   |   |
| `archivedAt` | string or null | yes |   |   |
| `canEdit` | boolean | yes |   | The caller may change or archive it |
| `updatedAt` | string | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Pass back to a write to refuse it if this changed since |
