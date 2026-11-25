---
title: "Knowledge: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.knowledge.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### toRead

My procedures: the published ones I must read and have not yet confirmed (oldest first, with the version to read and since when), and the ones I have confirmed (with when). For the person themselves, every staff account. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Who may call it | a person only (`humanOnly`) |
| Staff | every staff account (`anyStaff`) |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `toRead` | array of object | yes |   |   |
| `toRead[].id` | string | yes |   |   |
| `toRead[].title` | string or null | yes |   |   |
| `toRead[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The current published version |
| `toRead[].publishedAt` | string | yes |   |   |
| `toRead[].since` | string | yes |   |   |
| `confirmed` | array of object | yes |   |   |
| `confirmed[].id` | string | yes |   |   |
| `confirmed[].title` | string or null | yes |   |   |
| `confirmed[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The current published version |
| `confirmed[].publishedAt` | string | yes |   |   |
| `confirmed[].confirmedAt` | string | yes |   |   |

### confirm

Confirm that I have read and understood a procedure's current published version: one tap, by the person themselves. Refused for a version that is not the current one (read it again and confirm that), a procedure I am not asked to read, and a second time for the same version. A confirmation is kept for good and never changed. Not for an AI.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Who may call it | a person only (`humanOnly`) |
| Staff | every staff account (`anyStaff`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The procedure |
| `version` | integer | yes | ≥ 1, ≤ 9007199254740991 | The version I read: the current one |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `confirmedAt` | string | yes |   |   |

### readStatus

Who has read what. With a procedure's id: for its current version, everyone who must read it, who has confirmed it and when, and who has not and since when. Without one: every published procedure staff must read, with how many have confirmed it of how many must. For admins and people granted Read status; never for an AI. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `knowledge:manage` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string |   | min length 1, max length 64 | One procedure |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `procedures` | array of object | yes |   |   |
| `procedures[].id` | string | yes |   |   |
| `procedures[].title` | string or null | yes |   |   |
| `procedures[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The current published version |
| `procedures[].publishedAt` | string | yes |   |   |
| `procedures[].mustRead` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `procedures[].confirmed` | number | yes |   |   |
| `procedure` | object or null | yes |   |   |
| `procedure.id` | string | yes |   |   |
| `procedure.title` | string or null | yes |   |   |
| `procedure.version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The current published version |
| `procedure.publishedAt` | string | yes |   |   |
| `procedure.everyone` | boolean | yes |   |   |
| `procedure.roles` | array of string | yes |   |   |
| `procedure.people` | array of object | yes |   |   |
| `procedure.people[].account` | string | yes |   |   |
| `procedure.people[].name` | string | yes |   |   |
| `procedure.people[].email` | string | yes |   |   |
| `procedure.people[].confirmed` | object or null | yes |   |   |
| `procedure.people[].confirmed.version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `procedure.people[].confirmed.confirmedAt` | string | yes |   |   |
| `procedure.people[].lastConfirmed` | object or null | yes |   |   |
| `procedure.people[].lastConfirmed.version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `procedure.people[].lastConfirmed.confirmedAt` | string | yes |   |   |
| `procedure.people[].since` | string or null | yes |   |   |

### helpTopics

Every help topic, in their order: its id, name, address (slug) and icon, for a help centre's menu. Open to anyone. Read-only.

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
| `topics` | array of object | yes |   |   |
| `topics[].id` | string | yes |   |   |
| `topics[].name` | string or null | yes |   |   |
| `topics[].slug` | string or null | yes |   |   |
| `topics[].order` | number or null | yes |   |   |
| `topics[].icon` | string or null | yes |   |   |

### draftProcedure

Write a procedure's working copy from notes: a new one, or the draft of one that exists. Staff read only what a person publishes, so this changes nothing anyone reads until then; ask a person to publish it (record.publish waits for their approval). Who must read it and how often it is reviewed are set by a person. Name a role, not a person, in the words ('the duty manager', not 'Sam').

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `knowledge:write` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string |   | min length 1, max length 64 | Change this one's working copy; left out, a new one is made |
| `title` | string | yes | min length 1, max length 200 |   |
| `summary` | string |   | max length 500 | One or two sentences for lists |
| `notes` | string |   | max length 60000 | The words, as notes: '# ' or '## ' starts a section heading, '- ' a bullet, '1. ' a numbered step, a blank line ends a paragraph |
| `section` | string |   | min length 1, max length 64 | A section's id |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `created` | boolean | yes |   |   |
| `open` | object | yes |   |   |
| `open.object` | string | yes |   |   |
| `open.id` | string | yes |   |   |

### draftHelpPage

Write a help page's working copy from notes: a new one, or the draft of one that exists. The public reads only what a person publishes; ask a person to publish it (record.publish waits for their approval). Never put a customer's name or details in a help page drafted from their question.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `knowledge:write` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string |   | min length 1, max length 64 | Change this one's working copy; left out, a new one is made |
| `title` | string | yes | min length 1, max length 200 |   |
| `summary` | string |   | max length 500 | One or two sentences for lists |
| `notes` | string |   | max length 60000 | The words, as notes: '# ' or '## ' starts a section heading, '- ' a bullet, '1. ' a numbered step, a blank line ends a paragraph |
| `topic` | string |   | min length 1, max length 64 | A help topic's id |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `created` | boolean | yes |   |   |
| `open` | object | yes |   |   |
| `open.object` | string | yes |   |   |
| `open.id` | string | yes |   |   |

## Automations

### reviewDue

**Time to review a procedure.** On a published procedure's next review date (its last publish plus its review period, 12 months unless set; never when 0), tells its owner to check it is still right, or the admins when it has no owner.

|  |  |
| --- | --- |
| Trigger | dateRelative on knowledge.procedure, field nextReview |
| Steps | `tell` Tell the owner, or the admins |

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`ack.mine`](/reference/operations/ack/#ackmine)
- [`ack.confirm`](/reference/operations/ack/#ackconfirm)
- [`ack.status`](/reference/operations/ack/#ackstatus)
- [`ack.overview`](/reference/operations/ack/#ackoverview)
- [`public.list`](/reference/operations/public/#publiclist)
- [`notification.send`](/reference/operations/notification/#notificationsend)

Host modules it asks for: `ops`.
