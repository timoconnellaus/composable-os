---
title: "connection.* operations"
description: "The core operations named connection.*"
sidebar:
  label: "connection"
editUrl: false
---

## connection.bindResource

Grant a connection's agents access to one resource (a mailbox, calendar, Drive folder, Slack channel, webhook endpoint, sender address …) by its URL, usually chosen in the resource picker. The integration host creates the gatekeeper facet that serves it. Owner (or an admin for org connections); people only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |
| `url` | string | yes | min length 3, max length 2000 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `connection` | object | yes |   |   |
| `connection.id` | string | yes |   |   |
| `connection.vendor` | string | yes |   |   |
| `connection.vendorTitle` | string | yes |   |   |
| `connection.scope` | `"personal"`, `"org"` | yes |   |   |
| `connection.ownerUserId` | string | yes |   |   |
| `connection.ownerName` | string or null | yes |   |   |
| `connection.title` | string | yes |   |   |
| `connection.accountLabel` | string or null | yes |   |   |
| `connection.sharingLevel` | `"full"`, `"metadata"`, `"none"` | yes |   |   |
| `connection.status` | `"connecting"`, `"active"`, `"expired"`, `"error"`, `"disconnected"` | yes |   |   |
| `connection.error` | string or null | yes |   |   |
| `connection.resources` | array of object | yes |   |   |
| `connection.resources[].key` | string | yes |   |   |
| `connection.resources[].url` | string | yes |   |   |
| `connection.resources[].pattern` | string | yes |   |   |
| `connection.resources[].title` | string | yes |   |   |
| `connection.resources[].tsType` | string | yes |   |   |
| `connection.resources[].bindingName` | string | yes |   |   |
| `connection.resources[].hookTsType` | string |   |   |   |
| `connection.resources[].syncKind` | `"mail"`, `"calendar"` or null | yes |   |   |
| `connection.sync` | map of any | yes |   |   |
| `connection.pendingOutbound` | number | yes |   |   |
| `connection.usable` | boolean | yes |   |   |
| `connection.manageable` | boolean | yes |   |   |
| `connection.createdAt` | string | yes |   |   |
| `connection.updatedAt` | string | yes |   |   |
| `connection.connectedAt` | string or null | yes |   |   |
| `connection.lastSyncAt` | string or null | yes |   |   |
| `resource` | object | yes |   |   |
| `resource.key` | string | yes |   |   |
| `resource.url` | string | yes |   |   |
| `resource.pattern` | string | yes |   |   |
| `resource.title` | string | yes |   |   |
| `resource.tsType` | string | yes |   |   |
| `resource.bindingName` | string | yes |   |   |
| `resource.hookTsType` | string |   |   |   |
| `resource.syncKind` | `"mail"`, `"calendar"` or null | yes |   |   |

## connection.completeConnect

