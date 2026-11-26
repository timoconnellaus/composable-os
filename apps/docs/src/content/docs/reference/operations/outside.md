---
title: "outside.* operations"
description: "The core operations named outside.*"
sidebar:
  label: "outside"
editUrl: false
---

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

Remove the booking system's copy: the current members list (its outside people, their memberships and passes, membership types, links and To match), the timetable list (classes, class types, bookings, coaches and their To match), or all of it, which is what disconnecting the booking system means for a loaded list. The list stops counting at once and its rows are deleted at once, 2000 a statement and at most 200000 a call: when done is false, call again for the rest (nothing reads it meanwhile). Kept: the settings, the lists' log (counts only, 30 days), erased people's suppressions (so no later list brings them back), staff's unlink decisions (a hash, no person) and the timeline. Nothing is written to the booking system. A person with bookingSystem:manage only, never an AI, an MCP client, an extension or an automation.

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
