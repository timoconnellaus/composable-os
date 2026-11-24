---
title: "Courses: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.courses.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### catalogue

The published courses, bundles and themes, for a catalogue page: each course's title, theme, level, summary, cover, trailer, price and number of lessons; each bundle's courses and price; the themes in their order. Prices are in the major unit of `currency`. Filter by theme or level. Only what the public may read: a draft is not here. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer`, `public` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `theme` | string |   | min length 1, max length 64 |   |
| `level` | integer |   | ≥ 1, ≤ 3 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `themes` | array of object | yes |   |   |
| `themes[].id` | string | yes |   |   |
| `themes[].name` | string or null | yes |   |   |
| `themes[].slug` | string or null | yes |   |   |
| `themes[].summary` | string or null | yes |   |   |
| `themes[].picture` | map of any or null | yes |   |   |
| `themes[].picture.media` | string | yes |   |   |
| `themes[].picture.alt` | string |   |   |   |
| `courses` | array of object | yes |   |   |
| `courses[].id` | string | yes |   |   |
| `courses[].title` | string or null | yes |   |   |
| `courses[].slug` | string or null | yes |   |   |
| `courses[].theme` | string or null | yes |   |   |
| `courses[].level` | number or null | yes |   |   |
| `courses[].summary` | string or null | yes |   |   |
| `courses[].cover` | map of any or null | yes |   |   |
| `courses[].cover.media` | string | yes |   |   |
| `courses[].cover.alt` | string |   |   |   |
| `courses[].trailer` | object or null | yes |   |   |
| `courses[].trailer.media` | string | yes |   |   |
| `courses[].trailer.poster` | string |   |   |   |
| `courses[].price` | number or null | yes |   | In the major unit of `currency` |
| `courses[].lessons` | number | yes |   |   |
| `bundles` | array of object | yes |   |   |
| `bundles[].id` | string | yes |   |   |
| `bundles[].title` | string or null | yes |   |   |
| `bundles[].slug` | string or null | yes |   |   |
| `bundles[].summary` | string or null | yes |   |   |
| `bundles[].cover` | map of any or null | yes |   |   |
| `bundles[].cover.media` | string | yes |   |   |
| `bundles[].cover.alt` | string |   |   |   |
| `bundles[].courses` | array of string | yes |   |   |
| `bundles[].price` | number or null | yes |   |   |
| `currency` | string or null | yes |   | The currency prices are in (ISO 4217), the deployment's one; null until it is set |

### course

One published course by its address (slug): its fields, its description, its outline's sections and lessons (title, kind, minutes, whether a free preview) and, for a signed-in customer, whether they hold access and which lessons they have done. Not found for a draft or an unknown address. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer`, `public` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `slug` | string | yes | min length 1, max length 200 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `slug` | string or null | yes |   |   |
| `theme` | string or null | yes |   |   |
| `level` | number or null | yes |   |   |
| `summary` | string or null | yes |   |   |
| `cover` | map of any or null | yes |   |   |
| `cover.media` | string | yes |   |   |
| `cover.alt` | string |   |   |   |
| `trailer` | object or null | yes |   |   |
| `trailer.media` | string | yes |   |   |
| `trailer.poster` | string |   |   |   |
| `price` | number or null | yes |   | In the major unit of `currency` |
| `lessons` | number | yes |   |   |
| `description` | any | yes |   | Rich text |
| `sections` | array of object | yes |   |   |
| `sections[].key` | string | yes |   |   |
| `sections[].title` | string | yes |   |   |
| `sections[].lessons` | array of object | yes |   |   |
| `sections[].lessons[].key` | string | yes |   |   |
| `sections[].lessons[].title` | string | yes |   |   |
| `sections[].lessons[].kind` | `"video"`, `"text"`, `"session"`, `"download"` | yes |   |   |
| `sections[].lessons[].duration` | number or null | yes |   |   |
| `sections[].lessons[].preview` | boolean | yes |   |   |
| `currency` | string or null | yes |   | The currency prices are in (ISO 4217), the deployment's one; null until it is set |
| `holds` | boolean | yes |   | The caller holds access: show open, not buy |
| `done` | array of string | yes |   | The lesson keys the caller has done |
| `complete` | boolean | yes |   |   |

### lesson

