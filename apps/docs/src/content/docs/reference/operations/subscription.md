---
title: "subscription.* operations"
description: "The core operations named subscription.*"
sidebar:
  label: "subscription"
editUrl: false
---

## subscription.cancel

End a subscription when its current paid period (or trial) ends: nothing more is charged, and what it gives lasts until then. A signed-in customer cancels their own; staff any, with the subscriptions:manage permission. Nothing is refunded (a period's refund is order.refund). It can be undone until the period ends (subscription.resume). Asked of the payment provider: the subscription shows it once the provider confirms. Staff can instead end it at once (`now: true`): nothing more is charged, nothing is refunded and what it gives stops when the provider confirms; a customer cannot. A person decides, not an AI assistant.

|  |  |
| --- | --- |
| Permission | `subscriptions:manage` |
| Risk | `write` |
| Audiences | `staff`, `customer` |
| Actors | `human` |
| Also | host-internal (`hostInternal`) |
| Staff-only input | `now` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Subscription id (sbs_…) |
| `reason` | string |   | min length 1, max length 500, default `"Cancelled by the payer"` | Why |
| `now` | boolean |   | default `false` | Staff only: end it now instead of when its period ends |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `requested` | `true` | yes |   | Asked of the provider; the subscription shows it once the provider confirms |

## subscription.change

Move a subscription to another plan of the same kind (a membership from 3 a week to unlimited). A dearer plan is an upgrade: it takes effect now, and the payment provider charges the rest of the current period at once, prorated; the new plan applies only once that charge is paid, so nothing is given that was not paid for. A cheaper (or same-priced) plan is a downgrade: nothing is refunded or prorated, the member keeps the current plan until its period ends, and the new price is charged from the next period. What the subscription grants (a membership's classes) follows the plan when it takes effect. Only an active subscription not set to end, with no other change waiting. A signed-in customer changes their own, to a plan on sale; staff any, with subscriptions:manage. Asked of the payment provider: the subscription shows the change once the provider confirms it. A person decides, not an AI assistant.

|  |  |
| --- | --- |
| Permission | `subscriptions:manage` |
| Risk | `write` |
| Audiences | `staff`, `customer` |
| Actors | `human` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Subscription id (sbs_…) |
| `planId` | string | yes | min length 1, max length 64 | The plan to move to (a record of the same object) |
| `reason` | string |   | min length 1, max length 500, default `"Changed by the payer"` | Why |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `changeId` | string | yes |   |   |
| `kind` | `"upgrade"`, `"downgrade"` | yes |   |   |
| `effectiveAt` | string or null | yes |   | When a downgrade takes effect (the period's end); null for an upgrade: once paid |
| `amount` | number | yes |   | The new plan's price per period, minor units, tax included |
| `currency` | string | yes |   |   |
| `asked` | `"sent"`, `"pending"`, `"unknown"`, `"not_needed"` | yes |   | sent: the provider was asked; unknown: it may or may not have been (its next event decides); not_needed: the same price, nothing to ask |
| `requested` | `true` | yes |   |   |

## subscription.change.withdraw

Withdraw a subscription's plan change that has not taken effect: one stuck waiting for the payment provider, one whose outcome is unknown, or a downgrade waiting for its period (undo it). A downgrade the provider may already show is put back there: the old price from the next invoice, nothing prorated. An upgrade's pending charge is voided at the provider, so it can no longer be paid (with nothing pending there, it was voided or expired already). The change closes only once the provider is asked; refused or unknown, it stays open and is asked again. A pause is ended with subscription.unpause. Staff only, with subscriptions:manage. A person decides, not an AI assistant.

|  |  |
| --- | --- |
| Permission | `subscriptions:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Subscription id (sbs_…) |
| `reason` | string | yes | min length 1, max length 500 | Why |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `changeId` | string | yes |   |   |
| `asked` | `"sent"`, `"pending"`, `"unknown"`, `"not_needed"` | yes |   |   |

## subscription.coolingOff

Whether each subscription may be ended in its cooling-off period for a full refund: the business's setting (whole days, 0 off), counted from when the payment provider confirmed it to the end of the last day in the business's time zone, for a new member's membership only (not a pass, not one moved over with a continuation offer), once per member. Also says how far a cooling off asked for has got and where its refunds are. The host decides; an app shows the button only when `offered`. A signed-in customer asks about the subscriptions they pay for only; another's is not found. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string | yes | at least 1, at most 20 | Up to 20 subscriptions |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].subscriptionId` | string | yes |   |   |
| `items[].offered` | boolean | yes |   | The payer may end it now for a full refund (cooling off) |
| `items[].why` | `"not_covered"`, `"off"`, `"continuation"`, `"ended"`, `"window_passed"`, `"used"`, `"nothing_paid"` or null | yes |   | Why not: not_covered (the plan has no cooling off), off (the business set none), continuation (not started here as a new member), ended, window_passed, used (once per member), nothing_paid (a free trial: an ordinary cancel ends it at no charge) |
| `items[].days` | number | yes |   | The cooling-off days that apply; 0 when none |
| `items[].until` | string or null | yes |   | The last day of the window (YYYY-MM-DD, the business's time zone) |
| `items[].endsAt` | string or null | yes |   | The moment the window closes |
| `items[].refund` | number | yes |   | What a cooling off asked now owes back, not yet refunded, in minor units |
| `items[].currency` | string | yes |   |   |
| `items[].coolOff` | object or null | yes |   | A cooling off asked for, and how far it has got |
| `items[].coolOff.state` | `"asked"`, `"ended"`, `"lapsed"` | yes |   | asked: open until its deadline (any end of the subscription by then is its end); ended: it ended (or staff finished it) and its refunds are owed; lapsed: its deadline passed (or its waiting cancel was turned down, or the end was not its): nothing owed as cooled off, and the ordinary cancel works again |
| `items[].coolOff.asked` | `"sent"`, `"pending"`, `"unknown"`, `"refused"` or null | yes |   | What came of the latest ask of the provider |
| `items[].coolOff.askedBy` | `"payer"`, `"staff"` | yes |   |   |
| `items[].coolOff.askedAt` | string | yes |   |   |
| `items[].coolOff.deadline` | string | yes |   | Open until then: the ask plus the approval expiry (7 days) |
| `items[].coolOff.endedAt` | string or null | yes |   |   |
| `items[].coolOff.finished` | boolean | yes |   | Staff finished a lapsed one |
| `items[].coolOff.finishing` | `"asked"`, `"sent"`, `"pending"`, `"unknown"`, `"stuck"` or null | yes |   | Staff asked to finish a lapsed one, not yet confirmed: asked or unknown (the host asks the provider again), sent (waiting for the provider's end), pending (waiting for a person at the payments gatekeeper), stuck (it could not be done; admins were told) |
| `items[].coolOff.waiting` | boolean | yes |   | A cancel of it waits for a person at the payments gatekeeper: nobody may ask again until it is approved or turned down |
| `items[].coolOff.lapsedBecause` | `"deadline"`, `"action"`, `"end_time"`, `"used"` or null | yes |   |   |
| `items[].coolOff.askAgain` | boolean | yes |   | The caller may ask the provider again now (the member inside the period, staff before the deadline), or (staff) finish a lapsed one |
| `items[].coolOff.open` | boolean | yes |   | Open, before its deadline: the ordinary cancel waits |
| `items[].coolOff.staffTold` | boolean | yes |   | Admins were told it is stuck or lapsed |
| `items[].coolOff.paid` | number | yes |   | What it owes (or would, if it ended now): paid on or before the end of the period, plus paid after the ask and by the end, in minor units |
| `items[].coolOff.refunded` | number | yes |   | What has been refunded of that so far, in minor units |
| `items[].coolOff.refunds` | `"waiting"`, `"refunded"`, `"held"` or null | yes |   | Once ended: waiting (each refund waits for a person who may refund), refunded, or held (a refund was not approved or could not be asked: staff refund it from the order) |

## subscription.coolOff

End a subscription in its cooling-off period, for a full refund of what was paid in it (subscription.coolingOff says whether it may be, and what it owes). Ended at the payment provider now: nothing more is charged, and what it gives stops once the provider confirms. Then each order paid up to the end of the period, and between the ask and the end, is owed back in full, whatever was used; each waits for a person with orders:refund to approve it. The bookings ahead the membership paid for are cancelled as the business's. Refused for a plan with no cooling off, a membership moved over with a continuation offer, a member who has cooled off before, while nothing has been paid (a free trial: cancel instead), and after the period unless one was asked in it. An ask inside the period opens it for 7 days; any end in that time is the cooling off's, and at its deadline it lapses (the ordinary cancel works again). A signed-in customer ends their own (the one they pay for, a child's included) and asks again only inside the period; staff any, with subscriptions:manage, ask again until the deadline, and finish a lapsed one (only what was paid in the period is owed, once the provider confirms the membership ended). Each ask reads the provider first and is a new request to it; nothing is done twice. Refused while a cancel of it waits for a person at the payments gatekeeper. A person decides, never an AI assistant.

|  |  |
| --- | --- |
| Permission | `subscriptions:manage` |
| Risk | `write` |
| Audiences | `staff`, `customer` |
| Actors | `human` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Subscription id (sbs_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"asked"`, `"ended"`, `"lapsed"` | yes |   | asked: open; ended: it ended (or was finished) and its refunds are owed; lapsed: staff asked to finish it and the provider has not confirmed the end yet |
| `asked` | `"sent"`, `"pending"`, `"unknown"` or null | yes |   | sent: the provider was asked to end it; pending: it waits for a person at the payments gatekeeper; unknown: it may or may not have reached it (its next event decides; staff are told) |
| `refund` | number | yes |   | Paid and not refunded so far, in minor units: owed back |
| `currency` | string | yes |   |   |

## subscription.coolOffRelease

The host's follow-up for a membership ended in its cooling-off period: cancels the next bookings ahead it paid for, as the business's, until none is left. The host's own cron only.

|  |  |
| --- | --- |
| Permission | `subscriptions:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Subscription id (sbs_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `released` | number | yes |   |   |
| `left` | boolean | yes |   |   |

## subscription.coolOffSweep

The host's minute step for cooling offs: one whose call to the payment provider was lost or never made is resolved from the provider's read or asked again (the same ask) until its deadline; at the deadline, or once its latest waiting cancel is rejected or expires with none still waiting, or once its holder has used theirs on another, an open one lapses (every waiting cancel rejected, admins told once); staff's finish of a lapsed one is asked again, waited for, or marked stuck with admins told; then the summary emails. Bounded; nothing when nothing is due. The host's own cron only.

|  |  |
| --- | --- |
| Permission | `subscriptions:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `resolved` | number | yes |   |   |
| `asked` | number | yes |   |   |
| `told` | number | yes |   |   |
| `unread` | number | yes |   |   |
| `lapsed` | number | yes |   |   |
| `mailed` | number | yes |   |   |

## subscription.get

Get one subscription: its plan, price per period, state (trial, active, past due, ended…), the current period and whether it ends when that period does. A signed-in customer gets the subscriptions they pay for only; anyone else's is not found. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Subscription id (sbs_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"incomplete"`, `"expired"`, `"trialing"`, `"active"`, `"past_due"`, `"unpaid"`, `"paused"`, `"ended"` | yes |   |   |
| `planObject` | string | yes |   |   |
| `planId` | string | yes |   |   |
| `planTitle` | string | yes |   |   |
| `amount` | number | yes |   | The price of one period, in the currency's minor unit, tax included |
| `currency` | string | yes |   |   |
| `interval` | `"week"`, `"month"`, `"year"` | yes |   |   |
| `taxed` | boolean | yes |   |   |
| `trialEnd` | string or null | yes |   |   |
| `currentPeriodStart` | string or null | yes |   |   |
| `currentPeriodEnd` | string or null | yes |   | When the current paid period (or trial) ends: the next charge |
| `cancelAtPeriodEnd` | boolean | yes |   | Set to end when the current period ends |
| `cancelAt` | string or null | yes |   | A date it is set to end on at the provider (its dashboard), or null |
| `canceledAt` | string or null | yes |   |   |
| `endedAt` | string or null | yes |   |   |
| `actionUrl` | string or null | yes |   | The provider's page to confirm a renewal on, while one waits |
| `createdAt` | string | yes |   |   |
| `holderPersonId` | string or null | yes |   |   |
| `payerPersonId` | string or null |   |   |   |
| `email` | string or null |   |   |   |
| `endReason` | string or null |   |   |   |
| `failingSince` | string or null |   |   |   |
| `change` | object or null |   |   | A plan change or a pause asked for and not yet over, or the pause it is in |
| `change.id` | string | yes |   |   |
| `change.kind` | `"upgrade"`, `"downgrade"`, `"pause"` | yes |   |   |
| `change.state` | `"requested"`, `"waiting"`, `"applied"`, `"lapsed"`, `"withdrawn"` | yes |   | requested: asked of the provider (an upgrade waits for its charge to be paid); waiting: a downgrade from the next period, or a pause not yet started; applied: the pause it is in; lapsed: an upgrade whose charge was never paid |
| `change.toPlanId` | string or null | yes |   |   |
| `change.toPlanTitle` | string or null | yes |   |   |
| `change.toAmount` | number or null | yes |   |   |
| `change.pauseFrom` | string or null | yes |   |   |
| `change.pauseUntil` | string or null | yes |   | When a pause ends and the provider charges again |
| `change.effectiveAt` | string or null | yes |   | When a downgrade takes effect (its period's end) |
| `change.requestedAt` | string | yes |   |   |
| `change.callOutcome` | `"sent"`, `"pending"`, `"unknown"`, `"refused"` or null | yes |   | What came of asking the provider: unknown means it may or may not have reached it, and the provider's next event decides; staff can withdraw it |
| `change.actionUrl` | string or null | yes |   | The provider's page to confirm an upgrade's charge, while it waits |
| `change.endOutcome` | `"sent"`, `"pending"`, `"unknown"`, `"refused"` or null | yes |   | What came of ending a pause early: refused or unknown, ask again |

## subscription.list

A page of subscriptions, newest first unless sorted otherwise. Filter on state, planObject, planId, payerPersonId, holderPersonId, cancelAtPeriodEnd, currentPeriodEnd, failingSince, changeKind, changeState, pauseUntil. Each shows its plan change or pause (`change`). A signed-in customer sees the ones they pay for only. Pass nextCursor back as cursor for the next page. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filter` | any |   |   |   |
| `sort` | object |   |   |   |
| `sort.field` | string | yes | min length 1, max length 64 |   |
| `sort.direction` | `"asc"`, `"desc"` |   | default `"asc"` |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].state` | `"incomplete"`, `"expired"`, `"trialing"`, `"active"`, `"past_due"`, `"unpaid"`, `"paused"`, `"ended"` | yes |   |   |
| `items[].planObject` | string | yes |   |   |
| `items[].planId` | string | yes |   |   |
| `items[].planTitle` | string | yes |   |   |
| `items[].amount` | number | yes |   | The price of one period, in the currency's minor unit, tax included |
| `items[].currency` | string | yes |   |   |
| `items[].interval` | `"week"`, `"month"`, `"year"` | yes |   |   |
| `items[].taxed` | boolean | yes |   |   |
| `items[].trialEnd` | string or null | yes |   |   |
| `items[].currentPeriodStart` | string or null | yes |   |   |
| `items[].currentPeriodEnd` | string or null | yes |   | When the current paid period (or trial) ends: the next charge |
| `items[].cancelAtPeriodEnd` | boolean | yes |   | Set to end when the current period ends |
| `items[].cancelAt` | string or null | yes |   | A date it is set to end on at the provider (its dashboard), or null |
| `items[].canceledAt` | string or null | yes |   |   |
| `items[].endedAt` | string or null | yes |   |   |
| `items[].actionUrl` | string or null | yes |   | The provider's page to confirm a renewal on, while one waits |
| `items[].createdAt` | string | yes |   |   |
| `items[].holderPersonId` | string or null | yes |   |   |
| `items[].payerPersonId` | string or null |   |   |   |
| `items[].email` | string or null |   |   |   |
| `items[].endReason` | string or null |   |   |   |
| `items[].failingSince` | string or null |   |   |   |
| `items[].change` | object or null |   |   | A plan change or a pause asked for and not yet over, or the pause it is in |
| `items[].change.id` | string | yes |   |   |
| `items[].change.kind` | `"upgrade"`, `"downgrade"`, `"pause"` | yes |   |   |
| `items[].change.state` | `"requested"`, `"waiting"`, `"applied"`, `"lapsed"`, `"withdrawn"` | yes |   | requested: asked of the provider (an upgrade waits for its charge to be paid); waiting: a downgrade from the next period, or a pause not yet started; applied: the pause it is in; lapsed: an upgrade whose charge was never paid |
| `items[].change.toPlanId` | string or null | yes |   |   |
| `items[].change.toPlanTitle` | string or null | yes |   |   |
| `items[].change.toAmount` | number or null | yes |   |   |
| `items[].change.pauseFrom` | string or null | yes |   |   |
| `items[].change.pauseUntil` | string or null | yes |   | When a pause ends and the provider charges again |
| `items[].change.effectiveAt` | string or null | yes |   | When a downgrade takes effect (its period's end) |
| `items[].change.requestedAt` | string | yes |   |   |
| `items[].change.callOutcome` | `"sent"`, `"pending"`, `"unknown"`, `"refused"` or null | yes |   | What came of asking the provider: unknown means it may or may not have reached it, and the provider's next event decides; staff can withdraw it |
| `items[].change.actionUrl` | string or null | yes |   | The provider's page to confirm an upgrade's charge, while it waits |
| `items[].change.endOutcome` | `"sent"`, `"pending"`, `"unknown"`, `"refused"` or null | yes |   | What came of ending a pause early: refused or unknown, ask again |
| `nextCursor` | string or null | yes |   |   |

## subscription.offer.export

The continuation offers report as a CSV file (every offer, or those of one status): email, name, the old platform's reference, paid up to, status, when it was taken, when the new subscription starts charging, and the subscription. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"open"`, `"taken"`, `"expired"`, `"withdrawn"` |   |   |   |
| `planObject` | string |   | min length 1, max length 80 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filename` | string | yes |   |   |
| `csv` | string | yes |   |   |
| `rowCount` | number | yes |   |   |

## subscription.offer.import

Import up to 50 continuation offers for one plan: people subscribed on another platform, each an email address and the date they have paid up to there. Each person signs in as that address and subscribes again, free until the date, then charged; never a trial on top. Addresses are matched to the one live person who has them (import the people first; none is created). The address is the key: a re-run changes nothing, a changed date updates an offer not yet taken, and an offer taken or withdrawn since is a conflict, kept. A date is the start of that day in the organisation's time zone. dryRun checks everything and says what would happen, writing nothing. invite also invites each address to sign in (customer.invite; needs users:manage). A person's door: cos subscriptions offers import runs it.

|  |  |
| --- | --- |
| Permission | `subscriptions:manage` |
| Risk | `bulk-write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `plan` | object | yes |   |   |
| `plan.object` | string | yes | min length 1, max length 80 | The plan's object (one sold every period) |
| `plan.id` | string | yes | min length 1, max length 64 | The plan |
| `rows` | array of object | yes | at least 1, at most 50 |   |
| `rows[].email` | string | yes | max length 320 |   |
| `rows[].freeUntil` | string | yes | max length 40 | The date they have paid up to (YYYY-MM-DD), or a moment with its offset |
| `rows[].reference` | string |   | max length 200 | The other platform's reference for the old subscription |
| `dryRun` | boolean |   | default `false` |   |
| `invite` | boolean |   | default `false` | Invite each matched address to sign in as a customer (needs users:manage) |
| `reissue` | boolean |   | default `false` | Give an address whose offer staff withdrew a fresh offer (the withdrawn one stays as it was). Without it, such a row is a conflict. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `results` | array of object | yes |   |   |
| `results[].email` | string | yes |   |   |
| `results[].outcome` | `"created"`, `"updated"`, `"unchanged"`, `"unmatched"`, `"several_people"`, `"invalid"`, `"conflict"` | yes |   |   |
| `results[].offerId` | string or null | yes |   |   |
| `results[].personId` | string or null | yes |   |   |
| `results[].freeUntil` | string or null | yes |   |   |
| `results[].note` | string or null | yes |   |   |
| `results[].signIn` | `"invited"`, `"invited_before"`, `"has_account"`, `"invite_refused"` or null | yes |   |   |

## subscription.offer.list

The continuation offers report, by address: who has taken their offer (with the date their new subscription starts charging), so the company ends exactly those old subscriptions on the other platform at their period's end, and who has not, to chase before their date. Filter by status (taken, open, expired, withdrawn) and plan object. counts gives every status's total. Pass nextCursor back as cursor for the next page. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"open"`, `"taken"`, `"expired"`, `"withdrawn"` |   |   |   |
| `planObject` | string |   | min length 1, max length 80 |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].email` | string | yes |   |   |
| `items[].personId` | string or null | yes |   |   |
| `items[].personName` | string or null | yes |   |   |
| `items[].planObject` | string | yes |   |   |
| `items[].planId` | string | yes |   |   |
| `items[].reference` | string or null | yes |   |   |
| `items[].freeUntil` | string | yes |   | The date they paid up to elsewhere: free until then |
| `items[].status` | `"open"`, `"taken"`, `"expired"`, `"withdrawn"` | yes |   | taken (end their old subscription), open (not yet: chase them before the date), expired (the date passed untaken), withdrawn |
| `items[].page` | `"open"`, `"completing"`, `"unconfirmed"` or null | yes |   | A checkout from it, as the provider says now: open, completing (completed; being confirmed) or unconfirmed (the provider could not be asked); null: none |
| `items[].takenAt` | string or null | yes |   |   |
| `items[].subscriptionId` | string or null | yes |   |   |
| `items[].subscriptionState` | string or null | yes |   |   |
| `items[].chargesFrom` | string or null | yes |   | When the new subscription starts charging (taken offers only) |
| `items[].chargedFromStart` | boolean | yes |   | Taken with under 48 hours left, so charged at once with no free time |
| `items[].subscribedWithout` | object or null | yes |   | Not taken, but subscribed to the plan another way (charged, no free time) |
| `items[].subscribedWithout.id` | string | yes |   |   |
| `items[].subscribedWithout.state` | string | yes |   |   |
| `items[].subscribedWithout.createdAt` | string | yes |   |   |
| `items[].withdrawnAt` | string or null | yes |   |   |
| `items[].withdrawReason` | string or null | yes |   |   |
| `items[].reissuedAs` | string or null | yes |   | A withdrawn offer reissued: the fresh offer |
| `items[].createdAt` | string | yes |   |   |
| `nextCursor` | string or null | yes |   |   |
| `counts` | object | yes |   |   |
| `counts.open` | number | yes |   |   |
| `counts.taken` | number | yes |   |   |
| `counts.expired` | number | yes |   |   |
| `counts.withdrawn` | number | yes |   |   |

## subscription.offer.mine

The signed-in customer's own continuation offers they can still take: a plan, free until the date they have paid up to on another platform, then charged. Take one with subscription.start { offerId }. chargedNow: under 48 hours are left, so taking it now is charged at once. askUs: its plan is no longer on sale and there is no single other to follow to; the member asks the company. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `offers` | array of object | yes |   |   |
| `offers[].id` | string | yes |   |   |
| `offers[].planObject` | string | yes |   |   |
| `offers[].planId` | string | yes |   |   |
| `offers[].freeUntil` | string | yes |   |   |
| `offers[].chargedNow` | boolean | yes |   |   |
| `offers[].askUs` | boolean | yes |   | No plan on sale to take it on: ask the company (it has been told) |

## subscription.offer.withdraw

Withdraw a continuation offer that has not been taken, with a reason: it can no longer be taken. A checkout already open from it can still be completed at the provider; staff are told if it is. A person decides, not an AI assistant.

|  |  |
| --- | --- |
| Permission | `subscriptions:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Offer id (sof_…) |
| `reason` | string | yes | min length 1, max length 500 | Why |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `pageOpen` | boolean | yes |   | A checkout from it was open and may still be completed |

## subscription.pause

Pause a subscription for a set time (a membership frozen for an injury or travel): from now or a later moment until a moment, within the plan's shortest and longest pause. While it is paused the payment provider charges nothing, and what the subscription gives stops (no classes, no access); on the end date the provider resumes it and charges a new period, less the unused time of the period it was paused in. Only an active subscription not set to end, on a plan that allows pauses, with no other change waiting. Staff only, with subscriptions:manage; a member asks staff. Asked of the payment provider: the subscription shows it paused once the provider confirms. A person decides, not an AI assistant.

|  |  |
| --- | --- |
| Permission | `subscriptions:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Subscription id (sbs_…) |
| `from` | string |   | max length 40 | When the pause starts (ISO 8601, later than now); left out: now |
| `until` | string | yes | min length 1, max length 40 | When it ends and charging starts again (ISO 8601) |
| `reason` | string | yes | min length 1, max length 500 | Why (an injury, travel) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `changeId` | string | yes |   |   |
| `from` | string or null | yes |   |   |
| `until` | string | yes |   |   |
| `asked` | `"sent"`, `"pending"`, `"unknown"` | yes |   |   |
| `requested` | `true` | yes |   |   |

## subscription.portal

Open the payment provider's customer portal for the signed-in customer: the card they pay with, their billing details and past invoices. Cancelling and plan changes are not there (subscription.cancel). The address is short-lived and opens in its own page, never a frame.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `customer` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `returnUrl` | string | yes | min length 1, max length 2000 | Where the portal's back link goes |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `url` | string | yes |   |   |

## subscription.resume

Keep a subscription going that was set to end when its period does, before that happens: the provider charges the next period as usual. A signed-in customer resumes their own; staff any, with the subscriptions:manage permission. An end date set at the provider another way is refused: staff change it there. Asked of the payment provider: the subscription shows it once the provider confirms. A person decides, not an AI assistant.

|  |  |
| --- | --- |
| Permission | `subscriptions:manage` |
| Risk | `write` |
| Audiences | `staff`, `customer` |
| Actors | `human` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Subscription id (sbs_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `requested` | `true` | yes |   | Asked of the provider; the subscription shows it once the provider confirms |

## subscription.start

Start a subscription to a plan (a record of an object sold every week, month or year), as a signed-in customer, a guest (with an email address) or staff for someone. Opens the payment provider's own page, which takes the card; the provider charges each period on its own schedule, after the plan's free trial when it has one. A trial is one per person per plan, and only for a signed-in customer (or staff with subscriptions:manage starting it for a person): a guest is charged from the start, and `noTrial` says why no trial was given. Starting again while the page you opened with a trial is still open gives that page. A signed-in customer with a continuation offer (moving their subscription from another platform) takes it with `offerId`: free until their paid-up date, then charged, with no trial on top; with under 48 hours left it is charged at once. Nobody starts one without the agreements the business needs for the plan (its terms, a waiver): refused with rule agreements_due and the documents while any is due, a continuation offer included (a guest passes their acceptances in `agreements`; a signed-in customer agrees first; staff send a link or record paper). The host prices it from the plan: no price is sent. Coming back to `returnUrl` changes nothing: the subscription exists once the provider confirms it. Returns the page's address and what will be charged, in minor units.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`) |
| Staff-only input | `holderPersonId` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `plan` | object | yes |   |   |
| `plan.object` | string | yes | min length 1, max length 80 | The plan's object |
| `plan.id` | string | yes | min length 1, max length 64 | The plan |
| `returnUrl` | string | yes | min length 1, max length 2000 | Where the payer comes back to |
| `email` | string |   | max length 320 | The payer's email. Required unless the caller is a signed-in customer. |
| `offerId` | string |   | min length 1, max length 64 | Take your continuation offer (subscription.offer.mine): free until its date, then charged. A signed-in customer's own offer only. |
| `holderPersonId` | string |   | min length 1, max length 64 | Staff only: the Person who holds what it gives (a child whose parent pays), when not the payer. The payer, named by email, is billed; the trial and access are the holder's. |
| `agreements` | array of object |   | at most 20 | A visitor without an account only: what they agreed to on the way to paying, one entry per document the host says is due (each document's current version, the name they typed, a signature for a document agreed to by drawing, every answer for a health form). A signed-in customer agrees first (me.agreements.accept); staff never agree for anyone. |
| `agreements[].versionId` | string | yes | min length 1, max length 64 | The version's id (agv_…) the visitor read |
| `agreements[].typedName` | string | yes | min length 1, max length 200 | The name the person typed beside the box: personal data, never shown to an AI |
| `agreements[].signature` | object |   |   | A drawn signature as strokes in a 1000 by 400 box: personal data |
| `agreements[].signature.width` | `1000` | yes |   |   |
| `agreements[].signature.height` | `400` | yes |   |   |
| `agreements[].signature.strokes` | array of array of array of any | yes | at least 1, at most 30 |   |
| `agreements[].answers` | array of object |   | at least 1, at most 40 | A health form's answers: health information, never shown to an AI or logged |
| `agreements[].answers[].key` | string | yes | min length 1, max length 40 |   |
| `agreements[].answers[].yes` | boolean | yes |   |   |
| `agreements[].answers[].note` | string |   | max length 1000 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `subscriptionId` | string | yes |   |   |
| `url` | string | yes |   | The provider's page |
| `amount` | number | yes |   |   |
| `currency` | string | yes |   |   |
| `interval` | `"week"`, `"month"`, `"year"` | yes |   |   |
| `trialDays` | number or null | yes |   | The free days given; null: charged from the start |
| `freeUntil` | string or null | yes |   | Free until this moment (a continuation offer taken), then charged; else null |
| `noTrial` | `"sign_in"`, `"used"`, `"permission"`, `"held"`, `"unconfirmed"`, `"continuation"` or null | yes |   | Why the plan's trial was not given: sign_in (a guest: only a signed-in customer gets a trial), used (one trial per person per plan, had already), permission (staff without subscriptions:manage), held (another page with the trial is open for this person), unconfirmed (the payment provider could not say whether an earlier page was completed; try again later for the trial), continuation (this person has an open continuation offer on this plan, or a subscription from one still running: no trial on top of it). Null otherwise |
| `expiresAt` | string or null | yes |   |   |

## subscription.unpause

End a subscription's pause now, before its date: the payment provider resumes it and charges a new period from today, and what it gives starts again once the provider confirms. Or withdraw a pause asked for later that has not started. Staff only, with subscriptions:manage. A person decides, not an AI assistant.

|  |  |
| --- | --- |
| Permission | `subscriptions:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Subscription id (sbs_…) |
| `reason` | string |   | min length 1, max length 500, default `"Back early"` | Why |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `asked` | `"sent"`, `"pending"`, `"unknown"` | yes |   | unknown: it may or may not have reached the provider; ask again if it stays paused |
| `requested` | `true` | yes |   |   |
