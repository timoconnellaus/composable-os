---
title: "Content: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.content.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### categories

Every category of posts, by name: its id, name and address (slug), for a site's menu or a post's label. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer |   | ≥ 1, ≤ 200, default `100` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `categories` | array of object | yes |   |   |
| `categories[].id` | string | yes |   |   |
| `categories[].name` | string or null | yes |   |   |
| `categories[].slug` | string or null | yes |   |   |

## Automations

None.

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`public.list`](/reference/operations/public/#publiclist)

Host modules it asks for: `ops`.
