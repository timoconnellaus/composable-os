---
title: "notification.* operations"
description: "The core operations named notification.*"
sidebar:
  label: "notification"
editUrl: false
---

## notification.deliverySettings

The org's notification delivery settings (admins): the org connection email notifications and digests go out through (`email`, an Email sending connection) and the one Slack DMs and channel posts go out through (`slack`), how many minutes an unread 'Approvals waiting' notice waits before it escalates (0: never) and on which channels, and the local hour of the daily digest. `problems` lists set connections that cannot be used, and why. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `email` | string or null | yes |   |   |
| `slack` | string or null | yes |   |   |
| `escalationMinutes` | integer | yes | ≥ 0, ≤ 10080 |   |
| `escalationChannels` | array of `"email"`, `"slack"` | yes | at most 10 |   |
| `digestHour` | integer | yes | ≥ 0, ≤ 23 |   |
| `problems` | array of string | yes |   |   |

## notification.list

Your notifications, newest first, one page at a time (unreadOnly for unread ones only), with your unread count. Each has a title, optional body, what it links to and the app path (href). Pass nextCursor back as cursor for the next page. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `unreadOnly` | boolean |   | default `false` |   |
| `limit` | integer |   | ≥ 1, ≤ 100, default `30` |   |
| `cursor` | string |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].type` | `"automation.message"`, `"automation.paused"`, `"automation.failed"`, `"approval.pending"`, `"approval.decided"`, `"system.message"`, `"digest"` | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].body` | string or null | yes |   |   |
| `items[].link` | object or null | yes |   |   |
| `items[].href` | string or null | yes |   |   |
| `items[].source` | map of any | yes |   |   |
| `items[].readAt` | string or null | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `unread` | number | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## notification.markRead

Mark your notifications read: some by id, or all of them (all: true). Only your own notifications change; ids that are not yours or already read are ignored. Returns how many changed.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string |   | at least 1, at most 100 |   |
| `all` | boolean |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `updated` | number | yes |   |   |

## notification.preferences

Your notification preferences: for each notification type, whether it also reaches you by email or Slack DM (in-app is always on), whether you get the daily digest in the app (digestInApp, on by default) and by email (digest), and which channels an admin has set up. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `types` | array of object | yes |   |   |
| `types[].type` | `"automation.message"`, `"automation.paused"`, `"automation.failed"`, `"approval.pending"`, `"approval.decided"`, `"system.message"` | yes |   |   |
| `types[].label` | string | yes |   |   |
| `types[].category` | string | yes |   |   |
| `types[].channels` | array of `"email"`, `"slack"` | yes |   |   |
| `digest` | boolean | yes |   |   |
| `digestInApp` | boolean | yes |   |   |
| `available` | object | yes |   |   |
| `available.email` | boolean | yes |   |   |
| `available.slack` | boolean | yes |   |   |

## notification.routes

The org's Slack channel routes (admins): each posts a short message with a link to a Slack channel when a record of an object is created, updated or deleted, optionally only when a field changes (`field`, with `from` / `to` values or `{ stageType: 'won' }` for a stage move). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `routes` | array of object | yes |   |   |
| `routes[].id` | string | yes | min length 1, max length 64 |   |
| `routes[].label` | string | yes | min length 1, max length 120 |   |
| `routes[].object` | string | yes | min length 1, max length 120 |   |
| `routes[].event` | `"created"`, `"updated"`, `"deleted"` | yes |   |   |
| `routes[].field` | string |   | min length 1, max length 120 |   |
| `routes[].from` | string or number or boolean or null or object |   |   |   |
| `routes[].to` | string or number or boolean or null or object |   |   |   |
| `routes[].channel` | string | yes | min length 1, max length 80, pattern `^#?[A-Za-z0-9_-][A-Za-z0-9._-]*$` |   |
| `routes[].enabled` | boolean | yes |   |   |

## notification.send

