---
title: "Content: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Post (`content.post`)

A blog post. Its working copy is what staff edit; the public reads the version last published.

|  |  |
| --- | --- |
| Plural | Posts |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`publishable`](/reference/behaviours/#publishable), [`public`](/reference/behaviours/#public) |
| Indexes | `category`; `date` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `slug` | `slug` | Address |   |   | Where the post is read: /blog/&lt;address&gt;. Made from the title. |
| `excerpt` | `text` | Excerpt |   |   | One or two sentences for lists and link previews. |
| `body` | `richText` | Body |   |   |   |
| `cover` | `image` | Cover picture |   |   |   |
| `author` | `user` | Author |   |   |   |
| `byline` | `text` | Byline |   |   | Who wrote it, as readers see it: "Words by Sam Lee". Left empty, none. |
| `category` | `relation` | Category |   | to `content.category` |   |
| `date` | `datetime` | Date |   |   | The date readers are shown. Left empty, it is when the post goes live. |
| `seoTitle` | `text` | Search title |   |   |   |
| `seoDescription` | `text` | Search description |   |   |   |
| `seoImage` | `image` | Share picture |   |   |   |
| `noindex` | `boolean` | Hide from search engines |   |   | Asks search engines not to list the post's page. |

### Relations

- `category` → `content.category`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "publishable": {
    "content": [
      "title",
      "excerpt",
      "body",
      "cover",
      "author",
      "byline",
      "category",
      "date",
      "seoTitle",
      "seoDescription",
      "seoImage",
      "noindex"
    ],
    "slug": "slug",
    "date": "date"
  },
  "public": {
    "read": [
      "title",
      "slug",
      "excerpt",
      "body",
      "cover",
      "byline",
      "category",
      "date",
      "publishedAt",
      "seoTitle",
      "seoDescription",
      "seoImage",
      "noindex"
    ]
  }
}
```

</details>

## Category (`content.category`)

|  |  |
| --- | --- |
| Plural | Categories |
| Title field | `name` |
| Listed in | settings |
| Behaviours | [`public`](/reference/behaviours/#public) |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `slug` | `slug` | Address |   |   |   |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "public": {
    "read": [
      "name",
      "slug"
    ]
  }
}
```

</details>

## Views

| View | Object | Label |
| --- | --- | --- |
| `drafts` | `content.post` | Drafts |
| `scheduled` | `content.post` | Scheduled |
| `published` | `content.post` | Published |
