# ADR 0532: The Memberships dashboard, views, the Person page and the members' blocks

Status: accepted, 2026-11-22 (stage 32b, build step 7). Builds on ADRs
[0490](0490-the-course-plan-self-service-and-the-staff-side.md),
[0511](0511-the-memberships-pack-and-passes.md),
[0530](0530-plan-changes-upgrade-now-downgrade-next-period.md) and
[0531](0531-staff-pause-a-membership-for-a-set-time.md).

## Decision
**The Memberships dashboard** (`packs/memberships/dashboards.ts`), read-only SQL over the rec_*
views, with one date filter:
- now, whatever the dates: active, on trial, paused and failing (past due or unpaid) memberships,
  each clicking through to exactly those memberships, and a table of the failing ones;
- in the period: trials that ended and those with a paid period after the trial; recurring revenue
  (the paid orders of membership subscriptions, `rec_order.net`: less refunds and the tax inside
  them); cancellations by month and the provider's reason (asked for, payments failed); classes
  taken (uses of memberships and passes not given back, by the class's time) in all and by week.
It is checked against a fixture worked out by hand, end to end through the fake provider
(`apps/runner/test/memberships-changes.test.ts`, criterion 16).

**The subscription shows its change** (migration 0630's `rec_subscription`): the open plan change
or pause, or the pause it is in, as fields of the base record the seam reads
(`changeKind`, `changeState`, `changeToPlanTitle`, `changeToAmount`, `changeEffectiveAt`,
`pauseFrom`, `pauseUntil`), which a customer reads on their own and staff on any. No operation
reads it past the seam.

**Views**: "Paused" and "Passes expiring this week" beside step 6's (active, on trial, past due,
ending this month, passes expiring this month). "Trials ending this week" stays the admin's
Subscriptions → Trials tab (a trial's end is the subscription's, not the membership's).

**The staff side**: the subscription's page in the admin has Change plan, Pause and End the pause,
each with a reason, and shows the change waiting; a Person's page keeps its Subscriptions card
and Memberships and Passes tabs (step 6).

**Blocks and hooks** (`add-block`): `useChangePlan` (web only), `usePauseSubscription`,
`useUnpauseSubscription`, `useSubscriptionsOf` (staff), and the display helpers `changeWords`,
`canChangePlan` and `changeRefusalWords`. `memberships-mine` gains Change plan (the host says
whether it is now or from the next month); `memberships-staff-holdings` gains pausing a person's
membership and ending the pause; `memberships-native-mine` shows a change or a pause in words and
calls nothing new (the block lint refuses `subscription.change` and `.pause` in every native block,
ADR 0490).

## Not done
- A list of each use on the Person page (the spec's "and uses"): uses are counted on each holding
  (the holdings block, `x.memberships.mine`) and on the dashboard, and `rec_allowance_use` is
  queryable, but no tab lists them: a record tab needs an object, and a use is a core row. A core
  read of a person's uses, or uses as a registry object, is for later.
- The Courses dashboard's subscription numbers (the spec's "and the Courses dashboard's
  subscription numbers") are unchanged.

## Amended after review (2026-11-22, before merge)
The subscription's change also shows what the provider answered (`changeCallOutcome`,
`changeEndOutcome`) and an upgrade's confirm-payment page (`changeActionUrl`), to the payer and
staff. The admin's subscription page says them in words and has **Withdraw the change**
(`subscription.change.withdraw`); the member's block shows **Confirm the new plan's payment** when
an upgrade's charge waits on them, and says when the provider's answer was lost.

## Amended after the second review (2026-11-22, before merge)
A withdraw that did not finish keeps the change shown, with "Withdrawing it did not finish: try
again", and the admin's toast says so instead of "withdrawn". The confirm-payment button shows only
for an upgrade still open.
