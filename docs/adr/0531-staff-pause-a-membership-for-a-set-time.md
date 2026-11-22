# ADR 0531: Staff pause a membership for a set time: the provider's pause, followed by the host

Status: accepted, 2026-11-22 (stage 32b, build step 6; [the spec](../stages/32-memberships.md),
decisions 10 and 11: "paused by staff, for a set time"; no minimum term). Builds on ADRs
[0485](0485-recurring-billing-the-provider-runs-the-schedule.md),
[0493](0493-the-allowance-behaviour.md), [0510](0510-what-a-subscription-grants.md) and
[0530](0530-plan-changes-upgrade-now-downgrade-next-period.md). Migration 0630.

## Context
Gyms freeze a membership for an injury or travel. The owner decided staff pause, not members, for
a set time within limits the company sets; nothing is charged and nothing is spent meanwhile.
Stripe's pause (`POST /v1/subscriptions/:id/pause`, status `paused`, flexible billing mode) and its
pause schedules (on a subscription schedule: `pause_schedules[].pause.pause_at`,
`resume.resume_at`) were read 2026-11-22. Its `pause_collection` keeps the subscription `active`,
so it is not a pause here (recorded at 32a's review).

## Decision
**A plan allows pauses by declaring them**: `sellable.recurring.pause: { minDays?, maxDays? }`,
number fields of the plan holding the shortest and longest pause (empty: 1 day and 366 days, the
most the host asks for). Without it a subscription to the plan is never paused. Memberships'
plan declares `pauseMinDays` and `pauseMaxDays`.

**`subscription.pause { id, from?, until, reason }`** (staff only, `subscriptions:manage`,
`actors: ["human"]`): from now, or a later moment, until a moment within the plan's bounds. The
host refuses what the provider would, first: anything but `active` (on trial, past due, unpaid,
paused, incomplete, ended), one set to end, and one with a change open.
**`subscription.unpause { id, reason }`** (the same): ends a pause now, or withdraws one asked for
later that has not started. Customers have neither (decision 10: they ask staff).

**At the gatekeeper**, `payments.subscription.pause` and `.unpause` (never auto-approvable):
- the pause is a **pause schedule**, so the provider resumes it on its own: a schedule from the
  subscription, then one pause schedule (`pause_at` `now` or a timestamp, `resume_at` the end
  date); the resume's defaults anchor billing at the resume and resume only once its payment
  succeeds. If the second call is refused, the schedule is released, so nothing changed.
- ending it early releases the schedule, then `POST /v1/subscriptions/:id/resume` with
  `billing_cycle_anchor[type]=now` and `payment_behavior=resume_on_payment_success`.

**The host follows the provider**, as for every move (ADR 0485): the subscription is `paused` from
the provider's read, and its membership is moved to `paused` in that batch (ADR 0510). A paused
membership is not live (its `allowance.live` is trial, active and past due), so nothing spends it.
The change row is `applied` from the read that shows it paused; one asked for later stays
`requested` until then. While paused, no plan change and no cancel at the period's end (cancel
now still works).

**Billing.** No invoices while paused. On resuming, the provider charges a new period from the
resume, less the unused time of the period it was paused in (Stripe's `bill_for` default). That
first period's order is not flagged when it is at most the price.

## Consequences
- The company's minimum and maximum live on each plan, so different plans may differ.
- The provider's pause needs flexible billing mode, which every subscription the host opens has
  (ADR 0485).
- Runbook checks (Stripe's test mode): a pause schedule set on a schedule made `from_subscription`
  with nothing else; whether the schedule lingers after the resume (and so blocks a later plan
  change until released); a release while paused; what Stripe sends on the scheduled pause and
  resume (`customer.subscription.paused`, `.resumed`), which the host already reads.
- Classes booked before a pause for a time inside it keep their use (the allowance checks a
  holder when the use is spent, not again later). Stage 31's bookings may decide otherwise.

## Amended after review (2026-11-22, before merge)
- **Ending a pause early is one call**, as Stripe documents it (docs.stripe.com/billing/
  subscriptions/pause/schedules, "Start a resume attempt immediately", read 2026-11-22): the pause
  schedule is updated with its `key` and `resume[resume_at][type]=now`; Stripe starts the resume
  during the update with the schedule's resume settings (resumed only once its payment succeeds; a
  failed payment leaves it paused). Nothing is released first, so a failed call leaves the
  provider's own resume date in place. A paused subscription with no schedule is resumed with
  `POST /v1/subscriptions/:id/resume`, `billing_cycle_anchor[type]=now` (an object with `type`, as
  the API reference's example sends it) and `payment_behavior=resume_on_payment_success`
  (docs.stripe.com/api/subscriptions/resume, read 2026-11-22; its default is
  `resume_on_payment_attempt`). A pause not yet started is withdrawn by clearing its pause schedule
  (`pause_schedules=""`, the reference's way to clear it), then releasing the schedule; a release
  that fails after that is ignored. Each step follows a fresh read and has its own idempotency key,
  so asking again finishes one that stopped half way.
- **What came of ending it is kept** on the pause (`end_outcome`, audited): refused or unknown
  shows on the subscription ("did not finish: try again"), and the host shows it paused until the
  provider's read says it resumed. A pause not yet started is withdrawn only once the gatekeeper
  says the call was sent. A pause whose second call's outcome is unknown stays asked, shown so,
  until the provider's read pauses it or it expires a day after it was due; staff withdraw it.
- A pause's reason (free text) is blanked when its payer or holder is erased.
- Not in the documentation, left for the runbook: whether a release keeps a subscription paused,
  and whether a schedule made `from_subscription` lingers after the resume.

## Amended after the second review (2026-11-22, before merge)
- **The schedule is released once the pause is over.** The guide says a schedule may be released
  once its resume succeeds, in a separate request. The gatekeeper releases it before the next plan
  change or pause, when a fresh read shows the subscription not paused and every pause on the
  schedule resumed (`resume.status.type` `succeeded`) and the schedule is the host's; a pause still
  to come refuses a plan change. A schedule is not released straight after ending a pause early,
  because that resume may still be waiting for its payment.
- **A resume waiting for its payment is not asked again.** On the no-schedule path, an open latest
  invoice refuses it ("waiting for its payment"), nothing changed.
- **A refused pause whose schedule cannot then be released** is an unknown outcome, not a refusal:
  the schedule may still be attached; the host keeps the pause asked for, and staff withdraw it.
- A late paused read, for a pause that lapsed meanwhile, is followed as that pause (ADR 0530).