One lesson of a published course for someone who holds access to it (or any lesson marked a free preview): its kind and its material (a video and notes, a page of text, a training session, a download), where the student left its video, and the next lesson. A video is named with where it is shown: the app asks media.play for a token to play it. Not found without access, as a lesson that does not exist. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff`, `customer` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `courseId` | string | yes | min length 1, max length 64 |   |
| `lessonKey` | string | yes | min length 1, max length 40 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `courseId` | string | yes |   |   |
| `lesson` | map of any | yes |   | The lesson as the outline has it |
| `video` | object or null | yes |   | Pass to media.play to get a token and the address it plays at |
| `video.media` | string | yes |   |   |
| `video.poster` | string or null | yes |   |   |
| `video.record` | object | yes |   |   |
| `video.record.object` | string | yes |   |   |
| `video.record.id` | string | yes |   |   |
| `video.field` | string | yes |   |   |
| `position` | number or null | yes |   | Seconds: where the student left the video |
| `state` | `"started"`, `"done"` or null | yes |   |   |
| `next` | object or null | yes |   |   |
| `next.key` | string | yes |   |   |
| `next.title` | string | yes |   |   |
| `next.kind` | `"video"`, `"text"`, `"session"`, `"download"` | yes |   |   |
| `next.duration` | number or null | yes |   |   |
| `next.preview` | boolean | yes |   |   |

### progress

Mark a lesson started or done, and keep where its video was left (seconds), for the signed-in student. A video watched to within 10 seconds of its end counts as done (give its `duration`). The host refuses it, as a course that does not exist, when the student does not hold access to the course. Returns the lesson's progress and the course's.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `customer` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `courseId` | string | yes | min length 1, max length 64 |   |
| `lessonKey` | string | yes | min length 1, max length 40 |   |
| `state` | `"started"`, `"done"` |   |   |   |
| `position` | number |   | ≥ 0, ≤ 86400 |   |
| `duration` | number |   | ≥ 0, ≤ 86400 | The video's length, seconds |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lessonKey` | string | yes |   |   |
| `state` | `"started"`, `"done"` | yes |   |   |
| `position` | number or null | yes |   |   |
| `done` | number | yes |   |   |
| `counted` | number | yes |   |   |
| `complete` | boolean | yes |   |   |

### myCourses

Every course the signed-in student holds access to and why (bought, in a bundle, given by staff, imported, or through their course subscription), with how far they are (lessons done of those that count, complete) and the lesson to continue with. The host says which they hold; nothing here decides it. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer` |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `courses` | array of object | yes |   |   |
| `courses[].id` | string | yes |   |   |
| `courses[].title` | string or null | yes |   |   |
| `courses[].slug` | string or null | yes |   |   |
| `courses[].theme` | string or null | yes |   |   |
| `courses[].level` | number or null | yes |   |   |
| `courses[].summary` | string or null | yes |   |   |
| `courses[].cover` | map of any or null | yes |   |   |
| `courses[].cover.media` | string | yes |   |   |
| `courses[].cover.alt` | string |   |   |   |
| `courses[].trailer` | object or null | yes |   |   |
| `courses[].trailer.media` | string | yes |   |   |
| `courses[].trailer.poster` | string |   |   |   |
| `courses[].price` | number or null | yes |   | In the major unit of `currency` |
| `courses[].lessons` | number | yes |   |   |
| `courses[].why` | `"bought"`, `"bundle"`, `"given"`, `"imported"`, `"subscription"` | yes |   |   |
| `courses[].done` | number | yes |   |   |
| `courses[].counted` | number | yes |   |   |
| `courses[].complete` | boolean | yes |   |   |
| `courses[].continueWith` | string or null | yes |   | The first lesson not done yet |

### plans

The course plans on offer: a subscription to every published course, paid every month. Each plan's title, description, price per month (in the major unit of `currency`) and the days of its free trial. Whether a person gets the trial is the host's, when they subscribe (subscription.start): one per person, signed in. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer`, `public` |

#### Input

No fields.

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `plans` | array of object | yes |   |   |
| `plans[].id` | string | yes |   |   |
| `plans[].title` | string or null | yes |   |   |
| `plans[].description` | string or null | yes |   |   |
| `plans[].price` | number or null | yes |   | Per month, in the major unit of `currency` |
| `plans[].trialDays` | number or null | yes |   |   |
| `currency` | string or null | yes |   | The currency prices are in (ISO 4217), the deployment's one; null until it is set |

### buy

