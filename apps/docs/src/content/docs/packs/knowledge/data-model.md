---
title: "Knowledge: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Procedure (`knowledge.procedure`)

How the business does something, for staff: read by every staff account in the wording last published, never the draft, and confirmed as read and understood by those who must read it.

|  |  |
| --- | --- |
| Plural | Procedures |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`publishable`](/reference/behaviours/#publishable) |
| Indexes | `section`; `owner` |
| Owner field | `owner` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `slug` | `slug` | Address |   |   | How a link names the procedure. Made from the title. |
| `summary` | `text` | Summary |   |   | One or two sentences for lists and search results. |
| `body` | `richText` | Body |   |   | The procedure. Each heading is a section that search and the assistant link to. Name a role, not a person ('the duty manager', not 'Sam'). |
| `section` | `relation` | Section |   | to `knowledge.section` |   |
| `owner` | `user` | Kept right by |   |   | Who keeps it right: told when it is time to review it, and each week who has not confirmed it. |
| `mustRead` | `document` | Must read |   |   | Who is asked to confirm it: everyone, or some staff roles, pack roles (a coach, a cleaner) and granted permissions (the front desk). Every staff account may read it either way. Changing it counts at once. |
| `reviewEvery` | `number` | Review every (months) |   | default `12`; min 0; max 120 | How often its owner is asked to check it is still right. 0: never. |
| `nextReview` | `formula` | Next review |   |   | Its last publish plus the review period. Empty when it is never reviewed. |

### Relations

- `section` → `knowledge.section`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "publishable": {
    "content": [
      "title",
      "summary",
      "body",
      "section"
    ],
    "slug": "slug",
    "staffRead": true,
    "acknowledge": {
      "who": "mustRead",
      "manage": "knowledge:manage",
      "managed": [
        "reviewEvery"
      ],
      "owner": "owner",
      "notices": {
        "asked": {
          "title": "Please read: {record}",
          "body": "A procedure you must read has been published or changed. Read it and confirm you have read and understood it."
        },
        "reminder": {
          "title": "Still to read: {record}",
          "body": "Read this procedure and confirm you have read and understood it.",
          "afterDays": 7
        },
        "outstanding": {
          "title": "Not yet confirmed: {record}"
        },
        "welcome": {
          "title": "Procedures to read",
          "body": "Welcome. Read these procedures and confirm each one:"
        }
      }
    }
  }
}
```

</details>

## Section (`knowledge.section`)

A group of procedures (opening and closing, safety, the front desk). Staff only.

|  |  |
| --- | --- |
| Plural | Sections |
| Title field | `name` |
| Listed in | settings |
| Indexes | `order` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `order` | `number` | Order |   |   |   |

## Help page (`knowledge.helppage`)

An answer to a customer's question, on the business's website for anyone. The public reads the version last published.

|  |  |
| --- | --- |
| Plural | Help pages |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`publishable`](/reference/behaviours/#publishable), [`public`](/reference/behaviours/#public) |
| Indexes | `topic, order` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `slug` | `slug` | Address |   |   | Where the page is read: /help/&lt;address&gt;. Made from the title. |
| `summary` | `text` | Summary |   |   | One or two sentences for lists, search results and link previews. |
| `body` | `richText` | Body |   |   |   |
| `topic` | `relation` | Topic |   | to `knowledge.helptopic` |   |
| `order` | `number` | Order in its topic |   |   |   |
| `related` | `relation` | Related pages |   | to `knowledge.helppage`, many |   |
| `seoTitle` | `text` | Search title |   |   |   |
| `seoDescription` | `text` | Search description |   |   |   |
| `noindex` | `boolean` | Hide from search engines |   |   | Asks search engines not to list the page. |

### Relations

- `topic` → `knowledge.helptopic`
- `related` → `knowledge.helppage` (many)

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "publishable": {
    "content": [
      "title",
      "summary",
      "body",
      "topic",
      "order",
      "related",
      "seoTitle",
      "seoDescription",
      "noindex"
    ],
    "slug": "slug"
  },
  "public": {
    "read": [
      "title",
      "slug",
      "summary",
      "body",
      "topic",
      "order",
      "related",
      "seoTitle",
      "seoDescription",
      "noindex",
      "publishedAt"
    ]
  }
}
```

</details>

## Help topic (`knowledge.helptopic`)

A group of help pages, as the help centre's menu shows them.

|  |  |
| --- | --- |
| Plural | Help topics |
| Title field | `name` |
| Listed in | settings |
| Behaviours | [`public`](/reference/behaviours/#public) |
| Indexes | `order` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `slug` | `slug` | Address |   |   |   |
| `order` | `number` | Order |   |   |   |
| `icon` | `select` | Icon |   | one of `calendar`, `credit-card`, `user-round`, `smartphone`, `map-pin`, `baby`, `shield-check`, `wrench`, `circle-help` |   |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "public": {
    "read": [
      "name",
      "slug",
      "order",
      "icon"
    ]
  }
}
```

</details>

## Views

| View | Object | Label |
| --- | --- | --- |
| `procedureDrafts` | `knowledge.procedure` | Procedure drafts |
| `procedures` | `knowledge.procedure` | Published procedures |
| `reviewDue` | `knowledge.procedure` | Procedures by next review |
| `helpDrafts` | `knowledge.helppage` | Help page drafts |
| `helpPages` | `knowledge.helppage` | Published help pages |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `sectionProcedures` | `` | Procedures |
| tab | `topicPages` | `` | Help pages |
