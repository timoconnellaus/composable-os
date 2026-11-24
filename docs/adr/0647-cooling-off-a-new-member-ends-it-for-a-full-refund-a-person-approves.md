# ADR 0647: Cooling off: a new member ends it for a full refund, a person approves each refund

Status: accepted, 2026-11-24 (stage 44, build step 7); amended 2026-11-24 after the third review
of PR #299: "The rule" (A to G) replaces the earlier "whose end is it" and "what is owed" wording;
amended again 2026-11-24 after the fourth review: one waiting cancel at a time, a finish recorded
as ended only once the provider confirms, one release step a minute, a day's bound on an end
the provider shows but never sends, the provider's own time for "paid", and a holder who used
theirs elsewhere (each marked "(fourth review)" below); and after the fifth review: a `retryable`
answer is recorded as `unknown` and asked again, and a stuck finish is not finished by a later
end (each marked "(fifth review)").
Builds on
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
  ended or finished cannot have another. One lapsed, or refused and never finished (both got them
  nothing), does not count. Held by the host before it writes and by the database (migration 0856's
  triggers, never on the update a merge makes), and answered as a conflict (`reason: "used"`),
  never an internal error; an end is never refused for it (rule F below);
- something paid and not refunded: in a free trial nothing is owed back, so it is not offered and
  the member's ordinary cancel ends the trial at no charge (the button says "cancel").

**Who may**: `subscription.coolOff { id }` is the payer's own (a member, a guardian paying for a
child, a guest once signed in as the address that paid) or staff's with `subscriptions:manage`;
`actors: ["human"]`, never exposed over MCP: an AI never cools off for anyone, and is refused, not
queued. A customer naming another's subscription, or the holder who does not pay, is told "not
found", naming nobody. `subscription.coolingOff { ids }` (up to 20) says whether each is offered,
why not, the last day, exactly what it would owe back, and where one asked for stands (its state,
its deadline, whether it is open, whether the caller may ask again, whether admins were told): the
button shows only when the host says so, and no screen works the window out.

**The rule** (the coordinator's decision of 2026-11-24, third review of PR #299; it **replaces**
the earlier "whose end is it" wording, which judged an end by the provider's reason, a two-day
allowance after the latest ask and an inside-the-window test, and is withdrawn):

- **A. A valid ask is made inside the window** (by the member, or staff for them). It opens the
  cooling off and fixes a **deadline: `asked_at` + 7 days** (`COOL_OFF_OPEN_DAYS`, defined as the
  gatekeeper's `DEFAULT_APPROVAL_EXPIRY_DAYS`, so an ask waiting for a person and the cooling off
  close together). Asking again (the member inside the window; staff any time before the deadline)
  retries the provider and never moves `asked_at` or the deadline. Every ask again reads the
  provider first: one it already ended (an answer lost) is recorded as sent and nothing more is
  asked. Each ask by a person is a new request: its own idempotency key (`askKey: "cool-off-<n>"`,
  the row's ask count; Stripe's key `cos-cancel-<id>-now-cool-off-<n>`); the sweep's retry of an
  ask keeps its key. Staff's ordinary "end it now" keeps the subscription's own key. **While a
  cancel of it waits for a person at the gatekeeper, nobody may ask again** (fourth review): the
  member and staff are told so (`reason: "waiting"`), and nothing is asked of the provider.
- **B. While it is open and before its deadline, any end of the subscription is the cooling
  off's**, whatever the provider's reason (a cancel, failed payments, a dispute) and however it
  arrived (the ask, a retry, staff, an action a person approved at the gatekeeper). The one
  allowance is a fixed clock tolerance (`CLOCK_TOLERANCE_MS`, five minutes): an end timestamped
  earlier than `asked_at` less it, or after the deadline, is not the cooling off's and the row
  lapses.
