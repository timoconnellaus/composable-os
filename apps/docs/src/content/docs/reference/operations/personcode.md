---
title: "personCode.* operations"
description: "The core operations named personCode.*"
sidebar:
  label: "personCode"
editUrl: false
---

## personCode.issueCard

Give a person a check-in card or key tag: scan or type the card's code (at least 8 characters; a tag numbered in sequence can be guessed from its neighbour, so use cards with random codes) and a label to tell it apart. The card then checks them in at the check-in tablet until it is revoked. The code is never stored or shown again (only a keyed hash), and a code already on someone's live card is refused. Only a person on the staff with people:cards can do this: never the assistant, an MCP client or code. Audited.

|  |  |
| --- | --- |
| Permission | `people:cards` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | pattern `^per_[0-9A-HJKMNP-TV-Z]{26}$` | Who the card is for (per_…) |
| `code` | string | yes | min length 1, max length 200 | The card's code, as scanned or printed |
| `label` | string | yes | min length 1, max length 100 | To tell it apart, e.g. "blue key tag" |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"app"`, `"card"` | yes |   |   |
| `label` | string or null | yes |   |   |
| `issuedBy` | string or null | yes |   |   |
| `onGuardiansApp` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `lastUsedAt` | string or null | yes |   |   |
| `revokedAt` | string or null | yes |   |   |

## personCode.list

A person's check-in cards and app codes: each card's label, who issued it, when it was issued, last used and revoked, and each app sign-in showing a code. Never a code. Read-only.

|  |  |
| --- | --- |
| Permission | `people:cards` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | pattern `^per_[0-9A-HJKMNP-TV-Z]{26}$` | The person (per_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].kind` | `"app"`, `"card"` | yes |   |   |
| `items[].label` | string or null | yes |   |   |
| `items[].issuedBy` | string or null | yes |   |   |
| `items[].onGuardiansApp` | boolean | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].lastUsedAt` | string or null | yes |   |   |
| `items[].revokedAt` | string or null | yes |   |   |

## personCode.revokeCard

Revoke a person's check-in card (lost, or handed back), by its id from personCode.list: from now on it checks no one in. Revoking one already revoked changes nothing. Only a person on the staff with people:cards can do this. Audited.

|  |  |
| --- | --- |
| Permission | `people:cards` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `codeId` | string | yes | min length 1, max length 64 | The card's id (pc_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `revokedAt` | string | yes |   |   |
