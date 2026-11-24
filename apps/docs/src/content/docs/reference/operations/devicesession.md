---
title: "deviceSession.* operations"
description: "The core operations named deviceSession.*"
sidebar:
  label: "deviceSession"
editUrl: false
---

## deviceSession.list

Your own signed-in apps on phones and other devices (the HTTP surface's sessions): each one's device name, when it began and when it was last used, and which is this one. Browser sign-ins are not listed. Read-only.

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
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].deviceName` | string | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].lastUsedAt` | string | yes |   |   |
| `items[].current` | boolean | yes |   |   |

## deviceSession.revoke

Sign out one of your own apps on a device, by its id from deviceSession.list: its tokens stop working at once. Another person's session is not found. Humans only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Session id (dvs_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `revoked` | `true` | yes |   |   |

## deviceSession.settings.get

How many days a signed-in app on a phone or other device may go unused before it must sign in again. Read-only.

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
| `idleDays` | integer | yes | ≥ 1, ≤ 3650 | Days a phone or other device may stay signed in without being used (default 90). Then it must sign in again. Applies to staff and customer apps alike. |

## deviceSession.settings.update

Change how many days a signed-in app on a phone or other device may go unused before it must sign in again. Admins only, and only a human can call it: AI assistants, MCP clients, automations and extensions are refused.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `idleDays` | integer | yes | ≥ 1, ≤ 3650 | Days a phone or other device may stay signed in without being used (default 90). Then it must sign in again. Applies to staff and customer apps alike. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `idleDays` | integer | yes | ≥ 1, ≤ 3650 | Days a phone or other device may stay signed in without being used (default 90). Then it must sign in again. Applies to staff and customer apps alike. |
| `previous` | object | yes |   |   |
| `previous.idleDays` | integer | yes | ≥ 1, ≤ 3650 | Days a phone or other device may stay signed in without being used (default 90). Then it must sign in again. Applies to staff and customer apps alike. |
