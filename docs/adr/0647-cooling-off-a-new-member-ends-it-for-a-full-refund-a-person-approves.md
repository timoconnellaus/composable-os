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
  (`core_subscription_checkout.cooling_off_days`), for good (the owner's decision 5 of
  2026-11-24): a setting changed later, shorter or longer, applies only to
  subscriptions started after it, so a raise never reopens a closed window. One started before
  the setting existed has 0;
- **once per member, ever** (the owner's decision 2 of 2026-11-24): a holder with a cooling off
  asked or ended cannot have another. One refused that never ended the membership, or one lapsed
  (both got them nothing), does not count, until staff finish it (then it is `ended` and counts).
  Held by the database (migration 0856's triggers on insert and on a move into `asked` or `ended`,
  never on the update a merge makes), and answered by the host as a conflict (`reason: "used"`),
  never an internal error;
- something paid and not refunded: in a free trial nothing is owed back, so it is not offered and
  the member's ordinary cancel ends the trial at no charge (the button says "cancel").

**Who may**: `subscription.coolOff { id }` is the payer's own (a member, a guardian paying for a
child, a guest once signed in as the address that paid) or staff's with `subscriptions:manage`;
`actors: ["human"]`, never exposed over MCP: an AI never cools off for anyone, and is refused, not
queued. A customer naming another's subscription, or the holder who does not pay, is told "not
found", naming nobody. `subscription.coolingOff { ids }` (up to 20) says whether each is offered,
why not, the last day, exactly what it would owe back, and how far one asked for has got (whether
the caller may ask again, whether it is under way, whether admins were told): the button shows only
when the host says so, and no screen works the window out. While one is under way (asked, or
refused with its window open) `subscription.cancel` is refused (`rule: "cooling_off_open"`), for
the member and for staff: it is finished as a cooling off.

**What it does.** The operation writes `core_subscription_cool_off` (one row per subscription, for
good: the database refuses a second, an `INSERT OR REPLACE` included) in its batch, and after the
commit asks the payments gatekeeper to end the subscription now (`cancelSubscription
{ when: "now" }`, the host's own call). **Each ask by a person is a new request to the provider**:
its own idempotency key (`askKey: "cool-off-<n>"`, the row's ask count; Stripe's key
`cos-cancel-<id>-now-cool-off-<n>`), so a member trying again never replays a cached first answer,
and the sweep's retry of one ask keeps its key (one request, however often it is retried). Staff's
ordinary "end it now" keeps the subscription's own key (`cos-cancel-<id>-now`), never shared with
a cooling off. **Every ask again reads the provider first**: one it already ended (an answer lost)
is recorded as sent and nothing more is asked. What came of the call is written on the row with
an audit row of the host's:
- `sent`: asked; nothing more is asked;
- `pending`: the cancel waits at the gatekeeper (an approval, or a `retryable` failure the
  gatekeeper holds to apply again: never recorded as refused). The member waits; staff may ask
  again; the sweep, after an hour, reads the provider and tells admins once;
- `unknown` (the call failed or its answer was lost): left asked; admins are told once; the member
  is told it is not confirmed, never that it ended;
- `refused`: the provider's read is taken first, and a subscription it shows ended counts as sent.
  Otherwise the row is `refused`, nothing ended, nothing is owed, admins are told once.
- **Asking again**: by the member only while the window is open; after it, only staff with
  `subscriptions:manage` finish one asked in time, and what is owed stays bounded (below). Once a
  refused one's window has passed, or one has lapsed, the ordinary cancel is offered again.
- **A crash between the commit and the call** (`call_outcome` null), a lost answer and a long
  wait are resolved by the minute cron (`subscription.coolOffSweep`, a host step from the system
  origin, at most 10 asks a tick). An idle tick is one cheap read and invokes nothing, so it
  writes no audit row. After five minutes a lost or never-made ask is resolved from the
  provider's own read (ended: sent; unread: left), asked again (the same ask) while the window is
  open, else admins are told once. The member's screen treats null like unknown and says admins
  were told only when a notice was written.

**Whose end is it** (`causedBy`). When the provider shows the subscription ended, in the batch of
its verified event (`followCoolOff`, from `applySubscriptionEvent`), a cooling off `asked` or
`refused` is judged against the end's moment (the provider's read): it is the cooling off's when
the end is at or after the first ask (less five minutes for clocks) and inside the window (any end
there follows an ask made in time: a retry, staff, a retryable action the gatekeeper applied), or
within two days of the latest ask (staff finishing one after the window), or while the ask waits
at the gatekeeper and the provider says it was a cancel (not failed payments or a dispute):
whenever that person approves it, the end is the ask's, as the member asked in time. Otherwise it
is not: the row becomes `lapsed`, nothing is owed as cooled off, and admins are told once that
finishing it on the subscription's page (Cooling off) is how to refund what was paid in the
period, so it counts as the member's one; never a hand refund from the orders.

