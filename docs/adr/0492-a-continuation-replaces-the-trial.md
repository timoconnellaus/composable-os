# ADR 0492: A continuation replaces the trial, is not the trial, and under 48 hours is charged at once

Status: accepted, 2026-11-22 (stage 32a, build step 4; interview decision 7; owner decisions of
2026-11-22 recorded in [ADR 0489](0489-one-free-trial-per-person-per-plan.md)). Builds on ADRs
[0485](0485-recurring-billing-the-provider-runs-the-schedule.md),
[0489](0489-one-free-trial-per-person-per-plan.md) and [0491](0491-continuation-offers.md).
Amends ADR 0489.

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

**A continuing subscriber never gets the plan's trial.** A holder with an offer on a plan object
that staff have not withdrawn (open, held, taken or expired) is given no trial on any plan of that
object (`noTrial: "continuation"`): they are continuing, not trying it, and the trial would be free
time the company did not decide to give. Withdrawn offers do not count (staff withdraw one made in
error, and that person may be new). The subscribe block shows a member with an offer no trial on
any plan, and says why if the host refuses one.

**Under 48 hours, or already past: they subscribe normally, charged at once, with no trial.**
- With less than 48 hours and 15 minutes to the date when the page is opened (the provider's floor,
  and a margin for the call), the offer is taken with no free time: the page asks for the first
  payment at once, and the offer is marked taken `charged_from_start`. The overlap with the old
  platform is at most two days; giving free time to the floor instead would be up to two days the
  company did not decide to give.
- Once the date has passed the offer cannot be taken; the person subscribes without it, charged at
  once, and (above) gets no trial.
- Both are said: the import's report notes `under_48_hours` and `past` with each row's line; the
  member's block says continuing is charged from today; the report marks a taken offer "at once"
  and, for an offer not taken, a subscription the person started another way.

**When "paid up to" is.** A date is 00:00 on that day in the organisation's time zone: the day the
old platform would have charged next, so the first charge here falls on it. A source that knows
the moment gives it with its offset.

## Consequences
- A moving subscriber is charged for the first time on the day their old subscription would have
  renewed, if they take their offer at least two days before it.
- A person who misses their date pays from the day they subscribe, with no trial; the company can
  import a later date for them (an offer not yet taken updates) if it wants to give more.
- Whether Stripe honours a `trial_end` that a page completed late has brought under 48 hours is a
  check in the test-mode runbook (`docs/subscriptions-stripe-runbook.md`, check 26); the host's
  margin can be raised if it does not.

## Proof
`packages/core/test/subscription-offers.test.ts`: taking an offer sends `trialEnd` and no
`trialDays` and writes no trial row; the plan's trial is refused afterwards with `continuation`;
under 48 hours the page has no `trialEnd` and the offer is taken charged at once; a past date is
refused and the person's own start gets no trial; a withdrawn offer gives the trial back. The
dates: a date in UTC, Sydney and London in summer time, and a moment with its offset.
Removing the continuation rule fails 2 tests; sending the date with under 48 hours fails 1.
