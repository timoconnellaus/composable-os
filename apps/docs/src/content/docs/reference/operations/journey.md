---
title: "journey.* operations"
description: "The core operations named journey.*"
sidebar:
  label: "journey"
editUrl: false
---

## journey.archive

Archive a journey: it stops for good, every entry on it is stopped, and it no longer changes; it cannot be undone. Its versions and log are kept. Sends nothing. A person only: an AI may pause a journey, never archive one. Needs journeys:manage. Audited.

|  |  |
| --- | --- |
| Permission | `journeys:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The journey's id (jny_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `stopped` | number | yes |   | Entries stopped |

## journey.create

Start a new journey as a draft: its name, kind (service: about something the member has or did; promotional: needs the Person's recorded yes, never about a child; fixed once made), and optionally its owner and a first working copy. Nothing is sent and nobody enters until a person publishes it and sets it live. The reply-to must be an address a human admin allowed. The assistant may create one for someone who holds journeys:manage.

|  |  |
| --- | --- |
| Permission | `journeys:manage` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 120 |   |
| `kind` | `"service"`, `"promotional"` | yes |   |   |
| `ownerId` | string or null |   |   |   |
| `definition` | object |   |   |   |
| `definition.entry` | object | yes |   |   |
| `definition.conditions` | array of object |   | at most 5, default `[]` |   |
| `definition.exits` | array of string |   | at most 10, default `[]` | Signals that take a Person off it |
| `definition.reentry` | object |   | default `{"rule":"once"}` |   |
| `definition.includeBulk` | boolean |   | default `false` | Whether a signal from a bulk write (an import, a bulk change) enters anyone |
| `definition.replyTo` | string or null |   | default `null` | Where replies go: one of the addresses a human admin allowed |
| `definition.steps` | array of object | yes | at least 1, at most 40 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `draftRev` | number | yes |   |   |

## journey.enter

Add people to a live journey by hand (one, a selection, or a saved view's people; up to 500 at a time), at its first step on the newest version. Leaves out, and says why, anyone not found or in the trash, a minor on a promotional journey, anyone already on it, and anyone its re-entry rule keeps off. A bulk write: an AI's call waits for review under Balanced, and its entries' messages are held for a person unless a person approved it.

|  |  |
| --- | --- |
| Permission | `journeys:manage` |
| Risk | `bulk-write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The journey's id (jny_…) |
| `personIds` | array of string | yes | at least 1, at most 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `entered` | array of object | yes |   |   |
| `entered[].personId` | string | yes |   |   |
| `entered[].entryId` | string | yes |   |   |
| `excluded` | array of object | yes |   |   |
| `excluded[].personId` | string | yes |   |   |
| `excluded[].why` | `"not_found"`, `"minor"`, `"erased_address"`, `"already_on"`, `"once"`, `"too_soon"` | yes |   |   |

## journey.entries

