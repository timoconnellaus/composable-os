---
title: "activity.* operations"
description: "The core operations named activity.*"
sidebar:
  label: "activity"
editUrl: false
---

## activity.delete

Move an activity to Trash (soft delete). It disappears from every linked record's timeline and from search, and can be restored with activity.restore for 30 days.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^act_.*` | Activity id (act_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deletedAt` | string | yes |   |   |
| `restorableUntil` | string | yes |   |   |

## activity.get

Get one activity by id with its payload, author and linked records. Deleted activities are not found unless includeDeleted is true. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^act_.*` | Activity id (act_…) |
| `includeDeleted` | boolean |   | default `false` |   |

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
| `kind` | object |   |   |   |
| `kind.id` | string | yes |   |   |
| `kind.name` | string | yes |   |   |
| `sections` | array of object or null |   |   |   |
| `sections.key` | string | yes |   |   |
| `sections.label` | string | yes |   |   |
| `sections.text` | string | yes |   |   |

## activity.getBody

The full body of a synced email whose mailbox shares full content (kept in blob storage; timelines show a snippet). Falls back to the stored snippet. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^act_.*` | Activity id (act_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `body` | string or null | yes |   |   |
| `full` | boolean | yes |   |   |

## activity.list

List live activities across all records (the Activity feed), newest first by default, one page at a time. Filter with structured filter JSON over activity fields, e.g. { field: 'type', op: 'in', value: ['note', 'call'] }, { field: 'authorUserId', op: 'eq', value: 'usr_…' } or { field: 'occurredAt', op: 'gte', value: '2026-01-01' }; linkedRecordId finds activities on a record (for one record's timeline prefer activity.listForRecord). Each item includes its linked records. Pass nextCursor back as cursor for the next page. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filter` | any |   |   | Structured filter: { and \| or: [...] } of { field, op, value }. |
| `sort` | object |   |   | Sort field and direction. Defaults per object. |
| `sort.field` | string | yes | min length 1, max length 64 |   |
| `sort.direction` | `"asc"`, `"desc"` |   | default `"asc"` |   |
| `cursor` | string |   | max length 1000 | nextCursor from the previous page. |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |
| `fields` | array of string |   | at most 100 | Return only these fields of each item (id is always included). |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].type` | `"note"`, `"email"`, `"call"`, `"meeting"`, `"system"` |   |   |   |
| `items[].subject` | string or null |   |   |   |
| `items[].body` | string or null |   |   |   |
| `items[].payload` | map of any |   |   |   |
| `items[].occurredAt` | string |   |   |   |
| `items[].authorUserId` | string or null |   |   |   |
| `items[].authorName` | string or null |   |   |   |
| `items[].authorActor` | string |   |   |   |
| `items[].links` | array of object |   |   |   |
| `items[].links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `items[].links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `items[].links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `items[].createdAt` | string |   |   |   |
| `items[].updatedAt` | string |   |   |   |
| `items[].deletedAt` | string or null |   |   |   |
| `items[].synced` | boolean |   |   |   |
| `items[].private` | boolean |   |   |   |
| `items[].disclosure` | `"full"`, `"metadata"` or null |   |   |   |
| `items[].hasFullBody` | boolean |   |   |   |
| `items[].threadKey` | string or null |   |   |   |
| `items[].level` | `"coaches"`, `"sensitive"` |   |   |   |
| `items[].locked` | boolean |   |   |   |
| `items[].kind` | object |   |   |   |
| `items[].kind.id` | string | yes |   |   |
| `items[].kind.name` | string | yes |   |   |
| `items[].sections` | array of object or null |   |   |   |
| `items[].sections.key` | string | yes |   |   |
| `items[].sections.label` | string | yes |   |   |
| `items[].sections.text` | string | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## activity.listForRecord

A record's timeline: live activities linked to the record, newest first (by occurredAt), one page at a time. Filter by types (e.g. ['note', 'email']); include 'system' to see field changes and job changes. Pass nextCursor back as cursor for the next page. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `recordId` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `types` | array of `"note"`, `"email"`, `"call"`, `"meeting"`, `"system"` |   | at least 1, at most 5 |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 100, default `25` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].type` | `"note"`, `"email"`, `"call"`, `"meeting"`, `"system"` | yes |   |   |
| `items[].subject` | string or null | yes |   |   |
| `items[].body` | string or null | yes |   |   |
| `items[].payload` | map of any | yes |   |   |
| `items[].occurredAt` | string | yes |   |   |
| `items[].authorUserId` | string or null | yes |   |   |
| `items[].authorName` | string or null | yes |   |   |
| `items[].authorActor` | string | yes |   |   |
| `items[].links` | array of object | yes |   |   |
| `items[].links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `items[].links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `items[].links[].title` | string or null | yes |   | The record's display name, if it still exists |
| `items[].createdAt` | string | yes |   |   |
| `items[].updatedAt` | string | yes |   |   |
| `items[].deletedAt` | string or null | yes |   |   |
| `items[].synced` | boolean |   |   |   |
| `items[].private` | boolean |   |   |   |
| `items[].disclosure` | `"full"`, `"metadata"` or null |   |   |   |
| `items[].hasFullBody` | boolean |   |   |   |
| `items[].threadKey` | string or null |   |   |   |
| `items[].level` | `"coaches"`, `"sensitive"` |   |   |   |
| `items[].locked` | boolean |   |   |   |
| `items[].kind` | object |   |   |   |
| `items[].kind.id` | string | yes |   |   |
| `items[].kind.name` | string | yes |   |   |
| `items[].sections` | array of object or null |   |   |   |
| `items[].sections.key` | string | yes |   |   |
| `items[].sections.label` | string | yes |   |   |
| `items[].sections.text` | string | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## activity.log

Log a note, email, call or meeting on one or more records' timelines (people, organisations, tasks). Each type takes a typed payload: email needs a direction and optional from/to/cc; call takes direction, durationSeconds and outcome; meeting takes startsAt/endsAt, location, url and attendees; note takes none. A note has a kind (note.kinds.list; default Note) and a level (default the kind's, never below its lowest); a kind with a template takes its sections instead of a body. Notes need a body or sections. occurredAt defaults to now. System activities cannot be logged; the CRM posts them itself. Returns the activity with its links.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