- **C. What is owed is one formula, always** (`owedByCoolOff`): every order paid on or before the
  window's end, plus every order paid after `asked_at` and on or before the end (the end is at most
  the deadline). Nothing else, ever. **"Paid" is when the provider took the money** (fourth
  review): a period's order keeps the provider's time for its payment, its verified event's own
  time (`core_order.provider_paid_at`, migration 0856), beside `paid_at` (when the host processed
  it, which everything else still reads). The rule reads the provider's time when there is one,
  so an event the host applied late (a failed first delivery, the catch-up's backoff) owes what
  the provider took inside the bounds. The figure shown to the member and to staff is the same
  function over the same bounds (as if it ended now while open; the stored bounds once ended), and
  the refunds owed are one statement over them (insert or ignore, keyed by the order, each in full
  of what is left on it). A payment the provider reports later is owed by its own event's batch
  only when it falls inside the stored bounds.
- **D. At the deadline an open one lapses** (the minute cron, `subscription.coolOffSweep`): admins
  are told once, the ordinary cancel and staff's end-now work again. **Every cancel of it that
  ever waited at the gatekeeper is kept** (`core_subscription_cool_off_action`, by its ask; never
  overwritten, so a `retryable` answer to a later ask loses none), and at the deadline the host
  rejects each one still waiting. Once none waits and the latest ask's cancel was turned down or
  expired, the row lapses at once (the next tick, `lapsed_because: "action"`), not at the
  deadline. One the provider already shows ended (or cannot be read) is left for its event at
  most a day after the deadline; then it lapses, admins are told once, and the sweep no longer
  visits it (fourth review). A lapsed row never becomes the cooling off's by a later end, except
  by staff finishing it (E). **A holder who has since used theirs** on another membership (F):
  an open ask lapses as `used` at once (the ordinary cancel is not refused for it from that
  moment; the next tick records it, rejects any cancel still waiting and tells admins once).
- **E. Staff finish a lapsed one** from its card (`subscriptions:manage`; "Finish the cooling
  off"). It owes exactly the orders paid on or before the window's end (never later), releases
  the bookings ahead and waiting places, and sends the summary, as a normal end does, **but only
  once the provider confirms the membership ended** (fourth review). A membership already ended
  is finished at once. One still running is asked to end now (a new request, askKey
  `cool-off-finish-<n>`); the request is kept on the row (`finish_state`: asked, sent, pending,
  unknown) and the row stays `lapsed`. The sweep reads the provider, asks again with the same key
  at most hourly, and waits while a cancel waits for approval. It marks the finish `stuck` and
  tells admins once when it cannot be done: the provider refused, its cancel was turned down or
  expired, or no end was confirmed a day after the request (or its approval). A stuck one is not
  visited again, and a later end does not finish it (fifth review): an end months on, an
  ordinary cancel at period end say, would otherwise owe the window's payments and tell the
  member it ended in its cooling-off period. While a finish is under way (asked, sent, pending,
  unknown: at most a day, or until its approval is given or expires), the provider's verified
  event that shows the membership ended finishes it in its own batch, however it ended (the
  finish, a retry, or staff's ordinary "end it now"): stored
  as `ended`, finished, with the window's bounds; later events never add to it. Until then nothing
  is owed, released or emailed, and the operation answers `state: "lapsed"` with what came of the
  call. Staff may finish a stuck one again (a new request; a membership that has ended by then is
  finished at once).
- **F. Once per member**: an ended or finished cooling off counts; a lapsed one, or one refused and
  never finished, does not. The ask, the finish and the end's batch check this before writing
  (migration 0856's triggers hold it too: a second row for a subscription is refused, an
  `INSERT OR REPLACE` included, and a move into `ended` when the holder has another `ended`).
  **Nothing in the cooling-off path may fail the recording of a subscription's end**: if the
  holder has used theirs, the end is recorded normally and the row lapses as not counted
  (`lapsed_because: "used"`), admins told. The end's batch releases no bookings: the steps after
  it do (below), so a failing release never fails an end.
- **G. No trap**: every state has an exit (below), each tested.

**The states** (`core_subscription_cool_off.state`):

| State | Entered by | Exit for the member | Owed |
| --- | --- | --- | --- |
| none | — | inside the window and offered: ask (the button); otherwise the ordinary cancel | nothing |
| `asked`, open, inside the window (sent, pending, unknown, refused or never answered) | the member's or staff's ask inside the window | ask again (a new request); or wait for the end | not yet: the figure as if it ended now |
| `asked`, open, after the window | — (time) | wait: at most until the deadline (7 days from the ask); staff may ask again until then | not yet |
| `ended` | an end inside the bounds (B) of an open one, holder not used | none needed: the membership has ended | window's payments + those after the ask up to the end |
| `asked`, a cancel waiting at the gatekeeper | an ask the gatekeeper holds for a person | wait: approved, it ends (B); turned down or expired, it lapses at the next tick; at the deadline the host rejects it | not yet |
| `lapsed` (`deadline`, `action`, `end_time`) | the sweep at the deadline (or a day after it, when the provider shows it ended and its event never came); the latest waiting cancel rejected or expired with none still waiting; an end outside the bounds | the ordinary cancel (and staff's end-now) work again; staff may finish it (E) | nothing, until finished |
| `lapsed` (`used`) | an end while the holder had used theirs; the sweep, once the holder used theirs on another | none needed, or the ordinary cancel; the end is recorded as any other | nothing |
| `lapsed`, finishing (`finish_state` asked, sent, pending, unknown) | staff finish a lapsed one whose membership still runs | none needed: the host asks the provider (retried, the approval waited for); the provider's end finishes it | nothing yet |
| `lapsed`, finish `stuck` | the finish refused, turned down, or not confirmed in a day: admins told once | staff finish it again (ended by then: finished at once); a later end on its own does not finish it (fifth review) | nothing yet |
| `ended`, finished | the provider's event shows the membership ended after staff asked to finish (holder not used) | none needed | the window's payments only |

While one is open (`asked` and before its deadline), `subscription.cancel` is refused for the
member and staff (`rule: "cooling_off_open"`); the deadline bounds that wait.

**What came of a call** is written on the row (`call_outcome`, or `finish_state` for a finish)
with an audit row of the host's: `sent`; `pending` (the cancel waits at the gatekeeper for a
person, its id kept; admins told after an hour); `unknown` (the call failed, its answer was lost,
or the gatekeeper answered `retryable`, which sent nothing and leaves no approval to give (fifth
review): never recorded as refused or pending; admins told once); `refused` (the provider's read first: one it shows ended
counts as sent; admins told once; a finish refused is stuck). A crash between the commit and the
call (`call_outcome` null) and a lost answer are resolved by the sweep after five minutes from the
provider's own read, else asked again (the same ask, its key) at most hourly (`last_asked_at`)
until the deadline. An idle tick is one cheap read and invokes nothing, so it writes no audit row.

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
- a guest's subscription: covered as a new member's;
- staff already refunded part of an order: only what is left is owed;
- asked on day 13 of a 14-day window, ended on day 18 (any reason): the window's payments and
  those paid after the ask up to day 18;
- an ask waiting at the gatekeeper past its deadline: lapsed (rejected); the member cancels as
  usual; staff may finish it for the window's payments only, owed once the provider ends it;
- an upgrade's charge the provider took inside the window whose event the host applied after the
  end: owed (paid is the provider's time);
- an end months later (a cancel at period end, failed payments): lapsed; nothing owed as cooled
  off;
- a payment reported after the end and paid after it: never owed.

**What was used, and bookings ahead** (the owner's decision 1 of 2026-11-24). Classes attended stand
(decision 16). After the cooling off's end (or a finish), each record that spent a use of the
subscription's granted membership, not given back, whose time is still ahead and that is still in a
state it spends in (booked), and each of the member's own places on a waiting list for a class ahead
that it would pay for (one naming this membership; one naming nothing only when they hold nothing
else live: a member with a pass too keeps it), is moved by the host into its object's `released`
state: an optional field of the allowance spender's declaration (`allowance.spends.released`, a
return state with a host move from each spend state; checked by the contract; ADR 0493 amended).
Bookings declares `released: "cancelled_by_us"`: the gym's cancellation, its place freed (the
waiting list moves people in through the existing promotion) and its use given back. A booking
attended, cancelled late, paid by another holder, or for a class already started stands. **None is
released in the end's own batch** (rule F): the minute cron runs `subscription.coolOffRelease`, a
host step in its own batch, 15 at a time by class start (30 before the fourth review), until none is
left, **one step a minute tick** (the membership that has waited longest first; fourth review), so
the whole scheduled invocation stays bounded however many members cool off at once; it reads the
uses page by page (what cannot be released never hides those after) and counts only what it could
release toward what is left, so the steps always end. A step that fails three times in a row stops
(a step that succeeds clears the count): admins are told once, and the summary says the business
will cancel the rest. If the end's batch fails, nothing of it is recorded and the stored event is
applied again. **Stored payment events that keep failing** are tried every tick five times, then
with backoff (an hour, two, four, at most a day apart), for good; admins are told once at the fifth
failure (`payment-event.failing:<provider>:<event>`). Any other end of a membership keeps its
bookings.

**The member's one email.** Once the releases are done, the member (the subscription's address)
gets one email through the host's mail as an order's confirmation goes (the email channel an admin
chose; its approval rules apply), never one per class: their membership ended in its cooling-off
period, how many bookings ahead were cancelled with it (never more than were; when the steps
stopped early, that the business will cancel the rest), and that the refund is owed and approved
by the business. It is claimed (`sending`) before it is sent, with an idempotency key
(`cool-off-summary:<id>`); one left `sending` by a crash is tried once more after ten minutes with
the same key, then marked failed. One held for approval is `pending`, not sent. One that cannot be
sent (no channel, no address, two tries) is `failed` and admins are told once.

**Erase and merge.** The row holds ids only: no address, name or free text. Erasing the holder sets
it null (the foreign key); the payer's refunds stay owed on their orders (erase detaches orders, it
does not delete them). A merge moves the rows to the survivor in its batch; the once-per-member
triggers never fire on it, so no merge and no erase is ever refused for them.

**D1.** Measured with a metered database: `coolingOff` 9 statements whatever the paid periods (its
order read grows in rows, not statements; one more since the fourth review, the waiting cancels);
`coolOff` 14; the end event 35, the same whatever is booked ahead (it releases none). One minute
tick runs at most one release step, then the sweep (at most 10 open and 10 finishing rows) and at
most 10 summary emails. Measured over a whole tick (fourth review): five members cooling off at
once with 31 bookings ahead each, on the host's fixture, at most 172 statements a tick (it was
1,568 with five steps of 30 a tick). On the real packs, the runner's whole `minuteTick` (every
minute step, not only this one; `apps/runner/test/cooling-off-bookings.test.ts`, four members with
31 ahead each) is at most 499 statements a tick: about 20 a booking released on the shipped
Bookings pack, beside about 125 for the rest of the minute. A step of 30 measured 799, too close
to D1's 1,000 for a busy minute, so a step is 15. The refunds owed are one statement.

