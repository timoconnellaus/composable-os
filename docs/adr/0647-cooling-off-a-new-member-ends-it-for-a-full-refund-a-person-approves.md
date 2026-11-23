# ADR 0647: Cooling off: a new member ends it for a full refund, a person approves each refund

Status: accepted, 2026-11-24 (stage 44, build step 7). Builds on
[ADR 0429](0429-payments-gatekeeper-verified-events-and-refunds.md) (refunds through the payments
gatekeeper, approved by a person with `orders:refund`),
[ADR 0485](0485-recurring-billing-the-provider-runs-the-schedule.md) (the provider runs the
schedule; nothing charges a card on its own),
[ADR 0486](0486-an-order-per-paid-period-and-its-refund.md) (an order per paid period),
[ADR 0487](0487-the-payer-and-the-holder.md) (billing follows the payer),
[ADR 0489](0489-one-free-trial-per-person-per-plan.md) (trials),
[ADR 0490](0490-the-course-plan-self-service-and-the-staff-side.md) (the app reads a
subscription, the web changes it), [ADR 0491](0491-continuation-offers.md) (members moving over),
[ADR 0530](0530-plan-changes-upgrade-now-downgrade-next-period.md) and
[ADR 0531](0531-staff-pause-a-membership-for-a-set-time.md) (plan changes and pauses),
[ADR 0560](0560-a-paid-line-moves-a-record-that-exists.md) (a refund the host owes,
`core_sellable_refund_due`) and [ADR 0646](0646-erase-merge-and-retention-for-agreements.md)
(erase and merge). Stage 44's spec: "Cooling off (decision 11)", decisions 11, 16 and 17,
criterion 12, and row 7 of the build order.

## Context
Decision 11: a cooling-off period is a setting (days; 0 turns it off). A new member can cancel
within it for a full refund, which still goes through approval like every refund. Decision 16: a
full refund whatever was used. Decision 17: new members' memberships only, not passes, not members
moving over. What any law asks of the first client is not confirmed; the spec lists it for the
business's lawyer, and the platform takes no view.

## Decision
**The setting is the pack's, declared to the host.** `sellable.recurring.coolingOff: { setting }`
names a number setting of the plan's own extension holding whole days. The contract check requires
it to be a person's to change (`personApproves`: the assistant's change waits for one, ADR 0507),
bounded from 0 to at most `MAX_COOLING_OFF_DAYS` (90), and off (0 or no default) until a person sets
it. The Memberships pack declares `coolingOffDays` (0 to 30, default 0) for its plans; no other
pack declares one, so a course plan, a pass or a ticket is never covered. The host reads it through
the plan object, never by a pack's name.

