---
title: "Jobs: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.jobs.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### enquire

Takes an enquiry: a new job at the first stage of its pipeline (Trades unless another is named), for a customer (a Person id) and at a site (an existing site's id, or a new site's address, made for the same customer). A plain project names no site and the Projects pipeline. Pass requestId to make it safe to send again. Opens the new job.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:manage` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `title` | string | yes | min length 1, max length 200 |   |
| `customerId` | string |   | min length 1, max length 64 | The Person the work is for |
| `organisationId` | string |   | min length 1, max length 64 |   |
| `siteId` | string |   | min length 1, max length 64 |   |
| `site` | object |   |   | A new site, when siteId is not given |
| `site.name` | string |   | min length 1, max length 200 | How the office knows it; the street address by default |
| `site.line1` | string | yes | min length 1, max length 200 |   |
| `site.line2` | string |   | max length 200 |   |
| `site.suburb` | string |   | max length 100 |   |
| `site.region` | string |   | max length 100 |   |
| `site.postcode` | string |   | max length 20 |   |
| `site.country` | string |   | max length 100 |   |
| `site.hazards` | string |   | max length 2000 |   |
| `pipelineId` | string |   | min length 1, max length 64 |   |
| `billing` | `"fixed"`, `"time_and_materials"` |   |   |   |
| `description` | string |   | max length 5000 |   |
| `requestId` | string |   | min length 8, max length 64 | A key the caller makes once per action and sends again on a retry (a phone with poor signal): the same request finds what the first made instead of making it twice |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes |   |   |
| `siteId` | string or null | yes |   |   |
| `stageId` | string or null | yes |   |   |
| `existing` | boolean | yes |   | True when this request had already made the job |
| `open` | object | yes |   |   |
| `open.object` | `"jobs.job"` | yes |   |   |
| `open.id` | string | yes |   |   |

### jobSummary

One job for the office: its stage, customer, site, billing basis, the facts the host keeps (accepted, signed off, invoiced), its visits with their crew, its variations and how many lines it has of each kind and state. No prices: what is owed is unbilled's, for those who see prices. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `jobs:manage` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `stage` | string or null | yes |   |   |
| `status` | string or null | yes |   |   |
| `pipeline` | string or null | yes |   |   |
| `customer` | string or null | yes |   |   |
| `organisation` | string or null | yes |   |   |
| `owner` | string or null | yes |   |   |
| `billing` | string or null | yes |   |   |
| `site` | object or null | yes |   |   |
| `site.id` | string | yes |   |   |
| `site.name` | string or null | yes |   |   |
| `site.address` | string or null | yes |   |   |
| `site.hazards` | string or null | yes |   |   |
| `acceptedAt` | string or null | yes |   |   |
| `acceptedBy` | string or null | yes |   |   |
| `signedOffAt` | string or null | yes |   |   |
| `invoicedAt` | string or null | yes |   |   |
| `visits` | array of object | yes |   |   |
| `visits[].id` | string | yes |   |   |
| `visits[].title` | string or null | yes |   |   |
| `visits[].visitType` | string or null | yes |   |   |
| `visits[].starts` | string or null | yes |   |   |
| `visits[].ends` | string or null | yes |   |   |
| `visits[].zone` | string or null | yes |   |   |
| `visits[].arrivalWindow` | string or null | yes |   |   |
| `visits[].state` | `"booked"`, `"on_the_way"`, `"on_site"`, `"done"`, `"missed"`, `"cancelled"` or null | yes |   |   |
| `visits[].crew` | array of object | yes |   |   |
| `visits[].crew[].id` | string | yes |   |   |
| `visits[].crew[].staff` | string or null | yes |   |   |
| `visits[].crew[].lead` | boolean | yes |   |   |
| `visits[].crew[].state` | string or null | yes |   |   |
| `moreVisits` | boolean | yes |   |   |
| `variations` | array of object | yes |   |   |
| `variations[].id` | string | yes |   |   |
| `variations[].title` | string or null | yes |   |   |
| `variations[].state` | string or null | yes |   |   |
| `moreVariations` | boolean | yes |   |   |
| `lines` | array of object | yes |   | How many lines of each kind and state, at most the first 200 lines counted |
| `lines[].kind` | string | yes |   |   |
| `lines[].state` | string | yes |   |   |
| `lines[].count` | number | yes |   |   |

### recordAcceptance

Records that the customer accepted the work, on their word or a paper estimate, before quotes are built: sets the job's Accepted fact as the office's (never the customer's), approves exactly the estimate lines named (what the customer accepted), and moves the job to a stage when one is named. A person's own act; the assistant cannot do it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:manage` |
| Who may call it | a person only (`humanOnly`) |
| Kept from the audit log | `how` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes | min length 1, max length 64 |   |
| `how` | string | yes | min length 1, max length 500 | How the customer accepted: a signed paper estimate, a phone call |
| `estimateLines` | array of string | yes | at most 200 | The estimate lines the customer accepted; other drafts stay drafts |
| `stageId` | string |   | min length 1, max length 64 | A stage to move the job to in the same write (Accepted) |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes |   |   |
| `acceptedAt` | string or null | yes |   |   |
| `stage` | string or null | yes |   |   |
| `approvedLines` | array of string | yes |   |   |

