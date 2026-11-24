---
title: "agreement.* operations"
description: "The core operations named agreement.*"
sidebar:
  label: "agreement"
editUrl: false
---

## agreement.acceptance.get

One acceptance in full, for a person on the staff: the version shown, the name typed (beside the Person's own name), the signature drawn, and for paper who recorded it. Health answers are agreement.answers.get's. Never an AI's read. Who signed a paper form and its note are shown only with agreements:manage, as is an acceptance kept after an erase. Every read is audited (which acceptance, never what it says). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The acceptance's id (aga_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `documentId` | string | yes |   |   |
| `title` | string | yes |   |   |
| `kind` | string | yes |   |   |
| `versionId` | string | yes |   |   |
| `versionNumber` | number | yes |   |   |
| `personId` | string or null | yes |   |   |
| `by` | `"self"`, `"guardian"`, `"guest"`, `"paper"` | yes |   |   |
| `how` | `"typed"`, `"drawn"`, `"paper"` | yes |   |   |
| `channel` | `"web"`, `"app"`, `"paper"`, `"desk"` | yes |   |   |
| `acceptedAt` | string | yes |   |   |
| `agentPersonId` | string or null | yes |   | The guardian who agreed for a dependant |
| `recordedBy` | string or null | yes |   | Paper: the staff user who recorded it |
| `signedOn` | string or null | yes |   | Paper: the date on the form |
| `counts` | boolean | yes |   | Whether it is the acceptance that counts for its document now |
| `version` | object or null | yes |   |   |
| `version.id` | string | yes |   |   |
| `version.documentId` | string | yes |   |   |
| `version.number` | number | yes |   |   |
| `version.kind` | string | yes |   |   |
| `version.title` | string | yes |   |   |
| `version.body` | any | yes |   |   |
| `version.tickLabel` | string | yes |   |   |
| `version.questions` | array of object or null | yes |   |   |
| `version.questions.key` | string | yes |   |   |
| `version.questions.text` | string | yes |   |   |
| `version.questions.noteOnYes` | boolean | yes |   |   |
| `version.how` | `"typed"`, `"drawn"` | yes |   |   |
| `version.effectiveFrom` | string | yes |   |   |
| `version.hash` | string | yes |   |   |
| `personName` | string or null | yes |   |   |
| `typedName` | string or null | yes |   | Null once the guardian who typed it was erased |
| `signature` | object or null | yes |   |   |
| `signature.width` | number | yes |   |   |
| `signature.height` | number | yes |   |   |
| `signature.strokes` | array of array of array of number | yes |   |   |
| `agentName` | string or null | yes |   |   |
| `recordedByName` | string or null | yes |   |   |
| `signedBy` | string or null | yes |   | Paper: who signed it; null without agreements:manage |
| `note` | string or null | yes |   | Paper: staff's note; null without agreements:manage |
| `hasAnswers` | boolean | yes |   |   |
| `kept` | boolean | yes |   | Kept after its Person, or the guardian who made it, was erased |
| `copy` | object or null | yes |   | The emailed copy (step 4): whether it went; paper has none until Email a copy |
| `copy.state` | `"queued"`, `"sending"`, `"sent"`, `"waiting"`, `"failed"`, `"cancelled"` | yes |   |   |
| `copy.sentAt` | string or null | yes |   |   |

## agreement.acceptance.pdf

The signed PDF of one acceptance, for a person on the staff: the version shown and the record of who agreed, how and when, the name typed and the signature drawn (paper marked as recorded from paper), and a health form's answers only for staff with agreements:health. Every download is audited. Never an AI's read. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `acceptanceId` | string | yes | min length 1, max length 64 | The acceptance's id (aga_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filename` | string | yes |   | The file name to save it as |
| `document` | object | yes |   | What the signed PDF says; the download route draws it |
| `document.business` | string | yes |   |   |
| `document.title` | string | yes |   |   |
| `document.versionNumber` | number | yes |   |   |
| `document.versionHash` | string | yes |   |   |
| `document.body` | object | yes |   |   |
| `document.body.blocks` | array of any | yes |   |   |
| `document.tickLabel` | string | yes |   |   |
| `document.questions` | array of object |   |   |   |
| `document.questions[].key` | string | yes |   |   |
| `document.questions[].text` | string | yes |   |   |
| `document.answers` | array of object or `"in-app"` or `"withheld"` |   |   |   |
| `document.answers.key` | string | yes |   |   |
| `document.answers.yes` | boolean | yes |   |   |
| `document.answers.note` | string |   |   |   |
| `document.record` | array of object |   |   |   |
| `document.record[].label` | string | yes |   |   |
| `document.record[].value` | string | yes |   |   |
| `document.signature` | object |   |   |   |
| `document.signature.width` | number | yes |   |   |
| `document.signature.height` | number | yes |   |   |
| `document.signature.strokes` | array of array of array of number | yes |   |   |
| `document.acceptanceId` | string |   |   |   |
| `document.blank` | boolean |   |   |   |

## agreement.acceptances

The acceptances people made, newest first: by document, version, who agreed (themselves, a guardian, paper) and a date range, each with the Person and how and when. Never a name typed, a signature or health answers. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `documentId` | string |   | min length 1, max length 64 | Only this document's |
| `versionId` | string |   | min length 1, max length 64 | Only this version's |
| `by` | `"self"`, `"guardian"`, `"guest"`, `"paper"` |   |   |   |
| `channel` | `"web"`, `"app"`, `"paper"`, `"desk"` |   |   | Only those made this way: desk is at the desk |
| `deviceId` | string |   | min length 1, max length 64 | At the desk: only those made on this enrolled device (dev_…) |
| `startedBy` | string |   | min length 1, max length 64 | At the desk: only those in sessions this staff user started (usr_…) |
| `mark` | `"changed_recently"`, `"created_that_day"`, `"staff_address"` |   |   | At the desk: only those with this mark |
| `from` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `to` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |
| `before` | string |   |   | Paging: the acceptedAt of the last item seen |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].documentId` | string | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].kind` | string | yes |   |   |
| `items[].versionId` | string | yes |   |   |
| `items[].versionNumber` | number | yes |   |   |
| `items[].personId` | string or null | yes |   |   |
| `items[].by` | `"self"`, `"guardian"`, `"guest"`, `"paper"` | yes |   |   |
| `items[].how` | `"typed"`, `"drawn"`, `"paper"` | yes |   |   |
| `items[].channel` | `"web"`, `"app"`, `"paper"`, `"desk"` | yes |   |   |
| `items[].acceptedAt` | string | yes |   |   |
| `items[].agentPersonId` | string or null | yes |   | The guardian who agreed for a dependant |
| `items[].recordedBy` | string or null | yes |   | Paper: the staff user who recorded it |
| `items[].signedOn` | string or null | yes |   | Paper: the date on the form |
| `items[].counts` | boolean | yes |   | Whether it is the acceptance that counts for its document now |
| `items[].personName` | string or null | yes |   |   |
| `items[].desk` | object or null | yes |   |   |
| `items[].desk.sessionId` | string | yes |   |   |
| `items[].desk.device` | object | yes |   |   |
| `items[].desk.device.id` | string or null | yes |   |   |
| `items[].desk.device.name` | string | yes |   |   |
| `items[].desk.startedBy` | object | yes |   |   |
| `items[].desk.startedBy.id` | string | yes |   |   |
| `items[].desk.startedBy.name` | string | yes |   |   |
| `items[].desk.startedAt` | string | yes |   |   |
| `items[].desk.words` | string | yes |   | How it was made, as every screen and the PDF say it |
| `items[].desk.marks` | array of object | yes |   |   |
| `items[].desk.marks[].kind` | `"changed_recently"`, `"created_that_day"`, `"staff_address"` | yes |   |   |
| `items[].desk.marks[].at` | string |   |   |   |
| `items[].desk.marks[].by` | string |   |   |   |
| `items[].desk.marks[].how` | string |   |   |   |
| `next` | string or null | yes |   |   |

## agreement.answers.get

A health form's answers, for a person on the staff with agreements:health: each question, yes or no, and a note. Health information: every read is audited (who read whose), and no AI ever reads them. Read-only.

|  |  |
| --- | --- |
| Permission | `agreements:health` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `acceptanceId` | string | yes | min length 1, max length 64 | The acceptance's id (aga_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `acceptanceId` | string | yes |   |   |
| `personId` | string or null | yes |   |   |
| `acceptedAt` | string | yes |   |   |
| `enteredByStaff` | boolean | yes |   | Typed in by staff from a paper form |
| `answers` | array of object | yes |   |   |
| `answers[].key` | string | yes |   |   |
| `answers[].text` | string | yes |   |   |
| `answers[].yes` | boolean | yes |   |   |
| `answers[].note` | string or null | yes |   |   |

## agreement.attach

Attach a published agreement document to agreement points (agreement.points lists them), so it is needed there: from step 3 of stage 44, nobody buys or books there without a current acceptance of it. Nothing already bought or booked is touched. Only a person on the staff with agreements:manage can do this. Audited.

|  |  |
| --- | --- |
| Permission | `agreements:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `documentId` | string | yes | min length 1, max length 64 | The document's id (agd_…) |
| `points` | array of string | yes | at least 1, at most 20 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"terms"`, `"waiver"`, `"health"`, `"guardian"`, `"other"` | yes |   |   |
| `state` | `"draft"`, `"live"`, `"retired"` | yes |   |   |
| `title` | string | yes |   | The current version's title, or the working copy's before one |
| `current` | object or null | yes |   | The version in effect now |
| `current.id` | string | yes |   |   |
| `current.number` | number | yes |   |   |
| `current.effectiveFrom` | string | yes |   |   |
| `scheduled` | object or null | yes |   | A published version that takes effect later (never for a retired document: it never will) |
| `scheduled.id` | string | yes |   |   |
| `scheduled.number` | number | yes |   |   |
| `scheduled.effectiveFrom` | string | yes |   |   |
| `agreeFrom` | number | yes |   | Acceptances of versions numbered below this stop counting |
| `points` | array of string | yes |   | The agreement points it is attached to |
| `draftUpdatedAt` | string | yes |   |   |
| `retiredAt` | string or null | yes |   |   |

## agreement.copy.preview

Before Email a copy of a paper form: the address the host would send it to (the Person's sign-in address, or their primary email), or, for a child's form, the parents and guardians linked to the child now that you may see and that have an address, each with the address it would go to, to choose one; or why it would not be sent (a child with no such guardian, or no address), and whether a copy was already asked for. Show the address to the person, who confirms it with agreement.copy.send. A person on the staff with agreements:paper. Read-only.

|  |  |
| --- | --- |
| Permission | `agreements:paper` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `acceptanceId` | string | yes | min length 1, max length 64 | The paper acceptance's id (aga_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `acceptanceId` | string | yes |   |   |
| `to` | string or null | yes |   | An adult's form: the address it would go to |
| `guardians` | array of object | yes |   | A child's form: the linked parents and guardians to choose from |
| `guardians[].personId` | string | yes |   |   |
| `guardians[].name` | string | yes |   |   |
| `guardians[].to` | string | yes |   | The address the host holds for them, where it would go |
| `refused` | `"minor"`, `"no_address"` or null | yes |   |   |
| `state` | `"queued"`, `"sending"`, `"sent"`, `"waiting"`, `"failed"`, `"cancelled"` or null | yes |   | A copy already asked for: how it went |
| `askAgain` | boolean | yes |   | A child's copy cancelled before it went (its guardian erased or their link ended): it may be sent to a guardian linked now |

## agreement.copy.send

Email a paper form's copy (Email a copy): the signed PDF goes, as the host's own mail, to the address the host holds for the Person it is for, which agreement.copy.preview showed; for a child's form, to the linked parent or guardian chosen (`guardianId`, one the preview listed), at the address the host holds for them. `confirmTo` is that address as the person saw it: if the host's address changed since (an edit, by anyone), it is refused and shown again. Once only: asking again answers how the first one went. Refused for a child's form with no linked guardian who has an address, for anyone who is not a live guardian of the child, and for a Person with no address. A person on the staff with agreements:paper only.

|  |  |
| --- | --- |
| Permission | `agreements:paper` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `acceptanceId` | string | yes | min length 1, max length 64 | The paper acceptance's id (aga_…) |
| `guardianId` | string |   | min length 1, max length 64 | A child's form: the linked parent or guardian to send it to (per_…), as the preview listed |
| `confirmTo` | string | yes | min length 3, max length 320 | The address agreement.copy.preview showed, as the person confirmed it |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `acceptanceId` | string | yes |   |   |
| `state` | `"queued"`, `"sending"`, `"sent"`, `"waiting"`, `"failed"`, `"cancelled"` | yes |   |   |

## agreement.create

Start a new agreement document as a draft: its title and kind (terms, waiver, health for a health questions form, guardian for a parent's consent, other). The kind never changes. Its working copy is then written with agreement.draft.save; nothing is asked of anyone until a person publishes it and attaches it to an agreement point. The platform ships no wording: the business writes its own.

|  |  |
| --- | --- |
| Permission | `agreements:manage` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `title` | string | yes | min length 1, max length 200 |   |
| `kind` | `"terms"`, `"waiver"`, `"health"`, `"guardian"`, `"other"` | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |

## agreement.desk.devices

The devices an admin enrolled for desk signing, to choose the tablet a session is signed on: name and when last seen. agreements:desk. Read-only.

|  |  |
| --- | --- |
| Permission | `agreements:desk` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `configured` | boolean | yes |   |   |
| `devices` | array of object | yes |   |   |
| `devices[].id` | string | yes |   |   |
| `devices[].name` | string | yes |   |   |
| `devices[].lastSeenAt` | string or null | yes |   |   |

## agreement.desk.end

End a desk signing session now: the tablet's next call is refused. What was signed in it stays. agreements:desk, a person.

|  |  |
| --- | --- |
| Permission | `agreements:desk` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sessionId` | string | yes | min length 1, max length 64 | The session (ads_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `session` | object | yes |   |   |
| `session.id` | string | yes |   |   |
| `session.state` | `"waiting"`, `"claimed"`, `"ended"` | yes |   |   |
| `session.personId` | string or null | yes |   |   |
| `session.device` | object | yes |   |   |
| `session.device.id` | string | yes |   |   |
| `session.device.name` | string | yes |   |   |
| `session.claimedOn` | object or null | yes |   | The device a claim came from: the one chosen, or another that ended it |
| `session.claimedOn.id` | string | yes |   |   |
| `session.claimedOn.name` | string | yes |   |   |
| `session.startedAt` | string | yes |   |   |
| `session.codeExpiresAt` | string | yes |   |   |
| `session.claimedAt` | string or null | yes |   |   |
| `session.endedAt` | string or null | yes |   |   |
| `session.endReason` | string or null | yes |   |   |
| `session.signed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Acceptances made in it |

## agreement.desk.find

Find the Person a desk signing session is for: by their full name exactly (as a name is compared for duplicates: case, accents and middle initials folded) or by one of their email addresses exactly. Never a partial match or a list to page through: up to 5 people with that very name. Names and ids only. Every search is audited. agreements:desk, a person. Read-only.

|  |  |
| --- | --- |
| Permission | `agreements:desk` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `query` | string | yes | min length 3, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `people` | array of object | yes |   |   |
| `people[].personId` | string | yes |   |   |
| `people[].name` | string | yes |   |   |

## agreement.desk.get

A desk signing session's state, for the staff screen that started it: waiting for its code, claimed on which device and when, or ended and why (finished, ended by staff, run out, claimed on another device, a wrong code, the device revoked), and how many acceptances it made. agreements:desk. Read-only.

|  |  |
| --- | --- |
| Permission | `agreements:desk` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sessionId` | string | yes | min length 1, max length 64 | The session (ads_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `session` | object | yes |   |   |
| `session.id` | string | yes |   |   |
| `session.state` | `"waiting"`, `"claimed"`, `"ended"` | yes |   |   |
| `session.personId` | string or null | yes |   |   |
| `session.device` | object | yes |   |   |
| `session.device.id` | string | yes |   |   |
| `session.device.name` | string | yes |   |   |
| `session.claimedOn` | object or null | yes |   | The device a claim came from: the one chosen, or another that ended it |
| `session.claimedOn.id` | string | yes |   |   |
| `session.claimedOn.name` | string | yes |   |   |
| `session.startedAt` | string | yes |   |   |
| `session.codeExpiresAt` | string | yes |   |   |
| `session.claimedAt` | string or null | yes |   |   |
| `session.endedAt` | string or null | yes |   |   |
| `session.endReason` | string or null | yes |   |   |
| `session.signed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Acceptances made in it |

## agreement.desk.prepare

Before starting a desk signing session for a Person: the titles of what they have due, their live children and what each has due, where the copy goes (masked), and whether a session can start (and why not). Nothing else of their record. agreements:desk. Read-only.

|  |  |
| --- | --- |
| Permission | `agreements:desk` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 | The Person who will sign (per_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes |   |   |
| `name` | string | yes |   |   |
| `due` | array of string | yes |   |   |
| `dependants` | array of object | yes |   | The live children, by given name only |
| `dependants[].personId` | string | yes |   |   |
| `dependants[].name` | string | yes |   |   |
| `dependants[].due` | array of string | yes |   |   |
| `copyTo` | string or null | yes |   | Where the copy goes, masked (s•••@e•••.com) |
| `refused` | `"minor"`, `"no_address"` or null | yes |   | minor: a parent or guardian signs for them; no_address: the copy has nowhere to go |

## agreement.desk.start

Start a desk signing session: the named Person signs what they have due on the enrolled tablet chosen, and for a parent, for the live children listed. Answers an 8-character code, single use, good for 2 minutes, to type on that tablet. Refused for a Person in the Trash, a minor for themselves (start it for their parent or guardian), a signer with no email address (the copy goes there every time), a child not linked to them now, and a revoked device. Records no acceptance: the member signs. A person on the staff with agreements:desk.

|  |  |
| --- | --- |
| Permission | `agreements:desk` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 | Who signs (per_…) |
| `deviceId` | string | yes | min length 1, max length 64 | The enrolled tablet (dev_…) |
| `dependantIds` | array of string |   | at most 10 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `session` | object | yes |   |   |
| `session.id` | string | yes |   |   |
| `session.state` | `"waiting"`, `"claimed"`, `"ended"` | yes |   |   |
| `session.personId` | string or null | yes |   |   |
| `session.device` | object | yes |   |   |
| `session.device.id` | string | yes |   |   |
| `session.device.name` | string | yes |   |   |
| `session.claimedOn` | object or null | yes |   | The device a claim came from: the one chosen, or another that ended it |
| `session.claimedOn.id` | string | yes |   |   |
| `session.claimedOn.name` | string | yes |   |   |
| `session.startedAt` | string | yes |   |   |
| `session.codeExpiresAt` | string | yes |   |   |
| `session.claimedAt` | string or null | yes |   |   |
| `session.endedAt` | string or null | yes |   |   |
| `session.endReason` | string or null | yes |   |   |
| `session.signed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Acceptances made in it |
| `code` | string | yes |   | Shown once on the staff screen; stored only as its HMAC |
| `deskUrl` | string | yes |   | Where the tablet is (the desk origin) |

## agreement.detach

Detach an agreement document from agreement points: it is no longer needed there. Acceptances people made are kept. Only a person on the staff with agreements:manage can do this. Audited.

|  |  |
| --- | --- |
| Permission | `agreements:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `documentId` | string | yes | min length 1, max length 64 | The document's id (agd_…) |
| `points` | array of string | yes | at least 1, at most 20 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"terms"`, `"waiver"`, `"health"`, `"guardian"`, `"other"` | yes |   |   |
| `state` | `"draft"`, `"live"`, `"retired"` | yes |   |   |
| `title` | string | yes |   | The current version's title, or the working copy's before one |
| `current` | object or null | yes |   | The version in effect now |
| `current.id` | string | yes |   |   |
| `current.number` | number | yes |   |   |
| `current.effectiveFrom` | string | yes |   |   |
| `scheduled` | object or null | yes |   | A published version that takes effect later (never for a retired document: it never will) |
| `scheduled.id` | string | yes |   |   |
| `scheduled.number` | number | yes |   |   |
| `scheduled.effectiveFrom` | string | yes |   |   |
| `agreeFrom` | number | yes |   | Acceptances of versions numbered below this stop counting |
| `points` | array of string | yes |   | The agreement points it is attached to |
| `draftUpdatedAt` | string | yes |   |   |
| `retiredAt` | string or null | yes |   |   |

## agreement.draft.save

Write an agreement document's working copy: any of its title, body (rich text), tick label (the words beside the box), how a person agrees (typed name, or a drawn signature), who agrees (the participant or the payer), for whom (everyone, or only a dependant), and for a health form its questions and after how many months it is asked again. Only what is given changes. It changes no published version and nothing anyone is asked: a person publishes. draftRev, when given, is the copy's rev the change was made against: a copy saved by someone else since is refused. Two saves of the same rev never both apply. The assistant may write it for someone who holds agreements:manage.

|  |  |
| --- | --- |
| Permission | `agreements:manage` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The document's id (agd_…) |
| `draftRev` | integer |   | ≥ 0, ≤ 9007199254740991 |   |
| `title` | string |   | min length 1, max length 200 |   |
| `body` | any |   |   |   |
| `tickLabel` | string or null |   |   |   |
| `how` | `"typed"`, `"drawn"` |   |   |   |
| `who` | `"participant"`, `"payer"` |   |   |   |
| `forWhom` | `"everyone"`, `"dependants"` |   |   |   |
| `questions` | array of object or null |   |   | A health form's questions only |
| `questions.key` | string | yes | pattern `^[a-z][a-z0-9_]{0,39}$` | Stable key of the question within the form |
| `questions.text` | string | yes | min length 1, max length 500 |   |
| `questions.noteOnYes` | boolean |   | default `false` |   |
| `askAgainMonths` | integer or null |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `title` | string | yes |   |   |
| `body` | any or null | yes |   |   |
| `tickLabel` | string or null | yes |   |   |
| `questions` | array of object or null | yes |   |   |
| `questions.key` | string | yes |   |   |
| `questions.text` | string | yes |   |   |
| `questions.noteOnYes` | boolean | yes |   |   |
| `how` | `"typed"`, `"drawn"` | yes |   |   |
| `who` | `"participant"`, `"payer"` | yes |   |   |
| `forWhom` | `"everyone"`, `"dependants"` | yes |   |   |
| `askAgainMonths` | number or null | yes |   |   |
| `rev` | number | yes |   | Bumped by every save; publish and a careful save name it |
| `updatedAt` | string | yes |   |   |
| `updatedBy` | string | yes |   |   |
| `updatedVia` | string | yes |   | The actor of the last save: human, assistant, mcp, … |
| `updatedByName` | string or null | yes |   | The name of the staff account it was saved for |
| `hash` | string | yes |   | Hash of everything a version made from it would hold |

## agreement.due.list

Who still has to agree to which document: People with a sign-in, a subscription, a family link or the minor mark who have something attached due, those with a live subscription first. Titles and dates only. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `documentId` | string |   | min length 1, max length 64 | Only this document |
| `limit` | integer |   | ≥ 1, ≤ 200, default `100` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].personId` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].subscribed` | boolean | yes |   |   |
| `items[].due` | array of object | yes |   |   |
| `items[].due[].documentId` | string | yes |   |   |
| `items[].due[].title` | string | yes |   |   |
| `items[].due[].reason` | `"never"`, `"agree_again"`, `"ask_again"`, `"guardian"` | yes |   |   |
| `more` | boolean | yes |   |   |

## agreement.erasePreview

What erasing a Person would do to their agreements, for the screen that confirms an erase: how many acceptances (their own, and those they made as a guardian) are kept, no longer theirs, and until when; how many health forms' answers are deleted at once. Counts only, over them and anyone merged into them, a Person in the Trash included, and a buyer's acceptances on purchases that are theirs. A person only. Read-only.

|  |  |
| --- | --- |
| Permission | `audit:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 | The Person to erase (per_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kept` | number | yes |   |   |
| `until` | string or null | yes |   | When the purge deletes them; null: nothing is purged |
| `healthAnswers` | number | yes |   | Health forms whose answers are deleted at once |
| `buyerDeleted` | number | yes |   | A buyer's acceptances on an unpaid order or unconfirmed checkout: deleted |

## agreement.get

One agreement document: its summary, the working copy (the draft the editor changes, with its hash) and its versions, newest first, without their bodies (agreement.version.get reads one). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The document's id (agd_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"terms"`, `"waiver"`, `"health"`, `"guardian"`, `"other"` | yes |   |   |
| `state` | `"draft"`, `"live"`, `"retired"` | yes |   |   |
| `title` | string | yes |   | The current version's title, or the working copy's before one |
| `current` | object or null | yes |   | The version in effect now |
| `current.id` | string | yes |   |   |
| `current.number` | number | yes |   |   |
| `current.effectiveFrom` | string | yes |   |   |
| `scheduled` | object or null | yes |   | A published version that takes effect later (never for a retired document: it never will) |
| `scheduled.id` | string | yes |   |   |
| `scheduled.number` | number | yes |   |   |
| `scheduled.effectiveFrom` | string | yes |   |   |
| `agreeFrom` | number | yes |   | Acceptances of versions numbered below this stop counting |
| `points` | array of string | yes |   | The agreement points it is attached to |
| `draftUpdatedAt` | string | yes |   |   |
| `retiredAt` | string or null | yes |   |   |
| `draft` | object | yes |   |   |
| `draft.title` | string | yes |   |   |
| `draft.body` | any or null | yes |   |   |
| `draft.tickLabel` | string or null | yes |   |   |
| `draft.questions` | array of object or null | yes |   |   |
| `draft.questions.key` | string | yes |   |   |
| `draft.questions.text` | string | yes |   |   |
| `draft.questions.noteOnYes` | boolean | yes |   |   |
| `draft.how` | `"typed"`, `"drawn"` | yes |   |   |
| `draft.who` | `"participant"`, `"payer"` | yes |   |   |
| `draft.forWhom` | `"everyone"`, `"dependants"` | yes |   |   |
| `draft.askAgainMonths` | number or null | yes |   |   |
| `draft.rev` | number | yes |   | Bumped by every save; publish and a careful save name it |
| `draft.updatedAt` | string | yes |   |   |
| `draft.updatedBy` | string | yes |   |   |
| `draft.updatedVia` | string | yes |   | The actor of the last save: human, assistant, mcp, … |
| `draft.updatedByName` | string or null | yes |   | The name of the staff account it was saved for |
| `draft.hash` | string | yes |   | Hash of everything a version made from it would hold |
| `versions` | array of object | yes |   |   |
| `versions[].id` | string | yes |   |   |
| `versions[].documentId` | string | yes |   |   |
| `versions[].number` | number | yes |   |   |
| `versions[].title` | string | yes |   |   |
| `versions[].tickLabel` | string | yes |   |   |
| `versions[].how` | `"typed"`, `"drawn"` | yes |   |   |
| `versions[].who` | `"participant"`, `"payer"` | yes |   |   |
| `versions[].forWhom` | `"everyone"`, `"dependants"` | yes |   |   |
| `versions[].askAgainMonths` | number or null | yes |   |   |
| `versions[].change` | `"first"`, `"small"`, `"agree_again"` | yes |   |   |
| `versions[].effectiveFrom` | string | yes |   |   |
| `versions[].publishedAt` | string | yes |   |   |
| `versions[].publishedBy` | string | yes |   |   |
| `versions[].hash` | string | yes |   |   |
| `versions[].intact` | boolean | yes |   | The hash recomputed from the stored content matches: false means tampering |
| `versions[].status` | `"in_effect"`, `"replaced"`, `"scheduled"`, `"never_in_force"` | yes |   |   |
| `versions[].acceptances` | number | yes |   | How many acceptances of this version there are |

## agreement.guestVersions

The words a visitor buying without an account is asked to agree to: each version named (by the versionId of an agreements_due refusal from a buying call), as it will be recorded: its title, body, tick label, health questions and how it is agreed to. Only the version in effect of a live document attached somewhere and asked of everyone; any other id (an older version, one scheduled for later) is left out. The business's text, never anyone's personal data. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer`, `public` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `versionIds` | array of string | yes | at least 1, at most 20 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `versions` | array of object | yes |   |   |
| `versions[].id` | string | yes |   |   |
| `versions[].documentId` | string | yes |   |   |
| `versions[].number` | number | yes |   |   |
| `versions[].kind` | string | yes |   |   |
| `versions[].title` | string | yes |   |   |
| `versions[].body` | any | yes |   |   |
| `versions[].tickLabel` | string | yes |   |   |
| `versions[].questions` | array of object or null | yes |   |   |
| `versions[].questions.key` | string | yes |   |   |
| `versions[].questions.text` | string | yes |   |   |
| `versions[].questions.noteOnYes` | boolean | yes |   |   |
| `versions[].how` | `"typed"`, `"drawn"` | yes |   |   |
| `versions[].effectiveFrom` | string | yes |   |   |
| `versions[].hash` | string | yes |   |   |

## agreement.healthNotes

Which of these People answered yes on their current health form, as a yes or no each (a mark, nothing of the form). A person on the staff with agreements:health only; every read is audited. Read-only.

|  |  |
| --- | --- |
| Permission | `agreements:health` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personIds` | array of string | yes | at most 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `notes` | array of object | yes |   |   |
| `notes[].personId` | string | yes |   |   |
| `notes[].healthNote` | boolean | yes |   |   |

## agreement.healthReviews

The People whose current health form has a yes, newest first, for staff with agreements:health to look at (where a health notice sends them). Every read is audited. Read-only.

|  |  |
| --- | --- |
| Permission | `agreements:health` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].acceptanceId` | string | yes |   |   |
| `items[].personId` | string | yes |   |   |
| `items[].name` | string or null | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].acceptedAt` | string | yes |   |   |

## agreement.kept.find

Find acceptances kept after their person was erased, by the address the copy went to or the name typed (part of it), for a dispute or a claim: what was agreed, how and when, and until when it is kept. Open one with agreement.acceptance.pdf. A person on the staff with agreements:manage only; every search is audited, without what was searched for.

|  |  |
| --- | --- |
| Permission | `agreements:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `email` | string |   | max length 320 |   |
| `name` | string |   | min length 2, max length 200 |   |
| `limit` | integer |   | ≥ 1, ≤ 100, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].documentId` | string | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].versionNumber` | number | yes |   |   |
| `items[].by` | `"self"`, `"guardian"`, `"guest"`, `"paper"` | yes |   |   |
| `items[].how` | `"typed"`, `"drawn"`, `"paper"` | yes |   |   |
| `items[].channel` | `"web"`, `"app"`, `"paper"`, `"desk"` | yes |   |   |
| `items[].acceptedAt` | string | yes |   |   |
| `items[].erasedAt` | string | yes |   |   |
| `items[].until` | string or null | yes |   | When the purge deletes it; null: not while on hold |
| `items[].held` | boolean | yes |   |   |

## agreement.kept.hold

Hold a kept acceptance (one kept after its person was erased) for a dispute or a claim, so the retention purge passes it by; or release it (held: false), after which the purge takes it once its period is over. A person on the staff with agreements:manage only. Audited.

|  |  |
| --- | --- |
| Permission | `agreements:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `acceptanceId` | string | yes | min length 1, max length 64 | The kept acceptance (aga_…) |
| `held` | boolean | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `acceptanceId` | string | yes |   |   |
| `held` | boolean | yes |   |   |

## agreement.list

List the business's agreement documents (terms, waivers, health forms, a parent's consent): each with its kind, state (draft, live or retired), the version in effect now and any scheduled one, and the agreement points it is attached to. Titles and the business's own text only: nothing here names a member. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `retired` | boolean |   | default `false` | Include retired documents |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].kind` | `"terms"`, `"waiver"`, `"health"`, `"guardian"`, `"other"` | yes |   |   |
| `items[].state` | `"draft"`, `"live"`, `"retired"` | yes |   |   |
| `items[].title` | string | yes |   | The current version's title, or the working copy's before one |
| `items[].current` | object or null | yes |   | The version in effect now |
| `items[].current.id` | string | yes |   |   |
| `items[].current.number` | number | yes |   |   |
| `items[].current.effectiveFrom` | string | yes |   |   |
| `items[].scheduled` | object or null | yes |   | A published version that takes effect later (never for a retired document: it never will) |
| `items[].scheduled.id` | string | yes |   |   |
| `items[].scheduled.number` | number | yes |   |   |
| `items[].scheduled.effectiveFrom` | string | yes |   |   |
| `items[].agreeFrom` | number | yes |   | Acceptances of versions numbered below this stop counting |
| `items[].points` | array of string | yes |   | The agreement points it is attached to |
| `items[].draftUpdatedAt` | string | yes |   |   |
| `items[].retiredAt` | string or null | yes |   |   |

## agreement.listHealthNotes

For a list a pack declares (healthNotes on its object: a class's bookings): the host reads the People on the records of that list's own record (value, the class) and says which answered yes on their current health form (a mark only). Pack code inside a tool a person called themselves only; every call is audited. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `extension` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `records` | string | yes | min length 1, max length 80 | The calling pack's object that declares healthNotes (bookings.booking) |
| `value` | string | yes | min length 1, max length 64 | The list's own record (the class's id) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `notes` | array of object | yes |   |   |
| `notes[].personId` | string | yes |   |   |
| `notes[].healthNote` | boolean | yes |   |   |

## agreement.mergePlan

What merging mergedId into survivorId would do to their agreements: how many acceptances (their own, and made as a guardian) move to the survivor unchanged, whether the minor mark moves, and whether the caller may merge them (a person with agreements:manage only). Counts only. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `survivorId` | string | yes | min length 1, max length 64 | The person who remains |
| `mergedId` | string | yes | min length 1, max length 64 | The duplicate merged away |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `acceptances` | number | yes |   |   |
| `asGuardian` | number | yes |   |   |
| `minor` | boolean | yes |   |   |
| `needs` | `"agreements:manage"`, `"person"` or null | yes |   | Why the caller cannot merge them; null when they can, or nothing moves |

## agreement.person

A Person's agreements, as the Person page shows them: each document attached anywhere, current or due (and why: never agreed, agree again, asked again, a guardian must agree), every acceptance (who agreed, how, when; paper marked), and whether they are a minor. Titles and dates only: never a name typed, a signature or health answers. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 | The Person (per_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes |   |   |
| `minor` | object | yes |   |   |
| `minor.marked` | boolean | yes |   | Staff marked them a minor (agreement.setMinor) |
| `minor.dependant` | boolean | yes |   | A child of a live family link |
| `minor.markedBy` | string or null | yes |   |   |
| `minor.markedAt` | string or null | yes |   |   |
| `documents` | array of object | yes |   |   |
| `documents[].documentId` | string | yes |   |   |
| `documents[].kind` | string | yes |   |   |
| `documents[].title` | string | yes |   |   |
| `documents[].points` | array of string | yes |   |   |
| `documents[].versionId` | string | yes |   | The version in effect |
| `documents[].versionNumber` | number | yes |   |   |
| `documents[].status` | `"current"`, `"due"` | yes |   |   |
| `documents[].reason` | `"never"`, `"agree_again"`, `"ask_again"`, `"guardian"` or null | yes |   | Why it is due: never agreed, agree again, … |
| `documents[].acceptanceId` | string or null | yes |   | The acceptance that counts now |
| `documents[].acceptedAt` | string or null | yes |   |   |
| `acceptances` | array of object | yes |   |   |
| `acceptances[].id` | string | yes |   |   |
| `acceptances[].documentId` | string | yes |   |   |
| `acceptances[].title` | string | yes |   |   |
| `acceptances[].kind` | string | yes |   |   |
| `acceptances[].versionId` | string | yes |   |   |
| `acceptances[].versionNumber` | number | yes |   |   |
| `acceptances[].personId` | string or null | yes |   |   |
| `acceptances[].by` | `"self"`, `"guardian"`, `"guest"`, `"paper"` | yes |   |   |
| `acceptances[].how` | `"typed"`, `"drawn"`, `"paper"` | yes |   |   |
| `acceptances[].channel` | `"web"`, `"app"`, `"paper"`, `"desk"` | yes |   |   |
| `acceptances[].acceptedAt` | string | yes |   |   |
| `acceptances[].agentPersonId` | string or null | yes |   | The guardian who agreed for a dependant |
| `acceptances[].recordedBy` | string or null | yes |   | Paper: the staff user who recorded it |
| `acceptances[].signedOn` | string or null | yes |   | Paper: the date on the form |
| `acceptances[].counts` | boolean | yes |   | Whether it is the acceptance that counts for its document now |
| `acceptances[].agentName` | string or null | yes |   |   |
| `acceptances[].recordedByName` | string or null | yes |   |   |
| `acceptances[].desk` | object or null | yes |   | At the desk: its session, the device and the marks |
| `acceptances[].desk.sessionId` | string | yes |   |   |
| `acceptances[].desk.device` | object | yes |   |   |
| `acceptances[].desk.device.id` | string or null | yes |   |   |
| `acceptances[].desk.device.name` | string | yes |   |   |
| `acceptances[].desk.startedBy` | object | yes |   |   |
| `acceptances[].desk.startedBy.id` | string | yes |   |   |
| `acceptances[].desk.startedBy.name` | string | yes |   |   |
| `acceptances[].desk.startedAt` | string | yes |   |   |
| `acceptances[].desk.words` | string | yes |   | How it was made, as every screen and the PDF say it |
| `acceptances[].desk.marks` | array of object | yes |   |   |
| `acceptances[].desk.marks[].kind` | `"changed_recently"`, `"created_that_day"`, `"staff_address"` | yes |   |   |
| `acceptances[].desk.marks[].at` | string |   |   |   |
| `acceptances[].desk.marks[].by` | string |   |   |   |
| `acceptances[].desk.marks[].how` | string |   |   |   |
| `healthNote` | boolean or null | yes |   | A yes on their current health form; null unless the caller may read answers |
| `can` | object | yes |   |   |
| `can.recordPaper` | boolean | yes |   |   |
| `can.setMinor` | boolean | yes |   |   |
| `can.readAnswers` | boolean | yes |   |   |
| `can.signAtDesk` | boolean | yes |   | May start a desk signing session for them |

## agreement.points

The agreement points installed packs declare (buying a membership, making a booking): the places a business may attach its documents, each with its label, the kinds of document it suggests and the objects that declare it. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].point` | string | yes |   |   |
| `items[].label` | string | yes |   |   |
| `items[].suggests` | array of string | yes |   |   |
| `items[].objects` | array of string | yes |   |   |
| `items[].inlineStep` | boolean | yes |   | Whether the pack's screens let a person agree on the way: false means a document attached here refuses purchases or bookings there until they agree elsewhere |

## agreement.publish

Publish an agreement document's working copy as its next version, which nobody can change afterwards. change: small (earlier acceptances still count) or agree_again (everyone must agree to this version before their next booking or purchase); a first version is first. effectiveFrom (left out: now) schedules it; never in the past or before the newest version's, and never withdrawn. draftHash and draftRev are the preview's: a copy changed since in any field is refused. A person on the staff with agreements:manage only. Audited.

|  |  |
| --- | --- |
| Permission | `agreements:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `documentId` | string | yes | min length 1, max length 64 | The document's id (agd_…) |
| `change` | `"small"`, `"agree_again"` | yes |   |   |
| `effectiveFrom` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` |   |
| `draftHash` | string | yes | pattern `^[0-9a-f]{64}$` |   |
| `draftRev` | integer | yes | ≥ 0, ≤ 9007199254740991 |   |
| `number` | integer | yes | ≥ 1, ≤ 9007199254740991 | The version number the preview showed |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `document` | object | yes |   |   |
| `document.id` | string | yes |   |   |
| `document.kind` | `"terms"`, `"waiver"`, `"health"`, `"guardian"`, `"other"` | yes |   |   |
| `document.state` | `"draft"`, `"live"`, `"retired"` | yes |   |   |
| `document.title` | string | yes |   | The current version's title, or the working copy's before one |
| `document.current` | object or null | yes |   | The version in effect now |
| `document.current.id` | string | yes |   |   |
| `document.current.number` | number | yes |   |   |
| `document.current.effectiveFrom` | string | yes |   |   |
| `document.scheduled` | object or null | yes |   | A published version that takes effect later (never for a retired document: it never will) |
| `document.scheduled.id` | string | yes |   |   |
| `document.scheduled.number` | number | yes |   |   |
| `document.scheduled.effectiveFrom` | string | yes |   |   |
| `document.agreeFrom` | number | yes |   | Acceptances of versions numbered below this stop counting |
| `document.points` | array of string | yes |   | The agreement points it is attached to |
| `document.draftUpdatedAt` | string | yes |   |   |
| `document.retiredAt` | string or null | yes |   |   |
| `version` | object | yes |   |   |
| `version.id` | string | yes |   |   |
| `version.documentId` | string | yes |   |   |
| `version.number` | number | yes |   |   |
| `version.title` | string | yes |   |   |
| `version.body` | any | yes |   |   |
| `version.tickLabel` | string | yes |   |   |
| `version.questions` | array of object or null | yes |   |   |
| `version.questions.key` | string | yes |   |   |
| `version.questions.text` | string | yes |   |   |
| `version.questions.noteOnYes` | boolean | yes |   |   |
| `version.how` | `"typed"`, `"drawn"` | yes |   |   |
| `version.who` | `"participant"`, `"payer"` | yes |   |   |
| `version.forWhom` | `"everyone"`, `"dependants"` | yes |   |   |
| `version.askAgainMonths` | number or null | yes |   |   |
| `version.change` | `"first"`, `"small"`, `"agree_again"` | yes |   |   |
| `version.effectiveFrom` | string | yes |   |   |
| `version.publishedAt` | string | yes |   |   |
| `version.publishedBy` | string | yes |   |   |
| `version.hash` | string | yes |   |   |
| `version.intact` | boolean | yes |   | The hash recomputed from the stored content matches: false means tampering |

## agreement.publishPreview

What publishing an agreement document's working copy would make: the exact snapshot (every field a version holds), its number, whether it is the first, which fields changed against the newest version, the hash and rev to pass to agreement.publish, and why it cannot be published yet if it cannot. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The document's id (agd_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `number` | number | yes |   |   |
| `first` | boolean | yes |   |   |
| `changed` | array of `"title"`, `"body"`, `"tickLabel"`, `"questions"`, `"how"`, `"who"`, `"forWhom"`, `"askAgainMonths"` | yes |   |   |
| `snapshot` | object | yes |   |   |
| `snapshot.title` | string | yes |   |   |
| `snapshot.body` | any or null | yes |   |   |
| `snapshot.tickLabel` | string or null | yes |   |   |
| `snapshot.questions` | array of object or null | yes |   |   |
| `snapshot.questions.key` | string | yes |   |   |
| `snapshot.questions.text` | string | yes |   |   |
| `snapshot.questions.noteOnYes` | boolean | yes |   |   |
| `snapshot.how` | `"typed"`, `"drawn"` | yes |   |   |
| `snapshot.who` | `"participant"`, `"payer"` | yes |   |   |
| `snapshot.forWhom` | `"everyone"`, `"dependants"` | yes |   |   |
| `snapshot.askAgainMonths` | number or null | yes |   |   |
| `snapshot.rev` | number | yes |   | Bumped by every save; publish and a careful save name it |
| `snapshot.updatedAt` | string | yes |   |   |
| `snapshot.updatedBy` | string | yes |   |   |
| `snapshot.updatedVia` | string | yes |   | The actor of the last save: human, assistant, mcp, … |
| `snapshot.updatedByName` | string or null | yes |   | The name of the staff account it was saved for |
| `snapshot.hash` | string | yes |   | Hash of everything a version made from it would hold |
| `snapshot.kind` | `"terms"`, `"waiver"`, `"health"`, `"guardian"`, `"other"` | yes |   |   |
| `draftHash` | string | yes |   |   |
| `draftRev` | number | yes |   |   |
| `latest` | object or null | yes |   |   |
| `latest.id` | string | yes |   |   |
| `latest.documentId` | string | yes |   |   |
| `latest.number` | number | yes |   |   |
| `latest.title` | string | yes |   |   |
| `latest.body` | any | yes |   |   |
| `latest.tickLabel` | string | yes |   |   |
| `latest.questions` | array of object or null | yes |   |   |
| `latest.questions.key` | string | yes |   |   |
| `latest.questions.text` | string | yes |   |   |
| `latest.questions.noteOnYes` | boolean | yes |   |   |
| `latest.how` | `"typed"`, `"drawn"` | yes |   |   |
| `latest.who` | `"participant"`, `"payer"` | yes |   |   |
| `latest.forWhom` | `"everyone"`, `"dependants"` | yes |   |   |
| `latest.askAgainMonths` | number or null | yes |   |   |
| `latest.change` | `"first"`, `"small"`, `"agree_again"` | yes |   |   |
| `latest.effectiveFrom` | string | yes |   |   |
| `latest.publishedAt` | string | yes |   |   |
| `latest.publishedBy` | string | yes |   |   |
| `latest.hash` | string | yes |   |   |
| `latest.intact` | boolean | yes |   | The hash recomputed from the stored content matches: false means tampering |
| `problems` | array of string | yes |   |   |
| `asksAgain` | number | yes |   | How many people "agree again" would ask: those whose acceptance counts now |

## agreement.purgeKept

Platform use only: delete the acceptances kept after an erase whose retention period is over (oldest first, at most a bounded number per call), with their signature, answers and copy record; never one on hold, nor one whose copy the email gatekeeper has still to scrub unless that scrub has been owed for 30 days (those are named in the audit). No input names an acceptance.

|  |  |
| --- | --- |
| Permission | `records:erase` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |
| Also | a host step: never queued for review when the host itself calls it (`hostStep`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `purged` | number | yes |   |   |
| `more` | boolean | yes |   |   |
| `unscrubbed` | array of object | yes |   | Purged although an email gatekeeper that is gone never scrubbed their copy |
| `unscrubbed[].acceptanceId` | string | yes |   |   |
| `unscrubbed[].gatekeepers` | array of string | yes |   | Each `<connection id> <sender key>` gone 30 days that was never scrubbed |

## agreement.recordPaper

Record that a Person signed a version of a document on paper (printed from that version): the name on the form, the date written on it, who signed it for a child (signedBy), a note, and for a health form the answers typed in. Shown everywhere as recorded from paper by you, never as their own acceptance. A person on the staff with agreements:paper only.

|  |  |
| --- | --- |
| Permission | `agreements:paper` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 | Whom it is for (per_…): for a child, the child |
| `versionId` | string | yes | min length 1, max length 64 | The version printed on the form (agv_…) |
| `signedOn` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` | The date written on the form |
| `typedName` | string | yes | min length 1, max length 200 | The name as written on the form |
| `signedBy` | string |   | min length 1, max length 200 | For a child: who signed |
| `note` | string |   | max length 1000 |   |
| `answers` | array of object |   | at least 1, at most 40 | A health form's answers: health information, never shown to an AI or logged |
| `answers[].key` | string | yes | min length 1, max length 40 |   |
| `answers[].yes` | boolean | yes |   |   |
| `answers[].note` | string |   | max length 1000 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `documentId` | string | yes |   |   |
| `versionNumber` | number | yes |   |   |

