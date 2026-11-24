---
title: "integration.* operations"
description: "The core operations named integration.*"
sidebar:
  label: "integration"
editUrl: false
---

## integration.call

Call a method on a connected gatekeeper's session, e.g. Gmail `searchMessages('from:ada')` or email sending `send({...})`. Find connections and resources with connection.list and the session's TypeScript API with integration.types. Reads are recorded as observations. Side effects (sending, posting) are NOT applied at once: each becomes an outbound action that a person approves in the Approvals inbox (unless an admin let that kind auto-apply), returned in `pending`; until then the gatekeeper simulates it. Cursor results return the first page. For several steps or nested objects (a message's thread, replies), use the Code Mode tool with `import { connect } from "codemode:<gatekeeper>"`.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `connectionId` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |
| `resource` | string | yes | min length 1, max length 200 | Resource key or binding name, e.g. GMAIL |
| `method` | string | yes | pattern `^[a-zA-Z][a-zA-Z0-9]{0,60}$` |   |
| `args` | array of any |   | at most 10, default `[]` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `value` | any | yes |   |   |
| `pending` | array of map of any | yes |   |   |
| `applied` | array of map of any | yes |   |   |

## integration.catalogue

The gatekeepers this CRM ships (Google, Microsoft, Slack, MCP, email, ZoomInfo, web search, inbound webhooks, …): what each does, whether an admin enabled it for this deployment, whether it is deployed, and whether it syncs mail or calendars. Read-only.

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
| `items[].vendor` | string | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].description` | string | yes |   |   |
| `items[].connect` | `"oauth"`, `"auto"` | yes |   |   |
| `items[].scopes` | array of `"personal"`, `"org"` | yes |   |   |
| `items[].singleton` | boolean | yes |   |   |
| `items[].syncs` | array of `"mail"`, `"calendar"` | yes |   |   |
| `items[].companion` | string or null | yes |   |   |
| `items[].devOnly` | boolean | yes |   |   |
| `items[].enabled` | boolean | yes |   |   |
| `items[].mode` | `"off"`, `"optional"`, `"on"` or null | yes |   |   |
| `items[].available` | boolean | yes |   |   |

## integration.setVendor

Enable or disable a gatekeeper for this deployment. For web search, `mode` is off, optional (each user turns it on for their own actors) or on (one org connection for everyone). Admins only, and only a human. Disabling stops new connections; existing ones keep working until disconnected.

|  |  |
| --- | --- |
| Permission | `integrations:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `vendor` | string | yes | pattern `^[a-z][a-z0-9-]{1,40}$` | Gatekeeper vendor, e.g. google |
| `enabled` | boolean | yes |   |   |
| `mode` | `"off"`, `"optional"`, `"on"` |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `vendor` | string | yes |   |   |
| `enabled` | boolean | yes |   |   |
| `mode` | `"off"`, `"optional"`, `"on"` or null | yes |   |   |

## integration.types

The TypeScript declarations of a bound resource's session (what integration.call and Code Mode's codemode:&lt;gatekeeper&gt; can call), from the gatekeeper itself. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `connectionId` | string (starts_with) | yes | max length 64, pattern `^con_.*` | Connection id (con_…) |
| `resource` | string | yes | min length 1, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `tsType` | string | yes |   |   |
| `bindingName` | string | yes |   |   |
| `types` | string | yes |   |   |
