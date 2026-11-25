---
title: "inbox.* operations"
description: "The core operations named inbox.*"
sidebar:
  label: "inbox"
editUrl: false
---

## inbox.list

The shared inbox: conversations with people by email and chat, most recent first, one page at a time. view: 'mine' (yours), 'unassigned' (nobody has it) or 'all'. Filter by status (default open and waiting), channel, category or a person. Each item says who it is with (or the unknown sender's address), who has it, its status and times. Private conversations are listed only for admins and whoever has them. Pass nextCursor back as cursor for the next page. Read-only.

|  |  |
| --- | --- |
| Permission | `inbox:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `view` | `"mine"`, `"unassigned"`, `"all"` |   | default `"all"` |   |
| `status` | array of `"open"`, `"waiting"`, `"closed"` |   | at least 1, at most 3, default `["open","waiting"]` | Which statuses to list (default open and waiting) |
| `channel` | `"email"`, `"chat"` |   |   |   |
| `category` | string |   | min length 1, max length 80 |   |
| `personId` | string (starts_with) |   | max length 64, pattern `^per_.*` | One person's |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 100, default `25` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].channel` | `"email"`, `"chat"` | yes |   |   |
| `items[].subject` | string or null | yes |   |   |
| `items[].status` | `"open"`, `"waiting"`, `"closed"` | yes |   |   |
| `items[].person` | object or null | yes |   | The Person it is with; null while the sender is unknown |
| `items[].person.id` | string | yes |   |   |
| `items[].person.name` | string or null | yes |   |   |
| `items[].unknownSender` | string or null | yes |   | An unknown sender's address (null once linked to a Person) |
| `items[].senderUnverified` | boolean | yes |   | The sender check failed on a message |
| `items[].assignee` | object or null | yes |   | Who has it; null: unassigned |
| `items[].assignee.id` | string | yes |   |   |
| `items[].assignee.name` | string or null | yes |   |   |
| `items[].category` | string or null | yes |   |   |
| `items[].about` | object or null | yes |   | The record it is about |
| `items[].about.object` | string | yes |   |   |
| `items[].about.id` | string | yes |   |   |
| `items[].about.title` | string or null |   |   |   |
| `items[].private` | boolean | yes |   | Only admins and whoever has it see it |
| `items[].privateAt` | string or null | yes |   |   |
| `items[].privateBy` | string or null | yes |   |   |
| `items[].openedAt` | string | yes |   |   |
| `items[].lastInboundAt` | string or null | yes |   |   |
| `items[].lastReplyAt` | string or null | yes |   |   |
| `items[].firstReplyAt` | string or null | yes |   |   |
| `items[].replyDueAt` | string or null | yes |   |   |
| `items[].snoozedUntil` | string or null | yes |   |   |
| `items[].closedAt` | string or null | yes |   |   |
| `items[].closedBy` | string or null | yes |   |   |
| `items[].updatedAt` | string | yes |   |   |
| `items[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Pass back to a write to refuse it if this changed since |
| `nextCursor` | string or null | yes |   |   |