The entries of a journey (journeyId) or of a Person (personId): who is on it, at which step, when they are next looked at, how they entered and whether they finished or were stopped. A Person's entries for anyone who reads the Person; a journey's for journeys:read. Newest first, at most 100. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `journeyId` | string |   | min length 1, max length 64 | The journey's id (jny_…) |
| `personId` | string |   | min length 1, max length 64 |   |
| `state` | `"active"`, `"waiting"`, `"held"`, `"finished"`, `"stopped"` |   |   |   |
| `limit` | integer |   | ≥ 1, ≤ 100, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].journeyId` | string | yes |   |   |
| `items[].journeyName` | string | yes |   |   |
| `items[].versionNumber` | number | yes |   |   |
| `items[].personId` | string | yes |   |   |
| `items[].state` | `"active"`, `"waiting"`, `"held"`, `"finished"`, `"stopped"` | yes |   |   |
| `items[].step` | string | yes |   |   |
| `items[].nextAt` | string or null | yes |   |   |
| `items[].enteredAt` | string | yes |   |   |
| `items[].enteredBy` | `"signal"`, `"scan"`, `"birthday"`, `"person"` | yes |   |   |
| `items[].causeStanding` | `"person"`, `"host"`, `"ai"` | yes |   |   |
| `items[].endedAt` | string or null | yes |   |   |
| `items[].stoppedBy` | string or null | yes |   |   |
| `items[].stopReason` | string or null | yes |   |   |

## journey.get

One journey: its summary, the working copy (entry rule, conditions, exits, re-entry rule, reply-to and steps with their words), its rev and hash, whether an AI wrote it since the last publish, what stops it from being published, the plain-words summary, and its versions, newest first, without their steps (journey.version reads one). Read-only.

|  |  |
| --- | --- |
| Permission | `journeys:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The journey's id (jny_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `kind` | `"service"`, `"promotional"` | yes |   |   |
| `status` | `"draft"`, `"live"`, `"paused"`, `"archived"` | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `starter` | string or null | yes |   | The starter the host seeded it from, if any |
| `current` | object or null | yes |   | The newest published version: new entries start on it |
| `current.id` | string | yes |   |   |
| `current.number` | number | yes |   |   |
| `unpublishedChanges` | boolean | yes |   | The working copy differs from the newest version |
| `counts` | object | yes |   | Entries by state |
| `counts.active` | number | yes |   |   |
| `counts.waiting` | number | yes |   |   |
| `counts.held` | number | yes |   |   |
| `counts.finished` | number | yes |   |   |
| `counts.stopped` | number | yes |   |   |
| `draftUpdatedAt` | string | yes |   |   |
| `draft` | any | yes |   | The working copy (null when it cannot be read) |
| `draftRev` | number | yes |   |   |
| `draftHash` | string | yes |   |   |
| `draftUpdatedBy` | string | yes |   |   |
| `draftUpdatedVia` | string | yes |   |   |
| `draftedByAssistant` | boolean | yes |   | An AI wrote the working copy since the last publish |
| `problems` | array of object | yes |   | Why it cannot be published yet (empty: it can) |
| `problems[].path` | string | yes |   |   |
| `problems[].message` | string | yes |   |   |
| `summary` | string or null | yes |   | The working copy in plain words |
| `versions` | array of object | yes |   |   |
| `versions[].id` | string | yes |   |   |
| `versions[].journeyId` | string | yes |   |   |
| `versions[].number` | number | yes |   |   |
| `versions[].hash` | string | yes |   |   |
| `versions[].intact` | boolean | yes |   | The hash recomputed from the stored definition matches |
| `versions[].draftedBy` | `"person"`, `"assistant"` | yes |   |   |
| `versions[].publishedAt` | string | yes |   |   |
| `versions[].publishedBy` | string | yes |   |   |
| `versions[].requestedBy` | string or null | yes |   |   |
| `versions[].requestedVia` | string or null | yes |   |   |

## journey.goLive

Set a published journey live: from now on, people who meet its entry rule enter it (nobody who already qualified before is added; add them with journey.enter if you choose). Every signal it names must be one an installed pack declares. A person only: an AI may never set a journey live. Needs journeys:manage. Audited.

|  |  |
| --- | --- |
| Permission | `journeys:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The journey's id (jny_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `status` | `"draft"`, `"live"`, `"paused"`, `"archived"` | yes |   |   |

## journey.list

List the business's journeys (messages that go out on their own to one person at a time: a welcome series, a nudge when someone stops coming): each with its kind (service or promotional), status (draft, live, paused, archived), newest published version, whether the working copy has unpublished changes, and how many entries are active, waiting, held, finished and stopped. The four starter journeys are seeded as drafts. 100 a page (nextCursor). Read-only.

|  |  |
| --- | --- |
| Permission | `journeys:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `archived` | boolean |   | default `false` | Include archived journeys |
| `cursor` | string |   | max length 200 | The previous page's nextCursor |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].kind` | `"service"`, `"promotional"` | yes |   |   |
| `items[].status` | `"draft"`, `"live"`, `"paused"`, `"archived"` | yes |   |   |
| `items[].ownerId` | string or null | yes |   |   |
| `items[].starter` | string or null | yes |   | The starter the host seeded it from, if any |
| `items[].current` | object or null | yes |   | The newest published version: new entries start on it |
| `items[].current.id` | string | yes |   |   |
| `items[].current.number` | number | yes |   |   |
| `items[].unpublishedChanges` | boolean | yes |   | The working copy differs from the newest version |
| `items[].counts` | object | yes |   | Entries by state |
| `items[].counts.active` | number | yes |   |   |
| `items[].counts.waiting` | number | yes |   |   |
| `items[].counts.held` | number | yes |   |   |
| `items[].counts.finished` | number | yes |   |   |
| `items[].counts.stopped` | number | yes |   |   |
| `items[].draftUpdatedAt` | string | yes |   |   |
| `nextCursor` | string or null | yes |   | Pass it back for the next page; null: no more |

## journey.log

