---
title: "Courses: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

Requires [programs](/packs/programs/), [content](/packs/content/): the host refuses to install it while one is missing.

## Theme (`courses.theme`)

What courses are grouped by in the catalogue: handstands, mobility.

|  |  |
| --- | --- |
| Plural | Themes |
| Title field | `name` |
| Listed in | settings |
| Behaviours | [`public`](/reference/behaviours/#public) |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `slug` | `slug` | Slug |   |   |   |
| `order` | `number` | Order |   | min 0; max 1000 |   |
| `summary` | `text` | Short description |   |   |   |
| `picture` | `image` | Picture |   |   |   |

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
      "summary",
      "picture"
    ]
  }
}
```

</details>

## Course (`courses.course`)

A course of lessons a studio sells: its outline, price, trailer and cover.

|  |  |
| --- | --- |
| Plural | Courses |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`publishable`](/reference/behaviours/#publishable), [`public`](/reference/behaviours/#public), [`agreements`](/reference/behaviours/#agreements), [`sellable`](/reference/behaviours/#sellable), [`access`](/reference/behaviours/#access) |
| Indexes | `theme` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `slug` | `slug` | Slug |   |   |   |
| `theme` | `relation` | Theme |   | to `courses.theme` |   |
| `level` | `number` | Level |   | min 1; max 3 | 1 to 3: beginner, intermediate, advanced. |
| `summary` | `text` | Summary |   |   |   |
| `description` | `richText` | Description |   |   |   |
| `cover` | `image` | Cover |   |   |   |
| `trailer` | `video` | Trailer |   |   |   |
| `price` | `currency` | Price | yes |   |   |
| `onSaleFrom` | `datetime` | On sale from |   |   |   |
| `outline` | `document` | Outline |   |   |   |

### Relations

- `theme` → `courses.theme`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "publishable": {
    "content": [
      "title",
      "theme",
      "level",
      "summary",
      "description",
      "cover",
      "trailer",
      "outline"
    ],
    "slug": "slug"
  },
  "public": {
    "read": [
      "title",
      "slug",
      "theme",
      "level",
      "summary",
      "description",
      "cover",
      "trailer",
      "price",
      "onSaleFrom",
      "outline"
    ]
  },
  "agreements": {
    "point": "course",
    "label": "Buying a course",
    "suggests": [
      "terms"
    ],
    "inlineStep": true
  },
  "sellable": {
    "price": "price",
    "saleWindow": {
      "from": "onSaleFrom"
    },
    "tax": {
      "code": "txcd_20060158"
    },
    "finance": {
      "category": {
        "key": "courses",
        "label": "Courses"
      },
      "earned": "at_sale"
    },
    "grants": {
      "object": "enrolment",
      "set": {
        "holder": "order.person",
        "course": "item",
        "order": "order",
        "code": "code"
      },
      "void": "void"
    }
  },
  "access": {
    "sources": [
      {
        "via": "courses.enrolment",
        "field": "course",
        "states": [
          "active"
        ],
        "until": "until"
      },
      {
        "via": "courses.enrolment",
        "field": "bundle",
        "through": "courses",
        "states": [
          "active"
        ],
        "until": "until"
      },
      {
        "kind": "subscription",
        "options": {
          "plans": "courses.plan",
          "covers": "all"
        }
      }
    ]
  }
}
```

</details>

## Bundle (`courses.bundle`)

A fixed set of courses sold together at one price.

|  |  |
| --- | --- |
| Plural | Bundles |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`publishable`](/reference/behaviours/#publishable), [`public`](/reference/behaviours/#public), [`agreements`](/reference/behaviours/#agreements), [`sellable`](/reference/behaviours/#sellable) |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `slug` | `slug` | Slug |   |   |   |
| `summary` | `text` | Summary |   |   |   |
| `description` | `richText` | Description |   |   |   |
| `cover` | `image` | Cover |   |   |   |
| `courses` | `document` | Courses |   |   |   |
| `price` | `currency` | Price | yes |   |   |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "publishable": {
    "content": [
      "title",
      "summary",
      "description",
      "cover",
      "courses"
    ],
    "slug": "slug"
  },
  "public": {
    "read": [
      "title",
      "slug",
      "summary",
      "description",
      "cover",
      "courses",
      "price"
    ]
  },
  "agreements": {
    "point": "course",
    "label": "Buying a course",
    "suggests": [
      "terms"
    ],
    "inlineStep": true
  },
  "sellable": {
    "price": "price",
    "tax": {
      "code": "txcd_20060158"
    },
    "finance": {
      "category": {
        "key": "courses",
        "label": "Courses"
      },
      "earned": "at_sale"
    },
    "grants": {
      "object": "enrolment",
      "set": {
        "holder": "order.person",
        "bundle": "item",
        "order": "order",
        "code": "code"
      },
      "void": "void"
    }
  }
}
```

</details>

## Course plan (`courses.plan`)

A subscription to every published course, paid every month, with a free trial when it has trial days. One trial per person per plan; the payment provider charges each month.

|  |  |
| --- | --- |
| Plural | Course plans |
| Title field | `title` |
| Listed in | main |
| Behaviours | [`public`](/reference/behaviours/#public), [`agreements`](/reference/behaviours/#agreements), [`sellable`](/reference/behaviours/#sellable) |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `title` | `text` | Title | yes |   |   |
| `description` | `text` | Description |   |   |   |
| `price` | `currency` | Price per month | yes |   |   |
| `trialDays` | `number` | Free trial (days) |   | min 0; max 90 | Empty or 0: charged from the start. A person gets one trial on any plan. |

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "public": {
    "read": [
      "title",
      "description",
      "price",
      "trialDays"
    ]
  },
  "agreements": {
    "point": "course",
    "label": "Buying a course",
    "suggests": [
      "terms"
    ],
    "inlineStep": true
  },
  "sellable": {
    "price": "price",
    "tax": {
      "code": "txcd_20060158"
    },
    "finance": {
      "category": {
        "key": "courses",
        "label": "Courses"
      },
      "earned": "over_period"
    },
    "recurring": {
      "interval": "month",
      "trialDays": "trialDays"
    }
  }
}
```

