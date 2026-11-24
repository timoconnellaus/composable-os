# ADR 0713: Deleting an account: the preview and its consequences

Status: accepted, 2026-11-24 (stage 48, build step 6; interview decision 1). Amends ADR
[0402](0402-staff-and-customers.md). Builds on ADRs [0485](0485-recurring-billing-the-provider-runs-the-schedule.md) and
[0487](0487-the-payer-and-the-holder.md); relates to issue
[#293](https://github.com/timoconnellaus/composable-os/issues/293).

## Context

`me.deleteAccount` disabled the account, ended its sessions and opened an erase request (ADR 0402).
A membership the member paid kept billing until staff acted, and still after erase (#293); an
unpaid order stayed open. The member was not told any of this before they pressed the button. The
owner decided (decision 1) that deleting an account stops a monthly membership they pay at the end
of the period already paid for, and refunds nothing: what cancelling does today.

## Decision

- **Two calls, one operation.** `me.deleteAccount` without `confirm` changes nothing and answers
  what will happen; with `confirm: true` and the preview's `expect` it does exactly that. `expect`
  is a fingerprint of the ids acted on and the counts left (not a secret): when anything of it
  changed between the two calls, the confirm is a conflict (`preview_changed`) and changes
  nothing. Whether a subscription is already ending is left out of the fingerprint, since the
  provider's event can say so between the calls and it changes nothing the member agreed to.
- **Subscriptions they pay end at the period's end.** Every subscription whose payer is the
  member (ADR 0487) and that still runs (`trialing`, `active`, `past_due`) is asked of the
  provider to end when its paid period ends: the same gatekeeper call as `subscription.cancel`,
  reason "The payer deleted their account". Nothing is refunded and nothing new is charged. One
  already set to end is not asked again. A subscription someone else pays for them is not theirs
  to end and is not touched.
- **The provider first, then the batch.** The provider's calls are made before the batch: a
  refusal there throws, and the account, its sessions and its orders stay as they were (a
  subscription already asked keeps its end date; the member can resume it). Then one batch, with
  the audit row: each unpaid order cancelled, the account disabled, every session ended, the
  erase request opened. The record shows a subscription's end once the provider's event arrives,
  as for any cancel.
- **Unpaid orders are cancelled.** Each order of theirs still `pending` (nothing paid), other than
  a subscription period's order, is cancelled with the code a customer's own `order.cancel` runs
  (the engine's customer move, holds given back). A part-paid order is staff's: a customer cannot
  cancel one, and it is counted for staff.
- **What stays for staff is counted, never changed.** The preview and the admins' notice list:
  the member's open records of every object that declares a customer (a booking, a ticket, a
  course place), by object, where open means not in a state no move leaves; part-paid orders;
  and dependants left with no other live guardian (ADR 0540). Core names no pack: the objects come
  from the registry's customer declarations, counted at the visibility seam
  (`countOwnOpenRecords`, which reads the customer field the seam itself scopes by). Staff decide
  them at erase, as before.
- **Admins are told what was left.** The erase request's notice (ADR 0402) adds what stays for
  them, which subscriptions end and which orders were cancelled, in counts and labels only.
- **Bounded.** The preview reads a fixed number of statements (ten in the test) however many
  orders and records the member has: one per kind, the customer objects' counts in one statement
  per fifty objects. At most twenty subscriptions are ended and twenty orders cancelled in one
  deletion; any more are counted for staff and said so. The confirm with twenty orders runs 262
  statements, none with more than twenty bound variables.

## Consequences

- A client calling `me.deleteAccount` with `{}` now gets the preview, not the deletion: the
  account blocks (stage 48 step 7) show it and confirm.
- **#293 stays open** for what erase itself does to a subscription still running: erase staff
  start without the member deleting, a subscription paid by someone else, or one resumed after
  the deletion. A member's own deletion now sets theirs to end before the request opens, so by the
  erase's due date it has ended or is ending.
- A sign-in within the last 15 minutes, which the spec requires before deleting, is stage 48
  step 2's (`sign_in_again`), applied to this operation there.
- Tried against the payments gatekeeper's test double only; not yet against the provider's test
  mode.
