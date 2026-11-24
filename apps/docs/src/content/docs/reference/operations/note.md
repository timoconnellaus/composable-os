---
title: "note.* operations"
description: "The core operations named note.*"
sidebar:
  label: "note"
editUrl: false
---

## note.open

Open a note to read its text: a sensitive note is listed on timelines without it. Only a person who may read the note (its author, admins, and people the business named one by one) can open it; anyone else gets not found. Every opening is recorded in the audit log, without the text. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^act_.*` | The note (act_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `type` | `"note"`, `"email"`, `"call"`, `"meeting"`, `"system"` | yes |   |   |
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
| `level` | `"coaches"`, `"sensitive"` |   |   |   |
| `locked` | boolean |   |   |   |
