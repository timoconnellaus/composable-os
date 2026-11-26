---
title: "erasure.* operations"
description: "The core operations named erasure.*"
sidebar:
  label: "erasure"
editUrl: false
---

## erasure.addressStatus

Whether an email address is on the erased-address list: the addresses of erased people, which mail and calendar sync drops (the list holds only a hash of each address). Admins only.

|  |  |
| --- | --- |
| Permission | `audit:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `email` | string | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `erased` | boolean | yes |   |   |
| `erasedAt` | string or null | yes |   |   |

## erasure.allowAddress

Take an email address off the erased-address list, so mail and calendar sync can match and suggest it again: for a person who was erased and has come back by consent. Admins only, and only a person in the app. Records the decision in the erase log, so a re-apply after a restore keeps it.

|  |  |
| --- | --- |
| Permission | `records:erase` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `email` | string | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `removed` | boolean | yes |   |   |

## erasure.reapply

After the database is restored from a backup or Time Travel, erase again every person and organisation the erase log says was erased, and restore the erased-address list and the booking-system copy's suppressions. The log lives in blob storage, outside the database, and holds only hashes. Safe to run more than once. Admins only, and only a person in the app.

|  |  |
| --- | --- |
| Permission | `records:erase` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `entries` | number | yes |   | Erase-log entries read |
| `people` | array of string | yes |   | People erased again |
| `organisations` | array of string | yes |   | Organisations erased again |
| `addresses` | number | yes |   | Addresses on the erased-address list |
| `outsideSuppressed` | number | yes |   | Booking-system refs and addresses suppressed again (stage 65), by keyed hash |