## agreement.retention

How long an erased person's acceptances are kept as the business's evidence (years, counted from the erase; null when the setting is unreadable, and then nothing is purged), how many are kept now, and how many are on hold. With `years`, also how many kept acceptances that period would make due for deletion at the next daily run. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `years` | integer |   | ≥ 1, ≤ 50 | A period to ask about before setting it |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `years` | number or null | yes |   |   |
| `defaultYears` | number | yes |   |   |
| `kept` | number | yes |   | Acceptances kept after an erase |
| `held` | number | yes |   | Of those, on hold for a dispute or a claim |
| `cutoff` | string or null | yes |   | Erased before this are past the period: the daily cron purges them |
| `purgeableAt` | number or null | yes |   | With `years`: kept acceptances past that period now, not on hold |

## agreement.retire

Retire an agreement document: it is detached everywhere and needed nowhere, its working copy is frozen, and it cannot be published again (write a new document instead). Its versions and the acceptances people made are kept for good. Only a person on the staff with agreements:manage can do this. Audited.

|  |  |
| --- | --- |
| Permission | `agreements:manage` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `documentId` | string | yes | min length 1, max length 64 | The document's id (agd_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"terms"`, `"waiver"`, `"health"`, `"guardian"`, `"other"` | yes |   |   |
| `state` | `"draft"`, `"live"`, `"retired"` | yes |   |   |
| `title` | string | yes |   | The current version's title, or the working copy's before one |
| `current` | object or null | yes |   | The version in effect now |
| `current.id` | string | yes |   |   |
| `current.number` | number | yes |   |   |
| `current.effectiveFrom` | string | yes |   |   |
| `scheduled` | object or null | yes |   | A published version that takes effect later (never for a retired document: it never will) |
| `scheduled.id` | string | yes |   |   |
| `scheduled.number` | number | yes |   |   |
| `scheduled.effectiveFrom` | string | yes |   |   |
| `agreeFrom` | number | yes |   | Acceptances of versions numbered below this stop counting |
| `points` | array of string | yes |   | The agreement points it is attached to |
| `draftUpdatedAt` | string | yes |   |   |
| `retiredAt` | string or null | yes |   |   |

