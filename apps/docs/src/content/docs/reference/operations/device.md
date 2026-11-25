---
title: "device.* operations"
description: "The core operations named device.*"
sidebar:
  label: "device"
editUrl: false
---

## device.claim

On the desk origin's /enrol: the tablet types the enrolment code an admin was given, and becomes that enrolled device. The host sets its credential in a cookie that only the desk origin's calls read; it is never in the answer. Refused for a code that is wrong, used or run out.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `public` |
| Also | host-internal (`hostInternal`); only on the business's enrolled device (`deskOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `code` | string | yes | min length 1, max length 40 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes |   |   |
| `use` | `"signing"`, `"role"`, `"till"` | yes |   |   |

## device.enrol

Enrol a tablet or other browser as the business's own device, for one use: desk signing (stage 44), a device role a pack declares, or a till. Answers a single-use enrolment code, good for 10 minutes, to type at the desk origin's /enrol on the device. Every admin is told. An admin who is a person only; no grant gives it.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 80 | What the device is called ("Front desk iPad") |
| `use` | `"signing"`, `"role"`, `"till"` | yes |   | signing: desk signing (stage 44). role: a device role a pack declares (role names it). till: a till (not yet). |
| `role` | string |   | max length 80 | For use role: the device role, &lt;pack&gt;.&lt;role&gt;, an installed pack declares |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `device` | object | yes |   |   |
| `device.id` | string | yes |   |   |
| `device.name` | string | yes |   |   |
| `device.use` | `"signing"`, `"role"`, `"till"` | yes |   |   |
| `device.role` | string or null | yes |   |   |
| `device.state` | `"waiting"`, `"unclaimed"`, `"active"`, `"lapsed"`, `"revoked"` | yes |   | waiting: its enrolment code is not used yet; unclaimed: the code ran out; active; revoked |
| `device.enrolledBy` | object | yes |   |   |
| `device.enrolledBy.id` | string | yes |   |   |
| `device.enrolledBy.name` | string | yes |   |   |
| `device.enrolledAt` | string | yes |   |   |
| `device.claimedAt` | string or null | yes |   |   |
| `device.lastSeenAt` | string or null | yes |   |   |
| `device.browser` | string or null | yes |   | The browser it last said it was (at the claim or a rotation) |
| `device.network` | string or null | yes |   | The network address it last came from |
| `device.flags` | array of object | yes |   |   |
| `device.flags[].kind` | `"browser"`, `"network"` | yes |   |   |
| `device.flags[].at` | string | yes |   |   |
| `device.lockedUntil` | string or null | yes |   | Wrong desk codes locked it until then |
| `device.revokedAt` | string or null | yes |   |   |
| `device.revokedBy` | string or null | yes |   | Who revoked it; null for a clone or a lapse |
| `device.revokeReason` | `"admin"`, `"clone"`, `"lapsed"` or null | yes |   |   |
| `code` | string | yes |   | The enrolment code: shown once, never stored in the clear |
| `expiresAt` | string | yes |   |   |
| `enrolUrl` | string | yes |   | Where to type it, on the device |

## device.heartbeat

Called by an enrolled device holding a device role (a check-in tablet) every few minutes, so it is seen as on and does not lapse after 30 days. Answers the device's own name and role, so its screen knows what it is for. Reads nothing else. Only the device itself, on the desk origin.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `device` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes |   | The name an admin gave the device |
| `role` | string | yes |   | The device role it holds, &lt;pack&gt;.&lt;role&gt; |

## device.list

Every enrolled device, of every use: its name, use, who enrolled it and when, when it was last seen, the browser and network it last came from and the changes flagged, a lock-out from wrong codes, and whether it was revoked (by an admin, as a copied credential, or unused for 30 days). Also where the desk is. Admins. Read-only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `deskUrl` | string or null | yes |   | The desk origin, or null when this deployment has none |
| `configured` | boolean | yes |   | Whether devices can be enrolled here (the secret and the hostname) |
| `devices` | array of object | yes |   |   |
| `devices[].id` | string | yes |   |   |
| `devices[].name` | string | yes |   |   |
| `devices[].use` | `"signing"`, `"role"`, `"till"` | yes |   |   |
| `devices[].role` | string or null | yes |   |   |
| `devices[].state` | `"waiting"`, `"unclaimed"`, `"active"`, `"lapsed"`, `"revoked"` | yes |   | waiting: its enrolment code is not used yet; unclaimed: the code ran out; active; revoked |
| `devices[].enrolledBy` | object | yes |   |   |
| `devices[].enrolledBy.id` | string | yes |   |   |
| `devices[].enrolledBy.name` | string | yes |   |   |
| `devices[].enrolledAt` | string | yes |   |   |
| `devices[].claimedAt` | string or null | yes |   |   |
| `devices[].lastSeenAt` | string or null | yes |   |   |
| `devices[].browser` | string or null | yes |   | The browser it last said it was (at the claim or a rotation) |
| `devices[].network` | string or null | yes |   | The network address it last came from |
| `devices[].flags` | array of object | yes |   |   |
| `devices[].flags[].kind` | `"browser"`, `"network"` | yes |   |   |
| `devices[].flags[].at` | string | yes |   |   |
| `devices[].lockedUntil` | string or null | yes |   | Wrong desk codes locked it until then |
| `devices[].revokedAt` | string or null | yes |   |   |
| `devices[].revokedBy` | string or null | yes |   | Who revoked it; null for a clone or a lapse |
| `devices[].revokeReason` | `"admin"`, `"clone"`, `"lapsed"` or null | yes |   |   |