### bookVisit

Books a visit to a job's site at a time, with its crew (each person a crew place, a shift on the roster). The end defaults to the visit type's usual length. Answers each crew member's warnings (away, not qualified for the visit type); if anyone would be in two places at once, nothing is booked and the refusal names them. An assistant's booking waits for a person. Pass requestId to make it safe to send again.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:schedule` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes | min length 1, max length 64 |   |
| `visitTypeId` | string | yes | min length 1, max length 64 |   |
| `starts` | string (date-time) | yes | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `ends` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `zone` | string |   | max length 64 | An IANA time zone; the deployment's if left out |
| `arrivalWindow` | string |   | max length 100 |   |
| `crewNotes` | string |   | max length 2000 |   |
| `crew` | array of object |   | at most 10, default `[]` |   |
| `crew[].staffId` | string | yes | min length 1, max length 64 |   |
| `crew[].lead` | boolean |   |   |   |
| `requestId` | string |   | min length 8, max length 64 | A key the caller makes once per action and sends again on a retry (a phone with poor signal): the same request finds what the first made instead of making it twice |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes |   |   |
| `existing` | boolean | yes |   |   |
| `crew` | array of object | yes |   |   |
| `crew[].id` | string | yes |   |   |
| `crew[].staff` | string | yes |   |   |
| `crew[].warnings` | array of object | yes |   |   |
| `crew[].warnings[].code` | string | yes |   |   |
| `crew[].warnings[].account` | string or null | yes |   |   |
| `crew[].warnings[].message` | string | yes |   |   |
| `open` | object | yes |   |   |
| `open.object` | `"jobs.visit"` | yes |   |   |
| `open.id` | string | yes |   |   |

### moveVisit

Moves a visit to another time. Its whole crew moves with it in the same write; if anyone would then be in two places at once, nothing moves and the refusal names them. Answers each crew member's warnings. The end keeps the visit's length unless given. An assistant's move waits for a person.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:schedule` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes | min length 1, max length 64 |   |
| `starts` | string (date-time) | yes | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `ends` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `zone` | string |   | max length 64 |   |
| `arrivalWindow` | string |   | max length 100 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes |   |   |
| `starts` | string or null | yes |   |   |
| `ends` | string or null | yes |   |   |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | string | yes |   |   |
| `warnings[].account` | string or null | yes |   |   |
| `warnings[].message` | string | yes |   |   |

### cancelVisit

Cancels a visit that has not happened: its crew places are cancelled with it, off the roster. An assistant's cancel waits for a person.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:schedule` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes |   |   |
| `state` | string | yes |   |   |
| `changed` | boolean | yes |   | False when it was already in that state |

### assignCrew