Send an in-app notification (the bell and inbox) to users: by id ({ userId }), every admin ({ role: 'admin' }), the user in a user field of a record ({ field: 'owner', record }) or that user's manager ({ managerOf: 'owner', record }; users have no manager field yet, so this goes to the admins, and notes says so). Optionally link it to a record, approval or automation run, and pass dedupeKey to send at most one per user per key. Returns the recipients. Writes one notification per recipient; nothing is emailed.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `to` | array of object | yes | at least 1, at most 20 |   |
| `type` | `"automation.message"`, `"automation.paused"`, `"automation.failed"`, `"approval.pending"`, `"approval.decided"`, `"system.message"`, `"digest"` |   |   |   |
| `title` | string | yes | min length 1, max length 200 |   |
| `body` | string |   | max length 2000 |   |
| `link` | object |   |   |   |
| `dedupeKey` | string |   | max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sent` | number | yes |   |   |
| `userIds` | array of string | yes |   |   |
| `notes` | array of string | yes |   |   |

## notification.setPreferences

Change your notification preferences: `channels` maps a notification type to the external channels it should also reach you on (`email`, `slack`; an empty list means in-app only; types you leave out keep their setting), `digest` turns the daily email digest on or off and `digestInApp` the daily digest in the app. Only your own preferences change.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `channels` | map of array of `"email"`, `"slack"` |   |   |   |
| `digest` | boolean |   |   |   |
| `digestInApp` | boolean |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `types` | array of object | yes |   |   |
| `types[].type` | `"automation.message"`, `"automation.paused"`, `"automation.failed"`, `"approval.pending"`, `"approval.decided"`, `"system.message"` | yes |   |   |
| `types[].label` | string | yes |   |   |
| `types[].category` | string | yes |   |   |
| `types[].channels` | array of `"email"`, `"slack"` | yes |   |   |
| `digest` | boolean | yes |   |   |
| `digestInApp` | boolean | yes |   |   |
| `available` | object | yes |   |   |
| `available.email` | boolean | yes |   |   |
| `available.slack` | boolean | yes |   |   |

## notification.setRoutes

Replace the org's Slack channel routes (human admins only, audited; at most 50). Each route: `label` (e.g. 'Deal won'), `object`, `event` (created, updated or deleted), optional `field` with `from` / `to` (a value, { in: [...] } or { stageType }), the Slack `channel` (#sales) and `enabled`. Routes without an id get one. Activities (synced email and meetings) cannot be routed. Posts go through the Slack connection of the delivery settings.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `routes` | array of object | yes | at most 50 |   |
| `routes[].id` | string |   | min length 1, max length 64 |   |
| `routes[].label` | string | yes | min length 1, max length 120 |   |
| `routes[].object` | string | yes | min length 1, max length 120 |   |
| `routes[].event` | `"created"`, `"updated"`, `"deleted"` | yes |   |   |
| `routes[].field` | string |   | min length 1, max length 120 |   |
| `routes[].from` | string or number or boolean or null or object |   |   |   |
| `routes[].to` | string or number or boolean or null or object |   |   |   |
| `routes[].channel` | string | yes | min length 1, max length 80, pattern `^#?[A-Za-z0-9_-][A-Za-z0-9._-]*$` |   |
| `routes[].enabled` | boolean | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `routes` | array of object | yes |   |   |
| `routes[].id` | string | yes | min length 1, max length 64 |   |
| `routes[].label` | string | yes | min length 1, max length 120 |   |
| `routes[].object` | string | yes | min length 1, max length 120 |   |
| `routes[].event` | `"created"`, `"updated"`, `"deleted"` | yes |   |   |
| `routes[].field` | string |   | min length 1, max length 120 |   |
| `routes[].from` | string or number or boolean or null or object |   |   |   |
| `routes[].to` | string or number or boolean or null or object |   |   |   |
| `routes[].channel` | string | yes | min length 1, max length 80, pattern `^#?[A-Za-z0-9_-][A-Za-z0-9._-]*$` |   |
| `routes[].enabled` | boolean | yes |   |   |

## notification.unreadCount

How many of your notifications are unread (the bell's badge), counted up to 1000. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `unread` | number | yes |   |   |

## notification.updateDeliverySettings

Change the org's notification delivery settings (human admins only, audited): `email` / `slack` pick the org connection each channel goes out through (null turns the channel off), `escalationMinutes` and `escalationChannels` set when and where unread approval notices escalate, `digestHour` the local hour of the daily digest. Fields you leave out keep their value. Each send is an outbound action: enable auto-approval of the internal kinds (outbound.setAutoApprove) or every notice waits for review.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `email` | string or null |   |   |   |
| `slack` | string or null |   |   |   |
| `escalationMinutes` | integer |   | ≥ 0, ≤ 10080 |   |
| `escalationChannels` | array of `"email"`, `"slack"` |   | at most 10 |   |
| `digestHour` | integer |   | ≥ 0, ≤ 23 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `email` | string or null | yes |   |   |
| `slack` | string or null | yes |   |   |
| `escalationMinutes` | integer | yes | ≥ 0, ≤ 10080 |   |
| `escalationChannels` | array of `"email"`, `"slack"` | yes | at most 10 |   |
| `digestHour` | integer | yes | ≥ 0, ≤ 23 |   |
