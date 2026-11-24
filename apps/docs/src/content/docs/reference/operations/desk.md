---
title: "desk.* operations"
description: "The core operations named desk.*"
sidebar:
  label: "desk"
editUrl: false
---

## desk.accept

On the enrolled desk tablet, in a claimed session: the signer agrees to a version due now, for themselves or (forPersonId) for a child the session lists and who is still linked to them. Recorded as their own acceptance at the desk, with the session (who started it, the device); the copy is emailed to the address pinned at the start. Refused for anything not due for them now.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `public` |
| Also | host-internal (`hostInternal`); only on the business's enrolled device (`deskOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `versionId` | string | yes | min length 1, max length 64 | The version (agv_…), as desk.documents gave it |
| `forPersonId` | string |   | min length 1, max length 64 | A child the session lists (per_…); left out: the signer |
| `typedName` | string | yes | min length 1, max length 200 | The name the person typed beside the box: personal data, never shown to an AI |
| `signature` | object |   |   | A drawn signature as strokes in a 1000 by 400 box: personal data |
| `signature.width` | `1000` | yes |   |   |
| `signature.height` | `400` | yes |   |   |
| `signature.strokes` | array of array of array of any | yes | at least 1, at most 30 |   |
| `answers` | array of object |   | at least 1, at most 40 | A health form's answers: health information, never shown to an AI or logged |
| `answers[].key` | string | yes | min length 1, max length 40 |   |
| `answers[].yes` | boolean | yes |   |   |
| `answers[].note` | string |   | max length 1000 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `acceptedAt` | string | yes |   |   |
| `documentId` | string | yes |   |   |
| `versionNumber` | number | yes |   |   |

## desk.claim

On the enrolled desk tablet: type the code a person on the staff was given. Binds their session to this device and sets its token in a cookie (never in the answer); the device's credential is replaced in the same answer. Answers the business, the signer's given name and their children's. Wrong codes: five in a minute lock the device for five minutes.

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
| `business` | string | yes |   |   |
| `signer` | string | yes |   | The signer's given name |
| `children` | array of string | yes |   | The given names of the children they sign for |
| `endsAt` | string | yes |   | When the session is refused next, unless there is activity |

## desk.documents

On the enrolled desk tablet, in a claimed session: what the signer (and each child they sign for) has due now, each document's version in effect to read and agree to, and where the copy goes, masked. Nothing else of anyone's record. Counts as activity.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `public` |
| Also | host-internal (`hostInternal`); only on the business's enrolled device (`deskOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `business` | string | yes |   |   |
| `signer` | string | yes |   | The signer's given name |
| `children` | array of string | yes |   | The given names of the children they sign for |
| `endsAt` | string | yes |   | When the session is refused next, unless there is activity |
| `items` | array of object | yes |   |   |
| `items[].forPersonId` | string or null | yes |   | A child the signer agrees for; null: the signer |
| `items[].forName` | string | yes |   | Whose it is, by given name |
| `items[].documentId` | string | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].reason` | `"never"`, `"agree_again"`, `"ask_again"`, `"guardian"` | yes |   |   |
| `items[].version` | object | yes |   |   |
| `items[].version.id` | string | yes |   |   |
| `items[].version.documentId` | string | yes |   |   |
| `items[].version.number` | number | yes |   |   |
| `items[].version.kind` | string | yes |   |   |
| `items[].version.title` | string | yes |   |   |
| `items[].version.body` | any | yes |   |   |
| `items[].version.tickLabel` | string | yes |   |   |
| `items[].version.questions` | array of object or null | yes |   |   |
| `items[].version.questions.key` | string | yes |   |   |
| `items[].version.questions.text` | string | yes |   |   |
| `items[].version.questions.noteOnYes` | boolean | yes |   |   |
| `items[].version.how` | `"typed"`, `"drawn"` | yes |   |   |
| `items[].version.effectiveFrom` | string | yes |   |   |
| `items[].version.hash` | string | yes |   |   |
| `copyTo` | string or null | yes |   |   |

## desk.finish

On the enrolled desk tablet: "All done". Ends the session at once; the token answers nothing again and its cookie is cleared.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `public` |
| Also | host-internal (`hostInternal`); only on the business's enrolled device (`deskOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ended` | boolean | yes |   |   |

## desk.heartbeat

On the enrolled desk tablet, while the person reads or touches the page (at most every 30 seconds): keeps the session from its 3-minute idle limit. A heartbeat less than 20 seconds after the last one does not extend it, and none passes the 20-minute limit.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `public` |
| Also | host-internal (`hostInternal`); only on the business's enrolled device (`deskOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `endsAt` | string | yes |   |   |

## desk.status

On the desk origin: whether this browser is an enrolled device, and if so its name and use, so the tablet shows Enter code or Enrol. Reads nothing else. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `public` |
| Also | host-internal (`hostInternal`); only on the business's enrolled device (`deskOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `enrolled` | boolean | yes |   |   |
| `name` | string or null | yes |   |   |
| `use` | `"signing"`, `"role"`, `"till"` or null | yes |   |   |
