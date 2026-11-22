# ADR 0485: Recurring billing: the provider runs the schedule, the host mirrors current reads

Status: accepted, 2026-11-22 (stage 32a, build steps 1 and 2; [the spec](../stages/32-memberships.md),
interview decisions 2, 4, 5 and 6). Builds on ADRs
[0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md),
[0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md),
[0437](0437-a-move-is-made-from-a-current-read.md) and
[0479](0479-tax-at-checkout.md).

## Context
A company sells things paid for every month: first a subscription to its online courses, later
gym memberships. Stage 25 decided that nothing on the platform stores a card or charges one on a
schedule. The interview decided that the provider (Stripe) keeps the card, charges each period,
retries a failed charge, emails the payer, and ends the subscription when told or when its retries
run out (decisions 2, 4 and 6), and that the payer manages the card in the provider's portal while
cancel and resume are the host's operations (decision 5).

## Decision

**A plan is a sellable object that recurs.** `sellable.recurring: { interval, trialDays? }`
(`week`, `month` or `year`; a number field for the trial's days) makes an object a plan: its
records are subscribed to (`subscription.start`) and never put on an order (`order.start` refuses
one, and refuses anything but a plan in `subscription.start`). A plan has no `deposit`,
`maxPerOrder` or `grants` (the contract check refuses them; 32b adds what a subscription grants).
No pack declares a plan yet: Courses' `courses.plan` is build step 3. Tests use a fixture.

**The gatekeeper's subscription calls.** The payments session gains:
- `createSubscriptionCheckout` (an observation, as a checkout is): the provider's page that takes
  the card and starts the subscription, priced by the host, with the plan's trial (`trialDays`)
  or a free period until a moment (`trialEnd`, for step 4's continuation: at least 48 hours ahead),
  and tax when the host asks (below).
- `getSubscription` (an observation): a read now.
- `cancelSubscription { when: "period_end" | "now" }` and `resumeSubscription`: outbound actions
  `payments.subscription.cancel` and `payments.subscription.resume`, never auto-approvable. An
  agent's session holding the payment account waits for a person. The host's own call
  (`callAsHost`, purpose `orders`) is applied at once, as the host's order confirmation is: the
  host's operation has already established that the caller may (their own subscription).
- `openPortal` (an observation): the provider's customer portal for one customer, with a
  configuration the gatekeeper makes once and keeps (card, billing details, invoices on;
  cancelling, plan changes and pauses off), so cancelling goes through the host.

**Events are current reads.** A Stripe webhook is verified first (its signature, as stage 25's),
and nothing is stored before. For a subscription event the gatekeeper takes only the ids from the
payload (the subscription's, and the invoice's for an invoice event), reads the subscription (and
the invoice, with `expand[]=payments`) from Stripe now, with a pinned API version, and stores that
read as the event (`kind: "subscription"`, a `trigger` saying what happened, `observedAt`). A read
that fails answers 500, so Stripe delivers again. Two reasons:
- a webhook's payload is shaped by the endpoint's own API version, not by the version a request
  sends, and the fields read here moved in 2025-03-31.basil; a read with a pinned version has one
  shape;
- Stripe does not deliver events in order. A current read says what is true now; the host keeps
  the read time of the read it last moved from (`observed_at`) and an older read moves nothing.

Events read: `checkout.session.completed` in subscription mode, `customer.subscription.created`,
`.updated`, `.deleted`, `.paused`, `.resumed`, `.trial_will_end`, `invoice.paid`,
`invoice.payment_failed`, `invoice.payment_action_required`, `invoice.finalization_failed`, and
`credit_note.created` (ADR 0486). `invoice.payment_succeeded` is not read: `invoice.paid` says the
same and also covers an invoice paid another way. A subscription's `checkout.session.completed` is
never read as an order's payment. The fake provider delivers its own ledger's read in the same
shape, signed, through the same route.

**The record: `core_subscription`, a base record beside Order** (migration 0530). It holds the
payer and the holder (ADR 0487), the plan by object and id with its title, price and interval as
agreed at the start, the tax code sent (or none), the provider's references, the state, the
trial's end, the current period, whether it ends at the period's end, when and why it ended, the
provider's page for a renewal waiting on 3D Secure, and when it started failing. It is in the
registry (`subscription`) but not the generic object list. Its customer declaration names the
payer: a customer reads the subscriptions they pay for, and nobody else's.

**It exists only once the provider says so.** `subscription.start` records a
`core_subscription_checkout` (the id to be, the payer and holder, the plan as priced) and opens the
provider's page; the provider carries that id as `metadata.cos_subscription`. The first verified
event for a provider subscription makes `core_subscription` from that checkout, in the state the
read says. An event no checkout of this host's explains (no id, an unknown id, or an id whose
checkout already started another provider subscription), or one whose price, currency or interval
is not what was agreed, moves nothing and tells staff.

**Every move is the host's.** The machine mirrors the provider's statuses: `incomplete`,
`trialing`, `active`, `past_due`, `unpaid`, `paused` move freely between each other as the
provider's do; `expired` (the provider's `incomplete_expired`) and `ended` (`canceled`) are final.
Every move is `by: ["host"]`, made only by `applySubscriptionEvent`, which is reached only from
`order.applyPaymentEvent` (actor `automation`, input the stored event's key). No operation takes a
state; ending at the period's end is a flag, not a state. A repeated event is a duplicate by the
provider's event id (`core_payment_event`, now with kind `subscription`); a read older than the
last applied, or one for an ended subscription, records `stale` and moves nothing.
`core_subscription_stale` refuses a write made from an older read of the row, and the adapter
applies the event again on that, on a move made meanwhile, and on two deliveries making the same
row or the same period's order at once.

**Failing.** The provider retries (Smart Retries) and emails the payer (decision 6). The host
mirrors `past_due` and keeps everything while it retries (decision 4: access, in step 3, follows
the state), tells staff once per failing invoice, keeps the provider's link for a renewal that
needs the payer to confirm it, tells staff at once of an invoice the provider cannot finalize, and
tells staff when the retries ran out and it ended (`end_reason: payment_failed`). The company's
provider setting for exhausted retries should be "cancel the subscription" (runbook, step 4).

**Tax on each period.** When a human admin has turned tax on and the plan declares a code, the
checkout sends the price tax-inclusive with the plan's product tax code and automatic tax on
(billing address required); otherwise nothing about tax is sent. The code sent is kept on the
subscription: its periods keep the provider's tax figure (ADR 0486); a subscription opened without
tax keeps none, whatever the provider reports.

**The payer's operations.** `subscription.start` (staff, customer, public), `subscription.get` and
`.list` (staff; a customer their own), `subscription.cancel` and `.resume` (staff; a customer
their own; `actors: ["human"]`), `subscription.portal` (a customer, for their own provider
customer). Cancel and resume ask the provider; the record shows the change once the provider's
event arrives. Ending one at once (`when: "now"`, staff, `subscriptions:manage`) is step 3's staff
side: the gatekeeper supports it; no operation calls it yet.

## Verified against Stripe's documentation (read 2026-11-22)
Latest API version on the changelog: `2026-11-18.endive`, pinned as `STRIPE_BILLING_VERSION` on
every subscription call.
- Checkout `mode=subscription` with inline `price_data[recurring][interval]`,
  `price_data[tax_behavior]=inclusive`, `product_data[tax_code]` (both it and
  `product_data[tax_details][tax_code]` exist in endive; the plain one is used),
  `automatic_tax[enabled]`, `billing_address_collection=required`, `payment_method_collection=always`
  (top level, subscription mode only), `subscription_data[metadata]`,
  `subscription_data[trial_period_days]` (at least 1), `subscription_data[trial_end]` ("at least
  48 hours in the future", no maximum stated; this gatekeeper caps both at 730 days),
  `subscription_data[trial_settings][end_behavior][missing_payment_method]=cancel`,
  `subscription_data[billing_mode][type]=flexible` (Checkout accepts it; flexible has been the
  default since 2025-09-30.clover; set anyway). Subscription mode always makes a Customer:
  `customer` reuses the payer's, `customer_email` prefills a new one.
- Trial offers: generally available in 2026-09-30.endive for the Subscriptions API only; in
  Checkout still a private preview. Trial days are used, as the spec said.
- The Subscription: `status` values as above; `current_period_start` and `_end` only on
  `items.data[]` since basil; `cancel_at_period_end` deprecated in favour of `cancel_at` (2025-05-28)
  but still settable and honoured, so the host sets it, undoes it with `false`, and reads either as
  "ending"; `DELETE /v1/subscriptions/:id` ends it now (`invoice_now` and `prorate` default false);
  `/resume` is for a `paused` subscription, not for undoing a cancellation;
  `cancellation_details.reason` includes `payment_failed`.
- The Invoice: subscription under `parent.subscription_details.subscription` since basil (the top
  level read too, for an endpoint on an older version); the PaymentIntent under
  `payments.data[].payment.payment_intent`, includable with `expand[]=payments`; the service period
  on `lines.data[].period`; tax in `total_taxes[].amount` (`tax` and `total_tax_amounts` removed in
  basil); `customer_address.country`; `billing_reason`, `attempt_count`, `next_payment_attempt`,
  `hosted_invoice_url`.
- Webhooks: the event types above exist; "Stripe doesn't guarantee the delivery of events in the
  order that they're generated"; "each webhook endpoint has a specific API version. Stripe uses
  that version to structure the event payloads".
- The portal: `billing_portal/sessions` takes `customer`, `return_url`, `configuration`; a session
  expires after 5 minutes unused, within an hour of last use; the portal cannot be framed.
  `billing_portal/configurations` needs `features`; `business_profile` is optional;
  `features[subscription_pause]` is new in 2026-10-28.endive.
- Billing's fee: 0.7% of billing volume, pay as you go, on each regional page read (AU, GB, DE, FR,
  JP); the US page could not be read directly (requests were sent to the AU one).
- Smart Retries: up to 8 retries within 2 weeks by default (1 week to 2 months); what happens when
  they run out (cancel, mark unpaid, leave past due, pause) is a Dashboard setting, not an API field.

Not verified, to check in Stripe's test mode by hand (step 4's runbook): a `DELETE` with
`cancellation_details[comment]` in a form body; the portal configuration's `allowed_updates` list
as sent; that a credit note linked to an existing refund (`refunds[0][refund]`) is accepted with
`amount` equal to the refund (ADR 0486), and that an amount-only credit note on an automatic-tax
invoice returns `total_taxes`; that the account accepts the pinned `Stripe-Version:
2026-11-18.endive`; how Stripe answers a trial that crosses `trial_end`'s 48-hour floor because the
page was opened 47 hours before it.

## Amended after review (2026-11-22)
Before the branch was merged, a review found what follows; each is changed above or here, with a
test that fails without it.
- **A subscription this host did not start, or one it cannot read, is ignored, never retried.**
  Whose a subscription is comes from the fresh read's `metadata.cos_subscription`, not the
  payload. One without it (another integration's in the same Stripe account), or one whose price
  is tiered, metered or decimal (no `unit_amount`), or whose invoice cannot be read, is answered
  200 and counted (`PaymentsEvents` stats, `ignored.foreign` and `ignored.unreadable`). Only a read
  that failed answers 500: Stripe disables an endpoint that keeps failing, and that would stop
  one-off payments too.
- **Terms changed at the provider.** A read whose price, currency or interval is not what the
  subscription was agreed at tells staff once for the subscription and applies only what removes
  or reduces what the member holds: a move to a state that gives less (past due, unpaid, paused,
  ended, expired) or an end being set. It never extends anything (a later period, a trial, a
  failing one paid). Paid periods on it are orders, flagged (ADR 0486). A first read not as agreed
  still makes no subscription.
- **The portal opens only for the host's own call.** The session's `openPortal` asks its approval
  queue whether it is the host's own orders call (`isHostOrders`, answered only by the runner's
  queue for `callAsHost` with purpose `orders`), as the email gatekeeper asks about the host's
  sign-in mail (ADR 0456). Code Mode, an extension's tool, the assistant and MCP are refused: a
  portal address for an arbitrary customer shows their invoices and lets their card and email be
  changed.
- **`subscriptions:manage`** is a new permission (admins by default, grantable one by one as
  `orders:refund` is). `subscription.cancel` and `.resume` need it for staff; a customer cancels and
  resumes their own through the audience, as before.
- **`cancel_at` is reported apart.** The read's `cancelAtPeriodEnd` is Stripe's
  `cancel_at_period_end` only; a `cancel_at` date set another way (the dashboard, a schedule) is
  `cancelAt` (`core_subscription.cancel_at`). Resume sets `cancel_at_period_end=false`, Stripe's
  documented way to stop a pending cancellation (docs.stripe.com/billing/subscriptions/cancel,
  read 2026-11-22); removing a `cancel_at` date changes the period and prorates, so resume refuses
  it and says staff change it in the provider's dashboard, instead of reporting "requested".
- **The confirm-your-payment link** is kept only from a read applied now (not a stale one), for an
  invoice still `open`, on a subscription still owing; any move to a state that owes nothing
  (active among them) clears it.
- **A deleted provider customer** no longer fails every start: the host sends the payer's address
  with the customer it reuses, and the gatekeeper, refused with `resource_missing` on `customer`,
  opens the page again with a new customer from the address (its own idempotency key).
- **The fake provider runs off localhost only with its own secret.** With the default signing
  secret, which is public, anyone who can reach `/in/fake` could report a paid order or a paid
  subscription period. `PAYMENTS_FAKE_PROVIDER=true` now turns the fake on only when
  `FAKE_WEBHOOK_SECRET` is set, or the base address is `http://localhost` or `http://127.0.0.1`
  (the CRM's dev server and its e2e). A staging environment that tries checkout with the fake must
  set the secret (`docs/deploying.md`).

## Amended (2026-11-22): the fake's secret is a generated secret (issue #217)
`FAKE_WEBHOOK_SECRET` was a plain var of the gatekeeper, which no environment could set, so after
the change above a client's staging could no longer try checkout with the fake. It is now a secret
of the gatekeeper (release manifest source `generated`). The installer, and so `cos deploy`,
generates one (32 random bytes, hex) for a gatekeeper whose vars turn the fake on and that has
none stored or supplied with `--secret`; it is never printed and is written nowhere but the Worker,
and later deploys keep it. Only an environment marked `live: false` may turn the fake on (ADR
0452), so a live one never gets the secret. Local development and tests are unchanged: with no
secret, the public default still works on localhost only. A plain var of that name in an older
deployment state is dropped and never uploaded beside the secret.

## Consequences
- The host never decides that money is owed or taken: it opens the provider's page, asks the
  provider to stop or keep going, and mirrors what the provider's verified reads say.
- Every subscription webhook costs one or two Stripe reads. A read that fails is retried by
  Stripe's own redelivery.
- The one-trial rule (per holder per plan object), the `subscription` access kind, `courses.plan`
  and the staff side are build step 3. Until step 3, `subscription.start` gives the plan's trial
  every time: no pack declares a plan, so nothing can be subscribed to outside tests.
- Turning tax on later does not reach subscriptions already running (the spec's guess at an
  update of every live subscription is not built: the provider's page on it was not read). Recorded
  in the spec as left for step 4.

## Note (2026-11-22, build step 3)
The one-trial rule is built ([ADR 0489](0489-one-free-trial-per-person-per-plan.md)): a trial only
for a proved holder, once per holder per plan object, held while its page is open and used when
the provider confirms it. The `subscription` access kind is [ADR 0488](0488-the-subscription-access-source.md);
`courses.plan`, the members' blocks and the staff side (with ending one at once, `now`) are
[ADR 0490](0490-the-course-plan-self-service-and-the-staff-side.md).
