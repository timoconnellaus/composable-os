---
title: "note.* operations"
description: "The core operations named note.*"
sidebar:
  label: "note"
editUrl: false
---

## note.kinds.list

The kinds of note the business keeps (Note, Session note, Sensitive, From the client and its own), in the composer's order: each with its template's sections (label, hint, required), the level a note of it starts at and the levels it may have. Retired kinds are left out unless includeRetired. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `includeRetired` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].key` | string or null | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].defaultLevel` | `"staff"`, `"coaches"`, `"sensitive"` | yes |   |   |
| `items[].lowestLevel` | `"staff"`, `"coaches"`, `"sensitive"` | yes |   |   |
| `items[].levels` | array of `"staff"`, `"coaches"`, `"sensitive"` | yes |   |   |
| `items[].sections` | array of object | yes |   |   |
| `items[].sections[].key` | string | yes |   |   |
| `items[].sections[].label` | string | yes |   |   |
| `items[].sections[].hint` | string or null | yes |   |   |
| `items[].sections[].required` | boolean | yes |   |   |
| `items[].filesAllowed` | boolean | yes |   |   |
| `items[].evidence` | boolean | yes |   |   |
| `items[].retentionYears` | integer or null | yes |   |   |
| `items[].active` | boolean | yes |   |   |
| `items[].position` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].updatedAt` | string | yes |   |   |

## note.kinds.retire

Retire a kind of note (retired: true): the composer no longer offers it and its notes keep it. retired: false offers it again. Note, the kind of a note written without one, is never retired. Needs notes:manage; a person only.

|  |  |
| --- | --- |
| Permission | `notes:manage` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^nkd_.*` | The kind (nkd_…) |
| `retired` | boolean |   | default `true` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `key` | string or null | yes |   |   |
| `name` | string | yes |   |   |
| `defaultLevel` | `"staff"`, `"coaches"`, `"sensitive"` | yes |   |   |
| `lowestLevel` | `"staff"`, `"coaches"`, `"sensitive"` | yes |   |   |
| `levels` | array of `"staff"`, `"coaches"`, `"sensitive"` | yes |   |   |
| `sections` | array of object | yes |   |   |
| `sections[].key` | string | yes |   |   |
| `sections[].label` | string | yes |   |   |
| `sections[].hint` | string or null | yes |   |   |
| `sections[].required` | boolean | yes |   |   |
| `filesAllowed` | boolean | yes |   |   |
| `evidence` | boolean | yes |   |   |
| `retentionYears` | integer or null | yes |   |   |
| `active` | boolean | yes |   |   |
| `position` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `updatedAt` | string | yes |   |   |

## note.kinds.save

Write a kind of note: a new one (no id), or a change to one's name, the level a note of it starts at (defaultLevel), the lowest level a note of it may have (lowestLevel) and its template (sections given whole and in order, at most 12: label, an optional hint, required). A changed level applies to notes written from now on. Needs notes:manage. An assistant's or MCP client's write always waits for a person who holds it too, and may change only the name and the template: who reads a kind's notes is a person's to set.

|  |  |
| --- | --- |
| Permission | `notes:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `mcp` |
| Also | always reviewed when called by `assistant`, `mcp` (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) |   | max length 64, pattern `^nkd_.*` | The kind to change; empty: a new one |
| `name` | string | yes | min length 1, max length 80 |   |
| `defaultLevel` | `"staff"`, `"coaches"`, `"sensitive"` |   |   | Where a note of it starts. Default: staff |
| `lowestLevel` | `"staff"`, `"coaches"`, `"sensitive"` |   |   | The lowest level a note of it may have |
| `sections` | array of object |   | at most 12, default `[]` |   |
| `sections[].key` | string |   | pattern `^[a-z][a-z0-9_]{0,39}$` | Keep a section's key when changing its label; a new section gets one |
| `sections[].label` | string | yes | min length 1, max length 80 |   |
| `sections[].hint` | string or null |   |   | A line under the label, as a prompt |
| `sections[].required` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `key` | string or null | yes |   |   |
| `name` | string | yes |   |   |
| `defaultLevel` | `"staff"`, `"coaches"`, `"sensitive"` | yes |   |   |
| `lowestLevel` | `"staff"`, `"coaches"`, `"sensitive"` | yes |   |   |
| `levels` | array of `"staff"`, `"coaches"`, `"sensitive"` | yes |   |   |
| `sections` | array of object | yes |   |   |
| `sections[].key` | string | yes |   |   |
| `sections[].label` | string | yes |   |   |
| `sections[].hint` | string or null | yes |   |   |
| `sections[].required` | boolean | yes |   |   |
| `filesAllowed` | boolean | yes |   |   |
| `evidence` | boolean | yes |   |   |
| `retentionYears` | integer or null | yes |   |   |
| `active` | boolean | yes |   |   |
| `position` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `updatedAt` | string | yes |   |   |

## note.open

Open a note to read its text: a sensitive note is listed on timelines without it. Only a person who may read the note (its author, admins, and people the business named one by one) can open it; anyone else gets not found. Every opening is recorded in the audit log, without the text. Read-only.

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
| `id` | string (starts_with) | yes | max length 64, pattern `^act_.*` | The note (act_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `type` | `"note"`, `"email"`, `"call"`, `"meeting"`, `"system"`, `"chat"` | yes |   |   |
| `subject` | string or null | yes |   |   |
| `body` | string or null | yes |   |   |
| `payload` | map of any | yes |   |   |
| `occurredAt` | string | yes |   |   |
| `authorUserId` | string or null | yes |   |   |
| `authorName` | string or null | yes |   |   |
| `authorActor` | string | yes |   |   |
| `links` | array of object | yes |   |   |
| `links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `synced` | boolean |   |   |   |
| `private` | boolean |   |   |   |
| `disclosure` | `"full"`, `"metadata"` or null |   |   |   |
| `hasFullBody` | boolean |   |   |   |
| `threadKey` | string or null |   |   |   |
| `conversationId` | string or null |   |   |   |
| `level` | `"coaches"`, `"sensitive"` |   |   |   |
| `locked` | boolean |   |   |   |
| `kind` | object |   |   |   |
| `kind.id` | string | yes |   |   |
| `kind.name` | string | yes |   |   |
| `sections` | array of object or null |   |   |   |
| `sections.key` | string | yes |   |   |
| `sections.label` | string | yes |   |   |
| `sections.text` | string | yes |   |   |