What happened at each step of one journey entry, in order: entered, sent (with the message row), held, skipped and why, waited until, the branch taken, the task made. Never the words: the message log keeps what it keeps. For journeys:read, or anyone who reads the Person when they name them. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `entryId` | string | yes | min length 1, max length 64 |   |
| `personId` | string |   | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].step` | string | yes |   |   |
| `items[].at` | string | yes |   |   |
| `items[].what` | string | yes |   |   |
| `items[].detail` | any | yes |   |   |

## journey.pause

Pause a live journey: nobody enters it and its entries wait where they are until a person resumes it. The assistant may pause one. Sends nothing.

|  |  |
| --- | --- |
| Permission | `journeys:manage` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The journey's id (jny_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `status` | `"draft"`, `"live"`, `"paused"`, `"archived"` | yes |   |   |

## journey.preview

Render every message of a journey for a sample Person, as the publish dialog shows them: the working copy (or a published version by number), each send step's subject and body filled in for the Person (and, where the step has one, the guardian's version), with what would hold a message for a person; the plain-words summary; what stops it from being published; whether an AI drafted it; and the draftHash, draftRev and number to pass to journey.publish. personId left out: sample values. Sends nothing. Read-only.

|  |  |
| --- | --- |
| Permission | `journeys:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The journey's id (jny_…) |
| `version` | integer |   | ≥ 1, ≤ 9007199254740991 | A published version's number |
| `personId` | string |   | min length 1, max length 64 | The sample Person (per_…) |
| `record` | object |   |   | A sample record for {record} (the record whose signal started the entry) |
| `record.object` | string | yes | min length 1, max length 80 |   |
| `record.id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `number` | number | yes |   | The version a publish now would make, or the one shown |
| `draftHash` | string or null | yes |   |   |
| `draftRev` | number or null | yes |   |   |
| `draftedByAssistant` | boolean | yes |   |   |
| `summary` | string | yes |   |   |
| `problems` | array of object | yes |   |   |
| `problems[].path` | string | yes |   |   |
| `problems[].message` | string | yes |   |   |
| `person` | object or null | yes |   |   |
| `person.id` | string | yes |   |   |
| `person.name` | string | yes |   |   |
| `messages` | array of object | yes |   |   |
| `messages[].step` | string | yes |   |   |
| `messages[].position` | number | yes |   |   |
| `messages[].member` | object | yes |   |   |
| `messages[].member.subject` | string | yes |   |   |
| `messages[].member.body` | string | yes |   |   |
| `messages[].member.holds` | array of string | yes |   | Why this message would be held for a person (empty: none) |
| `messages[].guardian` | object or null | yes |   |   |
| `messages[].guardian.subject` | string | yes |   |   |
| `messages[].guardian.body` | string | yes |   |   |
| `messages[].guardian.holds` | array of string | yes |   | Why this message would be held for a person (empty: none) |

## journey.publish

Publish a journey's working copy as its next version: the approval of its wording. Only a published version runs, and its messages then go out without anyone approving each send (once a human admin turned journeys on). draftHash, draftRev and number are journey.preview's: a copy changed since is refused. moveEntries moves people already on it to the new version where their step is still in it; otherwise they carry on with the version they started on. Needs journeys:publish. An AI's call (the assistant, an MCP client) is a request that always waits for a person who holds journeys:publish; the adjudicator never approves one. Audited.

|  |  |
| --- | --- |
| Permission | `journeys:publish` |
| Risk | `write` |
| Audiences | `staff` |
| Also | always reviewed when called by `assistant`, `mcp`, `automation`, `extension` (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The journey's id (jny_…) |
| `draftHash` | string | yes | pattern `^[0-9a-f]{64}$` |   |
| `draftRev` | integer | yes | ≥ 0, ≤ 9007199254740991 |   |
| `number` | integer | yes | ≥ 1, ≤ 9007199254740991 | The version number the preview showed |
| `moveEntries` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `version` | object | yes |   |   |
| `version.id` | string | yes |   |   |
| `version.journeyId` | string | yes |   |   |
| `version.number` | number | yes |   |   |
| `version.definition` | any | yes |   |   |
| `version.summary` | string | yes |   |   |
| `version.hash` | string | yes |   |   |
| `version.intact` | boolean | yes |   | The hash recomputed from the stored definition matches |
| `version.draftedBy` | `"person"`, `"assistant"` | yes |   |   |
| `version.publishedAt` | string | yes |   |   |
| `version.publishedBy` | string | yes |   |   |
| `version.requestedBy` | string or null | yes |   |   |
| `version.requestedVia` | string or null | yes |   |   |
| `moved` | number | yes |   |   |

## journey.resume

Resume a paused journey: its entries carry on and people enter it again. A person only: an AI may never resume one. Needs journeys:manage. Audited.

|  |  |
| --- | --- |
| Permission | `journeys:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The journey's id (jny_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `status` | `"draft"`, `"live"`, `"paused"`, `"archived"` | yes |   |   |

## journey.settings

