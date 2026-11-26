---
title: "person.* operations"
description: "The core operations named person.*"
sidebar:
  label: "person"
editUrl: false
---

## person.changeJob

Record that a person changed jobs: their current primary affiliation ends (it stays in their job history), a new current affiliation at organisationId starts and becomes primary, so their job title and organisation follow it. Posts a 'Job change' system activity on the person's, the old organisation's and the new organisation's timelines. Works for a promotion within the same organisation too. Returns the person, the ended and the started affiliation.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string (starts_with) | yes | max length 64, pattern `^per_.*` | Person id (per_…) |
| `organisationId` | string (starts_with) | yes | max length 64, pattern `^org_.*` | The new organisation |
| `title` | string or null |   |   | The new job title |
| `role` | string or null |   |   | Role in the relationship, e.g. Decision maker |
| `startedOn` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | Start of the new job; default today |
| `previousEndedOn` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | End of the previous job; default the new start date |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `person` | object | yes |   |   |
| `person.id` | string | yes |   |   |
| `person.displayName` | string | yes |   |   |
| `person.givenName` | string or null | yes |   |   |
| `person.familyName` | string or null | yes |   |   |
| `person.emails` | array of object | yes |   |   |
| `person.emails[].email` | string | yes |   |   |
| `person.emails[].label` | string or null | yes |   |   |
| `person.emails[].primary` | boolean | yes |   |   |
| `person.phones` | array of object | yes |   |   |
| `person.phones[].number` | string | yes |   |   |
| `person.phones[].label` | string or null | yes |   |   |
| `person.phones[].primary` | boolean | yes |   |   |
| `person.location` | string or null | yes |   |   |
| `person.timezone` | string or null | yes |   |   |
| `person.socialProfiles` | array of object | yes |   |   |
| `person.socialProfiles[].network` | string | yes | min length 1, max length 50 | e.g. linkedin, x, github |
| `person.socialProfiles[].url` | string (uri) | yes | max length 500 |   |
| `person.socialProfiles[].handle` | string |   | max length 100 |   |
| `person.avatarKey` | string or null | yes |   |   |
| `person.ownerId` | string or null | yes |   |   |
| `person.description` | string or null | yes |   |   |
| `person.tags` | array of string | yes |   |   |
| `person.birthday` | object or null | yes |   |   |
| `person.birthday.day` | integer | yes | ≥ 1, ≤ 31 | Day of the month, 1 to 31 |
| `person.birthday.month` | integer | yes | ≥ 1, ≤ 12 | Month, 1 (January) to 12 (December) |
| `person.jobTitle` | string or null | yes |   |   |
| `person.primaryAffiliation` | object or null | yes |   |   |
| `person.primaryAffiliation.id` | string | yes |   |   |
| `person.primaryAffiliation.organisationId` | string | yes |   |   |
| `person.primaryAffiliation.organisationName` | string or null | yes |   |   |
| `person.primaryAffiliation.title` | string or null | yes |   |   |
| `person.createdAt` | string | yes |   |   |
| `person.createdBy` | string or null | yes |   |   |
| `person.updatedAt` | string | yes |   |   |
| `person.deletedAt` | string or null | yes |   |   |
| `person.mergedIntoId` | string or null | yes |   |   |
| `ended` | object or null | yes |   |   |
| `ended.id` | string | yes |   |   |
| `ended.personId` | string | yes |   |   |
| `ended.personName` | string or null | yes |   |   |
| `ended.organisationId` | string | yes |   |   |
| `ended.organisationName` | string or null | yes |   |   |
| `ended.title` | string or null | yes |   | Job title |
| `ended.role` | string or null | yes |   | Role in the relationship, e.g. Decision maker |
| `ended.startedOn` | string or null | yes |   |   |
| `ended.endedOn` | string or null | yes |   |   |
| `ended.current` | boolean | yes |   |   |
| `ended.primary` | boolean | yes |   |   |
| `ended.createdAt` | string | yes |   |   |
| `ended.updatedAt` | string | yes |   |   |
| `started` | object | yes |   |   |
| `started.id` | string | yes |   |   |
| `started.personId` | string | yes |   |   |
| `started.personName` | string or null | yes |   |   |
| `started.organisationId` | string | yes |   |   |
| `started.organisationName` | string or null | yes |   |   |
| `started.title` | string or null | yes |   | Job title |
| `started.role` | string or null | yes |   | Role in the relationship, e.g. Decision maker |
| `started.startedOn` | string or null | yes |   |   |
| `started.endedOn` | string or null | yes |   |   |
| `started.current` | boolean | yes |   |   |
| `started.primary` | boolean | yes |   |   |
| `started.createdAt` | string | yes |   |   |
| `started.updatedAt` | string | yes |   |   |
| `activityId` | string | yes |   |   |

## person.contact.record

