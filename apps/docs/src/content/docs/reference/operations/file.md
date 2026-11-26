---
title: "file.* operations"
description: "The core operations named file.*"
sidebar:
  label: "file"
editUrl: false
---

## file.checkUpload

Whether an upload of a file of this size may go ahead: onto this note (its author or someone allowed to manage notes, a kind that takes files, at most 20 files a note), or waiting for a note not yet saved; and within the business's storage. The upload route asks it before reading the file. Read-only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `note` | string (starts_with) |   | max length 64, pattern `^act_.*` | The note (act_…) |
| `bytes` | integer | yes | ≥ 0, ≤ 9007199254740991 | The size the upload says it is |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ok` | `true` | yes |   |   |

## file.delete

Remove a file from its note, at once and for good (it does not go to the Trash): its note's author or someone allowed to manage notes, or the person who uploaded it while it waits for its note. A person only. Returns the file's id.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^fil_.*` | A record file's id (fil_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |

## file.serve

Whether the caller may be served one record file now, and how: only a person who may read the note it is attached to, at this moment (its level, a private note's owner), and never a note in the Trash. Anything else is not found. Serves of a file on a note kept from the whole staff are recorded in the audit log. The file route (`/api/files/<id>`) streams it. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^fil_.*` | A record file's id (fil_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `key` | string | yes |   |   |
| `type` | `"image/jpeg"`, `"image/png"`, `"image/webp"`, `"application/pdf"` | yes |   |   |
| `bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `filename` | string | yes |   | The name to save it under, ending in its type's extension |

## file.storage.get

How much storage the files attached to notes take, how many there are, and the limit past which uploads are refused. People allowed to manage notes. Read-only.

|  |  |
| --- | --- |
| Permission | `notes:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `usedBytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | What every file attached to notes takes |
| `files` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `capBytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The limit: uploads past it are refused |

## file.storage.setCap

Change the limit on what the files attached to notes may take, in bytes (1 GB to 10 TB; default 10 GB). Uploads past it are refused; nothing already kept is deleted. A human admin in the app only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `capBytes` | integer | yes | ≥ 1073741824, ≤ 10995116277760 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `usedBytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | What every file attached to notes takes |
| `files` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `capBytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The limit: uploads past it are refused |
| `previousCapBytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## file.upload

Store a photo or PDF a person uploaded to attach to a note: a JPEG, PNG or WebP picture (at most 10 MB) or a PDF (at most 20 MB), typed from its bytes, never its name; location, camera and other metadata are removed from a picture before it is kept. With a note, it is attached to that note at once (its author or someone allowed to manage notes; a kind that takes files; at most 20 a note). Without one, it waits for the note it goes with (activity.log's files) and is deleted if no note takes it within a day. The file comes from the upload route, not from this input. A person only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 200 | The file's name, as uploaded |
| `note` | string (starts_with) |   | max length 64, pattern `^act_.*` | The note (act_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   | The name it was uploaded with |
| `type` | `"image/jpeg"`, `"image/png"`, `"image/webp"`, `"application/pdf"` | yes |   |   |
| `bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `width` | integer or null | yes |   |   |
| `height` | integer or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `note` | string or null | yes |   |   |
