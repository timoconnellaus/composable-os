---
title: "organisation.* operations"
description: "The core operations named organisation.*"
sidebar:
  label: "organisation"
editUrl: false
---

## organisation.create

Create an organisation (a company or other body) with a name and optional domains, website, industry, addresses, parent organisation, owner, tags and description. Check with organisation.list or search first: domains must be unique across live organisations (they power email → organisation matching), and a taken domain fails with a conflict. Domains are normalised (scheme, www. and paths stripped). Unknown tags are created. Returns the created organisation. Check possibleDuplicates in the result: existing organisations this one may duplicate by plain rules (same name, or a website at a domain another holds), each with its reason. If one is the same organisation, merge them with organisation.merge.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 200 |   |
| `domains` | array of object |   | at most 20 |   |
| `domains[].domain` | string | yes | min length 1, max length 300 | Bare domain, e.g. acme.com. A URL or www. prefix is stripped. |
| `domains[].primary` | boolean |   |   | Exactly one domain is primary; default the first. |
| `website` | string or null |   |   | Website URL |
| `industry` | string or null |   |   |   |
| `addresses` | array of object |   | at most 20 |   |
| `addresses[].label` | string or null |   |   | e.g. HQ, billing |
| `addresses[].line1` | string or null |   |   |   |
| `addresses[].line2` | string or null |   |   |   |
| `addresses[].city` | string or null |   |   |   |
| `addresses[].region` | string or null |   |   | State, province or county |
| `addresses[].postalCode` | string or null |   |   |   |
| `addresses[].country` | string or null |   |   | ISO 3166-1 alpha-2 country code, e.g. AU |
| `addresses[].primary` | boolean |   |   | Exactly one address is primary; default the first. |
| `parentId` | string (starts_with) or null |   |   | Parent organisation, e.g. the group it belongs to |
| `avatarKey` | string or null |   |   | R2 object key of an uploaded logo |
| `ownerId` | string or null |   |   | The user who owns this organisation |
| `description` | string or null |   |   | Markdown |
| `tags` | array of string |   | at most 50 | Tag names. Unknown tags are created. Replaces the record's tags. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `domains` | array of object | yes |   |   |
| `domains[].domain` | string | yes |   |   |
| `domains[].primary` | boolean | yes |   |   |
| `website` | string or null | yes |   |   |
| `industry` | string or null | yes |   |   |
| `addresses` | array of object | yes |   |   |
| `addresses[].label` | string or null | yes |   |   |
| `addresses[].line1` | string or null | yes |   |   |
| `addresses[].line2` | string or null | yes |   |   |
| `addresses[].city` | string or null | yes |   |   |
| `addresses[].region` | string or null | yes |   |   |
| `addresses[].postalCode` | string or null | yes |   |   |
| `addresses[].country` | string or null | yes |   |   |
| `addresses[].primary` | boolean | yes |   |   |
| `parentId` | string or null | yes |   |   |
| `parentName` | string or null | yes |   |   |
| `avatarKey` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `tags` | array of string | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `mergedIntoId` | string or null | yes |   |   |
| `possibleDuplicates` | array of object | yes | default `[]` | Existing records this one may duplicate, by plain rules (no score), at most 5. Check it: if one is the same record, merge them (person.merge / organisation.merge). |
| `possibleDuplicates[].id` | string | yes |   | The existing record's id |
| `possibleDuplicates[].title` | string | yes |   | Its name |
| `possibleDuplicates[].rules` | array of `"same_email"`, `"same_name_organisation"`, `"same_name_email_domain"`, `"same_phone"`, `"same_name_only"`, `"same_domain"`, `"same_name"` | yes |   |   |
| `possibleDuplicates[].reasons` | array of string | yes |   | One plain sentence per rule, e.g. 'Same name only' |

## organisation.delete

Move an organisation to Trash (soft delete). It disappears from lists, search and views, and its domains become free for other organisations. It can be restored with organisation.restore for 30 days, after which it is purged. Affiliations, activities and tasks linked to it are kept.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^org_.*` | Organisation id (org_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deletedAt` | string | yes |   |   |
| `restorableUntil` | string | yes |   |   |