Journeys' settings: whether journeys send on their own (off until a human admin turns it on), the cap per Person (at most 3 a week and 1 a day), and the addresses a journey's replies may go to (staff accounts' addresses: for those who write journeys). Read-only.

|  |  |
| --- | --- |
| Permission | `journeys:manage` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sendOnOwn` | boolean | yes |   | Journeys send on their own (off on deploy until a human admin turns it on) |
| `weekCap` | number | yes |   | Journey messages a Person gets in 7 days, across journeys |
| `dayCap` | number | yes |   | Journey messages a Person gets in a day (fixed at 1) |
| `replyTo` | array of object | yes |   |   |
| `replyTo[].address` | string | yes |   |   |
| `replyTo[].userId` | string | yes |   |   |
| `replyTo[].current` | boolean | yes |   | The account still has this address and is active |

## journey.settings.update

Change journeys' settings: whether they send on their own, the weekly cap (1 to 3), and which staff accounts' addresses a journey's replies may go to (replyToUserIds, given whole). A human admin only, never an AI, not on MCP. Audited.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sendOnOwn` | boolean |   |   |   |
| `weekCap` | integer |   | ≥ 1, ≤ 3 |   |
| `replyToUserIds` | array of string |   | at most 50 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sendOnOwn` | boolean | yes |   | Journeys send on their own (off on deploy until a human admin turns it on) |
| `weekCap` | number | yes |   | Journey messages a Person gets in 7 days, across journeys |
| `dayCap` | number | yes |   | Journey messages a Person gets in a day (fixed at 1) |
| `replyTo` | array of object | yes |   |   |
| `replyTo[].address` | string | yes |   |   |
| `replyTo[].userId` | string | yes |   |   |
| `replyTo[].current` | boolean | yes |   | The account still has this address and is active |

## journey.stop

Stop a Person's journey: one entry (entryId), or every journey they are on (personId, optionally only journeyId's). They get nothing more from it; what was sent stays in the log. Anyone who may update the Person; the assistant may stop one.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `entryId` | string |   | min length 1, max length 64 |   |
| `personId` | string |   | min length 1, max length 64 |   |
| `journeyId` | string |   | min length 1, max length 64 | The journey's id (jny_…) |
| `reason` | string |   | max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `stopped` | array of string | yes |   | The entries stopped |

## journey.update

Change a journey: its name, its owner (who gets tasks assigned to the owner; a person only), or its working copy, given whole: entry rule, conditions, exits, re-entry rule, includeBulk, the reply-to (an address a human admin allowed) and the steps (send, wait, branch, task, end) with their words. It changes no published version and sends nothing: a person publishes. draftRev, when given, is the copy's rev the change was made against: a copy saved since is refused. The assistant may write it for someone who holds journeys:manage; the publish dialog then says it was drafted by the assistant.

|  |  |
| --- | --- |
| Permission | `journeys:manage` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The journey's id (jny_…) |
| `draftRev` | integer |   | ≥ 0, ≤ 9007199254740991 |   |
| `name` | string |   | min length 1, max length 120 |   |
| `ownerId` | string or null |   |   |   |
| `definition` | object |   |   |   |
| `definition.entry` | object | yes |   |   |
| `definition.conditions` | array of object |   | at most 5, default `[]` |   |
| `definition.exits` | array of string |   | at most 10, default `[]` | Signals that take a Person off it |
| `definition.reentry` | object |   | default `{"rule":"once"}` |   |
| `definition.includeBulk` | boolean |   | default `false` | Whether a signal from a bulk write (an import, a bulk change) enters anyone |
| `definition.replyTo` | string or null |   | default `null` | Where replies go: one of the addresses a human admin allowed |
| `definition.steps` | array of object | yes | at least 1, at most 40 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `draftRev` | number | yes |   |   |
| `draftHash` | string | yes |   |   |

## journey.version

One published version of a journey, exactly as it runs: its steps and words, the plain-words summary its publisher was shown, who published it (and, for an AI's request, who asked), and whether an AI drafted it. A version never changes. Read-only.

|  |  |
| --- | --- |
| Permission | `journeys:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The version's id (jnv_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `journeyId` | string | yes |   |   |
| `number` | number | yes |   |   |
| `definition` | any | yes |   |   |
| `summary` | string | yes |   |   |
| `hash` | string | yes |   |   |
| `intact` | boolean | yes |   | The hash recomputed from the stored definition matches |
| `draftedBy` | `"person"`, `"assistant"` | yes |   |   |
| `publishedAt` | string | yes |   |   |
| `publishedBy` | string | yes |   |   |
| `requestedBy` | string or null | yes |   |   |
| `requestedVia` | string or null | yes |   |   |
