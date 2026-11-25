---
title: "practitioner.* operations"
description: "The core operations named practitioner.*"
sidebar:
  label: "practitioner"
editUrl: false
---

## practitioner.end

End an outside practitioner's account, with the reason: they can no longer sign in, and every session of theirs ends at once. An invite not yet accepted is withdrawn the same way. Needs practitioners:manage, and only a person can call it. Returns the account.

|  |  |
| --- | --- |
| Permission | `practitioners:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Practitioner account id (prc_…) |
| `reason` | string | yes | min length 1, max length 500 | Why the account ends |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `personId` | string | yes |   |   |
| `email` | string | yes |   |   |
| `name` | string | yes |   |   |
| `discipline` | string | yes |   |   |
| `practiceId` | string or null | yes |   |   |
| `status` | `"invited"`, `"active"`, `"ended"` | yes |   |   |
| `invitedBy` | string | yes |   |   |
| `invitedAt` | string | yes |   |   |
| `activatedAt` | string or null | yes |   |   |
| `endedAt` | string or null | yes |   |   |
| `endedBy` | string or null | yes |   |   |
| `endedReason` | string or null | yes |   |   |
| `lastSignInAt` | string or null | yes |   |   |

## practitioner.get

One outside practitioner's account by id (prc_…): name, sign-in address, discipline, practice, state, who invited and ended it and why. Needs practitioners:manage, and only a person can call it. Read-only.

|  |  |
| --- | --- |
| Permission | `practitioners:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Practitioner account id (prc_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `personId` | string | yes |   |   |
| `email` | string | yes |   |   |
| `name` | string | yes |   |   |
| `discipline` | string | yes |   |   |
| `practiceId` | string or null | yes |   |   |
| `status` | `"invited"`, `"active"`, `"ended"` | yes |   |   |
| `invitedBy` | string | yes |   |   |
| `invitedAt` | string | yes |   |   |
| `activatedAt` | string or null | yes |   |   |
| `endedAt` | string or null | yes |   |   |
| `endedBy` | string or null | yes |   |   |
| `endedReason` | string or null | yes |   |   |
| `lastSignInAt` | string or null | yes |   |   |

## practitioner.invite

Invite an outside practitioner (a physiotherapist, a dietitian) to their own practitioner account, by email, with their name, discipline and optionally the practice (an Organisation) they work for. They accept by signing in with a code emailed to that address. The account is apart from any staff or customer account the same address has, and reaches nothing about any client until that client agrees. The address's Person is used, or made when there is none. Inviting an address whose invite is not yet accepted updates and resends it; an address with an active or ended practitioner account cannot be invited. Needs practitioners:manage, and only a person can call it.

|  |  |
| --- | --- |
| Permission | `practitioners:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `email` | string | yes | min length 3, max length 254 | Their email address |
| `name` | string | yes | min length 1, max length 200 | Their name |
| `discipline` | string | yes | min length 1, max length 80 | What they do, as a label ("Physiotherapist", "Dietitian") |
| `practiceId` | string |   | min length 1, max length 64 | The practice they work for: an Organisation's id (org_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `personId` | string | yes |   |   |
| `email` | string | yes |   |   |
| `name` | string | yes |   |   |
| `discipline` | string | yes |   |   |
| `practiceId` | string or null | yes |   |   |
| `status` | `"invited"`, `"active"`, `"ended"` | yes |   |   |
| `invitedBy` | string | yes |   |   |
| `invitedAt` | string | yes |   |   |
| `activatedAt` | string or null | yes |   |   |
| `endedAt` | string or null | yes |   |   |
| `endedBy` | string or null | yes |   |   |
| `endedReason` | string or null | yes |   |   |
| `lastSignInAt` | string or null | yes |   |   |
| `invitationEmail` | `"sent"`, `"pending"`, `"not_sent"` | yes |   |   |

## practitioner.list

List the outside practitioners (physiotherapists, dietitians and the like) the business has invited: each one's name, sign-in address, discipline, practice, whether they are invited (not yet signed in), active or ended, and who invited and ended them. Needs practitioners:manage, and only a person can call it. Read-only.

|  |  |
| --- | --- |
| Permission | `practitioners:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"invited"`, `"active"`, `"ended"` |   |   | Only accounts in this state |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].personId` | string | yes |   |   |
| `items[].email` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].discipline` | string | yes |   |   |
| `items[].practiceId` | string or null | yes |   |   |
| `items[].status` | `"invited"`, `"active"`, `"ended"` | yes |   |   |
| `items[].invitedBy` | string | yes |   |   |
| `items[].invitedAt` | string | yes |   |   |
| `items[].activatedAt` | string or null | yes |   |   |
| `items[].endedAt` | string or null | yes |   |   |
| `items[].endedBy` | string or null | yes |   |   |
| `items[].endedReason` | string or null | yes |   |   |
| `items[].lastSignInAt` | string or null | yes |   |   |

## practitioner.me

Your own practitioner account, as a signed-in practitioner: your name, sign-in address and discipline. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `practitioner` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `email` | string | yes |   |   |
| `discipline` | string | yes |   |   |