Records a member's contact choice they gave by phone or on paper: a kind of message, a channel and on or off (news_and_offers: yes or no, with the words they agreed to). Says why. A person only, never an AI. It cannot turn back on what the member stopped themselves.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 |   |
| `choices` | array of object | yes | at least 1, at most 40 |   |
| `choices[].scope` | string | yes | min length 1, max length 80 | A kind of message: a routine message kind (bookings.reminder), follow_up, or news_and_offers |
| `choices[].channel` | `"email"`, `"text"`, `"push"` | yes |   |   |
| `choices[].value` | `"on"`, `"off"`, `"yes"`, `"no"` | yes |   | on or off; for news_and_offers, yes or no |
| `how` | `"staff_on_request"`, `"staff_from_paper"` | yes |   | They asked (by phone, at the desk), or on a paper form |
| `reason` | string | yes | min length 3, max length 500 | Why, in a few words |
| `wording` | string |   | max length 1000 | For a yes to news and offers: the words they agreed to |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `changed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## person.create

Create a person (a contact) with optional names, emails, phones, location, owner, tags and description. Use it after checking with person.list or search that the person does not already exist: emails must be unique across live people, and a taken email fails with a conflict. Returns the created person. Unknown tags are created. Check possibleDuplicates in the result: existing people this one may duplicate by plain rules (same name and organisation, same name and email domain, same phone number, same name only), each with its reason. If one is the same person, merge them with person.merge.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `givenName` | string or null |   |   |   |
| `familyName` | string or null |   |   |   |
| `displayName` | string |   | min length 1, max length 200 | Shown name. Defaults to given + family name, or the primary email. |
| `emails` | array of object |   | at most 20 |   |
| `emails[].email` | string | yes |   |   |
| `emails[].label` | string or null |   |   | e.g. work, personal |
| `emails[].primary` | boolean |   |   | Exactly one email is primary; default the first. |
| `phones` | array of object |   | at most 20 |   |
| `phones[].number` | string | yes | min length 1, max length 50 |   |
| `phones[].label` | string or null |   |   | e.g. mobile, work |
| `phones[].primary` | boolean |   |   | Exactly one phone is primary; default the first. |
| `location` | string or null |   |   | Free text, e.g. 'Sydney, Australia' |
| `timezone` | string or null |   |   | IANA timezone, e.g. Australia/Sydney |
| `socialProfiles` | array of object |   | at most 20 |   |
| `socialProfiles[].network` | string | yes | min length 1, max length 50 | e.g. linkedin, x, github |
| `socialProfiles[].url` | string (uri) | yes | max length 500 |   |
| `socialProfiles[].handle` | string |   | max length 100 |   |
| `avatarKey` | string or null |   |   | R2 object key of an uploaded avatar |
| `ownerId` | string or null |   |   | The user who owns this person |
| `description` | string or null |   |   | Markdown |
| `tags` | array of string |   | at most 50 | Tag names. Unknown tags are created. Replaces the record's tags. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `displayName` | string | yes |   |   |
| `givenName` | string or null | yes |   |   |
| `familyName` | string or null | yes |   |   |
| `emails` | array of object | yes |   |   |
| `emails[].email` | string | yes |   |   |
| `emails[].label` | string or null | yes |   |   |
| `emails[].primary` | boolean | yes |   |   |
| `phones` | array of object | yes |   |   |
| `phones[].number` | string | yes |   |   |
| `phones[].label` | string or null | yes |   |   |
| `phones[].primary` | boolean | yes |   |   |
| `location` | string or null | yes |   |   |
| `timezone` | string or null | yes |   |   |
| `socialProfiles` | array of object | yes |   |   |
| `socialProfiles[].network` | string | yes | min length 1, max length 50 | e.g. linkedin, x, github |
| `socialProfiles[].url` | string (uri) | yes | max length 500 |   |
| `socialProfiles[].handle` | string |   | max length 100 |   |
| `avatarKey` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `tags` | array of string | yes |   |   |
| `birthday` | object or null | yes |   |   |
| `birthday.day` | integer | yes | ≥ 1, ≤ 31 | Day of the month, 1 to 31 |
| `birthday.month` | integer | yes | ≥ 1, ≤ 12 | Month, 1 (January) to 12 (December) |
| `jobTitle` | string or null | yes |   |   |
| `primaryAffiliation` | object or null | yes |   |   |
| `primaryAffiliation.id` | string | yes |   |   |
| `primaryAffiliation.organisationId` | string | yes |   |   |
| `primaryAffiliation.organisationName` | string or null | yes |   |   |
| `primaryAffiliation.title` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `mergedIntoId` | string or null | yes |   |   |
| `possibleDuplicates` | array of object | yes | default `[]` | Existing records this one may duplicate, by plain rules (no score), at most 5. Check it: if one is the same record, merge them (person.merge / organisation.merge). |
| `possibleDuplicates[].id` | string | yes |   | The existing record's id |
| `possibleDuplicates[].title` | string | yes |   | Its name |
| `possibleDuplicates[].rules` | array of `"same_email"`, `"same_name_organisation"`, `"same_name_email_domain"`, `"same_phone"`, `"same_name_only"`, `"same_domain"`, `"same_name"` | yes |   |   |
| `possibleDuplicates[].reasons` | array of string | yes |   | One plain sentence per rule, e.g. 'Same name only' |

## person.createWith

Create a new person and one record of an extension object that points at them (its `field`, a relation to person), in one batch: if the record is refused (for example a booking into a full class), the person is not created either. The platform's duplicate check runs first: an email that already belongs to a live person is refused (conflict, rule person_exists, naming them), and possible duplicates (same name, same phone…) are refused (conflict, rule possible_duplicates, listing them) unless allowDuplicates is true because you checked they are different people. Returns both ids.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `person` | object | yes |   |   |
| `person.givenName` | string or null |   |   |   |
| `person.familyName` | string or null |   |   |   |
| `person.displayName` | string |   | min length 1, max length 200 | Shown name. Defaults to given + family name, or the primary email. |
| `person.emails` | array of object |   | at most 20 |   |
| `person.emails[].email` | string | yes |   |   |
| `person.emails[].label` | string or null |   |   | e.g. work, personal |
| `person.emails[].primary` | boolean |   |   | Exactly one email is primary; default the first. |
| `person.phones` | array of object |   | at most 20 |   |
| `person.phones[].number` | string | yes | min length 1, max length 50 |   |
| `person.phones[].label` | string or null |   |   | e.g. mobile, work |
| `person.phones[].primary` | boolean |   |   | Exactly one phone is primary; default the first. |
| `person.location` | string or null |   |   | Free text, e.g. 'Sydney, Australia' |
| `person.timezone` | string or null |   |   | IANA timezone, e.g. Australia/Sydney |
| `person.socialProfiles` | array of object |   | at most 20 |   |
| `person.socialProfiles[].network` | string | yes | min length 1, max length 50 | e.g. linkedin, x, github |
| `person.socialProfiles[].url` | string (uri) | yes | max length 500 |   |
| `person.socialProfiles[].handle` | string |   | max length 100 |   |
| `person.avatarKey` | string or null |   |   | R2 object key of an uploaded avatar |
| `person.ownerId` | string or null |   |   | The user who owns this person |
| `person.description` | string or null |   |   | Markdown |
| `person.tags` | array of string |   | at most 50 | Tag names. Unknown tags are created. Replaces the record's tags. |
| `object` | string | yes | min length 1, max length 81 | The extension object, e.g. bookings.booking |
| `field` | string | yes | min length 1, max length 40 | Its relation to person, e.g. person |
| `values` | map of any |   | default `{}` |   |
| `allowDuplicates` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes |   |   |
| `id` | string | yes |   |   |

## person.delete

Move a person to Trash (soft delete). They disappear from lists, search and views, and their emails become free for other people. They can be restored with person.restore for 30 days, after which they are purged. Activities and tasks linked to them are kept.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^per_.*` | Person id (per_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deletedAt` | string | yes |   |   |
| `restorableUntil` | string | yes |   |   |

## person.deleteMany

Move many people to Trash at once (soft delete), like person.delete for each: their emails become free, and they can be restored one by one for 30 days. Fails, deleting none, if any id is not a live person. At most 100 people per call, applied atomically (all or none). For more, call again with the next ids: separate calls are separate transactions, each audited and gated on its own, so a later call can fail after earlier ones applied.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string (starts_with) | yes | at least 1, at most 100 | Person ids, at most 100 per call |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string | yes |   |   |
| `count` | number | yes |   |   |
| `deletedAt` | string | yes |   |   |
| `restorableUntil` | string | yes |   |   |

## person.erase

Permanently delete a person now, for GDPR erasure requests (admins only). Works on live people and people in Trash, and also erases anyone merged into them. Emails, phones, affiliations and tags go; activities and tasks linked only to them are deleted; system activities about them (field changes, job changes, merges) are removed from every timeline. Audit-log content that mentions them (their id, emails or phone numbers) is replaced with "[erased]"; who did what and when is kept. In-app assistant conversations that referenced them are redacted the same way (tool calls and results that mention them lose their content; their ids, emails, phone numbers and names in text become "[erased]"). Former emails and phones count too. Synced email bodies, suggested contacts, signatures, extension data related to them, automation run history and notifications about them are deleted or redacted, and their addresses are added to the erased-address list so mail sync does not collect them again. Their customer account, its sessions and sign-in codes, invites for their addresses and their erase requests are deleted (an open request is closed as erased). Their birthday, health answers and minor mark are deleted; what they agreed to is kept, no longer theirs, as the business's evidence until the retention period ends (agreement.retention, counted from the erase), then deleted: agreementsKept says how many and until when. Every subscription they pay for or hold that still runs is asked at the payment provider to end when the period already paid for ends (one paused, unpaid or waiting for its first payment ends at once): nothing is refunded and nothing more is charged; admins are told of one that could not be asked, and of one another person is still on. In the booking system's copy, the outside people linked to them, those linked to nobody on an address only they hold, and coaches on it with no staff account go, with their memberships, passes, bookings and To match; their addresses (but one someone else holds) and the linked rows' refs are suppressed, so no later list brings them back. A row linked to anyone else, or waiting because another Person holds the address, stays. bookingSystem says what happened, and that a copy remains in the booking system itself. Cannot be undone; use person.delete for a reversible delete.

|  |  |
| --- | --- |
| Permission | `records:erase` |
| Risk | `destructive` |
| Audiences | `staff` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^per_.*` | Person id (per_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `erased` | array of string | yes |   |   |
| `activitiesDeleted` | number | yes |   |   |
| `tasksDeleted` | number | yes |   |   |
| `auditRowsRedacted` | number | yes |   |   |
| `conversationsScrubbed` | number | yes |   |   |
| `suggestionsRemoved` | number | yes |   | Suggested contacts removed (a person's addresses; an organisation's domains) |
| `extensionRowsErased` | number | yes |   | Extension rows deleted or scrubbed |
| `runsRedacted` | number | yes |   | Automation runs redacted |
| `notificationsDeleted` | number | yes |   |   |
| `memoryLinesDeleted` | number | yes |   | Assistant memory lines that named the subject |
| `eraseRequestsClosed` | number | yes |   | Open erase requests the erase closed (a person's customer account goes with them) |
| `agreementsKept` | object |   |   | A person's agreements (ADR 0646): health answers and the minor mark are deleted; each acceptance is kept, detached, until the retention period ends |
| `agreementsKept.count` | number | yes |   | Acceptances kept, no longer theirs, as the business's evidence |
| `agreementsKept.until` | string or null | yes |   | When the retention purge deletes them (agreement.retention); null: none kept, or the setting keeps them |
| `agreementsKept.deleted` | number | yes |   | A buyer's acceptances on an unpaid order or unconfirmed checkout, deleted |
| `bodiesDeleted` | number | yes |   | Synced email bodies deleted from blob storage now (the rest are retried) |
| `bookingSystem` | object |   |   | Whenever the host holds a booking system's copy (stage 65): what the erase did to it. Present even when nothing of theirs was found. A copy remains in the booking system, for staff to deal with there |
| `bookingSystem.deletedLinked` | number | yes |   | Outside people linked to them (by address or by staff): deleted, their refs suppressed |
| `bookingSystem.deletedUnlinked` | number | yes |   | Outside people linked to nobody on an address only they held (their household's unmatched copies): deleted, no ref suppressed |
| `bookingSystem.coaches` | number | yes |   | Coaches on their address with no staff account: deleted |
| `bookingSystem.keptLinkedToOthers` | number | yes |   | Outside people and coaches on their address kept, because linked to another Person or a staff account |
| `bookingSystem.keptWaiting` | number | yes |   | Outside people on their address left waiting in To match, because another Person holds the address too |
| `bookingSystem.sharedAddresses` | number | yes |   | Their addresses another Person, customer account or kept outside person also holds: not suppressed, not redacted (a count only) |
| `bookingSystem.textScrubbed` | number | yes |   | Classes and class types whose text named them (a full name, whole words), scrubbed; a later list brings back what the booking system still says |
| `bookingSystem.copyRemains` | `true` | yes |   | The booking system itself still holds them: the host cannot remove it there |
| `bookingSystem.note` | string | yes |   |   |
| `dependantsWithoutGuardian` | array of string |   |   | People this person was the only live guardian of (ADR 0540): they stay, with no guardian linked, and a note on their timeline |
| `subscriptionsEnding` | object | yes |   | Their subscriptions, as payer or holder (issue #293, ADR 0533): nothing is refunded |
| `subscriptionsEnding.atPeriodEnd` | number | yes |   | Asked to end when the period already paid for ends |
| `subscriptionsEnding.now` | number | yes |   | Asked to end at once (past due, paused, unpaid, or waiting for a payment) |
| `subscriptionsEnding.leftForStaff` | number | yes |   | Could not be asked at the provider: the admins are told to end them |
| `invoicesKept` | number | yes |   | Issued invoices billed to them (stage 35): kept, no longer theirs, with their number, amounts and the bill-to as printed (the name, address and email they were sent to), for the books until the retention period decides (stage 35 step 11); staff credit or void one still owed |

## person.get

Get one person by id, with all emails, phones, tags, social profiles, owner, description and current primary affiliation (job title and organisation). Deleted people are not found unless includeDeleted is true. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^per_.*` | Person id (per_…) |
| `includeDeleted` | boolean |   | default `false` | Also find people in Trash |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `displayName` | string | yes |   |   |
| `givenName` | string or null | yes |   |   |
| `familyName` | string or null | yes |   |   |
| `emails` | array of object | yes |   |   |
| `emails[].email` | string | yes |   |   |
| `emails[].label` | string or null | yes |   |   |
| `emails[].primary` | boolean | yes |   |   |
| `phones` | array of object | yes |   |   |
| `phones[].number` | string | yes |   |   |
| `phones[].label` | string or null | yes |   |   |
| `phones[].primary` | boolean | yes |   |   |
| `location` | string or null | yes |   |   |
| `timezone` | string or null | yes |   |   |
| `socialProfiles` | array of object | yes |   |   |
| `socialProfiles[].network` | string | yes | min length 1, max length 50 | e.g. linkedin, x, github |
| `socialProfiles[].url` | string (uri) | yes | max length 500 |   |
| `socialProfiles[].handle` | string |   | max length 100 |   |
| `avatarKey` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `tags` | array of string | yes |   |   |
| `birthday` | object or null | yes |   |   |
| `birthday.day` | integer | yes | ≥ 1, ≤ 31 | Day of the month, 1 to 31 |
| `birthday.month` | integer | yes | ≥ 1, ≤ 12 | Month, 1 (January) to 12 (December) |
| `jobTitle` | string or null | yes |   |   |
| `primaryAffiliation` | object or null | yes |   |   |
| `primaryAffiliation.id` | string | yes |   |   |
| `primaryAffiliation.organisationId` | string | yes |   |   |
| `primaryAffiliation.organisationName` | string or null | yes |   |   |
| `primaryAffiliation.title` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `mergedIntoId` | string or null | yes |   |   |

## person.link.add

Link a guardian (a parent) to a dependant (a child) they may act for: while the link is live the guardian, signed in on the gym's site or app, books, cancels and joins waitlists for the dependant, and reads the dependant's bookings and what their memberships and passes have left, and nothing else of theirs. The dependant may have no email and no account. A dependant may have several guardians, a guardian several dependants. Refused when the two are already linked either way. Only a person on the staff with people:link can do this: never the assistant, an MCP client or code. Audited.

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
| `guardianId` | string | yes | min length 1, max length 64 | The parent or guardian (per_…) |
| `dependantId` | string | yes | min length 1, max length 64 | The child they may act for (per_…) |
| `note` | string |   | max length 500 | Why, e.g. mother, legal guardian |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"guardian"` | yes |   |   |
| `guardian` | object | yes |   |   |
| `guardian.id` | string | yes |   |   |
| `guardian.name` | string or null | yes |   |   |
| `dependant` | object | yes |   |   |
| `dependant.id` | string | yes |   |   |
| `dependant.name` | string or null | yes |   |   |
| `note` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string | yes |   |   |
| `endedAt` | string or null | yes |   |   |
| `endedBy` | string or null | yes |   |   |
| `endReason` | string or null | yes |   |   |
| `warning` | string or null | yes |   | Set when the child's record has an email that is also the parent's or another account's: signing in with it would open that account as the child's |

## person.link.end

End a family link: from that moment the guardian reads nothing of the dependant's and books nothing for them. Bookings they already made stay (cancel them separately if needed); the answer says how many (stays). The link is kept, ended, with who ended it and why. Only a person on the staff with people:link can do this. Audited.

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
| `id` | string | yes | min length 1, max length 64 | The link's id (pln_…) |
| `reason` | string |   | max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `kind` | `"guardian"` | yes |   |   |
| `guardian` | object | yes |   |   |
| `guardian.id` | string | yes |   |   |
| `guardian.name` | string or null | yes |   |   |
| `dependant` | object | yes |   |   |
| `dependant.id` | string | yes |   |   |
| `dependant.name` | string or null | yes |   |   |
| `note` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string | yes |   |   |
| `endedAt` | string or null | yes |   |   |
| `endedBy` | string or null | yes |   |   |
| `endReason` | string or null | yes |   |   |
| `warning` | string or null | yes |   | Set when the child's record has an email that is also the parent's or another account's: signing in with it would open that account as the child's |
| `stays` | array of object | yes |   | Live records the guardian made for the dependant (bookings): they stay |
| `stays[].object` | string | yes |   |   |
| `stays[].label` | string | yes |   |   |
| `stays[].count` | number | yes |   |   |

## person.link.list

A person's family links: the guardians who may act for them and the dependants they may act for, live ones first, with names, who made each and when, and (with ended) the links that have ended. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string | yes | min length 1, max length 64 | The person (per_…) |
| `ended` | boolean |   | default `false` | Include links that have ended |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].kind` | `"guardian"` | yes |   |   |
| `items[].guardian` | object | yes |   |   |
| `items[].guardian.id` | string | yes |   |   |
| `items[].guardian.name` | string or null | yes |   |   |
| `items[].dependant` | object | yes |   |   |
| `items[].dependant.id` | string | yes |   |   |
| `items[].dependant.name` | string or null | yes |   |   |
| `items[].note` | string or null | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].createdBy` | string | yes |   |   |
| `items[].endedAt` | string or null | yes |   |   |
| `items[].endedBy` | string or null | yes |   |   |
| `items[].endReason` | string or null | yes |   |   |
| `items[].warning` | string or null | yes |   | Set when the child's record has an email that is also the parent's or another account's: signing in with it would open that account as the child's |

## person.link.mergePlan

What merging one person (mergedId) into another (survivorId) would do to their family links: how many move, how many end (a duplicate, or one whose other way round is linked: never a two-way link), how many are deleted (links between the two) and how many past links move as history. A merge that touches a live link waits for a person's approval when anyone but a person asks for it. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `survivorId` | string | yes | min length 1, max length 64 |   |
| `mergedId` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `moved` | number | yes |   |   |
| `ended` | number | yes |   |   |
| `deleted` | number | yes |   |   |
| `history` | number | yes |   |   |
| `needs` | `"people:link"` or null | yes |   | The permission the merge needs because it moves a live link, when the caller lacks it |

## person.list

List live people, one page at a time. Filter with structured filter JSON over person fields (e.g. { and: [{ field: 'organisationName', op: 'contains', value: 'acme' }, { field: 'tags', op: 'eq', value: 'VIP' }] }); 'emails', 'phones' and 'tags' match any value. Sort by a sortable field (default displayName). Pass nextCursor back as cursor for the next page. Use fields to return only some columns. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filter` | any |   |   | Structured filter: { and \| or: [...] } of { field, op, value }. |
| `sort` | object |   |   | Sort field and direction. Defaults per object. |
| `sort.field` | string | yes | min length 1, max length 64 |   |
| `sort.direction` | `"asc"`, `"desc"` |   | default `"asc"` |   |
| `cursor` | string |   | max length 1000 | nextCursor from the previous page. |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |
| `fields` | array of string |   | at most 100 | Return only these fields of each item (id is always included). |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].displayName` | string |   |   |   |
| `items[].givenName` | string or null |   |   |   |
| `items[].familyName` | string or null |   |   |   |
| `items[].primaryEmail` | string or null |   |   |   |
| `items[].emails` | array of string |   |   |   |
| `items[].primaryPhone` | string or null |   |   |   |
| `items[].jobTitle` | string or null |   |   |   |
| `items[].organisationId` | string or null |   |   |   |
| `items[].organisationName` | string or null |   |   |   |
| `items[].location` | string or null |   |   |   |
| `items[].timezone` | string or null |   |   |   |
| `items[].ownerId` | string or null |   |   |   |
| `items[].avatarKey` | string or null |   |   |   |
| `items[].tags` | array of string |   |   |   |
| `items[].createdAt` | string |   |   |   |
| `items[].updatedAt` | string |   |   |   |
| `nextCursor` | string or null | yes |   |   |

## person.merge

Merge a duplicate person (mergedId) into another (survivorId). The survivor keeps its own values unless fields says to take the duplicate's (per field: 'survivor' or 'merged'); empty survivor fields are filled from the duplicate (the birthday too: the survivor's is kept unless it has none). Emails, phones, social profiles and tags are combined, and the duplicate's affiliations, activity links and task links move to the survivor (the survivor keeps its primary affiliation if it has one). The duplicate goes to Trash pointing at the survivor, and can be restored from there (without what moved). Links to the booking system's copy move to the survivor. A customer account moves to the survivor; when both people have one, the merge is refused until staff disable one (the disabled one is then deleted). Returns the survivor.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `survivorId` | string (starts_with) | yes | max length 64, pattern `^per_.*` | The person who remains |
| `mergedId` | string (starts_with) | yes | max length 64, pattern `^per_.*` | The duplicate that is merged away into Trash |
| `fields` | map of `"survivor"`, `"merged"` |   | default `{}` | Which record's value to keep for each field (default survivor) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `displayName` | string | yes |   |   |
| `givenName` | string or null | yes |   |   |
| `familyName` | string or null | yes |   |   |
| `emails` | array of object | yes |   |   |
| `emails[].email` | string | yes |   |   |
| `emails[].label` | string or null | yes |   |   |
| `emails[].primary` | boolean | yes |   |   |
| `phones` | array of object | yes |   |   |
| `phones[].number` | string | yes |   |   |
| `phones[].label` | string or null | yes |   |   |
| `phones[].primary` | boolean | yes |   |   |
| `location` | string or null | yes |   |   |
| `timezone` | string or null | yes |   |   |
| `socialProfiles` | array of object | yes |   |   |
| `socialProfiles[].network` | string | yes | min length 1, max length 50 | e.g. linkedin, x, github |
| `socialProfiles[].url` | string (uri) | yes | max length 500 |   |
| `socialProfiles[].handle` | string |   | max length 100 |   |
| `avatarKey` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `tags` | array of string | yes |   |   |
| `birthday` | object or null | yes |   |   |
| `birthday.day` | integer | yes | ≥ 1, ≤ 31 | Day of the month, 1 to 31 |
| `birthday.month` | integer | yes | ≥ 1, ≤ 12 | Month, 1 (January) to 12 (December) |
| `jobTitle` | string or null | yes |   |   |
| `primaryAffiliation` | object or null | yes |   |   |
| `primaryAffiliation.id` | string | yes |   |   |
| `primaryAffiliation.organisationId` | string | yes |   |   |
| `primaryAffiliation.organisationName` | string or null | yes |   |   |
| `primaryAffiliation.title` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `mergedIntoId` | string or null | yes |   |   |
| `moved` | object | yes |   |   |
| `moved.affiliations` | number | yes |   |   |
| `moved.activities` | number | yes |   |   |
| `moved.tasks` | number | yes |   |   |
| `familyLinks` | object |   |   | What happened to the duplicate's family links (guardians and children) |
| `familyLinks.moved` | number | yes |   | Live family links that moved to the survivor |
| `familyLinks.ended` | number | yes |   | Live links ended: a duplicate, or one whose other way round is linked |
| `familyLinks.deleted` | number | yes |   | Links between the two People, deleted |
| `familyLinks.history` | number | yes |   | Links that had already ended, moved as history |

## person.restore

Restore a person from Trash, including one that was merged away (they come back without what the merge moved to the survivor). Fails with a conflict if one of their emails now belongs to another live person (edit or delete that person first). Returns the restored person.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^per_.*` | Person id (per_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `displayName` | string | yes |   |   |
| `givenName` | string or null | yes |   |   |
| `familyName` | string or null | yes |   |   |
| `emails` | array of object | yes |   |   |
| `emails[].email` | string | yes |   |   |
| `emails[].label` | string or null | yes |   |   |
| `emails[].primary` | boolean | yes |   |   |
| `phones` | array of object | yes |   |   |
| `phones[].number` | string | yes |   |   |
| `phones[].label` | string or null | yes |   |   |
| `phones[].primary` | boolean | yes |   |   |
| `location` | string or null | yes |   |   |
| `timezone` | string or null | yes |   |   |
| `socialProfiles` | array of object | yes |   |   |
| `socialProfiles[].network` | string | yes | min length 1, max length 50 | e.g. linkedin, x, github |
| `socialProfiles[].url` | string (uri) | yes | max length 500 |   |
| `socialProfiles[].handle` | string |   | max length 100 |   |
| `avatarKey` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `tags` | array of string | yes |   |   |
| `birthday` | object or null | yes |   |   |
| `birthday.day` | integer | yes | ≥ 1, ≤ 31 | Day of the month, 1 to 31 |
| `birthday.month` | integer | yes | ≥ 1, ≤ 12 | Month, 1 (January) to 12 (December) |
| `jobTitle` | string or null | yes |   |   |
| `primaryAffiliation` | object or null | yes |   |   |
| `primaryAffiliation.id` | string | yes |   |   |
| `primaryAffiliation.organisationId` | string | yes |   |   |
| `primaryAffiliation.organisationName` | string or null | yes |   |   |
| `primaryAffiliation.title` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `mergedIntoId` | string or null | yes |   |   |

## person.setBirthday

Record a person's birthday: day and month only, never a year (null removes it). A birthday journey starts on it, in the business's time zone. Only a person on the staff may change a birthday the member gave themselves. Returns the person.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^per_.*` | Person id (per_…) |
| `birthday` | object or null | yes |   | Day and month, or null to remove it |
| `birthday.day` | integer | yes | ≥ 1, ≤ 31 | Day of the month, 1 to 31 |
| `birthday.month` | integer | yes | ≥ 1, ≤ 12 | Month, 1 (January) to 12 (December) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `displayName` | string | yes |   |   |
| `givenName` | string or null | yes |   |   |
| `familyName` | string or null | yes |   |   |
| `emails` | array of object | yes |   |   |
| `emails[].email` | string | yes |   |   |
| `emails[].label` | string or null | yes |   |   |
| `emails[].primary` | boolean | yes |   |   |
| `phones` | array of object | yes |   |   |
| `phones[].number` | string | yes |   |   |
| `phones[].label` | string or null | yes |   |   |
| `phones[].primary` | boolean | yes |   |   |
| `location` | string or null | yes |   |   |
| `timezone` | string or null | yes |   |   |
| `socialProfiles` | array of object | yes |   |   |
| `socialProfiles[].network` | string | yes | min length 1, max length 50 | e.g. linkedin, x, github |
| `socialProfiles[].url` | string (uri) | yes | max length 500 |   |
| `socialProfiles[].handle` | string |   | max length 100 |   |
| `avatarKey` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `tags` | array of string | yes |   |   |
| `birthday` | object or null | yes |   |   |
| `birthday.day` | integer | yes | ≥ 1, ≤ 31 | Day of the month, 1 to 31 |
| `birthday.month` | integer | yes | ≥ 1, ≤ 12 | Month, 1 (January) to 12 (December) |
| `jobTitle` | string or null | yes |   |   |
| `primaryAffiliation` | object or null | yes |   |   |
| `primaryAffiliation.id` | string | yes |   |   |
| `primaryAffiliation.organisationId` | string | yes |   |   |
| `primaryAffiliation.organisationName` | string or null | yes |   |   |
| `primaryAffiliation.title` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `mergedIntoId` | string or null | yes |   |   |

## person.update

Update a person's fields. Only the fields you pass change; pass null to clear a field. emails, phones, socialProfiles and tags replace the whole list when given. Changing the owner posts a system activity on the person's timeline. Fails with a conflict if an email belongs to another live person. Returns the updated person.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^per_.*` | Person id (per_…) |
| `givenName` | string or null |   |   |   |
| `familyName` | string or null |   |   |   |
| `displayName` | string |   | min length 1, max length 200 | Shown name. Defaults to given + family name, or the primary email. |
| `emails` | array of object |   | at most 20 |   |
| `emails[].email` | string | yes |   |   |
| `emails[].label` | string or null |   |   | e.g. work, personal |
| `emails[].primary` | boolean |   |   | Exactly one email is primary; default the first. |
| `phones` | array of object |   | at most 20 |   |
| `phones[].number` | string | yes | min length 1, max length 50 |   |
| `phones[].label` | string or null |   |   | e.g. mobile, work |
| `phones[].primary` | boolean |   |   | Exactly one phone is primary; default the first. |
| `location` | string or null |   |   | Free text, e.g. 'Sydney, Australia' |
| `timezone` | string or null |   |   | IANA timezone, e.g. Australia/Sydney |
| `socialProfiles` | array of object |   | at most 20 |   |
| `socialProfiles[].network` | string | yes | min length 1, max length 50 | e.g. linkedin, x, github |
| `socialProfiles[].url` | string (uri) | yes | max length 500 |   |
| `socialProfiles[].handle` | string |   | max length 100 |   |
| `avatarKey` | string or null |   |   | R2 object key of an uploaded avatar |
| `ownerId` | string or null |   |   | The user who owns this person |
| `description` | string or null |   |   | Markdown |
| `tags` | array of string |   | at most 50 | Tag names. Unknown tags are created. Replaces the record's tags. |
| `birthday` | any |   |   | Not set here: use person.setBirthday |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `displayName` | string | yes |   |   |
| `givenName` | string or null | yes |   |   |
| `familyName` | string or null | yes |   |   |
| `emails` | array of object | yes |   |   |
| `emails[].email` | string | yes |   |   |
| `emails[].label` | string or null | yes |   |   |
| `emails[].primary` | boolean | yes |   |   |
| `phones` | array of object | yes |   |   |
| `phones[].number` | string | yes |   |   |
| `phones[].label` | string or null | yes |   |   |
| `phones[].primary` | boolean | yes |   |   |
| `location` | string or null | yes |   |   |
| `timezone` | string or null | yes |   |   |
| `socialProfiles` | array of object | yes |   |   |
| `socialProfiles[].network` | string | yes | min length 1, max length 50 | e.g. linkedin, x, github |
| `socialProfiles[].url` | string (uri) | yes | max length 500 |   |
| `socialProfiles[].handle` | string |   | max length 100 |   |
| `avatarKey` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `description` | string or null | yes |   |   |
| `tags` | array of string | yes |   |   |
| `birthday` | object or null | yes |   |   |
| `birthday.day` | integer | yes | ≥ 1, ≤ 31 | Day of the month, 1 to 31 |
| `birthday.month` | integer | yes | ≥ 1, ≤ 12 | Month, 1 (January) to 12 (December) |
| `jobTitle` | string or null | yes |   |   |
| `primaryAffiliation` | object or null | yes |   |   |
| `primaryAffiliation.id` | string | yes |   |   |
| `primaryAffiliation.organisationId` | string | yes |   |   |
| `primaryAffiliation.organisationName` | string or null | yes |   |   |
| `primaryAffiliation.title` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `createdBy` | string or null | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `deletedAt` | string or null | yes |   |   |
| `mergedIntoId` | string or null | yes |   |   |

## person.updateMany

Set the same fields on many people at once: owner, location, timezone, and tags to add or remove. Fields you leave out are untouched; pass null to clear owner, location or timezone. Owner changes post a system activity on each person's timeline. At most 100 people per call, applied atomically (all or none). For more, call again with the next ids: separate calls are separate transactions, each audited and gated on its own, so a later call can fail after earlier ones applied. Returns the ids updated.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `bulk-write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string (starts_with) | yes | at least 1, at most 100 | Person ids, at most 100 per call |
| `set` | object |   | default `{}` |   |
| `set.ownerId` | string or null |   |   |   |
| `set.location` | string or null |   |   |   |
| `set.timezone` | string or null |   |   |   |
| `addTags` | array of string |   | at most 10 | Tag names to add (created if unknown) |
| `removeTags` | array of string |   | at most 10 | Tag names to remove |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string | yes |   |   |
| `count` | number | yes |   |   |