Finish a connect flow: redeem the ticket the gatekeeper's final page handed to /connect/handoff, with the popup's nonce. Only the user who started the flow can redeem it; otherwise the staged account is revoked. May return a next step (a companion gatekeeper connected in the same flow). People only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `connectionId` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |
| `ticket` | string | yes | min length 8, max length 2000 |   |
| `nonce` | string | yes | min length 8, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `connection` | object | yes |   |   |
| `connection.id` | string | yes |   |   |
| `connection.vendor` | string | yes |   |   |
| `connection.vendorTitle` | string | yes |   |   |
| `connection.scope` | `"personal"`, `"org"` | yes |   |   |
| `connection.ownerUserId` | string | yes |   |   |
| `connection.ownerName` | string or null | yes |   |   |
| `connection.title` | string | yes |   |   |
| `connection.accountLabel` | string or null | yes |   |   |
| `connection.sharingLevel` | `"full"`, `"metadata"`, `"none"` | yes |   |   |
| `connection.status` | `"connecting"`, `"active"`, `"expired"`, `"error"`, `"disconnected"` | yes |   |   |
| `connection.error` | string or null | yes |   |   |
| `connection.resources` | array of object | yes |   |   |
| `connection.resources[].key` | string | yes |   |   |
| `connection.resources[].url` | string | yes |   |   |
| `connection.resources[].pattern` | string | yes |   |   |
| `connection.resources[].title` | string | yes |   |   |
| `connection.resources[].tsType` | string | yes |   |   |
| `connection.resources[].bindingName` | string | yes |   |   |
| `connection.resources[].hookTsType` | string |   |   |   |
| `connection.resources[].syncKind` | `"mail"`, `"calendar"` or null | yes |   |   |
| `connection.sync` | map of any | yes |   |   |
| `connection.pendingOutbound` | number | yes |   |   |
| `connection.usable` | boolean | yes |   |   |
| `connection.manageable` | boolean | yes |   |   |
| `connection.createdAt` | string | yes |   |   |
| `connection.updatedAt` | string | yes |   |   |
| `connection.connectedAt` | string or null | yes |   |   |
| `connection.lastSyncAt` | string or null | yes |   |   |
| `next` | object or null | yes |   |   |
| `next.url` | string | yes |   |   |
| `next.nonce` | string | yes |   |   |
| `next.vendor` | string | yes |   |   |

## connection.configure

Resource picker plumbing: call a method of the gatekeeper's resource configurator capability (listing drives, labels, channels …) for a resource type. People only, from Settings → Integrations.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |
| `pattern` | string | yes | min length 1, max length 500 |   |
| `method` | string | yes | pattern `^[a-zA-Z][a-zA-Z0-9]{0,60}$` | A configurator method |
| `args` | array of any |   | at most 10, default `[]` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `value` | any | yes |   |   |

## connection.create