## agreement.setMinor

Mark a Person as a minor, or clear the mark: a parent or guardian agrees for them (or staff record paper), never they themselves, and every document attached anywhere is due as for a child. The host holds no date of birth: clear it when they come of age. A person on the staff with people:link only. Audited.

|  |  |
| --- | --- |
| Permission | `people:link` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 | The Person (per_…) |
| `minor` | boolean | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes |   |   |
| `minor` | boolean | yes |   |   |

## agreement.setRetention

Set how many years an erased person's acceptances are kept (1 to 50, counted from each erase); the daily cron then deletes those past it, except any on hold. A change that makes more kept acceptances due for deletion needs `confirmPurgeable`: the number agreement.retention gives for that period, typed by the person. Admins only, and only a person in the app: AI assistants, MCP clients and automations are refused. Audited, with that number.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `years` | integer | yes | ≥ 1, ≤ 50 | Years an erased person's acceptances are kept, counted from the erase (1 to 50) |
| `confirmPurgeable` | integer |   | ≥ 0, ≤ 9007199254740991 | How many kept acceptances the new period makes due for deletion, as shown |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `years` | number | yes |   |   |
| `previousYears` | number or null | yes |   |   |
| `purgeable` | number | yes |   | Kept acceptances past the new period now, not on hold |