## organisation.deleteMany

Move many organisations to Trash at once (soft delete), like organisation.delete for each. They can be restored one by one for 30 days. Fails, deleting none, if any id is not a live organisation. At most 100 organisations per call, applied atomically (all or none). For more, call again with the next ids: separate calls are separate transactions, each audited and gated on its own, so a later call can fail after earlier ones applied.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string (starts_with) | yes | at least 1, at most 100 | Organisation ids, at most 100 per call |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string | yes |   |   |
| `count` | number | yes |   |   |
| `deletedAt` | string | yes |   |   |
| `restorableUntil` | string | yes |   |   |

## organisation.erase

Permanently delete an organisation now (admins only), live or in Trash, together with any organisations merged into it: domains, addresses, affiliations and tags go, activities and tasks linked only to it are deleted, and its system activities are removed from every timeline. Audit-log content that mentions it is replaced with "[erased]" (who did what and when is kept), and so are in-app assistant conversations that referenced it (its id and name). Its domains, website and street lines, current and former, are matched too, and extension data, run history and notifications about it are redacted or deleted. A synced email's full body is deleted only when no person is linked to it; otherwise the body is kept without those terms. Cannot be undone; use organisation.delete for a reversible delete.

|  |  |
| --- | --- |
| Permission | `records:erase` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^org_.*` | Organisation id (org_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `erased` | array of string | yes |   |   |
| `activitiesDeleted` | number | yes |   |   |
| `tasksDeleted` | number | yes |   |   |
| `auditRowsRedacted` | number | yes |   |   |
| `conversationsScrubbed` | number | yes |   |   |
| `suggestionsRemoved` | number | yes |   | Suggested contacts removed (a person's addresses; an organisation's domains) |
| `extensionRowsErased` | number | yes |   | Extension rows deleted or scrubbed |
| `runsRedacted` | number | yes |   | Automation runs redacted |
| `notificationsDeleted` | number | yes |   |   |
| `memoryLinesDeleted` | number | yes |   | Assistant memory lines that named the subject |
| `eraseRequestsClosed` | number | yes |   | Open erase requests the erase closed (a person's customer account goes with them) |
| `agreementsKept` | object |   |   | A person's agreements (ADR 0646): health answers and the minor mark are deleted; each acceptance is kept, detached, until the retention period ends |
| `agreementsKept.count` | number | yes |   | Acceptances kept, no longer theirs, as the business's evidence |
| `agreementsKept.until` | string or null | yes |   | When the retention purge deletes them (agreement.retention); null: none kept, or the setting keeps them |
| `agreementsKept.deleted` | number | yes |   | A buyer's acceptances on an unpaid order or unconfirmed checkout, deleted |
| `bodiesDeleted` | number | yes |   | Synced email bodies deleted from blob storage now (the rest are retried) |

## organisation.get

Get one organisation by id, with all domains, addresses, tags, parent, owner and description. Deleted organisations are not found unless includeDeleted is true. Use affiliation.list for its people. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^org_.*` | Organisation id (org_…) |
| `includeDeleted` | boolean |   | default `false` | Also find organisations in Trash |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `domains` | array of object | yes |   |   |
| `domains[].domain` | string | yes |   |   |
| `domains[].primary` | boolean | yes |   |   |
| `website` | string or null | yes |   |   |
| `industry` | string or null | yes |   |   |
| `addresses` | array of object | yes |   |   |
| `addresses[].label` | string or null | yes |   |   |
| `addresses[].line1` | string or null | yes |   |   |
| `addresses[].line2` | string or null | yes |   |   |
| `addresses[].city` | string or null | yes |   |   |
| `addresses[].region` | string or null | yes |   |   |
| `addresses[].postalCode` | string or null | yes |   |   |
| `addresses[].country` | string or null | yes |   |   |
| `addresses[].primary` | boolean | yes |   |   |
| `parentId` | string or null | yes |   |   |
| `parentName` | string or null | yes |   |   |
| `avatarKey` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `tags` | array of string | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `mergedIntoId` | string or null | yes |   |   |