Start connecting a gatekeeper: a personal connection (yours) or an org connection (admins). OAuth gatekeepers return a connect URL and a nonce: open the URL in a popup; its final page hands a ticket to /connect/handoff, which calls connection.completeConnect. Auto-provisioned gatekeepers (web search, email sending, webhooks) are active at once. People only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `vendor` | string | yes | pattern `^[a-z][a-z0-9-]{1,40}$` | Gatekeeper vendor, e.g. google |
| `scope` | `"personal"`, `"org"` | yes |   |   |
| `title` | string |   | min length 1, max length 200 |   |
| `sharingLevel` | `"full"`, `"metadata"`, `"none"` |   | default `"metadata"` | How synced mail and meetings are disclosed: full (content), metadata (subject, participants, time) or none (don't sync) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `connection` | object | yes |   |   |
| `connection.id` | string | yes |   |   |
| `connection.vendor` | string | yes |   |   |
| `connection.vendorTitle` | string | yes |   |   |
| `connection.scope` | `"personal"`, `"org"` | yes |   |   |
| `connection.ownerUserId` | string | yes |   |   |
| `connection.ownerName` | string or null | yes |   |   |
| `connection.title` | string | yes |   |   |
| `connection.accountLabel` | string or null | yes |   |   |
| `connection.sharingLevel` | `"full"`, `"metadata"`, `"none"` | yes |   |   |
| `connection.status` | `"connecting"`, `"active"`, `"expired"`, `"error"`, `"disconnected"` | yes |   |   |
| `connection.error` | string or null | yes |   |   |
| `connection.resources` | array of object | yes |   |   |
| `connection.resources[].key` | string | yes |   |   |
| `connection.resources[].url` | string | yes |   |   |
| `connection.resources[].pattern` | string | yes |   |   |
| `connection.resources[].title` | string | yes |   |   |
| `connection.resources[].tsType` | string | yes |   |   |
| `connection.resources[].bindingName` | string | yes |   |   |
| `connection.resources[].hookTsType` | string |   |   |   |
| `connection.resources[].syncKind` | `"mail"`, `"calendar"` or null | yes |   |   |
| `connection.sync` | map of any | yes |   |   |
| `connection.pendingOutbound` | number | yes |   |   |
| `connection.usable` | boolean | yes |   |   |
| `connection.manageable` | boolean | yes |   |   |
| `connection.createdAt` | string | yes |   |   |
| `connection.updatedAt` | string | yes |   |   |
| `connection.connectedAt` | string or null | yes |   |   |
| `connection.lastSyncAt` | string or null | yes |   |   |
| `connect` | object or null | yes |   |   |
| `connect.url` | string | yes |   |   |
| `connect.nonce` | string | yes |   |   |

## connection.disconnect

Disconnect: revoke the gatekeeper account, drop its resources, hooks and sync. Already synced activities stay. Outbound actions still waiting on it will fail if approved. Owner (or an admin for org connections); people only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `vendor` | string | yes |   |   |
| `vendorTitle` | string | yes |   |   |
| `scope` | `"personal"`, `"org"` | yes |   |   |
| `ownerUserId` | string | yes |   |   |
| `ownerName` | string or null | yes |   |   |
| `title` | string | yes |   |   |
| `accountLabel` | string or null | yes |   |   |
| `sharingLevel` | `"full"`, `"metadata"`, `"none"` | yes |   |   |
| `status` | `"connecting"`, `"active"`, `"expired"`, `"error"`, `"disconnected"` | yes |   |   |
| `error` | string or null | yes |   |   |
| `resources` | array of object | yes |   |   |
| `resources[].key` | string | yes |   |   |
| `resources[].url` | string | yes |   |   |
| `resources[].pattern` | string | yes |   |   |
| `resources[].title` | string | yes |   |   |
| `resources[].tsType` | string | yes |   |   |
| `resources[].bindingName` | string | yes |   |   |
| `resources[].hookTsType` | string |   |   |   |
| `resources[].syncKind` | `"mail"`, `"calendar"` or null | yes |   |   |
| `sync` | map of any | yes |   |   |
| `pendingOutbound` | number | yes |   |   |
| `usable` | boolean | yes |   |   |
| `manageable` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `connectedAt` | string or null | yes |   |   |
| `lastSyncAt` | string or null | yes |   |   |

## connection.get

One connection with its resources, sync state and status. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `vendor` | string | yes |   |   |
| `vendorTitle` | string | yes |   |   |
| `scope` | `"personal"`, `"org"` | yes |   |   |
| `ownerUserId` | string | yes |   |   |
| `ownerName` | string or null | yes |   |   |
| `title` | string | yes |   |   |
| `accountLabel` | string or null | yes |   |   |
| `sharingLevel` | `"full"`, `"metadata"`, `"none"` | yes |   |   |
| `status` | `"connecting"`, `"active"`, `"expired"`, `"error"`, `"disconnected"` | yes |   |   |
| `error` | string or null | yes |   |   |
| `resources` | array of object | yes |   |   |
| `resources[].key` | string | yes |   |   |
| `resources[].url` | string | yes |   |   |
| `resources[].pattern` | string | yes |   |   |
| `resources[].title` | string | yes |   |   |
| `resources[].tsType` | string | yes |   |   |
| `resources[].bindingName` | string | yes |   |   |
| `resources[].hookTsType` | string |   |   |   |
| `resources[].syncKind` | `"mail"`, `"calendar"` or null | yes |   |   |
| `sync` | map of any | yes |   |   |
| `pendingOutbound` | number | yes |   |   |
| `usable` | boolean | yes |   |   |
| `manageable` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `connectedAt` | string or null | yes |   |   |
| `lastSyncAt` | string or null | yes |   |   |

## connection.list

Connections to gatekeepers: your personal ones and the org's. Each has its owner, sharing level, status (and error), bound resources with the session type and binding name agents code against, sync state, and how many outbound actions wait for approval. `usable` says whether your actors may call it. Admins also see others' personal connections (metadata only). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `scope` | `"usable"`, `"mine"`, `"org"`, `"all"` |   | default `"usable"` |   |
| `includeDisconnected` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].vendor` | string | yes |   |   |
| `items[].vendorTitle` | string | yes |   |   |
| `items[].scope` | `"personal"`, `"org"` | yes |   |   |
| `items[].ownerUserId` | string | yes |   |   |
| `items[].ownerName` | string or null | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].accountLabel` | string or null | yes |   |   |
| `items[].sharingLevel` | `"full"`, `"metadata"`, `"none"` | yes |   |   |
| `items[].status` | `"connecting"`, `"active"`, `"expired"`, `"error"`, `"disconnected"` | yes |   |   |
| `items[].error` | string or null | yes |   |   |
| `items[].resources` | array of object | yes |   |   |
| `items[].resources[].key` | string | yes |   |   |
| `items[].resources[].url` | string | yes |   |   |
| `items[].resources[].pattern` | string | yes |   |   |
| `items[].resources[].title` | string | yes |   |   |
| `items[].resources[].tsType` | string | yes |   |   |
| `items[].resources[].bindingName` | string | yes |   |   |
| `items[].resources[].hookTsType` | string |   |   |   |
| `items[].resources[].syncKind` | `"mail"`, `"calendar"` or null | yes |   |   |
| `items[].sync` | map of any | yes |   |   |
| `items[].pendingOutbound` | number | yes |   |   |
| `items[].usable` | boolean | yes |   |   |
| `items[].manageable` | boolean | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].updatedAt` | string | yes |   |   |
| `items[].connectedAt` | string or null | yes |   |   |
| `items[].lastSyncAt` | string or null | yes |   |   |

## connection.reconnect

Start a reconnect for a connection whose credentials expired (or to widen its grant). Returns a connect URL and nonce, finished like a first connect. Owner only; people only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `connect` | object | yes |   |   |
| `connect.url` | string | yes |   |   |
| `connect.nonce` | string | yes |   |   |

## connection.resourceTypes

The kinds of resource a connection's account can grant (a mailbox, calendars, Drive folders, channels …), each with its URL pattern, for the resource picker. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].urlPattern` | string | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].description` | string | yes |   |   |
| `items[].grantable` | boolean | yes |   |   |
| `items[].vendor` | string | yes |   |   |
| `items[].syncKind` | `"mail"`, `"calendar"` or null | yes |   |   |

## connection.setSync

Choose which bound mailbox and calendar sync onto CRM timelines, and how far back the first sync reads (default 90 days, chunked). Sync follows the connection's sharing level; 'none' syncs nothing. Owner (or an admin for org connections); people only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |
| `mail` | string or null | yes |   | Resource key of the mailbox, or null |
| `calendar` | string or null | yes |   | Resource key of the calendar, or null |
| `backfillDays` | integer |   | ≥ 0, ≤ 365, default `90` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `vendor` | string | yes |   |   |
| `vendorTitle` | string | yes |   |   |
| `scope` | `"personal"`, `"org"` | yes |   |   |
| `ownerUserId` | string | yes |   |   |
| `ownerName` | string or null | yes |   |   |
| `title` | string | yes |   |   |
| `accountLabel` | string or null | yes |   |   |
| `sharingLevel` | `"full"`, `"metadata"`, `"none"` | yes |   |   |
| `status` | `"connecting"`, `"active"`, `"expired"`, `"error"`, `"disconnected"` | yes |   |   |
| `error` | string or null | yes |   |   |
| `resources` | array of object | yes |   |   |
| `resources[].key` | string | yes |   |   |
| `resources[].url` | string | yes |   |   |
| `resources[].pattern` | string | yes |   |   |
| `resources[].title` | string | yes |   |   |
| `resources[].tsType` | string | yes |   |   |
| `resources[].bindingName` | string | yes |   |   |
| `resources[].hookTsType` | string |   |   |   |
| `resources[].syncKind` | `"mail"`, `"calendar"` or null | yes |   |   |
| `sync` | map of any | yes |   |   |
| `pendingOutbound` | number | yes |   |   |
| `usable` | boolean | yes |   |   |
| `manageable` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `connectedAt` | string or null | yes |   |   |
| `lastSyncAt` | string or null | yes |   |   |

## connection.syncNow

Run a sync pass on a connection now (catch-up, or the next backfill chunk). Owner (or an admin for org connections); people only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ok` | `true` | yes |   |   |