## device.revoke

Revoke an enrolled device at once: its credential opens nothing again, and a signing session open on it ends in the same change. For a lost or stolen tablet, or one no longer used. Every admin is told. An admin who is a person only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `deviceId` | string | yes | min length 1, max length 64 | The device (dev_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `device` | object | yes |   |   |
| `device.id` | string | yes |   |   |
| `device.name` | string | yes |   |   |
| `device.use` | `"signing"`, `"role"`, `"till"` | yes |   |   |
| `device.role` | string or null | yes |   |   |
| `device.state` | `"waiting"`, `"unclaimed"`, `"active"`, `"lapsed"`, `"revoked"` | yes |   | waiting: its enrolment code is not used yet; unclaimed: the code ran out; active; revoked |
| `device.enrolledBy` | object | yes |   |   |
| `device.enrolledBy.id` | string | yes |   |   |
| `device.enrolledBy.name` | string | yes |   |   |
| `device.enrolledAt` | string | yes |   |   |
| `device.claimedAt` | string or null | yes |   |   |
| `device.lastSeenAt` | string or null | yes |   |   |
| `device.browser` | string or null | yes |   | The browser it last said it was (at the claim or a rotation) |
| `device.network` | string or null | yes |   | The network address it last came from |
| `device.flags` | array of object | yes |   |   |
| `device.flags[].kind` | `"browser"`, `"network"` | yes |   |   |
| `device.flags[].at` | string | yes |   |   |
| `device.lockedUntil` | string or null | yes |   | Wrong desk codes locked it until then |
| `device.revokedAt` | string or null | yes |   |   |
| `device.revokedBy` | string or null | yes |   | Who revoked it; null for a clone or a lapse |
| `device.revokeReason` | `"admin"`, `"clone"`, `"lapsed"` or null | yes |   |   |

## device.setUse

Change what an enrolled device is for: desk signing, a device role, or a till. A signing session open on it ends in the same change. Every admin is told. An admin who is a person only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `deviceId` | string | yes | min length 1, max length 64 | The device (dev_…) |
| `use` | `"signing"`, `"role"`, `"till"` | yes |   | signing: desk signing (stage 44). role: a device role a pack declares (role names it). till: a till (not yet). |
| `role` | string |   | max length 80 | For use role: the device role, &lt;pack&gt;.&lt;role&gt;, an installed pack declares |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `device` | object | yes |   |   |
| `device.id` | string | yes |   |   |
| `device.name` | string | yes |   |   |
| `device.use` | `"signing"`, `"role"`, `"till"` | yes |   |   |
| `device.role` | string or null | yes |   |   |
| `device.state` | `"waiting"`, `"unclaimed"`, `"active"`, `"lapsed"`, `"revoked"` | yes |   | waiting: its enrolment code is not used yet; unclaimed: the code ran out; active; revoked |
| `device.enrolledBy` | object | yes |   |   |
| `device.enrolledBy.id` | string | yes |   |   |
| `device.enrolledBy.name` | string | yes |   |   |
| `device.enrolledAt` | string | yes |   |   |
| `device.claimedAt` | string or null | yes |   |   |
| `device.lastSeenAt` | string or null | yes |   |   |
| `device.browser` | string or null | yes |   | The browser it last said it was (at the claim or a rotation) |
| `device.network` | string or null | yes |   | The network address it last came from |
| `device.flags` | array of object | yes |   |   |
| `device.flags[].kind` | `"browser"`, `"network"` | yes |   |   |
| `device.flags[].at` | string | yes |   |   |
| `device.lockedUntil` | string or null | yes |   | Wrong desk codes locked it until then |
| `device.revokedAt` | string or null | yes |   |   |
| `device.revokedBy` | string or null | yes |   | Who revoked it; null for a clone or a lapse |
| `device.revokeReason` | `"admin"`, `"clone"`, `"lapsed"` or null | yes |   |   |
| `previous` | object | yes |   |   |
| `previous.use` | `"signing"`, `"role"`, `"till"` | yes |   |   |
| `previous.role` | string or null | yes |   |   |