## organisation.list

List live organisations, one page at a time. Filter with structured filter JSON over organisation fields (e.g. { and: [{ field: 'domains', op: 'eq', value: 'acme.com' }, { field: 'industry', op: 'contains', value: 'software' }] }); 'domains' and 'tags' match any value. Sort by a sortable field (default name). Pass nextCursor back as cursor for the next page. Use fields to return only some columns. Read-only.

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
| `items[].name` | string |   |   |   |
| `items[].primaryDomain` | string or null |   |   |   |
| `items[].domains` | array of string |   |   |   |
| `items[].website` | string or null |   |   |   |
| `items[].industry` | string or null |   |   |   |
| `items[].parentId` | string or null |   |   |   |
| `items[].parentName` | string or null |   |   |   |
| `items[].ownerId` | string or null |   |   |   |
| `items[].avatarKey` | string or null |   |   |   |
| `items[].currentPeopleCount` | number |   |   |   |
| `items[].tags` | array of string |   |   |   |
| `items[].createdAt` | string |   |   |   |
| `items[].updatedAt` | string |   |   |   |
| `nextCursor` | string or null | yes |   |   |

## organisation.merge

Merge a duplicate organisation (mergedId) into another (survivorId). The survivor keeps its own values unless fields says to take the duplicate's (per field: 'survivor' or 'merged'); empty survivor fields are filled from the duplicate. Domains, addresses and tags are combined, and the duplicate's affiliations, child organisations, activity links and task links move to the survivor. The duplicate goes to Trash pointing at the survivor, and can be restored from there (without what moved). Returns the survivor.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `survivorId` | string (starts_with) | yes | max length 64, pattern `^org_.*` | The organisation that remains |
| `mergedId` | string (starts_with) | yes | max length 64, pattern `^org_.*` | The duplicate that is merged away into Trash |
| `fields` | map of `"survivor"`, `"merged"` |   | default `{}` | Which record's value to keep for each field (default survivor) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `domains` | array of object | yes |   |   |
| `domains[].domain` | string | yes |   |   |
| `domains[].primary` | boolean | yes |   |   |
| `website` | string or null | yes |   |   |
| `industry` | string or null | yes |   |   |
| `addresses` | array of object | yes |   |   |
| `addresses[].label` | string or null | yes |   |   |
| `addresses[].line1` | string or null | yes |   |   |
| `addresses[].line2` | string or null | yes |   |   |
| `addresses[].city` | string or null | yes |   |   |
| `addresses[].region` | string or null | yes |   |   |
| `addresses[].postalCode` | string or null | yes |   |   |
| `addresses[].country` | string or null | yes |   |   |
| `addresses[].primary` | boolean | yes |   |   |
| `parentId` | string or null | yes |   |   |
| `parentName` | string or null | yes |   |   |
| `avatarKey` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `tags` | array of string | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `mergedIntoId` | string or null | yes |   |   |
| `moved` | object | yes |   |   |
| `moved.affiliations` | number | yes |   |   |
| `moved.activities` | number | yes |   |   |
| `moved.tasks` | number | yes |   |   |
| `moved.children` | number | yes |   |   |

## organisation.restore

