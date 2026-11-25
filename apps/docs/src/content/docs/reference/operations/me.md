---
title: "me.* operations"
description: "The core operations named me.*"
sidebar:
  label: "me"
editUrl: false
---

## me.agreements.accept

Agree to a version of a document, as a signed-in customer: for yourself, or with forPersonId for a child linked to you. Give the name you type, a signature for a document agreed to by drawing, and every answer for a health form. Recorded for good and never changed. Refused for yourself when a parent or guardian agrees for you.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `versionId` | string | yes | min length 1, max length 64 | The version's id (agv_…), as me.agreements.due gave it |
| `forPersonId` | string |   | min length 1, max length 64 | A child linked to you (per_…); left out: yourself |
| `typedName` | string | yes | min length 1, max length 200 | The name the person typed beside the box: personal data, never shown to an AI |
| `signature` | object |   |   | A drawn signature as strokes in a 1000 by 400 box: personal data |
| `signature.width` | `1000` | yes |   |   |
| `signature.height` | `400` | yes |   |   |
| `signature.strokes` | array of array of array of any | yes | at least 1, at most 30 |   |
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
| `acceptedAt` | string | yes |   |   |
| `copyTo` | string or null | yes |   | The address the copy is emailed to (your sign-in address), or null for none |

## me.agreements.due

What you, as a signed-in customer, and each child linked to you still have to agree to: each due document's version in effect, to read and agree to with me.agreements.accept. canAgree is false for someone a parent or guardian agrees for. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `people` | array of object | yes |   |   |
| `people[].personId` | string | yes |   |   |
| `people[].name` | string | yes |   |   |
| `people[].self` | boolean | yes |   |   |
| `people[].canAgree` | boolean | yes |   | False when a parent or guardian agrees for them |
| `people[].due` | array of object | yes |   |   |
| `people[].due[].documentId` | string | yes |   |   |
| `people[].due[].kind` | string | yes |   |   |
| `people[].due[].title` | string | yes |   |   |
| `people[].due[].reason` | `"never"`, `"agree_again"`, `"ask_again"`, `"guardian"` | yes |   |   |
| `people[].due[].version` | object | yes |   |   |
| `people[].due[].version.id` | string | yes |   |   |
| `people[].due[].version.documentId` | string | yes |   |   |
| `people[].due[].version.number` | number | yes |   |   |
| `people[].due[].version.kind` | string | yes |   |   |
| `people[].due[].version.title` | string | yes |   |   |
| `people[].due[].version.body` | any | yes |   |   |
| `people[].due[].version.tickLabel` | string | yes |   |   |
| `people[].due[].version.questions` | array of object or null | yes |   |   |
| `people[].due[].version.questions.key` | string | yes |   |   |
| `people[].due[].version.questions.text` | string | yes |   |   |
| `people[].due[].version.questions.noteOnYes` | boolean | yes |   |   |
| `people[].due[].version.how` | `"typed"`, `"drawn"` | yes |   |   |
| `people[].due[].version.effectiveFrom` | string | yes |   |   |
| `people[].due[].version.hash` | string | yes |   |   |

## me.agreements.get