**Who it covers** (`subscriptions/cooling-off.ts`, `coolingOffStatuses`, one definition for the
button, the operation and staff's page):
- a subscription to a plan that declares it, started here by `subscription.start` without a
  continuation offer (its checkout exists and names no offer): a member moving over is not new;
- within the window: from the moment the provider confirmed it (the host's record, made by the
  verified event, on the host's clock) to the end of the last local day in the business's time
  zone, the start's own day being day 0. The end is a local midnight, so a change of clocks moves
  nothing. A plan change, a pause, a renewal or an agreement accepted again makes no new
  subscription and so never moves it;
- the days are **the longer of the setting when the subscription was started** (kept on its
  checkout, `core_subscription_checkout.cooling_off_days`) **and the setting now**: shortening it
  or turning it off never shortens the window of someone who started under it, and the membership
  terms the member accepted then are what said how long it was;
- **once per member** (the spec is silent; the coordinator's conservative reading): a holder who
  cooled off one membership here cannot cool off another (subscribe, use the classes, cool off,
  repeat). Held by the database (migration 0856's triggers, on insert and on a refused one asked
  again, never on the update a merge makes);
- something paid and not refunded: in a free trial nothing is owed back, so it is not offered and
  the member's ordinary cancel ends the trial at no charge (the button says "cancel").

**Who may**: `subscription.coolOff { id }` is the payer's own (a member, a guardian paying for a
child, a guest once signed in as the address that paid) or staff's with `subscriptions:manage`;
`actors: ["human"]`, never exposed over MCP: an AI never cools off for anyone, and is refused, not
queued. A customer naming another's subscription, or the holder who does not pay, is told "not
found", naming nobody. `subscription.coolingOff { ids }` (up to 20) says whether each is offered,
why not, the last day and the refund it would owe, and how far one asked for has got: the button
shows only when the host says `offered`, and no screen works the window out.

**What it does.** The operation writes `core_subscription_cool_off` (one row per subscription, the
holder, who asked, the days and the closing instant) in its batch, and after the commit asks the
payments gatekeeper to end the subscription now (`cancelSubscription { when: "now" }`, the host's
own call, applied at once as staff's "end it now" is). What came of the call is written on the row
with an audit row of the host's:
- `sent` or `pending`: asked; nothing more is asked by a retry;
- `unknown` (the call failed or its answer was lost): left asked; admins are told; the member is
  told it is not confirmed, never that it ended; asked again by the member or staff (after the
  window too: it was asked inside it), until sent;
- `refused`: the provider's read is taken first, and a subscription it shows ended counts as sent
  (a second ask racing the first). Otherwise the row is `refused`, nothing ended, nothing is owed,
  admins are told, and it is asked again.
Two asks at once: the row's primary key fails the second batch, so the provider is asked once.

**The refunds are owed by the verified event, not by the ask.** In the batch of every verified
event of a subscription with a cooling off asked (`followCoolOff`, called from
`applySubscriptionEvent`), once the provider shows it ended: one statement writes a refund owed
(`core_sellable_refund_due`, `entered: "cooled_off"`, object `subscription`) for every order of the
subscription with money on it not refunded, each in full (`payment_ref` null: the whole order),
keyed by the order (insert or ignore: a retry writes nothing twice); the row becomes `ended`
(final, by trigger); admins are told once with the total. A period the provider charged as it
ended, reported later, is owed back by that event's batch the same way. The minute cron asks the
gatekeeper for each (ADR 0560), where each waits for a person with `orders:refund`; a rejected or
lapsed one tells staff as ADR 0560's do. Nothing here refunds or charges a card on its own.

**Money, case by case** (all integer minor units, every paid order of the subscription in full):
- the first period paid, and any renewal paid before it ended: refunded;
- a plan change inside the window: the upgrade's prorated charge is an order of the subscription:
  refunded too; a downgrade moves no money;
- a pause inside the window: what was paid before it is refunded; the window does not move;
- a trial: nothing paid, nothing owed, not offered; a trial shorter than the window: the first
  charge inside the window is refunded;
- a continuation offer's free period (a member moving over): never covered;
- a guardian paying for a child: the guardian (the payer) cools off; the payer's orders are
  refunded; the child's membership ends;
- a guest's subscription: covered as a new member's; staff end it for them, or the guest once
  signed in as the address that paid;
- staff already refunded part of an order: only what is left is owed.

**What was used** is kept (decision 16): classes attended stay attended. What the ended membership
gives and bookings ahead follow a membership ended at once today (stage 32b): the membership ends
with the subscription; bookings already made are not cancelled by the host (a question for the
owner, below).

**Erase and merge.** The row holds ids only: no address, name or free text. Erasing the holder sets
it null (the foreign key); the payer's refunds stay owed on their orders (erase detaches orders, it
does not delete them). A merge moves the rows to the survivor in its batch; the once-per-member
trigger is on insert only, so no merge and no erase is ever refused for it.

**D1.** `coolingOff` reads a fixed number of statements whatever the number of subscriptions (up to
20) or paid periods; the operation adds a handful; the event's refunds are one statement. Tested
with a metered database.

**The member's screens.** The Memberships web block shows "You can cancel for a full refund until
the end of [day]" and "Cancel for a full refund" only while the host offers it, then where the
refund is; each refusal has its words. The app's block (ADR 0490: the app never changes a
subscription) says until when, and that it is done on the website, with no amounts. The block lint
counts `subscription.coolOff` and `useCoolOff` as billing. Staff see the same on the subscription's
page, end it for a member, and ask the provider again.

## Consequences
- A plan's pack decides whether its plans have cooling off; core knows no pack's name.
- A refund owed by cooling off is the same row, cron and approval as a drop-in's.
- The window counts from the host's record of the provider's confirmation. An event that arrives
  late starts the window late, which favours the member.
- `INSERT OR REPLACE` over a cool-off row would bypass the final-state trigger (recursive triggers
  are off); no host code writes one that way.

## Open, for the owner
- Bookings ahead after cooling off stay booked (as any membership ended at once). Should the host
  release them (a waiting list moving people in as usual)?
- Once per member is the coordinator's reading where the spec is silent. Per member and plan, or
  per payer, are the alternatives.
- The setting's upper bound (30 days) is a guess; the platform allows up to 90.