## connection.unbindResource

Remove a resource from a connection: its facet, hooks and any sync from it stop. Owner (or an admin for org connections); people only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |
| `key` | string | yes | min length 1, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `vendor` | string | yes |   |   |
| `vendorTitle` | string | yes |   |   |
| `scope` | `"personal"`, `"org"` | yes |   |   |
| `ownerUserId` | string | yes |   |   |
| `ownerName` | string or null | yes |   |   |
| `title` | string | yes |   |   |
| `accountLabel` | string or null | yes |   |   |
| `sharingLevel` | `"full"`, `"metadata"`, `"none"` | yes |   |   |
| `status` | `"connecting"`, `"active"`, `"expired"`, `"error"`, `"disconnected"` | yes |   |   |
| `error` | string or null | yes |   |   |
| `resources` | array of object | yes |   |   |
| `resources[].key` | string | yes |   |   |
| `resources[].url` | string | yes |   |   |
| `resources[].pattern` | string | yes |   |   |
| `resources[].title` | string | yes |   |   |
| `resources[].tsType` | string | yes |   |   |
| `resources[].bindingName` | string | yes |   |   |
| `resources[].hookTsType` | string |   |   |   |
| `resources[].syncKind` | `"mail"`, `"calendar"` or null | yes |   |   |
| `sync` | map of any | yes |   |   |
| `pendingOutbound` | number | yes |   |   |
| `usable` | boolean | yes |   |   |
| `manageable` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `connectedAt` | string or null | yes |   |   |
| `lastSyncAt` | string or null | yes |   |   |

