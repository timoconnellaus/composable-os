---
title: "search.* operations"
description: "The core operations named search.*"
sidebar:
  label: "search"
editUrl: false
---

## search.global

Search everything by name, email, domain or text: people (names, emails), organisations (name, domains), activities (subject, body) and tasks (title, notes). Every word must match the start of a word in the record, so partial input works ('ada lov', 'acme.co'). Best matches first, titles weighted over body text. Restrict with objects. Returns typed hits with title, subtitle and highlighted parts. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `query` | string | yes | max length 200 | What the user typed |
| `objects` | array of string |   | at least 1, at most 50 | Object types to search (default all, including extension objects) |
| `limit` | integer |   | ≥ 1, ≤ 50, default `20` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `hits` | array of object | yes |   |   |
| `hits[].object` | string | yes |   | person, organisation, activity, task or &lt;extension&gt;.&lt;object&gt; |
| `hits[].id` | string | yes |   |   |
| `hits[].title` | string | yes |   |   |
| `hits[].subtitle` | string or null | yes |   |   |
| `hits[].titleHighlight` | array of object | yes |   |   |
| `hits[].titleHighlight[].text` | string | yes |   |   |
| `hits[].titleHighlight[].match` | boolean | yes |   |   |
| `hits[].snippet` | array of object or null | yes |   |   |
| `hits[].snippet.text` | string | yes |   |   |
| `hits[].snippet.match` | boolean | yes |   |   |

## search.hybrid

Search by meaning as well as words: full-text matches and semantic (embedding) matches merged and ranked together, so 'customers worried about pricing' finds notes that never use those words. Use it for natural-language questions; search.global is faster for names as you type. withText adds each hit's indexed text (for answering from the results). Falls back to full-text only when semantic search is not configured. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `query` | string | yes | min length 1, max length 500 |   |
| `objects` | array of string |   | at least 1, at most 50 |   |
| `limit` | integer |   | ≥ 1, ≤ 30, default `10` |   |
| `withText` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `hits` | array of object | yes |   |   |
| `hits[].object` | string | yes |   | person, organisation, activity, task or &lt;extension&gt;.&lt;object&gt; |
| `hits[].id` | string | yes |   |   |
| `hits[].title` | string | yes |   |   |
| `hits[].subtitle` | string or null | yes |   |   |
| `hits[].titleHighlight` | array of object | yes |   |   |
| `hits[].titleHighlight[].text` | string | yes |   |   |
| `hits[].titleHighlight[].match` | boolean | yes |   |   |
| `hits[].snippet` | array of object or null | yes |   |   |
| `hits[].snippet.text` | string | yes |   |   |
| `hits[].snippet.match` | boolean | yes |   |   |
| `hits[].score` | number | yes |   |   |
| `hits[].matchedBy` | array of `"text"`, `"meaning"` | yes |   |   |
| `hits[].text` | string |   |   |   |
| `semantic` | boolean | yes |   |   |
