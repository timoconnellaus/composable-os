# ADR 0490: The course plan, members' self-service on the web, and the staff side for subscriptions

Status: accepted, 2026-11-22 (stage 32a, build step 3; interview decision 5; stage 42's "where
people buy: on the web, never in the app"). Builds on ADRs
[0478](0478-the-courses-pack.md), [0485](0485-recurring-billing-the-provider-runs-the-schedule.md),
[0488](0488-the-subscription-access-source.md) and
[0489](0489-one-free-trial-per-person-per-plan.md).

## Decision

**`courses.plan` in the Courses pack.** Title, description, price per month, trial days (0 to 90;
empty or 0 is charged from the start), read by the public; `sellable` with the courses' tax code
(`txcd_20060158`) and `recurring: { interval: "month", trialDays: "trialDays" }`. `courses.course`
adds `{ kind: "subscription", options: { plans: "courses.plan", covers: "all" } }` to its
`access.sources` (ADR 0488). The pack hooks no write and holds no rule: the price is the host's,
the trial is the host's (ADR 0489), the access is the seam's. A new tool, `x.courses.plans`
(customer, public, read), lists the plans; `x.courses.myCourses` reports a course held with no
enrolment as `why: "subscription"`, from `access.check`.

**Members' self-service is the web's, through the host's own operations.** The pack's client gains
`usePlans`, `useSubscribe` (`subscription.start`), `useMySubscriptions` (`subscription.list`,
filtered to the plan object), `useCancelSubscription`, `useResumeSubscription` and
`useBillingPortal` (`subscription.portal`), and display helpers (`subscriptionStatus`,
`formatMinor`). Two web blocks:
- `courses-subscribe`: the plans with the host's price and trial days; a signed-in customer starts
  the trial, a guest gives an email and pays from today or follows `signInUrl` for the trial;
- `courses-subscription`: the member's own subscriptions in words (trial until, next charge,
  ending on, a payment to confirm with the provider's link), cancel at the period's end, keep it
  going, and "card and invoices" (the provider's portal, in its own page). The block shows only
  what the host reports; every action can be refused by the host.

**The app reads only.** `courses-native-subscription` shows the state, the next charge or end date
and that it gives every course: no price, no button. It is `noPurchase`, and the block lint now
refuses the subscription's billing operations (`subscription.start`, `.cancel`, `.resume`,
`.portal`, and 32b's `.change`, `.pause`) and their hooks in **every** native block, marked or
not: keeping every billing action on the web is the simpler rule for the stores (the spec's
guess, kept).

**The staff side, in the admin app.** A Subscriptions section (`/subscriptions`) with the views
staff need: all, trials, failing (past due or unpaid, oldest failure first: the daily list of
failing payments) and ending; a subscription's page with its terms, payer and holder, period, end,
and the paid order of each period (refunds stay the order's, through approval); a Person's
subscriptions on their page. Staff with `subscriptions:manage` cancel at the period's end or end
it now, with a reason, and keep a cancelled one going. `subscription.cancel` gains `now` for
staff (a customer is refused); the provider's event then moves the record. Notifications about a
subscription link to its page.

## Deviations from the spec
- **An AI does not propose a cancel.** The spec says "an AI may propose, a person approves, as for
  refunds". Steps 1 and 2 made `subscription.cancel` and `.resume` `actors: ["human"]` (ADR 0485),
  and the gatekeeper's cancel action is never auto-approvable; letting the assistant queue one
  would need the approval flow to carry a host-internal call made for someone else. Kept as built:
  a person decides; the assistant can point staff at the subscription's page.
- **Saved views on the generic list** are not used: `subscription` is a base record outside the
  generic object list (as Order is, ADR 0427), so its views are tabs of its own page.

## Consequences
- A client app adds the two web blocks to its account pages and the native block to its app.
- The block lint's native rule applies to every pack's native blocks, not only Courses'.

## Amended after review (2026-11-22)
- **The block lint is a product rule, not a security boundary.** It keeps billing off the app for
  the stores' sake and catches mistakes; what a caller may do is the host's (audiences, the seam,
  `subscriptions:manage`). It now also reads a block's raw source for a billing operation named as
  a string, walks a block's subfolders, and refuses an operation a block's code names that its
  `block.json` does not list.
- **The subscribe block says why there is no trial** (`noTrial`) before the provider's page asks
  for the first payment, and offers signing in for it when the reason is `sign_in`.
- **`now` is in the customer API's input schema** for `subscription.cancel`: the contract
  generator has one input per operation, not one per audience. A customer's `now: true` is refused
  (`invalid_input`), tested.