One of your acceptances, or a linked child's, as a signed-in customer: the version as you were shown it, a health form's answers, and the name typed and the signature drawn when you are the one who agreed (another guardian's are not shown). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

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
| `version` | object | yes |   |   |
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
| `typedName` | string or null | yes |   |   |
| `signature` | object or null | yes |   |   |
| `signature.width` | number | yes |   |   |
| `signature.height` | number | yes |   |   |
| `signature.strokes` | array of array of array of number | yes |   |   |
| `answers` | array of object or null | yes |   |   |
| `answers.key` | string | yes |   |   |
| `answers.yes` | boolean | yes |   |   |
| `answers.note` | string |   |   |   |

## me.agreements.list

Your agreements, as a signed-in customer, and those of each child linked to you: every acceptance, newest first, with the document, the version, who agreed and how, and whether it is the one that counts now. me.agreements.get reads one. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

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

## me.agreements.pdf

The signed PDF of one of your acceptances, as a signed-in customer, or a linked child's: the version as you were shown it and the record of who agreed, how and when, with a health form's answers. The name typed and the signature drawn are in it when you are the one who agreed. Built when asked, never stored. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

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

## me.attention

What needs your attention, as a signed-in customer, soonest first: a document to agree to (for you or a child linked to you), a card payment that failed, a payment waiting for you to confirm with your bank, the rest of a deposit to pay, an order you started paying for and did not finish, a pass about to expire with uses left or with none left (yours or a child's), and a free trial about to end. `days` is how far ahead it looks for a pass or a trial ending. An item goes once its cause is fixed. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `days` | number | yes |   | How many days ahead a pass or trial ending is listed |
| `items` | array of object | yes |   |   |
| `items[].key` | string | yes |   | Stable for the same cause: kind, record and Person |
| `items[].kind` | `"agree"`, `"card_failing"`, `"confirm_payment"`, `"balance_due"`, `"finish_paying"`, `"pass_expiring"`, `"pass_used_up"`, `"trial_ending"` | yes |   | agree: a document to agree to (me.agreements.due has it). card_failing: a card payment for a subscription you pay failed. confirm_payment: a payment waits for you to confirm it with your bank. balance_due: the rest of a deposit to pay. finish_paying: an order holding places you started paying for and did not finish. pass_expiring: a pass about to expire with uses still on it. pass_used_up: a pass with no uses left. trial_ending: a free trial about to end. |
| `items[].person` | object | yes |   | Whose it is: you (self), or a child linked to you |
| `items[].person.id` | string | yes |   |   |
| `items[].person.name` | string | yes |   |   |
| `items[].person.self` | boolean | yes |   |   |
| `items[].record` | object | yes |   | What it is about: an agreement document, a subscription, an order, or a pass by its object |
| `items[].record.object` | string | yes |   |   |
| `items[].record.id` | string | yes |   |   |
| `items[].record.title` | string | yes |   |   |
| `items[].at` | string or null | yes |   | The moment it is about: the version taking effect, the first failed payment, the payment started, the balance due, the held order expiring, the pass or trial ending |
| `items[].amount` | number or null | yes |   | Money due or to be charged, in the currency's minor unit; null where none |
| `items[].currency` | string or null | yes |   |   |
| `items[].usesLeft` | number or null | yes |   | A pass's uses left; null for other kinds |

## me.birthday.get

Your birthday as the business has it, as a signed-in customer: day and month only, or null when none is recorded. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `birthday` | object or null | yes |   | Day and month; null when none is recorded |
| `birthday.day` | integer | yes | ≥ 1, ≤ 31 | Day of the month, 1 to 31 |
| `birthday.month` | integer | yes | ≥ 1, ≤ 12 | Month, 1 (January) to 12 (December) |

## me.birthday.set

Give your birthday, as a signed-in customer: day and month only, never a year; null removes it. The business may send you a message on the day. Returns your birthday.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `birthday` | object or null | yes |   | Day and month; null when none is recorded |
| `birthday.day` | integer | yes | ≥ 1, ≤ 31 | Day of the month, 1 to 31 |
| `birthday.month` | integer | yes | ≥ 1, ≤ 12 | Month, 1 (January) to 12 (December) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `birthday` | object or null | yes |   | Day and month; null when none is recorded |
| `birthday.day` | integer | yes | ≥ 1, ≤ 31 | Day of the month, 1 to 31 |
| `birthday.month` | integer | yes | ≥ 1, ≤ 12 | Month, 1 (January) to 12 (December) |

## me.calendarFeed.revoke

Turn off your private calendar link, as a signed-in customer: it then answers as if it never existed (a calendar app subscribed to it keeps what it last fetched, and gets no more). Make a new one with me.calendarFeed.rotate.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `revoked` | boolean | yes |   |   |

## me.calendarFeed.rotate

A new private link for your calendar, as a signed-in customer: your bookings and your children's, from two weeks ago to four months ahead, for a calendar app to subscribe to. It replaces any old link, which stops working at once. The link is shown this once and never again: anyone who has it sees your bookings, so do not share it. Your own act.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Actors | `human` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `path` | string | yes |   | The link's address on this host (put the host's origin before it; webcal:// opens it in a calendar app). Shown once. |
| `createdAt` | string | yes |   |   |

## me.calendarFeed.status

Whether you have a private calendar link (your bookings, and your children's, for a calendar app to subscribe to), and when it was made, as a signed-in customer. Never the link itself: it is shown once, when made. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `active` | boolean | yes |   | Whether a calendar link exists (it is never shown again) |
| `createdAt` | string or null | yes |   | When the current link was made |

## me.code

Your check-in code, as a signed-in customer: the code to hold up at the gym's check-in tablet, and one for each child linked to you (by their given name), each changing every 30 seconds. It works only while this sign-in lasts. In the native app it also carries the secret the app makes the code from offline. Made the first time it is asked for on a sign-in.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `codes` | array of object | yes |   |   |
| `codes[].givenName` | string or null | yes |   |   |
| `codes[].own` | boolean | yes |   |   |
| `codes[].payload` | string | yes |   |   |
| `codes[].secret` | string or null | yes |   |   |
| `refreshAt` | string | yes |   |   |
| `algorithm` | object | yes |   |   |
| `algorithm.kind` | `"totp"` | yes |   |   |
| `algorithm.hash` | `"SHA-1"` | yes |   |   |
| `algorithm.periodSeconds` | number | yes |   |   |
| `algorithm.digits` | number | yes |   |   |

## me.deleteAccount

Delete your customer account and ask for your personal data to be erased, signed in within the last 15 minutes (else sign_in_again, for the preview too). Without `confirm` it changes nothing and says what will happen: each subscription you pay ends when the period already paid for ends (nothing refunded, nothing more charged), or with a cooling off you asked for; one that cannot be ended that way (an end date set later, or waiting for payment, unpaid or paused) is left for staff and may charge until they end it. Your unpaid orders are cancelled, and your bookings, tickets and other records stay for staff to decide when they erase your data. With `confirm: true` and the preview's `expect` it does that: you are signed out everywhere at once and can no longer sign in, and staff erase your data, or tell you by email why some of it must be kept, by the due date returned. A preview that changed meanwhile is a conflict: ask for it again.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Actors | `human` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `confirm` | boolean |   | default `false` | Delete now, as the preview said |
| `expect` | string |   | max length 64 | The preview's `expect`; required with confirm: true |

### Output

No fields.

## me.email.change

Ask to change the address you sign in with, as a signed-in customer who signed in within the last 15 minutes (else sign_in_again). A code is emailed to the new address; enter it with me.email.confirm within 15 minutes. Nothing changes until then. Asking again replaces the earlier request. The answer is the same whatever the address: whether it can be used is said only when the code is entered.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `email` | string | yes | min length 3, max length 320 | The new sign-in address |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `newEmail` | string | yes |   | The address the code was sent to |
| `expiresAt` | string | yes |   | When the code stops working |

## me.email.confirm

Finish changing your sign-in address with the code emailed to the new address, as the signed-in customer it was asked for (by you, or by staff for you), signed in within the last 15 minutes (else sign_in_again; the code keeps working). From then on you sign in with the new address, which is also your primary email; the old one is removed from your details and told of the change; every other place you are signed in is signed out. A wrong code five times ends the request. Refused, changing nothing, when the new address is already in use at the business.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `code` | string | yes | min length 1, max length 20 | The emailed code |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `signInEmail` | string | yes |   | Your sign-in address now |
| `sessionsEnded` | number | yes |   | Other sessions signed out |

## me.family

Your family, as a signed-in customer: yourself, the dependants (children) the gym has linked to you, whom you may book for, and the guardians linked to you, each with their name and id. Only live links; the gym's staff make and end them. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `self` | object | yes |   |   |
| `self.personId` | string | yes |   |   |
| `self.name` | string | yes |   |   |
| `dependants` | array of object | yes |   |   |
| `dependants[].personId` | string | yes |   |   |
| `dependants[].name` | string | yes |   |   |
| `guardians` | array of object | yes |   |   |
| `guardians[].personId` | string | yes |   |   |
| `guardians[].name` | string | yes |   |   |

## me.get

Your own Person, as a signed-in customer: your name, primary email and primary phone, and your account's sign-in address (signInEmail, the one the emailed code verified, with signInEmailVerified). Link records kept elsewhere to a customer by signInEmail only: primaryEmail is a contact address staff can change. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `displayName` | string | yes |   |   |
| `givenName` | string or null | yes |   |   |
| `familyName` | string or null | yes |   |   |
| `primaryEmail` | string or null | yes |   |   |
| `primaryPhone` | string or null | yes |   |   |
| `signInEmail` | string | yes |   | The address you sign in with: the one the emailed code verified, lower-cased. Not the Person's contact email (primaryEmail), which staff can change. The only address to trust when linking records kept elsewhere to this customer. |
| `signInEmailVerified` | boolean | yes |   | Whether signInEmail was verified by an emailed code. True for every signed-in customer. |

## me.phone.check

Checks the code a text sent to one of your own numbers (me.phone.startCheck). A match marks the number as checked: your routine texts may go to it.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `number` | string | yes | min length 3, max length 40 | One of your own numbers, as it is in your details |
| `code` | string | yes | pattern `^\d{4,10}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `checked` | boolean | yes |   |   |

## me.phone.startCheck

Sends a code by text to one of your own mobile numbers, to check it is yours. Type it back with me.phone.check within 10 minutes. At most three codes a day.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `number` | string | yes | min length 3, max length 40 | One of your own numbers, as it is in your details |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `started` | `true` | yes |   |   |
| `number` | string | yes |   | The number the code went to, partly hidden |
| `minutes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | How long the code may be typed back |

## me.pin.clear

Remove your PIN, as a signed-in customer: nobody can then check in as you by name and PIN. Your check-in code and cards still work. Clearing when there is none changes nothing.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `cleared` | boolean | yes |   |   |

## me.pin.set

Choose your 4-digit PIN, as a signed-in customer, to check in at the gym's tablet by typing your full name and the PIN when you do not have your phone. The most common PINs (1234, 0000 and the like) are refused. Setting it again replaces it, and turns it back on after too many wrong tries turned it off.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `pin` | string | yes | max length 16 | 4 digits |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `set` | `true` | yes |   |   |

## me.portal

The sections of your account, as a signed-in customer, in the order they show: your orders, agreements, family, payment method (only when you pay a subscription), details and where you are signed in, and each installed pack's section (bookings, memberships and passes, courses, tickets, training) when you, or a child linked to you, have something there. `paysSubscription` says whether you pay a subscription. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sections` | array of object | yes |   |   |
| `sections[].key` | string | yes |   | A base section's key (orders, agreements, family, payment, details, devices), or a pack's as &lt;pack&gt;.&lt;key&gt; |
| `sections[].pack` | string or null | yes |   | The pack the section is from; null for a base section |
| `sections[].label` | string | yes |   |   |
| `sections[].order` | number | yes |   | Lower first: a pack's sections come before the base ones |
| `sections[].web` | object or null | yes |   | The block of the client app that draws a pack's section, and its component |
| `sections[].web.block` | string | yes |   |   |
| `sections[].web.export` | string | yes |   |   |
| `sections[].native` | object or null | yes |   | The block of the client app that draws a pack's section, and its component |
| `sections[].native.block` | string | yes |   |   |
| `sections[].native.export` | string | yes |   |   |
| `paysSubscription` | boolean | yes |   | Whether you pay a subscription that has not ended |

## me.sessions.list

The places you are signed in, as a signed-in customer: each session's id, whether it is a browser or an app on a device (with the device's name), when it began, when it was last used and when it expires, and which one is this one. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].kind` | `"browser"`, `"device"` | yes |   |   |
| `items[].deviceName` | string or null | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].lastActiveAt` | string | yes |   |   |
| `items[].expiresAt` | string or null | yes |   |   |
| `items[].current` | boolean | yes |   |   |

## me.sessions.revoke

Sign out one of your sessions, as a signed-in customer, by its id from me.sessions.list. A session that is not yours is not found.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 128 | Session id from me.sessions.list |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `revoked` | `true` | yes |   |   |

## me.signOut

Sign out of this session, as a signed-in customer. Your other sessions stay signed in (end them with me.sessions.revoke).

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `signedOut` | boolean | yes |   |   |

## me.update

Change your own name or primary phone, as a signed-in customer. Only the fields you pass change; pass null to clear one. Your email cannot be changed here: change your sign-in address with me.email.change and me.email.confirm. Returns your Person.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `customer` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `displayName` | string |   | min length 1, max length 200 |   |
| `givenName` | string or null |   |   |   |
| `familyName` | string or null |   |   |   |
| `primaryPhone` | string or null |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `displayName` | string | yes |   |   |
| `givenName` | string or null | yes |   |   |
| `familyName` | string or null | yes |   |   |
| `primaryEmail` | string or null | yes |   |   |
| `primaryPhone` | string or null | yes |   |   |