Puts a staff member on a visit (a crew place: a shift at the visit's time). Answers their warnings (away, not qualified for the visit type), which never stop it; being on another shift at that time does, and the refusal names it. With Rostering installed only someone who rosters may do it. An assistant's call waits for a person.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:schedule` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes | min length 1, max length 64 |   |
| `staffId` | string | yes | min length 1, max length 64 |   |
| `lead` | boolean |   |   |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `staff` | string | yes |   |   |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | string | yes |   |   |
| `warnings[].account` | string or null | yes |   |   |
| `warnings[].message` | string | yes |   |   |

### removeCrew

Takes a staff member off a visit: their crew place is cancelled, off the roster. An assistant's call waits for a person.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:schedule` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `placeId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `placeId` | string | yes |   |   |
| `state` | string | yes |   |   |

### myVisits

The caller's own visits from today for the next days (7 by default, at most 14), soonest first: each visit's time, arrival window, state, notes for the crew, the job and the site's address and hazards. No prices. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `jobs:crew`, `jobs:manage` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `days` | integer |   | ≥ 1, ≤ 14, default `7` |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visits` | array of object | yes |   |   |
| `visits[].id` | string | yes |   |   |
| `visits[].title` | string or null | yes |   |   |
| `visits[].visitType` | string or null | yes |   |   |
| `visits[].starts` | string or null | yes |   |   |
| `visits[].ends` | string or null | yes |   |   |
| `visits[].zone` | string or null | yes |   |   |
| `visits[].arrivalWindow` | string or null | yes |   |   |
| `visits[].state` | `"booked"`, `"on_the_way"`, `"on_site"`, `"done"`, `"missed"`, `"cancelled"` or null | yes |   |   |
| `visits[].placeId` | string | yes |   |   |
| `visits[].lead` | boolean | yes |   |   |
| `visits[].crewNotes` | string or null | yes |   |   |
| `visits[].job` | object or null | yes |   |   |
| `visits[].job.id` | string | yes |   |   |
| `visits[].job.title` | string or null | yes |   |   |
| `visits[].site` | object or null | yes |   |   |
| `visits[].site.id` | string | yes |   |   |
| `visits[].site.name` | string or null | yes |   |   |
| `visits[].site.address` | string or null | yes |   |   |
| `visits[].site.hazards` | string or null | yes |   |   |
| `truncated` | boolean | yes |   |   |

### myJob

A job as the crew sees it: its title and description, the site's address and hazards, its visits, the materials recorded on it and its variations. Quantities, never prices. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `jobs:crew`, `jobs:manage` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `site` | object or null | yes |   |   |
| `site.id` | string | yes |   |   |
| `site.name` | string or null | yes |   |   |
| `site.address` | string or null | yes |   |   |
| `site.hazards` | string or null | yes |   |   |
| `visits` | array of object | yes |   |   |
| `visits[].id` | string | yes |   |   |
| `visits[].title` | string or null | yes |   |   |
| `visits[].visitType` | string or null | yes |   |   |
| `visits[].starts` | string or null | yes |   |   |
| `visits[].ends` | string or null | yes |   |   |
| `visits[].zone` | string or null | yes |   |   |
| `visits[].arrivalWindow` | string or null | yes |   |   |
| `visits[].state` | `"booked"`, `"on_the_way"`, `"on_site"`, `"done"`, `"missed"`, `"cancelled"` or null | yes |   |   |
| `materials` | array of object | yes |   |   |
| `materials[].id` | string | yes |   |   |
| `materials[].description` | string or null | yes |   |   |
| `materials[].quantity` | number or null | yes |   |   |
| `materials[].unit` | string or null | yes |   |   |
| `materials[].state` | `"draft"`, `"approved"`, `"billed"`, `"void"` or null | yes |   |   |
| `materials[].recordedByName` | string or null | yes |   |   |
| `variations` | array of object | yes |   |   |
| `variations[].id` | string | yes |   |   |
| `variations[].title` | string or null | yes |   |   |
| `variations[].state` | `"proposed"`, `"approved"`, `"declined"`, `"withdrawn"` or null | yes |   |   |
| `truncated` | boolean | yes |   | More visits, materials or variations than shown (50 each) |

### markOnTheWay

Marks a booked visit on the way. A person's own act, by someone on the visit or the office; the assistant cannot do it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:crew`, `jobs:manage` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes |   |   |
| `state` | string | yes |   |   |
| `changed` | boolean | yes |   | False when it was already in that state |

### markOnSite

Marks a visit on site: the crew has arrived. A person's own act, by someone on the visit or the office; the assistant cannot do it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:crew`, `jobs:manage` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes |   |   |
| `state` | string | yes |   |   |
| `changed` | boolean | yes |   | False when it was already in that state |

### markDone

Marks a visit done: the work of the day is finished. A person's own act, by someone on the visit or the office; the assistant cannot do it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:crew`, `jobs:manage` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes |   |   |
| `state` | string | yes |   |   |
| `changed` | boolean | yes |   | False when it was already in that state |

### markMissed

Marks a visit missed: nobody could get in, or the crew could not come. A person's own act, by someone on the visit or the office; the assistant cannot do it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:crew`, `jobs:manage` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `visitId` | string | yes |   |   |
| `state` | string | yes |   |   |
| `changed` | boolean | yes |   | False when it was already in that state |

### addMaterial

Records a material used on a job: what, how many and in what unit (and a catalogue item's code if it has one), as a draft line the office prices. By someone with a place on the job, or the office. No price is asked or shown. Pass requestId to make it safe to send again.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:crew`, `jobs:manage` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes | min length 1, max length 64 |   |
| `description` | string | yes | min length 1, max length 200 |   |
| `quantity` | number | yes | ≥ 0, ≤ 1000000 |   |
| `unit` | string |   | max length 20 |   |
| `itemCode` | string |   | max length 100 |   |
| `requestId` | string |   | min length 8, max length 64 | A key the caller makes once per action and sends again on a retry (a phone with poor signal): the same request finds what the first made instead of making it twice |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lineId` | string | yes |   |   |
| `existing` | boolean | yes |   |   |

### addLine

Adds a priced draft line to a job: an estimate line (what is quoted) or a material line. Prices are in the base currency, before tax. Approving an estimate is the customer's acceptance; a material line is approved with approveLine. Pass requestId to make it safe to send again.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:prices` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes | min length 1, max length 64 |   |
| `kind` | `"estimate"`, `"material"` | yes |   |   |
| `description` | string | yes | min length 1, max length 200 |   |
| `quantity` | number | yes | ≥ 0, ≤ 1000000 |   |
| `unit` | string |   | max length 20 |   |
| `unitPrice` | number |   | ≥ 0, ≤ 10000000 |   |
| `cost` | number |   | ≥ 0, ≤ 10000000 |   |
| `taxCode` | string |   | max length 40 |   |
| `itemCode` | string |   | max length 100 |   |
| `requestId` | string |   | min length 8, max length 64 | A key the caller makes once per action and sends again on a retry (a phone with poor signal): the same request finds what the first made instead of making it twice |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lineId` | string | yes |   |   |
| `existing` | boolean | yes |   |   |

### editLine

Changes a draft line (its description, quantity, unit, price, cost, tax code or item; how the office prices a material the crew recorded): the draft is voided as replaced and a corrected draft made in its place, which this answers. A line's words and numbers never change once written, so an approved, billed or void line is never changed (the host refuses the void of anything but a draft). Safe to send again.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:prices` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lineId` | string | yes | min length 1, max length 64 |   |
| `description` | string |   | min length 1, max length 200 |   |
| `quantity` | number |   | ≥ 0, ≤ 1000000 |   |
| `unit` | string or null |   |   |   |
| `unitPrice` | number or null |   |   |   |
| `cost` | number or null |   |   |   |
| `taxCode` | string or null |   |   |   |
| `itemCode` | string or null |   |   |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `job` | string or null | yes |   |   |
| `kind` | `"estimate"`, `"variation"`, `"material"`, `"labour"` or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `quantity` | number or null | yes |   |   |
| `unit` | string or null | yes |   |   |
| `unitPrice` | number or null | yes |   |   |
| `cost` | number or null | yes |   |   |
| `taxCode` | string or null | yes |   |   |
| `state` | `"draft"`, `"approved"`, `"billed"`, `"void"` or null | yes |   |   |

### approveLine

Approves a draft material or labour line: it then counts as owed on a time and materials job (and as cost on a fixed-price one) and cannot be changed. An estimate line is approved by the customer's acceptance and a variation's lines with the variation, not here. An assistant's call waits for a person.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:prices` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lineId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `job` | string or null | yes |   |   |
| `kind` | `"estimate"`, `"variation"`, `"material"`, `"labour"` or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `quantity` | number or null | yes |   |   |
| `unit` | string or null | yes |   |   |
| `unitPrice` | number or null | yes |   |   |
| `cost` | number or null | yes |   |   |
| `taxCode` | string or null | yes |   |   |
| `state` | `"draft"`, `"approved"`, `"billed"`, `"void"` or null | yes |   |   |

### voidLine

Voids a draft or approved line: it no longer counts. A billed line is given back only when its invoice is voided. An assistant's call waits for a person.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:prices` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lineId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `job` | string or null | yes |   |   |
| `kind` | `"estimate"`, `"variation"`, `"material"`, `"labour"` or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `quantity` | number or null | yes |   |   |
| `unit` | string or null | yes |   |   |
| `unitPrice` | number or null | yes |   |   |
| `cost` | number or null | yes |   |   |
| `taxCode` | string or null | yes |   |   |
| `state` | `"draft"`, `"approved"`, `"billed"`, `"void"` or null | yes |   |   |

### proposeVariation

Proposes extra work on a job (a variation): what, why and who asked, with its lines (what and how many; the office prices them). It is approved before the work is done. By someone with a place on the job, or the office. Pass requestId to make it safe to send again.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:crew`, `jobs:manage` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes | min length 1, max length 64 |   |
| `title` | string | yes | min length 1, max length 200 |   |
| `why` | string | yes | min length 1, max length 2000 |   |
| `askedBy` | `"customer"`, `"crew"`, `"office"` |   |   |   |
| `lines` | array of object | yes | at least 1, at most 20 |   |
| `lines[].description` | string | yes | min length 1, max length 200 |   |
| `lines[].quantity` | number | yes | ≥ 0, ≤ 1000000 |   |
| `lines[].unit` | string |   | max length 20 |   |
| `requestId` | string |   | min length 8, max length 64 | A key the caller makes once per action and sends again on a retry (a phone with poor signal): the same request finds what the first made instead of making it twice |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `variationId` | string | yes |   |   |
| `lineIds` | array of string | yes |   |   |
| `existing` | boolean | yes |   |   |

### approveVariation

Records that the customer approved a proposed variation, on their word (a phone call, an email): recorded as the office's, never as the customer's own. Its lines are approved with it. A person's own act; the assistant cannot do it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:manage` |
| Who may call it | a person only (`humanOnly`) |
| Kept from the audit log | `note` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `variationId` | string | yes | min length 1, max length 64 |   |
| `note` | string | yes | min length 1, max length 500 | How the customer said so |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `variationId` | string | yes |   |   |
| `state` | `"proposed"`, `"approved"`, `"declined"`, `"withdrawn"` or null | yes |   |   |
| `decidedBy` | string or null | yes |   |   |

### declineVariation

Records that the customer declined a proposed variation, on their word (a phone call, an email): recorded as the office's, never as the customer's own. Its lines are voided with it. A person's own act; the assistant cannot do it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:manage` |
| Who may call it | a person only (`humanOnly`) |
| Kept from the audit log | `note` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `variationId` | string | yes | min length 1, max length 64 |   |
| `note` | string | yes | min length 1, max length 500 | How the customer said so |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `variationId` | string | yes |   |   |
| `state` | `"proposed"`, `"approved"`, `"declined"`, `"withdrawn"` or null | yes |   |   |
| `decidedBy` | string or null | yes |   |   |

### withdrawVariation

Withdraws a proposed variation nobody wants any more: its lines are voided with it. An assistant's call waits for a person.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `jobs:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `variationId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `variationId` | string | yes |   |   |
| `state` | `"proposed"`, `"approved"`, `"declined"`, `"withdrawn"` or null | yes |   |   |
| `decidedBy` | string or null | yes |   |   |

### unbilled

What is owed and not yet billed, by job: on a fixed-price job its approved estimate and variation lines, on a time and materials job its approved labour and material lines. Each line's amount and each job's total are integers in minor units of the base currency (cents), before tax. One job with jobId, else every job, at most 500 lines (truncated says when there were more). Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `jobs:prices` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string |   | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobs` | array of object | yes |   |   |
| `jobs[].jobId` | string | yes |   |   |
| `jobs[].title` | string or null | yes |   |   |
| `jobs[].billing` | string or null | yes |   |   |
| `jobs[].total` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `jobs[].lines` | array of object | yes |   |   |
| `jobs[].lines[].lineId` | string | yes |   |   |
| `jobs[].lines[].kind` | string or null | yes |   |   |
| `jobs[].lines[].description` | string or null | yes |   |   |
| `jobs[].lines[].quantity` | number or null | yes |   |   |
| `jobs[].lines[].unit` | string or null | yes |   |   |
| `jobs[].lines[].unitPrice` | number or null | yes |   |   |
| `jobs[].lines[].amount` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `jobs[].lines[].taxCode` | string or null | yes |   |   |
| `total` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `truncated` | boolean | yes |   |   |

### exportUnbilled

What is owed and not yet billed, as a CSV file for the accounting system: one row per approved line that is owed (unbilled's), amounts in minor units of the base currency before tax. At most 500 lines; truncated says when there were more. A person only, and every download is in the audit log.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `jobs:prices` |
| Who may call it | a person only (`humanOnly`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string |   | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filename` | string | yes |   |   |
| `contentType` | `"text/csv"` | yes |   |   |
| `csv` | string | yes |   |   |
| `lines` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `truncated` | boolean | yes |   |   |

## Automations

None.

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`query.sql`](/reference/operations/query/#querysql)

Host modules it asks for: `ops`.