**The member's screens.** The Memberships web block shows "You can cancel for a full refund until
the end of [day]" and "Cancel for a full refund" only while the host offers it, "Ask again" only
when the host says the member may, then where the refund is; each refusal has its words. The app's
block (ADR 0490: the app never changes a subscription) says until when, and that it is done on
the website, with no amounts. The block lint counts `subscription.coolOff` and `useCoolOff` as
billing. Staff see the same on the subscription's page, end it for a member, finish one after the
window before its deadline, and finish a lapsed one.

## Consequences
- A plan's pack decides whether its plans have cooling off; core knows no pack's name.
- A refund owed by cooling off is the same row, cron and approval as a drop-in's.
- The platform has no dispute model (issue #245): a chargeback on an order a cooling off also owes
  back is for staff to settle by hand; nothing here knows of one.
- `INSERT OR REPLACE` over a cool-off row is refused by the insert trigger (a row exists); no host
  code writes one that way.
- An ask waiting for a person at the gatekeeper is rejected by the host at the deadline; a
  connection whose approval expiry is set longer than the default still closes the cooling off at
  seven days.
- A race the host's check cannot see (two ends for one holder in the same instant) is caught by the
  trigger: that batch fails, is applied again, and the second lapses as used.
- The clock tolerance (five minutes before the ask, rule B) is a little more generous than "while
  the ask is open"; it stays, recorded here (fourth review, finding 7).
- A finish whose provider shows the membership ended but never sends the event stays `lapsed`
  (stuck, admins told): the host owes nothing it has not seen end (fourth review).
- A `retryable` answer leaves no approval to wait for, so it is `unknown`: the sweep reads the
  provider and asks again with the same key at most hourly (fifth review; it was `pending`, which
  waited for an approval that did not exist).
- One release step a minute for the whole host releases bookings slowly when many end at once:
  200 members with 15 ahead each are all released in about 200 minutes, with 60 each in about 13
  hours. The queue is oldest first, so none starves; until a member's step runs, their places
  stay held, waiters are not moved in, and their summary email waits. That is acceptable for the
  numbers a business on this host sees; a busier one would want a statement budget per tick
  instead of one step (fifth review).

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
