---
title: "connectedApp.* operations"
description: "The core operations named connectedApp.*"
sidebar:
  label: "connectedApp"
editUrl: false
---

## connectedApp.list

Your connected apps: the MCP clients you authorized to use the CRM for you, with their scopes, when they were connected and last used. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `includeRevoked` | boolean |   | default `false` | Also list revoked and replaced ones |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].userId` | string | yes |   |   |
| `items[].userName` | string or null | yes |   |   |
| `items[].userEmail` | string or null | yes |   |   |
| `items[].clientId` | string | yes |   |   |
| `items[].clientName` | string | yes |   |   |
| `items[].clientUri` | string or null | yes |   |   |
| `items[].redirectHost` | string or null | yes |   |   |
| `items[].scopes` | array of string | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].lastUsedAt` | string or null | yes |   |   |
| `items[].revokedAt` | string or null | yes |   |   |
| `items[].revokedBy` | string or null | yes |   |   |
| `items[].revokeReason` | string or null | yes |   |   |
| `items[].active` | boolean | yes |   |   |

## connectedApp.listAll

Every user's connected apps, for admins: who authorized which MCP client, with what scopes, and when it was last used. Read-only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `includeRevoked` | boolean |   | default `false` | Also list revoked and replaced ones |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].userId` | string | yes |   |   |
| `items[].userName` | string or null | yes |   |   |
| `items[].userEmail` | string or null | yes |   |   |
| `items[].clientId` | string | yes |   |   |
| `items[].clientName` | string | yes |   |   |
| `items[].clientUri` | string or null | yes |   |   |
| `items[].redirectHost` | string or null | yes |   |   |
| `items[].scopes` | array of string | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].lastUsedAt` | string or null | yes |   |   |
| `items[].revokedAt` | string or null | yes |   |   |
| `items[].revokedBy` | string or null | yes |   |   |
| `items[].revokeReason` | string or null | yes |   |   |
| `items[].active` | boolean | yes |   |   |

## connectedApp.register

Record that the signed-in user authorized an MCP client with the given scopes (the OAuth consent step). Scopes must be ones the user's role may grant: admin only for admins. Earlier connections of the same client for this user are marked replaced. Called by the consent page, never by agents.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `clientId` | string | yes | min length 1, max length 500 |   |
| `clientName` | string | yes | min length 1, max length 200 |   |
| `clientUri` | string or null |   |   |   |
| `redirectHost` | string or null |   |   |   |
| `scopes` | array of `"read"`, `"write"`, `"admin"` | yes | at least 1, at most 3 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `scopes` | array of string | yes |   |   |

## connectedApp.revoke

Disconnect an MCP client: its access and refresh tokens stop working immediately and it must be authorized again. Users revoke their own apps; admins can revoke anyone's. People only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^cap_.*` | Connected app id (cap_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `userId` | string | yes |   |   |
| `userName` | string or null | yes |   |   |
| `userEmail` | string or null | yes |   |   |
| `clientId` | string | yes |   |   |
| `clientName` | string | yes |   |   |
| `clientUri` | string or null | yes |   |   |
| `redirectHost` | string or null | yes |   |   |
| `scopes` | array of string | yes |   |   |
| `createdAt` | string | yes |   |   |
| `lastUsedAt` | string or null | yes |   |   |
| `revokedAt` | string or null | yes |   |   |
| `revokedBy` | string or null | yes |   |   |
| `revokeReason` | string or null | yes |   |   |
| `active` | boolean | yes |   |   |
| `grantId` | string or null | yes |   |   |
