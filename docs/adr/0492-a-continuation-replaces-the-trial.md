# ADR 0492: A continuation replaces the trial, is not the trial, and under 48 hours is charged at once

Status: accepted, 2026-11-22 (stage 32a, build step 4; interview decision 7; owner decisions of
2026-11-22 recorded in [ADR 0489](0489-one-free-trial-per-person-per-plan.md)). Builds on ADRs
[0485](0485-recurring-billing-the-provider-runs-the-schedule.md),
[0489](0489-one-free-trial-per-person-per-plan.md) and [0491](0491-continuation-offers.md).
Amends ADR 0489. Amended the same day (below).

## Context
A course plan has a 7-day free trial, one per Person per plan object (ADR 0489). A continuation
offer gives free time until the date a person has paid up to elsewhere (ADR 0491). Three questions:
whether the two add up, whether taking an offer uses the person's one trial, and what happens when
the date is too close for the provider or has passed. Stripe's `trial_end` must be at least 48
hours ahead (ADR 0485, read from its documentation).

## Decision

**A continuation replaces the trial** (decision 7: "free until the paid-up date, then charged; no
trial on top"). A page opened from an offer sends `trialEnd` (the offer's date) and never
`trialDays`; the plan's trial is never added before or after it.

**A continuation's free time is not the trial** (owner decision, ADR 0489): only a checkout with
the plan's trial days writes or uses a trial row. An offer's checkout has `trial_end` and no
`trial_days`, so the verified event uses nothing and tells no one of "a second free trial".

**No trial during a continuation; the one-trial rule after it** (owner's decision, 2026-11-22).
A holder is given no trial on any plan of the object (`noTrial: "continuation"`) while:
- they have an offer they can still take (not taken, not expired, not withdrawn): the offer is
  their free time, and a trial instead would stack on it; or
- a subscription started from an offer is still running or has not ended (any state but ended or
  expired): cancelling during the free time and starting again must not add a trial onto it.
Once that subscription has ended, or the offer expired untaken, the continuation is behind them
and it was not the trial: the ordinary rule applies, so a returning former subscriber who has
never had the trial gets it once (ADR 0489). A withdrawn offer never counts. The subscribe block
shows a member with an open offer no trial on any plan, and says why if the host refuses one.

**Under 48 hours, or already past: they subscribe normally, charged at once, with no trial.**
- With less than 48 hours and 15 minutes to the date when the page is opened (the provider's floor,
  and a margin for the call), the offer is taken with no free time: the page asks for the first
  payment at once, and the offer is marked taken `charged_from_start`. The overlap with the old
  platform is at most two days; giving free time to the floor instead would be up to two days the
  company did not decide to give.
- Once the date has passed the offer cannot be taken; the person subscribes without it like
  anyone, under the one-trial rule (above): the plan's trial once if they never had it, otherwise
  charged at once.
- Both are said: the import's report notes `under_48_hours` and `past` with each row's line; the
  member's block says continuing is charged from today; the report marks a taken offer "at once"
  and, for an offer not taken, a subscription the person started another way.

**When "paid up to" is.** A date is 00:00 on that day in the organisation's time zone: the day the
old platform would have charged next, so the first charge here falls on it. A source that knows
the moment gives it with its offset.

## Consequences
- A moving subscriber is charged for the first time on the day their old subscription would have
  renewed, if they take their offer at least two days before it.
- A person who misses their date subscribes as anyone does (the trial once, if they never had
  it); the company can import a later date for them (an offer not yet taken updates) if it wants
  to give more.
- A former subscriber who continued, ended, and comes back later can have the 7-day trial once:
  the owner's stated consequence of "a continuation is not the trial".
- Whether Stripe honours a `trial_end` that a page completed late has brought under 48 hours is a
  check in the test-mode runbook (`docs/subscriptions-stripe-runbook.md`, check 26); the host's
  margin can be raised if it does not.

## Proof
`packages/core/test/subscription-offers.test.ts`: taking an offer sends `trialEnd` and no
`trialDays` and writes no trial row; while the offer is open, and while the subscription from it
runs (set to end too), a start gets no trial (`continuation`); once it has ended the trial is
given once; under 48 hours the page has no `trialEnd`, the offer is taken charged at once and no
trial follows while that subscription runs; a past date is refused and the person's own start gets
the trial; a withdrawn offer gives the trial back. The dates: a date in UTC, Sydney and London in
summer time, and a moment with its offset. Each removed, tests fail: the running-subscription
check (2), the open-offer check (1), the offer's date (an expired offer counted, 1), sending the
date with under 48 hours (1).

## Amended (2026-11-22, before merge)
The first build gave no trial ever again to anyone with an offer that staff had not withdrawn,
taken or expired. The owner's answer was that a continuation is not the trial, with the stated
consequence that a returning former subscriber could still get the trial once. Corrected to the
rule above: no trial while an offer can be taken or a subscription from one has not ended; the
one-trial rule once it has.
