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
names a number setting of the plan's own extension holding whole days. Any pack may declare it on
a recurring sellable; the contract check requires the setting to be a person's to change
(`personApproves`: the assistant's change waits for one, ADR 0507), bounded from 0 to at most
`MAX_COOLING_OFF_DAYS` (90), and off (0 or no default) until a person sets it, and every refund it
leads to is approved by a person, as every refund is. The Memberships pack declares
`coolingOffDays` (0 to 30, default 0) for its plans; no other shipped pack declares one, so a
course plan, a pass or a ticket is not covered. The host reads it through the plan object, never by
a pack's name.

**Who it covers** (`subscriptions/cooling-off.ts`, `coolingOffStatuses`, one definition for the
button, the operation and staff's page):
- a subscription to a plan that declares it, started here by `subscription.start` without a
  continuation offer (its checkout exists and names no offer): a member moving over is not new;
- within the window: from the host's processing of the provider's first verified event for it
  (the record's `created_at`, the host's clock; a late webhook starts it late, which favours the
  member) to the end of the last local day in the business's time zone, the start's own day being
  day 0. The end is a local midnight, so a change of clocks moves nothing. A plan change, a pause,
  a renewal or an agreement accepted again makes no new subscription and so never moves it;
- the days are **those in force when it was started**, kept on its checkout
  (`core_subscription_checkout.cooling_off_days`), for good (coordinator's decision of
  2026-11-24, the owner being asked): a setting changed later, shorter or longer, applies only to
  subscriptions started after it, so a raise never reopens a closed window. One started before
  the setting existed has 0;
- **once per member** (the spec is silent; the coordinator's conservative reading): a holder who
  cooled off one membership here cannot cool off another. Held by the database (migration 0856's
  triggers, on insert and on a refused one asked again, never on the update a merge makes), and
  answered by the host as a conflict (`reason: "used"`), never an internal error;
- something paid and not refunded: in a free trial nothing is owed back, so it is not offered and
  the member's ordinary cancel ends the trial at no charge (the button says "cancel").

**Who may**: `subscription.coolOff { id }` is the payer's own (a member, a guardian paying for a
child, a guest once signed in as the address that paid) or staff's with `subscriptions:manage`;
`actors: ["human"]`, never exposed over MCP: an AI never cools off for anyone, and is refused, not
queued. A customer naming another's subscription, or the holder who does not pay, is told "not
found", naming nobody. `subscription.coolingOff { ids }` (up to 20) says whether each is offered,
why not, the last day, exactly what it would owe back, and how far one asked for has got (whether
the caller may ask again, whether it is under way, whether admins were told): the button shows only
when the host says so, and no screen works the window out.

**What it does.** The operation writes `core_subscription_cool_off` (one row per subscription: the
holder, who asked, the days, the closing instant, the first and the latest ask) in its batch, and
after the commit asks the payments gatekeeper to end the subscription now
(`cancelSubscription { when: "now" }`, the host's own call, applied at once as staff's "end it
now" is). Its idempotency key at the provider is fixed per subscription (`cos-cancel-<id>-now`), so
asking again is the same request; Stripe keeps a key's answer for a day, so an error it cached for
it (a 4xx) comes back unchanged for a day, which the host records as refused and staff ask again
after. What came of the call is written on the row with an audit row of the host's:
- `sent` or `pending`: asked; nothing more is asked by a retry;
- `unknown` (the call failed or its answer was lost): left asked; admins are told once; the member
  is told it is not confirmed, never that it ended;
- `refused`: the provider's read is taken first, and a subscription it shows ended counts as sent
  (a second ask racing the first). Otherwise the row is `refused`, nothing ended, nothing is owed,
  admins are told once.
- **Asking again** (refused, or no answer): by the member only while the window is open; after
  it, only staff with `subscriptions:manage` finish one the member asked in time, and what is owed
  stays bounded (below). Once a refused one's window has passed, or one has lapsed, the ordinary
  cancel is offered again.
- **A crash between the commit and the call** (`call_outcome` null) and a lost answer are resolved
  by the minute cron's sweep (`subscription.coolOffSweep`, a host step from the system origin,
  bounded to 10 asks a tick, one indexed read when nothing is due): after five minutes it reads
  the provider's own state first (ended: sent; unread: left for the next tick), asks again while
  the window is open, else tells admins once. The member's screen treats null like unknown and
  says admins were told only when a notice was written.
Two asks at once: the row's primary key fails the second batch, so the provider is asked once.

**The refunds are owed by the verified event of the end the cooling off caused, and are bounded.**
In the batch of every verified event of a subscription with a cooling off asked (`followCoolOff`,
called from `applySubscriptionEvent`), once the provider shows it ended:
- an end within two days of the latest ask (the provider's end moment from its read) is this
  cooling off's. One statement writes a refund owed (`core_sellable_refund_due`,
  `entered: "cooled_off"`, object `subscription`) for each order of the subscription with money on
  it not refunded **whose period started (or which was paid) up to the window's end, or between
  the latest ask and the end**, each in full of what is left on it (`payment_ref` null), keyed by
  the order (insert or ignore). The row becomes `ended` (final); admins are told once with the
  total. A period within those bounds reported later is owed by its own event's batch;
- any other end (an ordinary cancel, failed payments, an end months later) owes nothing as cooled
  off: the row becomes `lapsed` (final) and admins are told once to check whether a refund of what
  was paid in the period is due.
The member's "a full refund of X" is exactly what this rule gives. The minute cron asks the
gatekeeper for each refund (ADR 0560), where each waits for a person with `orders:refund`; a
rejected or lapsed one tells staff as ADR 0560's do. Nothing here refunds or charges a card on its
own.

**Money, case by case** (all integer minor units, each owed order in full of what is left):
- the first period paid, and any renewal for a period starting inside the window: refunded;
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
- staff already refunded part of an order: only what is left is owed;
- refused in the window and finished by staff months later: only what was paid for the window
  (renewals since are not owed).

**What was used, and bookings ahead** (coordinator's decision of 2026-11-24, the owner being
asked). Classes attended stand (decision 16). When the cooling off's end is processed, in the same
batch, each record that spent a use of the subscription's granted membership, not given back,
whose time is still ahead and that is still in a state it spends in (booked), is moved by the host
into its object's `released` state: a new optional field of the allowance spender's declaration
(`allowance.spends.released`, a return state with a host move from each spend state; checked by
the contract). Bookings declares `released: "cancelled_by_us"`: the gym's cancellation, its place
freed (the waiting list moves people in through the existing promotion) and its use given back. A
booking attended, or cancelled late, stands. At most 60 in the batch (measured: 36 statements for
the end, about 11 a booking); staff are told of any left. Any other end of a membership keeps its
bookings, as today. No pack code runs; the platform had no way for an ending holder to release
what it paid for, and this is it, scoped to cooling off.

**Erase and merge.** The row holds ids only: no address, name or free text. Erasing the holder sets
it null (the foreign key); the payer's refunds stay owed on their orders (erase detaches orders, it
does not delete them). A merge moves the rows to the survivor in its batch; the once-per-member
trigger is on insert only, so no merge and no erase is ever refused for it.

**D1.** Measured with a metered database: `coolingOff` 8 statements whatever the paid periods (its
order read grows in rows, not statements); `coolOff` 13; the end event 36, plus about 11 a booking
released (60 at most: under 700). The refunds owed are one statement.

**The member's screens.** The Memberships web block shows "You can cancel for a full refund until
the end of [day]" and "Cancel for a full refund" only while the host offers it, "Ask again" only
when the host says the member may, then where the refund is; each refusal has its words. The app's
block (ADR 0490: the app never changes a subscription) says until when, and that it is done on
the website, with no amounts. The block lint counts `subscription.coolOff` and `useCoolOff` as
billing. Staff see the same on the subscription's page, end it for a member, and finish one after
the window.

## Consequences
- A plan's pack decides whether its plans have cooling off; core knows no pack's name.
- A refund owed by cooling off is the same row, cron and approval as a drop-in's.
- The platform has no dispute model (issue #245): a chargeback on an order a cooling off also owes
  back is for staff to settle by hand; nothing here knows of one.
- `INSERT OR REPLACE` over a cool-off row would bypass the final-state trigger (recursive triggers
  are off); no host code writes one that way.

## Open, for the owner
- Bookings ahead are cancelled as the business's (coordinator's decision, above): confirm.
- The days are those at the start, for good (coordinator's decision, above): confirm.
- Once per member is the coordinator's reading where the spec is silent. Per member and plan, or
  per payer, are the alternatives.
- The setting's upper bound (30 days) is a guess; the platform allows up to 90.
- The window counts from the host's processing of the provider's confirmation; counting from the
  member's acceptance of the terms is the alternative.
