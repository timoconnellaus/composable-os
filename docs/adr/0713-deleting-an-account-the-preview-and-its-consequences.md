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
  reason "The payer deleted their account". Nothing is refunded and nothing new is charged. Each
  is shown with how it ends (`ending`): `period_end` (asked now), `already` (already set to end by
  then: its own cancel, or an end date at the provider on or before the paid time's end; not
  asked again), or `cooling_off` (a cooling off under way ends it with its refund, ADR 0647; not
  asked). A subscription someone else pays for them is not theirs to end and is not touched.
- **What deleting cannot end is said, not hidden.** An end date set at the provider after the
  period paid for keeps charging until then, and only staff move it there (`cancelAtPeriodEnd`
  refuses it, as `subscription.resume` does); a subscription waiting for a first payment, unpaid
  or paused cannot be ended at its period's end; and any beyond the twenty one deletion ends. Each
  is listed in `leftForStaff.subscriptions` with why, and the admins' notice says it may still
  charge until they end it at the provider.
- **The cooling off's rule is the host's, on every path.** The `cooling_off_open` refusal moved
  from `subscription.cancel`'s handler into the host's own `cancelAtPeriodEnd` and `cancelNow`, so
  no path that ends a subscription can end one under a cooling off as an ordinary end.
- **The orders, then the provider, then the batch.** Each unpaid order's cancel is worked out and
  queued first, so an order the engine refuses stops the deletion before the provider is asked
  anything. Then the provider is asked, before the batch: a refusal there throws and the batch is
  not run. With two or more subscriptions, one asked before the refusal stays set to end (the
  member can resume it, or confirm again: the fingerprint leaves out how a subscription ends, so
  a retry goes through). Two confirms at once both ask the provider for the same end before the
  second's batch fails on the order's version (`core_order_stale`): the same request twice, which
  changes nothing more. Then one batch, with the audit row: each unpaid order cancelled, the
  account disabled, every session ended (web and app), the erase request opened. The record shows a subscription's end once the provider's event arrives,
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
  (`countOwnOpenRecords`, which reads the customer field the seam itself scopes by). A record a
  subscription they pay granted (a membership, ADR 0510) follows that subscription and is not
  counted. Staff decide them at erase, as before.
- **Admins are told what was left.** The erase request's notice (ADR 0402) adds what stays for
  them, which subscriptions end and which orders were cancelled, in counts and labels only.
- **Bounded.** The preview reads a fixed number of statements however many orders, subscriptions
  and records the member has (ten in the test, eleven with subscriptions: one read of their
  cooling offs, then the cooling off's own rule only for one asked): one per kind, the customer
  objects' counts in one statement per forty objects (two bound variables each, so at most
  eighty). At most twenty subscriptions are ended and twenty orders cancelled in one deletion;
  any more are listed for staff and said so. The confirm with twenty subscriptions and twenty
  orders runs 323 statements in the test, none with more than twenty-one bound variables.
- **A person deletes, never a pack's tool.** `me.deleteAccount` is `actors: ["human"]`, and the
  pipeline's outside path now refuses an operation kept to a person when a pack's tool makes the
  call for its customer (`rule: "actor"`), as the staff path does. This holds for
  `subscription.cancel`, `.resume`, `.change` and `.coolOff` too; no pack's tool calls them.

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
  mode. Whether the provider still retries an overdue invoice on a `past_due` subscription set to
  end at its period's end is the provider's, and needs a test-mode run.