## connection.update

Rename a connection or change its sharing level (full / metadata / none for synced mail and meetings). A new level applies to what syncs from now on. Owner (or an admin for org connections); people only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |
| `title` | string |   | min length 1, max length 200 |   |
| `sharingLevel` | `"full"`, `"metadata"`, `"none"` |   |   | How synced mail and meetings are disclosed: full (content), metadata (subject, participants, time) or none (don't sync) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `vendor` | string | yes |   |   |
| `vendorTitle` | string | yes |   |   |
| `scope` | `"personal"`, `"org"` | yes |   |   |
| `ownerUserId` | string | yes |   |   |
| `ownerName` | string or null | yes |   |   |
| `title` | string | yes |   |   |
| `accountLabel` | string or null | yes |   |   |
| `sharingLevel` | `"full"`, `"metadata"`, `"none"` | yes |   |   |
| `status` | `"connecting"`, `"active"`, `"expired"`, `"error"`, `"disconnected"` | yes |   |   |
| `error` | string or null | yes |   |   |
| `resources` | array of object | yes |   |   |
| `resources[].key` | string | yes |   |   |
| `resources[].url` | string | yes |   |   |
| `resources[].pattern` | string | yes |   |   |
| `resources[].title` | string | yes |   |   |
| `resources[].tsType` | string | yes |   |   |
| `resources[].bindingName` | string | yes |   |   |
| `resources[].hookTsType` | string |   |   |   |
| `resources[].syncKind` | `"mail"`, `"calendar"` or null | yes |   |   |
| `sync` | map of any | yes |   |   |
| `pendingOutbound` | number | yes |   |   |
| `usable` | boolean | yes |   |   |
| `manageable` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `connectedAt` | string or null | yes |   |   |
| `lastSyncAt` | string or null | yes |   |   |