Start an order for one course or one bundle. A signed-in customer buys as themselves; a guest gives their email address. The host prices it from the record and refuses one outside its sale window. A course the caller already holds access to is refused as one that does not exist. Nothing is paid here: the buyer then calls order.checkout with the order's id (and a guest's token) to pay on the provider's page. Amounts in the minor unit.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `customer`, `public` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `courseId` | string |   | min length 1, max length 64 |   |
| `bundleId` | string |   | min length 1, max length 64 |   |
| `email` | string |   | max length 320 | A guest's email address |
| `agreements` | array of map of any |   | at most 20 | A guest only: their acceptances of what is due, passed on to the host as they are (each { versionId, typedName, signature?, answers? }); the host checks and records them. A signed-in member agrees first. |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | string | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `token` | string or null | yes |   | A guest's key to this order, shown once |

### enrol

Give a person access to a course or a bundle, recorded as given by staff with the reason, until a date or for as long as it is offered. It is an enrolment like a bought one: the person signs in with their email and finds the course. Returns the enrolment.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `courses:enrol` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 |   |
| `courseId` | string |   | min length 1, max length 64 |   |
| `bundleId` | string |   | min length 1, max length 64 |   |
| `until` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `reason` | string | yes | min length 3, max length 500 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `enrolmentId` | string | yes |   |   |
| `status` | string | yes |   |   |
| `source` | string | yes |   |   |

### endEnrolment

End an enrolment staff gave or one that was imported, with the reason: the person no longer holds access through it. A bought enrolment ends by a refund of its order, as every grant does, and is refused here.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `courses:enrol` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `enrolmentId` | string | yes | min length 1, max length 64 |   |
| `reason` | string | yes | min length 3, max length 500 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `enrolmentId` | string | yes |   |   |
| `status` | string | yes |   |   |
| `source` | string | yes |   |   |

### stats

For staff: enrolments by course (active, ended, void), how many students completed it (every lesson that counts done), and lessons marked done by week. All courses, or one. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `courseId` | string |   | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `courses` | array of object | yes |   |   |
| `courses[].courseId` | string | yes |   |   |
| `courses[].title` | string or null | yes |   |   |
| `courses[].active` | number | yes |   |   |
| `courses[].ended` | number | yes |   |   |
| `courses[].void` | number | yes |   |   |
| `courses[].lessonsDone` | number | yes |   |   |
| `byWeek` | array of object | yes |   |   |
| `byWeek[].week` | string | yes |   |   |
| `byWeek[].done` | number | yes |   |   |

### draft

Draft a course from a brief ("a beginner handstand course in three parts") as a working copy for staff to edit: sections of lessons built only from videos already in the media library (ready ones) and programs already published, with each lesson's title. It reads the brief with the extract model role when the deployment has AI. It never publishes: a person publishes it, and an assistant's request to publish waits for one (ADR 0480). Returns the new course.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `brief` | string | yes | min length 3, max length 2000 |   |
| `title` | string |   | min length 1, max length 200 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `courseId` | string | yes |   |   |
| `title` | string | yes |   |   |
| `sections` | number | yes |   |   |
| `lessons` | number | yes |   |   |
| `videos` | array of string | yes |   |   |
| `programs` | array of string | yes |   |   |
| `published` | `false` | yes |   |   |

### startSession

For a session lesson: the signed-in student's own Programs session for it, once the program is assigned to them (it is, from the day they first open the course: the dates are a suggested pace). They then log sets with Programs' own tools. `preparing` while the assignment is being made. Not found without access to the course.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `customer` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `courseId` | string | yes | min length 1, max length 64 |   |
| `lessonKey` | string | yes | min length 1, max length 40 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `preparing` | boolean | yes |   |   |
| `sessionId` | string or null | yes |   |   |
| `date` | string or null | yes |   |   |
| `programId` | string or null | yes |   |   |

## Automations

### assignSessions

**Assign a course's sessions.** When a student first opens a course with session lessons, assigns them each Programs program those lessons use, from that day. A program already assigned to them is left as it is.

|  |  |
| --- | --- |
| Trigger | record on courses.progress (created) |
| Steps | `findPrograms` Find the course's session programs and the student's assignments; `assign` Assign each program not yet assigned |

## Dashboards

| Dashboard | Label | Widgets |
| --- | --- | --- |
| `courses` |   | 8 |

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`public.list`](/reference/operations/public/#publiclist)
- [`public.get`](/reference/operations/public/#publicget)
- [`access.check`](/reference/operations/access/#accesscheck)
- [`order.start`](/reference/operations/order/#orderstart)
- [`media.list`](/reference/operations/media/#medialist)
- [`order.settings.get`](/reference/operations/order/#ordersettingsget)
- [`query.sql`](/reference/operations/query/#querysql)
- [`x.programs.assign`](/packs/programs/tools/#assign)

Host modules it asks for: `ops`, `ai`.