</details>

## Enrolment (`courses.enrolment`)

A student's access to a course or a bundle: bought (granted by a paid order), given by staff, or imported. Voided when its order is refunded in full.

|  |  |
| --- | --- |
| Plural | Enrolments |
| Title field | `code` |
| Listed in | main |
| Behaviours | [`states`](/reference/behaviours/#states), [`agreements`](/reference/behaviours/#agreements), [`customer`](/reference/behaviours/#customer) |
| Indexes | `holder`; `course`; `bundle`; `order` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `code` | `text` | Code |   | read-only |   |
| `holder` | `relation` | Student |   | to `person` |   |
| `course` | `relation` | Course |   | to `courses.course` |   |
| `bundle` | `relation` | Bundle |   | to `courses.bundle` |   |
| `order` | `text` | Order |   | read-only | The order that granted this enrolment, set by the host. |
| `source` | `select` | Where it came from |   | one of `purchase`, `staff`, `import`; default `"purchase"` |   |
| `reason` | `text` | Why it was given or ended |   |   |   |
| `from` | `datetime` | From |   |   |   |
| `until` | `datetime` | Until |   |   | Empty: for as long as the course is offered. |
| `completed` | `boolean` | Completed (imported) |   |   | Marked done on the old platform: the course shows as complete. |
| `status` | `select` | Status |   | one of `active`, `ended`, `void` |   |

### Relations

- `holder` → `person`
- `course` → `courses.course`
- `bundle` → `courses.bundle`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "states": {
    "field": "status",
    "initial": "active",
    "moves": [
      {
        "from": "active",
        "to": "ended",
        "by": [
          "staff"
        ]
      },
      {
        "from": "ended",
        "to": "active",
        "by": [
          "staff"
        ]
      },
      {
        "from": [
          "active",
          "ended"
        ],
        "to": "void",
        "by": [
          "host"
        ],
        "final": true
      }
    ]
  },
  "agreements": {
    "point": "course",
    "label": "Buying a course",
    "suggests": [
      "terms"
    ],
    "enter": [
      "active"
    ],
    "person": "holder",
    "importMovesOver": true,
    "inlineStep": true
  },
  "customer": {
    "field": "holder",
    "read": [
      "course",
      "bundle",
      "source",
      "from",
      "until",
      "completed",
      "status"
    ],
    "write": []
  }
}
```

</details>

## Progress (`courses.progress`)

One student's progress on one lesson: started or done, and where a video was left.

|  |  |
| --- | --- |
| Plural | Progress |
| Title field | `lessonKey` |
| Listed in | settings |
| Behaviours | [`customer`](/reference/behaviours/#customer) |
| Indexes | `holder, course`; `course, lessonKey` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `holder` | `relation` | Student | yes | to `person` |   |
| `course` | `relation` | Course | yes | to `courses.course` |   |
| `lessonKey` | `text` | Lesson | yes |   |   |
| `state` | `select` | State |   | one of `started`, `done` |   |
| `startedAt` | `datetime` | Started |   |   |   |
| `doneAt` | `datetime` | Done |   |   |   |
| `position` | `number` | Position (seconds) |   | min 0; max 86400 | Where the video was left, so the player resumes there. |
| `source` | `select` | Where it came from |   | one of `self`, `import`; default `"self"` |   |

### Relations

- `holder` → `person`
- `course` → `courses.course`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "customer": {
    "field": "holder",
    "read": [
      "course",
      "lessonKey",
      "state",
      "startedAt",
      "doneAt",
      "position",
      "source"
    ],
    "write": [
      "course",
      "lessonKey",
      "state",
      "startedAt",
      "doneAt",
      "position"
    ],
    "requireAccess": [
      "course"
    ]
  }
}
```

</details>

## Views

| View | Object | Label |
| --- | --- | --- |
| `published` | `courses.course` | Published courses |
| `drafts` | `courses.course` | Drafts |
| `enrolmentsThisMonth` | `courses.enrolment` | Enrolments this month |
| `importedEnrolments` | `courses.enrolment` | Imported enrolments |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `personCourses` | `` | Courses |
| tab | `personProgress` | `` | Lessons |
