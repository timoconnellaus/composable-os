---
title: "outside.* operations"
description: "The core operations named outside.*"
sidebar:
  label: "outside"
editUrl: false
---

## outside.file.load

Load a list exported from the booking system, as its dry run showed: the same file, mapping and export date, and the dry run's fingerprint. The host plans again and refuses, writing nothing, unless the plan is the one the dry run showed (the file, the copy, an erase or a Person's address changed since). The list replaces the current one of its kind in one batch: rows not in the new file go, with their links and matches; nothing of an erased person is kept. The mapping is saved for the next export of the same shape. The file itself is not kept; the audit records counts only. A person with bookingSystem:manage only, never an AI, an MCP client, Code Mode, an extension or an automation.

|  |  |
| --- | --- |
| Permission | `bookingSystem:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"members"`, `"timetable"` | yes |   | members (people and their memberships and passes) or timetable |
| `file` | string | yes | min length 1, max length 13333340 | The exported file's bytes, base64 (at most 10 MB): CSV, semicolon or tab separated, in UTF-8, UTF-16 or Windows-1252, read by its content |
| `mapping` | object |   |   | Omit to use the saved mapping (when the file has its columns) or the suggestion |
| `mapping.columns` | map of string | yes |   | Field → the column header that holds it, e.g. { email: "E-mail" } |
| `mapping.values` | map of map of string |   |   | The export's own words for values, per value map: members' memberStatus, membershipStatus, membershipKind, membershipType (a plan's name → membership or pass); timetable's bookingState |
| `mapping.dateFormat` | `"YYYY-MM-DD"`, `"DD/MM/YYYY"`, `"MM/DD/YYYY"` |   |   |   |
| `exportedOn` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | The date the file was exported (what the list's age counts from); default today |
| `fingerprint` | string | yes | min length 1, max length 200 | The dry run's fingerprint |
| `saveMapping` | boolean |   |   | Default true: save the mapping for next time |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"members"`, `"timetable"` | yes |   |   |
| `exportedOn` | string | yes |   |   |
| `rows` | object | yes |   |   |
| `rows.read` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `rows.refused` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `issueCount` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome` | object | yes |   |   |
| `outcome.changes` | object | yes |   | People (members) or classes (timetable) against the current list |
| `outcome.changes.new` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.changes.changed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.changes.unchanged` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.changes.removed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | In the current list and not in this file: they go |
| `outcome.kept` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.notKept` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Not a member, no live pass, not booked, not staff-linked |
| `outcome.dropped` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Of an erased person: nothing of them is kept |
| `outcome.previouslyErased` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Of those, dropped by a ref an erase suppressed |
| `outcome.linked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.links` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.toMatch` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.unlinked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.items` | map of integer | yes |   |   |

## outside.file.preview

The dry run of a list exported from the booking system: decodes the file by its content, maps its columns (the given mapping, else the saved one, else a suggestion from the headers), and says what the load would do against the current list (new, changed, unchanged, removed; not kept; dropped because the person was erased; who would link by address and who would wait in To match) and every refused row with why. Writes nothing and keeps nothing of the file. Pass its fingerprint, with the same file, mapping and export date, to outside.file.load. A person with bookingSystem:manage only, never an AI.

|  |  |
| --- | --- |
| Permission | `bookingSystem:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"members"`, `"timetable"` | yes |   | members (people and their memberships and passes) or timetable |
| `file` | string | yes | min length 1, max length 13333340 | The exported file's bytes, base64 (at most 10 MB): CSV, semicolon or tab separated, in UTF-8, UTF-16 or Windows-1252, read by its content |
| `mapping` | object |   |   | Omit to use the saved mapping (when the file has its columns) or the suggestion |
| `mapping.columns` | map of string | yes |   | Field → the column header that holds it, e.g. { email: "E-mail" } |
| `mapping.values` | map of map of string |   |   | The export's own words for values, per value map: members' memberStatus, membershipStatus, membershipKind, membershipType (a plan's name → membership or pass); timetable's bookingState |
| `mapping.dateFormat` | `"YYYY-MM-DD"`, `"DD/MM/YYYY"`, `"MM/DD/YYYY"` |   |   |   |
| `exportedOn` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | The date the file was exported (what the list's age counts from); default today |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"members"`, `"timetable"` | yes |   |   |
| `ready` | boolean | yes |   | False when a required field has no column: map it and ask again |
| `missing` | array of string | yes |   |   |
| `headers` | array of string | yes |   |   |
| `mapping` | object | yes |   |   |
| `mapping.columns` | map of string | yes |   |   |
| `mapping.values` | map of map of string |   |   |   |
| `mapping.dateFormat` | `"YYYY-MM-DD"`, `"DD/MM/YYYY"`, `"MM/DD/YYYY"` |   |   |   |
| `mappingFrom` | `"given"`, `"saved"`, `"suggested"` | yes |   |   |
| `suggested` | object | yes |   |   |
| `suggested.columns` | map of string | yes |   |   |
| `suggested.values` | map of map of string |   |   |   |
| `suggested.dateFormat` | `"YYYY-MM-DD"`, `"DD/MM/YYYY"`, `"MM/DD/YYYY"` |   |   |   |
| `encoding` | `"utf-8"`, `"utf-16le"`, `"utf-16be"`, `"windows-1252"` | yes |   |   |
| `exportedOn` | string | yes |   |   |
| `rows` | object | yes |   |   |
| `rows.read` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `rows.refused` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `issueCount` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `issues` | array of object | yes |   |   |
| `issues[].file` | `"people"`, `"timetable"` | yes |   |   |
| `issues[].row` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `issues[].column` | string |   |   |   |
| `issues[].problem` | string | yes |   |   |
| `formulaLike` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Cells kept as text that start as a formula would |
| `outcome` | object | yes |   |   |
| `outcome.changes` | object | yes |   | People (members) or classes (timetable) against the current list |
| `outcome.changes.new` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.changes.changed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.changes.unchanged` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.changes.removed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | In the current list and not in this file: they go |
| `outcome.kept` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.notKept` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Not a member, no live pass, not booked, not staff-linked |
| `outcome.dropped` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Of an erased person: nothing of them is kept |
| `outcome.previouslyErased` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Of those, dropped by a ref an erase suppressed |
| `outcome.linked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.links` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.toMatch` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.unlinked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `outcome.items` | map of integer | yes |   |   |
| `linking` | array of object | yes |   |   |
| `linking[].ref` | string | yes |   |   |
| `linking[].name` | string | yes |   |   |
| `linking[].to` | string | yes |   |   |
| `waiting` | array of object | yes |   |   |
| `waiting[].ref` | string | yes |   |   |
| `waiting[].name` | string | yes |   |   |
| `waiting[].why` | string | yes |   |   |
| `statements` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `fingerprint` | string | yes |   |   |

## outside.link

Link an outside person from the members list to a Person, or a coach from the timetable list to a staff account, by hand, with why. A link made by a person is kept across loads by ref, whatever the address. It changes nothing on the Person: no name, address or phone, no customer account, nothing sent. Removes them from To match. A person with bookingSystem:manage only, never an AI.

|  |  |
| --- | --- |
| Permission | `bookingSystem:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"person"`, `"staff"` | yes |   |   |
| `linkedTo` | string | yes |   |   |

## outside.lists.remove

Remove the booking system's copy: the current members list (its outside people, their memberships and passes, membership types, links and To match), the timetable list (classes, class types, bookings, coaches and their To match), or all of it, which is what disconnecting the booking system means for a loaded list. The list stops counting at once and its rows are deleted at once, 2000 a statement and at most 200000 a call: when done is false, the daily maintenance finishes the rest, or call again with finish: true (nothing reads it meanwhile, and a list loaded since is never touched). Kept: the settings, the lists' log (counts only, 30 days), erased people's suppressions (so no later list brings them back), staff's unlink decisions (a hash, no person) and the timeline. Nothing is written to the booking system. A person with bookingSystem:manage only, never an AI, an MCP client, an extension or an automation.

|  |  |
| --- | --- |
| Permission | `bookingSystem:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"members"`, `"timetable"`, `"all"` | yes |   | members, timetable, or all (disconnect the booking system's lists) |
| `finish` | boolean |   |   | Only finish a removal already made (after done: false): removes no current list, so a list loaded since stays |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `removed` | array of `"members"`, `"timetable"` | yes |   | The kinds whose current list was removed |
| `rows` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Rows of the copy deleted by this call |
| `remaining` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Rows left for the next call; 0 when done |
| `done` | boolean | yes |   |   |

## outside.matches

To match: the outside people and coaches the host could not link by address, each with why (several_people: more than one Person or staff account has the address; shared_address: several outside people share it, as a family on one mailbox; no_address: the list gives none) and the candidates (Persons, or staff accounts) to choose from. Nobody is linked until a person links them with outside.link. Paged by ref. Needs bookingSystem:manage.

|  |  |
| --- | --- |
| Permission | `bookingSystem:manage` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"person"`, `"staff"` |   |   | Only people, or only coaches |
| `after` | string |   | max length 700 | The `next` of the page before |
| `limit` | integer |   | ≥ 1, ≤ 50 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `matches` | array of object | yes |   |   |
| `matches[].kind` | `"person"`, `"staff"` | yes |   |   |
| `matches[].ref` | string | yes |   |   |
| `matches[].name` | string | yes |   |   |
| `matches[].address` | string or null | yes |   |   |
| `matches[].why` | `"several_people"`, `"shared_address"`, `"no_address"` | yes |   |   |
| `matches[].candidates` | array of object | yes |   |   |
| `matches[].candidates[].id` | string | yes |   |   |
| `matches[].candidates[].name` | string | yes |   |   |
| `matches[].since` | string | yes |   |   |
| `next` | string or null | yes |   |   |

## outside.settings.get

Read the booking-system settings: whether the copy is on, which outside membership and pass types make a Person a member (by default every membership, no pass), the business's links (where a member manages their membership, where to book a class) and the largest age a members list counts for; and the membership types the current members list holds, each marked whether it counts. Needs bookingSystem:manage.

|  |  |
| --- | --- |
| Permission | `bookingSystem:manage` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `source` | `"file"` | yes |   |   |
| `enabled` | boolean | yes |   | Off: the copy is kept and nothing reads it |
| `memberTypes` | array of string or null | yes |   | The outside membership and pass types that make a Person a member; null: every type of kind membership, no pass |
| `manageUrl` | string or null | yes |   | Where a member manages their membership |
| `bookUrl` | string or null | yes |   | Where to book a class |
| `largestAgeDays` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | A members list counts for this many days |
| `updatedAt` | string or null | yes |   |   |
| `types` | array of object | yes |   |   |
| `types[].ref` | string | yes |   |   |
| `types[].name` | string | yes |   |   |
| `types[].kind` | `"membership"`, `"pass"` | yes |   |   |
| `types[].active` | boolean | yes |   |   |
| `types[].counts` | boolean | yes |   | It makes a Person a member |
| `mappings` | map of any | yes |   | The column mapping and value maps saved by the last load of each kind |

## outside.settings.update

Change the booking-system settings: on or off, the outside types that make a Person a member (null for the default: every membership type, no pass), the two links (each an https address, or null), and the largest age a members list counts for (1 to 90 days). Leave a setting out to keep it. A human admin in the app only.

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
| `enabled` | boolean |   |   |   |
| `memberTypes` | array of string or null |   |   |   |
| `manageUrl` | string or null |   |   |   |
| `bookUrl` | string or null |   |   |   |
| `largestAgeDays` | integer |   | ≥ 1, ≤ 90 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `source` | `"file"` | yes |   |   |
| `enabled` | boolean | yes |   | Off: the copy is kept and nothing reads it |
| `memberTypes` | array of string or null | yes |   | The outside membership and pass types that make a Person a member; null: every type of kind membership, no pass |
| `manageUrl` | string or null | yes |   | Where a member manages their membership |
| `bookUrl` | string or null | yes |   | Where to book a class |
| `largestAgeDays` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | A members list counts for this many days |
| `updatedAt` | string or null | yes |   |   |

## outside.status

The state of the booking system's copy: the current members and timetable lists (each with the date its file was exported, its age, when and by whom it was loaded, rows read, refused and kept, and for a members list whether it is too old to count), how many outside people are kept and linked, and how many people and coaches wait in To match. With no list loaded every count is 0. Counts and dates only, no names. Needs bookingSystem:manage.

|  |  |
| --- | --- |
| Permission | `bookingSystem:manage` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | yes |   |   |
| `largestAgeDays` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `today` | string | yes |   |   |
| `lists` | array of object | yes |   |   |
| `lists[].kind` | `"members"`, `"timetable"` | yes |   |   |
| `lists[].exportedOn` | string | yes |   | The date the list's file was exported, YYYY-MM-DD |
| `lists[].loadedAt` | string | yes |   |   |
| `lists[].loadedBy` | string | yes |   |   |
| `lists[].loadedByName` | string or null | yes |   |   |
| `lists[].rows` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `lists[].refused` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `lists[].kept` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `lists[].ageDays` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Days since it was exported |
| `lists[].countsUntil` | string | yes |   | A members list's last day counting |
| `lists[].tooOld` | boolean | yes |   | A members list past the largest age: shown, and counts no more |
| `counts` | object | yes |   |   |
| `counts.people` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `counts.linked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `counts.memberships` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `counts.classes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `counts.bookings` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `counts.staff` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `counts.staffLinked` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `counts.waitingPeople` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `counts.waitingStaff` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## outside.suppression.lift

Lift the suppression of an outside ref an erase left: when the booking system has given an erased person's old ref to someone new, every load drops that ref (counted as previously erased) until a person lifts it. The new person is then kept and matched as anyone is. The erased person's addresses stay suppressed. This undoes an erase's protection for that ref: if the booking system still lists the erased person under it, they come back. Needs both bookingSystem:manage and records:erase (the erase's own permission), a person only, never an AI, an MCP client, an extension or an automation.

|  |  |
| --- | --- |
| Permission | `bookingSystem:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"person"`, `"staff"` | yes |   |   |
| `ref` | string | yes | min length 1, max length 600 | The outside person's or coach's ref, as listed |
| `why` | string | yes | min length 1, max length 500 | Why: kept with the link and audited |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lifted` | boolean | yes |   |   |

## outside.unlink

Unlink an outside person or coach, with why: they stay in the copy linked to nobody while they count (a member, a live pass, booked), and the host never links them by address again (the decision is kept by ref across loads) until a person links them with outside.link. Removes them from To match. A person with bookingSystem:manage only, never an AI.

|  |  |
| --- | --- |
| Permission | `bookingSystem:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"person"`, `"staff"` | yes |   |   |
| `ref` | string | yes | min length 1, max length 600 | The outside person's or coach's ref, as listed |
| `why` | string | yes | min length 1, max length 500 | Why: kept with the link and audited |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `kind` | `"person"`, `"staff"` | yes |   |   |
| `unlinked` | boolean | yes |   |   |