Restore an organisation from Trash, including one that was merged away (it comes back without what the merge moved to the survivor). Fails with a conflict if one of its domains now belongs to another live organisation. Returns the restored organisation.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^org_.*` | Organisation id (org_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `domains` | array of object | yes |   |   |
| `domains[].domain` | string | yes |   |   |
| `domains[].primary` | boolean | yes |   |   |
| `website` | string or null | yes |   |   |
| `industry` | string or null | yes |   |   |
| `addresses` | array of object | yes |   |   |
| `addresses[].label` | string or null | yes |   |   |
| `addresses[].line1` | string or null | yes |   |   |
| `addresses[].line2` | string or null | yes |   |   |
| `addresses[].city` | string or null | yes |   |   |
| `addresses[].region` | string or null | yes |   |   |
| `addresses[].postalCode` | string or null | yes |   |   |
| `addresses[].country` | string or null | yes |   |   |
| `addresses[].primary` | boolean | yes |   |   |
| `parentId` | string or null | yes |   |   |
| `parentName` | string or null | yes |   |   |
| `avatarKey` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `tags` | array of string | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `mergedIntoId` | string or null | yes |   |   |

## organisation.update

Update an organisation's fields. Only the fields you pass change; pass null to clear one. domains, addresses and tags replace the whole list when given. Changing the name, domains, parent or owner posts a system activity on its timeline. Fails with a conflict if a domain belongs to another live organisation, and refuses a parent that would make a cycle. Returns the updated organisation.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^org_.*` | Organisation id (org_…) |
| `name` | string |   | min length 1, max length 200 |   |
| `domains` | array of object |   | at most 20 |   |
| `domains[].domain` | string | yes | min length 1, max length 300 | Bare domain, e.g. acme.com. A URL or www. prefix is stripped. |
| `domains[].primary` | boolean |   |   | Exactly one domain is primary; default the first. |
| `website` | string or null |   |   | Website URL |
| `industry` | string or null |   |   |   |
| `addresses` | array of object |   | at most 20 |   |
| `addresses[].label` | string or null |   |   | e.g. HQ, billing |
| `addresses[].line1` | string or null |   |   |   |
| `addresses[].line2` | string or null |   |   |   |
| `addresses[].city` | string or null |   |   |   |
| `addresses[].region` | string or null |   |   | State, province or county |
| `addresses[].postalCode` | string or null |   |   |   |
| `addresses[].country` | string or null |   |   | ISO 3166-1 alpha-2 country code, e.g. AU |
| `addresses[].primary` | boolean |   |   | Exactly one address is primary; default the first. |
| `parentId` | string (starts_with) or null |   |   | Parent organisation, e.g. the group it belongs to |
| `avatarKey` | string or null |   |   | R2 object key of an uploaded logo |
| `ownerId` | string or null |   |   | The user who owns this organisation |
| `description` | string or null |   |   | Markdown |
| `tags` | array of string |   | at most 50 | Tag names. Unknown tags are created. Replaces the record's tags. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `domains` | array of object | yes |   |   |
| `domains[].domain` | string | yes |   |   |
| `domains[].primary` | boolean | yes |   |   |
| `website` | string or null | yes |   |   |
| `industry` | string or null | yes |   |   |
| `addresses` | array of object | yes |   |   |
| `addresses[].label` | string or null | yes |   |   |
| `addresses[].line1` | string or null | yes |   |   |
| `addresses[].line2` | string or null | yes |   |   |
| `addresses[].city` | string or null | yes |   |   |
| `addresses[].region` | string or null | yes |   |   |
| `addresses[].postalCode` | string or null | yes |   |   |
| `addresses[].country` | string or null | yes |   |   |
| `addresses[].primary` | boolean | yes |   |   |
| `parentId` | string or null | yes |   |   |
| `parentName` | string or null | yes |   |   |
| `avatarKey` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `tags` | array of string | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `mergedIntoId` | string or null | yes |   |   |

## organisation.updateMany

Set the same fields on many organisations at once: owner, industry, parent, and tags to add or remove. Fields you leave out are untouched; pass null to clear owner, industry or parent. Owner and parent changes post a system activity on each organisation's timeline. At most 100 organisations per call, applied atomically (all or none). For more, call again with the next ids: separate calls are separate transactions, each audited and gated on its own, so a later call can fail after earlier ones applied. Returns the ids updated.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `bulk-write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string (starts_with) | yes | at least 1, at most 100 | Organisation ids, at most 100 per call |
| `set` | object |   | default `{}` |   |
| `set.ownerId` | string or null |   |   |   |
| `set.industry` | string or null |   |   |   |
| `set.parentId` | string (starts_with) or null |   |   |   |
| `addTags` | array of string |   | at most 10 | Tag names to add (created if unknown) |
| `removeTags` | array of string |   | at most 10 | Tag names to remove |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string | yes |   |   |
| `count` | number | yes |   |   |