## agreement.takeEffect

Platform use only: make current the scheduled agreement versions whose time has come (the minute cron), as a person published them. No input names a document or a version.

|  |  |
| --- | --- |
| Permission | `agreements:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |
| Also | a host step: never queued for review when the host itself calls it (`hostStep`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `documents` | array of string | yes |   |   |

## agreement.version.get

One published version of an agreement document, exactly as people are shown it: title, body, tick label, questions, how a person agrees, and when it took or takes effect. A version never changes. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The version's id (agv_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `documentId` | string | yes |   |   |
| `number` | number | yes |   |   |
| `title` | string | yes |   |   |
| `body` | any | yes |   |   |
| `tickLabel` | string | yes |   |   |
| `questions` | array of object or null | yes |   |   |
| `questions.key` | string | yes |   |   |
| `questions.text` | string | yes |   |   |
| `questions.noteOnYes` | boolean | yes |   |   |
| `how` | `"typed"`, `"drawn"` | yes |   |   |
| `who` | `"participant"`, `"payer"` | yes |   |   |
| `forWhom` | `"everyone"`, `"dependants"` | yes |   |   |
| `askAgainMonths` | number or null | yes |   |   |
| `change` | `"first"`, `"small"`, `"agree_again"` | yes |   |   |
| `effectiveFrom` | string | yes |   |   |
| `publishedAt` | string | yes |   |   |
| `publishedBy` | string | yes |   |   |
| `hash` | string | yes |   |   |
| `intact` | boolean | yes |   | The hash recomputed from the stored content matches: false means tampering |

## agreement.version.pdf

A version's blank form as a PDF, to print and sign on paper (then agreement.recordPaper): its words, the tick label, a health form's questions with boxes, lines for the name, signature and date, and the version's number and hash at the foot of every page. A person on the staff. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `versionId` | string | yes | min length 1, max length 64 | The version's id (agv_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filename` | string | yes |   | The file name to save it as |
| `document` | object | yes |   | What the signed PDF says; the download route draws it |
| `document.business` | string | yes |   |   |
| `document.title` | string | yes |   |   |
| `document.versionNumber` | number | yes |   |   |
| `document.versionHash` | string | yes |   |   |
| `document.body` | object | yes |   |   |
| `document.body.blocks` | array of any | yes |   |   |
| `document.tickLabel` | string | yes |   |   |
| `document.questions` | array of object |   |   |   |
| `document.questions[].key` | string | yes |   |   |
| `document.questions[].text` | string | yes |   |   |
| `document.answers` | array of object or `"in-app"` or `"withheld"` |   |   |   |
| `document.answers.key` | string | yes |   |   |
| `document.answers.yes` | boolean | yes |   |   |
| `document.answers.note` | string |   |   |   |
| `document.record` | array of object |   |   |   |
| `document.record[].label` | string | yes |   |   |
| `document.record[].value` | string | yes |   |   |
| `document.signature` | object |   |   |   |
| `document.signature.width` | number | yes |   |   |
| `document.signature.height` | number | yes |   |   |
| `document.signature.strokes` | array of array of array of number | yes |   |   |
| `document.acceptanceId` | string |   |   |   |
| `document.blank` | boolean |   |   |   |