No fields.

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
| `kind` | object |   |   |   |
| `kind.id` | string | yes |   |   |
| `kind.name` | string | yes |   |   |
| `sections` | array of object or null |   |   |   |
| `sections.key` | string | yes |   |   |
| `sections.label` | string | yes |   |   |
| `sections.text` | string | yes |   |   |

## activity.proposeNote

Propose a note on a record for the person to OK, instead of adding it straight away. Use it for a fact about a customer the person wants kept: memory.propose refuses those, and this puts them on the record, where the team can see them. It always waits in the person's approvals, with Approve and Reject shown right here, and nothing is added until then.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | always reviewed by a person, whoever calls it (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `record` | object | yes |   | The record the note goes on, e.g. { object: 'person', id: 'per_…' } |
| `record.object` | string | yes | min length 1, max length 100 |   |
| `record.id` | string | yes | min length 1, max length 100 |   |
| `body` | string | yes | min length 1, max length 10000 | The note, in plain words |

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
| `kind` | object |   |   |   |
| `kind.id` | string | yes |   |   |
| `kind.name` | string | yes |   |   |
| `sections` | array of object or null |   |   |   |
| `sections.key` | string | yes |   |   |
| `sections.label` | string | yes |   |   |
| `sections.text` | string | yes |   |   |

## activity.restore

Restore an activity from Trash, putting it back on its linked records' timelines. Returns the restored activity.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^act_.*` | Activity id (act_…) |

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
| `kind` | object |   |   |   |
| `kind.id` | string | yes |   |   |
| `kind.name` | string | yes |   |   |
| `sections` | array of object or null |   |   |   |
| `sections.key` | string | yes |   |   |
| `sections.label` | string | yes |   |   |
| `sections.text` | string | yes |   |   |

## activity.setPrivate

Mark a synced email or meeting private (only you see it: it leaves everyone else's timelines, search and SQL views) or shared again. Only the owner of the mailbox or calendar it was synced from can do this. People only.

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
| `id` | string (starts_with) | yes | max length 64, pattern `^act_.*` | Activity id (act_…) |
| `private` | boolean | yes |   |   |

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
| `kind` | object |   |   |   |
| `kind.id` | string | yes |   |   |
| `kind.name` | string | yes |   |   |
| `sections` | array of object or null |   |   |   |
| `sections.key` | string | yes |   |   |
| `sections.label` | string | yes |   |   |
| `sections.text` | string | yes |   |   |

## activity.update

Edit a note, email, call or meeting: subject, body, occurredAt, payload (validated for the activity's type, replacing the old payload), links (replacing the list), or a note's level, kind (kindId) and template sections (which remake its body). The type cannot change. System activities cannot be edited. A note is changed by its author or someone allowed to manage notes; lowering a level is a person's, with that permission, and never below the kind's lowest. Returns the updated activity.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^act_.*` | Activity id (act_…) |
| `subject` | string or null |   |   | Headline: email subject, call topic |
| `body` | string or null |   |   | Markdown body: the note, email text, notes |
| `occurredAt` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` | ISO-8601 timestamp |
| `payload` | map of any |   |   | Typed by the activity's type |
| `links` | array of object |   | at least 1, at most 50 | Records whose timelines show this activity (people, organisations, tasks) |
| `links[].object` | string | yes | max length 64, pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9]*)?$` | Object type: person, organisation, task or an extension object (&lt;ext&gt;.&lt;object&gt;) |
| `links[].id` | string | yes | min length 1, max length 64 | Record id, e.g. per_… |
| `level` | `"staff"`, `"coaches"`, `"sensitive"` |   |   | Who may read the note: staff (every staff account, the default), coaches (its author, the staff who look after the one Person it is about, and managers) or sensitive (its author and the people the business named one by one; every opening is recorded). A note at coaches or sensitive is about exactly one Person. Notes only. |
| `kindId` | string (starts_with) |   | max length 64, pattern `^nkd_.*` | The kind of note (note.kinds.list). Default: Note |
| `sections` | array of object |   | at most 12 | A note from its kind's template: each section's key and text. The body is made from them; give one or the other. A kind with a required section takes its sections. |
| `sections[].key` | string | yes | min length 1, max length 40 | The template section's key |
| `sections[].text` | string | yes | max length 20000 | What the person wrote under it (Markdown) |

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
| `kind` | object |   |   |   |
| `kind.id` | string | yes |   |   |
| `kind.name` | string | yes |   |   |
| `sections` | array of object or null |   |   |   |
| `sections.key` | string | yes |   |   |
| `sections.label` | string | yes |   |   |
| `sections.text` | string | yes |   |   |
