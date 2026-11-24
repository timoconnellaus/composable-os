---
title: "content.* operations"
description: "The core operations named content.*"
sidebar:
  label: "content"
editUrl: false
---

## content.get

Read one published record of a content object (a blog post) by its slug, as the public reads it: its published version, with only the fields the object lets the public read. An old slug of a record whose slug changed answers `redirect` with the slug it has now. A draft, an unpublished record and an unknown slug are all not found. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | A publishable object the public reads, e.g. `content.post` |
| `slug` | string | yes | min length 1, max length 200 | The record's address, e.g. `summer-launch` |

### Output

No fields.

## content.list

A page of the published records of a content object (blog posts), as the public reads them: published versions only, with only the fields the object lets the public read. Newest first by default (the object's date, else when each was published). Filter and sort on those fields; pass nextCursor back as cursor. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | A publishable object the public reads, e.g. `content.post` |
| `filter` | any |   |   |   |
| `sort` | object |   |   |   |
| `sort.field` | string | yes | min length 1, max length 64 |   |
| `sort.direction` | `"asc"`, `"desc"` |   | default `"asc"` |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 200, default `20` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].values` | map of any | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## content.preview

Read the working copy of one record of a content object with a preview link's token: what staff are editing, before it is published, with only the fields the public would read. The token names one record and works until it expires; for any other record, or after, it is not found. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | A publishable object the public reads, e.g. `content.post` |
| `slug` | string | yes | min length 1, max length 200 | The record's address, e.g. `summer-launch` |
| `token` | string | yes | min length 1, max length 100 | The token of a preview link |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `values` | map of any | yes |   |   |
| `kind` | `"preview"` | yes |   |   |

## content.previewLink

Make a preview link for one record of a content object: a token that lets anyone holding it read the record's working copy (the fields the public would read) with content.preview, for 24 hours by default and at most 168. Share it only with people who may see the draft. Returns the token and when it stops working.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | A publishable object the public reads, e.g. `content.post` |
| `id` | string | yes | min length 1, max length 64 | Record id |
| `hours` | integer |   | ≥ 1, ≤ 168, default `24` | How long it works |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `token` | string | yes |   |   |
| `expiresAt` | string | yes |   |   |

## content.previewLinks

The preview links of one record of a content object that still work: when each was made, by whom and when it stops. Never their tokens, which are shown once when a link is made. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | A publishable object the public reads, e.g. `content.post` |
| `id` | string | yes | min length 1, max length 64 | Record id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   | The link's id (not its token): what contentRevokePreview takes |
| `items[].expiresAt` | string | yes |   |   |
| `items[].createdBy` | string | yes |   |   |
| `items[].createdAt` | string | yes |   |   |

## content.reindex

Platform use only: catch the published-text index up with the objects' declarations (the minute cron): an object whose searchable fields changed has its records' rows made again from their current versions, a batch a call; an object no longer searched loses its rows. Returns how many records were written and whether more is due.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `records` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `more` | boolean | yes |   |   |

## content.revokePreview

Stop preview links of one record of a content object working now: one by its id (from content.previewLinks), or every one with `all`. Returns how many stopped.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | A publishable object the public reads, e.g. `content.post` |
| `id` | string | yes | min length 1, max length 64 | Record id |
| `link` | string |   | pattern `^[0-9a-f]{16}$` | The link's id |
| `all` | boolean |   |   | Every link of the record |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `revoked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## content.search

Search the published records of a content object (help pages, blog posts) by the words the public reads in them: their published versions only, never a draft or a working copy. Every word of two letters or more must match the start of a word, so partial input works. Best matches first, one result per record, each with its slug, title, the section the best match is in (its heading and anchor, to link to) and a highlighted snippet as plain and matching parts. Pass nextCursor back as cursor. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | A publishable object the public reads, e.g. `content.post` |
| `q` | string | yes | max length 200 | What the reader typed |
| `cursor` | string |   | pattern `^\d{1,3}$` | nextCursor from the previous page |
| `limit` | integer |   | ≥ 1, ≤ 50, default `10` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].slug` | string | yes |   | Read the record with content.get by this slug |
| `items[].title` | string or null | yes |   | The record's title, when the public reads it |
| `items[].titleHighlight` | array of object | yes |   | The title in parts, matching words marked |
| `items[].titleHighlight[].text` | string | yes |   |   |
| `items[].titleHighlight[].match` | boolean | yes |   |   |
| `items[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The published version the words are from |
| `items[].section` | object | yes |   | Where in the record the best match is |
| `items[].section.field` | string | yes |   | The content field the match is in |
| `items[].section.anchor` | string or null | yes |   | The heading's anchor: link to `#<anchor>`. Null: the top of the record |
| `items[].section.heading` | string | yes |   | The heading's words; empty before the first heading |
| `items[].section.headingHighlight` | array of object | yes |   |   |
| `items[].section.headingHighlight[].text` | string | yes |   |   |
| `items[].section.headingHighlight[].match` | boolean | yes |   |   |
| `items[].snippet` | array of object or null | yes |   | A short excerpt of the matching words, as plain and matching parts (no HTML) |
| `items[].snippet.text` | string | yes |   |   |
| `items[].snippet.match` | boolean | yes |   |   |
| `nextCursor` | string or null | yes |   |   |
