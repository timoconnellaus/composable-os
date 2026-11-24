---
title: "support.* operations"
description: "The core operations named support.*"
sidebar:
  label: "support"
editUrl: false
---

## support.grant.approve

Approve a requested support grant. Support gets its own support user (never your account) with the requested role until the grant expires: the requested duration, at most 72 hours. Everything support does is in the audit log. Admins only, and only a person in the app: AI assistants, MCP clients, automations, extensions and support users are refused. Returns the grant.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[A-Za-z0-9_-]{1,64}$` | Support grant id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `staffEmail` | string | yes |   |   |
| `reason` | string | yes |   |   |
| `role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
| `requestedMinutes` | number | yes |   | What support asked for; approval caps it at 3 days |
| `status` | `"requested"`, `"approved"`, `"denied"`, `"revoked"` | yes |   |   |
| `requestedAt` | string | yes |   |   |
| `decidedAt` | string or null | yes |   |   |
| `decidedBy` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `userId` | string or null | yes |   | The support user created on approval |
| `active` | boolean | yes |   | Approved and not yet expired |

## support.grant.deny

Deny a requested support grant: support gets no access. Admins only, and only a person in the app: AI assistants, MCP clients, automations, extensions and support users are refused. Returns the grant.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[A-Za-z0-9_-]{1,64}$` | Support grant id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `staffEmail` | string | yes |   |   |
| `reason` | string | yes |   |   |
| `role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
| `requestedMinutes` | number | yes |   | What support asked for; approval caps it at 3 days |
| `status` | `"requested"`, `"approved"`, `"denied"`, `"revoked"` | yes |   |   |
| `requestedAt` | string | yes |   |   |
| `decidedAt` | string or null | yes |   |   |
| `decidedBy` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `userId` | string or null | yes |   | The support user created on approval |
| `active` | boolean | yes |   | Approved and not yet expired |

## support.grant.list

List support access requests from the hosted service's support team, newest first: who asked, why, with which role, for how long, their status and when access expires. Admins only, and only a person in the app: AI assistants, MCP clients, automations, extensions and support users are refused. Read-only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].staffEmail` | string | yes |   |   |
| `items[].reason` | string | yes |   |   |
| `items[].role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
| `items[].requestedMinutes` | number | yes |   | What support asked for; approval caps it at 3 days |
| `items[].status` | `"requested"`, `"approved"`, `"denied"`, `"revoked"` | yes |   |   |
| `items[].requestedAt` | string | yes |   |   |
| `items[].decidedAt` | string or null | yes |   |   |
| `items[].decidedBy` | string or null | yes |   |   |
| `items[].expiresAt` | string or null | yes |   |   |
| `items[].userId` | string or null | yes |   | The support user created on approval |
| `items[].active` | boolean | yes |   | Approved and not yet expired |

## support.grant.revoke

Revoke a support grant before it expires: the support user is deactivated and its next request is refused. Admins only, and only a person in the app: AI assistants, MCP clients, automations, extensions and support users are refused. Returns the grant.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[A-Za-z0-9_-]{1,64}$` | Support grant id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `staffEmail` | string | yes |   |   |
| `reason` | string | yes |   |   |
| `role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
| `requestedMinutes` | number | yes |   | What support asked for; approval caps it at 3 days |
| `status` | `"requested"`, `"approved"`, `"denied"`, `"revoked"` | yes |   |   |
| `requestedAt` | string | yes |   |   |
| `decidedAt` | string or null | yes |   |   |
| `decidedBy` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `userId` | string or null | yes |   | The support user created on approval |
| `active` | boolean | yes |   | Approved and not yet expired |

## support.session.start

Record that a support session started under an approved support grant (audit only). Called by the app when support staff enter with a signed token; only the grant's own support user can call it. Writes nothing else.

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
| `grantId` | string | yes | pattern `^[A-Za-z0-9_-]{1,64}$` | Support grant id |
| `staffEmail` | string | yes | max length 320 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `grantId` | string | yes |   |   |
| `expiresAt` | string | yes |   |   |