**What is owed** (the owner's rule): every order of the subscription **paid** on or before the
window's end (by when it was paid), plus those paid between the ask that ended it (the first ask
for an end inside the window, else the latest) and the end, a payment the provider took as it
ended and reported up to two days later included; each in full of what is left on it
(`payment_ref` null), one statement keyed by the order (insert or ignore). A payment taken inside
the window for a period after it is owed too. The row becomes `ended` (final); admins are told
once with the total; a payment within those bounds reported later is owed by its own event's
batch. Staff finishing a lapsed one owe the window's payments only. The member's "a full refund
of X" is exactly what this rule gives. The minute cron asks the gatekeeper for each refund (ADR
0560), where each waits for a person with `orders:refund`; a rejected or lapsed one tells staff as
ADR 0560's do. Nothing here refunds or charges a card on its own.

**Money, case by case** (all integer minor units, each owed order in full of what is left):
- the first period paid, and anything paid until the window's end: refunded;
- a payment inside the window for a later period (an invoice in advance): refunded;
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
- refused in the window and finished by staff months later: only what was paid in the window
  (renewals since are not owed);
- an ask waiting at the gatekeeper approved weeks later: what was paid in the window and since the
  ask (the member asked in time; the wait was the business's).

**What was used, and bookings ahead** (the owner's decision 1 of 2026-11-24). Classes attended
stand (decision 16). When the cooling off's end is processed, each record that spent a use of the
subscription's granted membership, not given back, whose time is still ahead and that is still in
a state it spends in (booked), and each of the member's own places on a waiting list ahead that it
would pay for (naming it, or naming nothing when they hold nothing else live), is moved by the host
into its object's `released` state: an optional field of the allowance spender's declaration
(`allowance.spends.released`, a return state with a host move from each spend state; checked by
the contract; ADR 0493 amended). Bookings declares `released: "cancelled_by_us"`: the gym's
cancellation, its place freed (the waiting list moves people in through the existing promotion)
and its use given back. A booking attended, cancelled late, paid by another holder, or for a class
already started stands. 20 are released in the end's own batch; the rest by follow-ups
(`subscription.coolOffRelease`, a host step the minute cron runs, 30 a time, idempotently, until
none is left; admins are told only if one keeps failing, after three tries). If the end's batch
fails, nothing of it is recorded and the stored event is applied again (the end, the refunds and
the releases together). Any other end of a membership keeps its bookings, as today.

**The member's one email.** Once the releases are done, the member (the subscription's address)
gets one email, through the host's mail as an order's confirmation goes (the email channel an admin
chose; its approval rules apply), never one per class: their membership ended in its cooling-off
period, how many bookings ahead it paid for were cancelled with it, and that the refund is owed and
approved by the business. It is claimed before it is sent, so it goes once; one that cannot be sent
is marked so.

**Erase and merge.** The row holds ids only: no address, name or free text. Erasing the holder sets
it null (the foreign key); the payer's refunds stay owed on their orders (erase detaches orders, it
does not delete them). A merge moves the rows to the survivor in its batch; the once-per-member
triggers never fire on it, so no merge and no erase is ever refused for them.

**D1.** Measured with a metered database: `coolingOff` 8 statements whatever the paid periods (its
order read grows in rows, not statements); `coolOff` 13; the end event 37, plus about 11 a booking
released (20 in the batch: about 260); a follow-up of 30, about 360. On the real Bookings pack the
end's batch with 20 released was 260 statements and the largest follow-up 484 (at 40, before the
follow-up was lowered to 30). The refunds owed are one statement.

**The member's screens.** The Memberships web block shows "You can cancel for a full refund until
the end of [day]" and "Cancel for a full refund" only while the host offers it, "Ask again" only
when the host says the member may, then where the refund is; each refusal has its words. The app's
block (ADR 0490: the app never changes a subscription) says until when, and that it is done on
the website, with no amounts. The block lint counts `subscription.coolOff` and `useCoolOff` as
billing. Staff see the same on the subscription's page, end it for a member, finish one after the
window, and finish a lapsed one.

## Consequences
- A plan's pack decides whether its plans have cooling off; core knows no pack's name.
- A refund owed by cooling off is the same row, cron and approval as a drop-in's.
- The platform has no dispute model (issue #245): a chargeback on an order a cooling off also owes
  back is for staff to settle by hand; nothing here knows of one.
- `INSERT OR REPLACE` over a cool-off row would bypass the final-state trigger (recursive triggers
  are off); no host code writes one that way.

## The owner's decisions (interview of 2026-11-24)
1. When a member cools off, classes booked for later are cancelled and their places freed, waiting
   lists moving people in (built: `allowance.spends.released`, above).
2. Once per member, ever (built: migration 0856's triggers).
3. The ceiling for the setting is 30 days (the Memberships pack's `coolingOffDays`, 0 to 30; the
   platform's contract allows a pack up to 90, and no shipped pack goes past 30).
4. The clock starts when the payment provider confirms the membership started (the host's
   processing of the provider's first verified event for it).
5. A longer period set later applies only to people who join after the change (the days kept on
   the checkout at the start, for good).
