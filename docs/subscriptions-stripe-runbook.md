# Subscriptions with Stripe: a test-mode run by hand

Stage 32a's acceptance needs one run against Stripe in test mode, which automated tests never make
(they use the fake provider). It also settles the checks that Stripe's documentation alone could
not, listed in [the spec](stages/32-memberships.md) ("Step 4's test-mode runbook: open checks").
**Status: not yet run; needs a person with a Stripe account.** Run it before any company's
subscribers move (the continuation offers, part 7).

Design: ADRs [0485](adr/0485-recurring-billing-the-provider-runs-the-schedule.md) (the provider
runs the schedule),
[0486](adr/0486-an-order-per-paid-period-and-its-refund.md) (an order per paid period, its refund),
[0489](adr/0489-one-free-trial-per-person-per-plan.md) (one trial per person per plan),
[0490](adr/0490-the-course-plan-self-service-and-the-staff-side.md) (the course plan, the blocks,
the staff side), [0491](adr/0491-continuation-offers.md) and
[0492](adr/0492-a-continuation-replaces-the-trial.md) (continuation offers). The gatekeeper:
[`packages/gatekeeper-payments/README.md`](../packages/gatekeeper-payments/README.md),
"Subscriptions". One-off payments and tax at checkout have their own run:
[`payments-stripe-runbook.md`](payments-stripe-runbook.md); do its parts 1 to 3 first.

Take a screenshot at each numbered check into `docs/stages/assets/stage-32a-stripe/`. Write down
every result, including the ones that mean "as expected": each check below says what each answer
means and what to do about it.

## You need
- Everything [`payments-stripe-runbook.md`](payments-stripe-runbook.md) lists, done through its
  part 3 (keys, the gatekeeper deployed and bound, the payments connection active, the currency
  and the sites a buyer may come back to). **Test mode only**: never live keys.
- The Courses pack installed, a published course, and a course plan (Course plans) priced, for
  example, 29.00 a month with 7 trial days.
- Customer sign-in working on the deployment (Settings → Customers: an email connection that sends
  the sign-in code), and two email addresses you can read.
- If you use a restricted key: write access to Checkout Sessions, Subscriptions, Customers,
  Invoices, Credit Notes, Refunds and Customer Portal (Billing Portal configurations and
  sessions), and read access to Payment Intents. Check the names in the Dashboard; the build did
  not.

## 1. The webhook's events
Add these to the endpoint of part 2 of the payments runbook (Stripe → Developers → Webhooks → your
endpoint → Update details): `customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `customer.subscription.paused`,
`customer.subscription.resumed`, `customer.subscription.trial_will_end`, `invoice.paid`,
`invoice.payment_failed`, `invoice.payment_action_required`, `invoice.finalization_failed` and
`credit_note.created` (`checkout.session.completed` is there already).

**Check 1:** the endpoint lists them. The endpoint's own API version does not matter: the
gatekeeper reads each subscription again with its own pinned version (ADR 0485).

## 2. The company's own provider settings (decisions 4 and 6)
These are the company's settings in its Stripe account, not the platform's, and nothing the host
can set or read. Open each and set it; screenshot each.

1. **Retries exhausted → cancel the subscription.** Dashboard → Settings → Billing → Subscriptions
   and emails → Manage failed payments → "If all retries for a payment fail": **cancel the
   subscription**. **Check 2:** it says cancel. If it says mark unpaid, the host keeps such a
   subscription `unpaid` (no access) and it never ends; if it says leave past due, the host gives
   access for 30 days of failing and then stops (ADR 0488) and staff are told. Either works, but
   only "cancel" ends it cleanly, which is what was decided.
2. **Smart Retries** on (the default for new accounts): up to 8 retries within 2 weeks. **Check 3:**
   on, and the window is what the company wants (1 week to 2 months).
3. **Customer emails** (Settings → Billing → Subscriptions and emails → Customer emails): **send
   emails when card payments fail**, **send reminders when cards are about to expire**, and
   **send a link to a Stripe-hosted page when a payment needs to be confirmed (3D Secure)** on;
   the trial reminder (7 days before a trial ends) is the company's choice. **Check 4:** each is
   on. If they are off, nobody tells the member their payment failed: the host tells staff only
   (decision 6).
4. **Nobody pauses collection.** Stripe's "Pause payment collection" (`pause_collection`) keeps a
   subscription `active`, so the host keeps giving access while nothing is charged (ADR 0488).
   **Check 5:** tell everyone with Dashboard access not to use it; staff end or (in 32b) pause a
   subscription from the host. Nothing to screenshot; write down who was told.

## 3. The pinned API version
Start a subscription (part 4, step 1) and watch the gatekeeper's log
(`wrangler tail cos-gatekeeper-payments`).

**Check 6:** the checkout opens. Every subscription call sends
`Stripe-Version: 2026-11-18.endive` (`STRIPE_BILLING_VERSION`). If Stripe refuses it (an
`invalid_request_error` naming the version, or "Invalid Stripe API version"), the account cannot
use it yet: no subscription can be started. Stop, and change `STRIPE_BILLING_VERSION` in
`packages/gatekeeper-payments/src/stripe.ts` to the newest version the account accepts, then
re-read the fields ADR 0485 lists for that version before going on.

## 4. A subscription with a free trial
1. In a private window, sign in on the site as a customer (your first address) and open the page
   with the subscribe block. **Check 7:** the plan shows "Start your 7-day free trial".
2. Start it. On Stripe's page (`checkout.stripe.com`) pay with `4242 4242 4242 4242`. **Check 8:**
   Stripe's page says the trial and the date of the first charge, and asks for the card; after it,
   the member's subscription block says "Free until <date>, then charged each month", and every
   published course opens.
3. **Check 9 (the checkout status the trial rule asks):** in the log, the host's
   `getSubscriptionCheckout` read of an earlier page answers `status` `open`, `complete` or
   `expired`. To see it: start a second subscription as the same customer before paying the
   first, then come back. If the status is anything else, or the call fails, the host gives no
   trial (`noTrial: "unconfirmed"`): safe, but every second attempt says "try again later". Record
   what Stripe answered.
4. Start a trial again as the same customer after the first is confirmed. **Check 10:** no trial is
   offered; Stripe's page asks for the first payment at once.

## 5. The portal, cancel and resume
1. In the subscription block, "Card and invoices". **Check 11 (`allowed_updates`):** the portal
   opens. The gatekeeper creates its portal configuration once with
   `features[customer_update][allowed_updates]` = address, email, name, tax_id. If Stripe refuses
   the configuration (the log shows `/v1/billing_portal/configurations` answered 400 naming
   `allowed_updates`), the portal cannot open for anyone: record Stripe's message and change the
   list in `#portalConfiguration` (`stripe.ts`) to what it accepts. In the portal, **check 12:**
   there is no cancel, no plan change and no pause (those are the host's).
2. Back on the site, "Cancel subscription". **Check 13:** within seconds the block says it ends on
   the period's end; in Stripe the subscription shows "Cancels <date>".
3. "Keep my subscription". **Check 14:** Stripe no longer shows a cancellation.
4. As staff, the subscription's page → "End now", with a reason. **Check 15
   (`cancellation_details`):** Stripe shows it cancelled, and its cancellation comment is the reason
   you typed. The gatekeeper sends `DELETE /v1/subscriptions/:id` with
   `cancellation_details[comment]` in a form body. If Stripe refuses the body (400) or ignores the
   comment, ending at once fails or loses the reason: record which, and move the comment to a
   `POST` before the `DELETE` in `cancelSubscription` (`stripe.ts`).

## 6. Renewal, failure and a period's refund
Use a [test clock](https://docs.stripe.com/billing/testing/test-clocks) to move time, or a plan
with no trial.

1. Renew: advance the clock past the trial. **Check 16:** the host shows a paid order for the
   period with the plan's price (Orders), and the subscription is Active.
2. Fail: update the customer's card to `4000 0000 0000 0341` (attaches, then declines) and advance
   to the next renewal. **Check 17:** the subscription is Past due, staff got "A subscription's
   payment failed", the member keeps every course, and (if check 4 holds) Stripe emailed them.
   Advance until the retries run out. **Check 18:** the subscription Ended (with check 2's
   setting), staff were told, and the courses no longer open.
3. Refund a period: on a paid period's order, Refund the full amount; approve it. **Check 19
   (a credit note linked to an existing refund):** Stripe shows the refund and a credit note on
   the invoice for the same amount, linked to that refund. The gatekeeper sends the refund, then
   `POST /v1/credit_notes` with `refunds[0][refund]` = the refund and `amount` equal to it, on an
   invoice paid in full. If Stripe refuses the credit note, the refund still stands, and the host
   keeps retrying the credit note (the order shows the refund's tax as not yet known): record
   Stripe's message.
4. With tax on (the payments runbook, part 8) and a taxed plan, refund a period. **Check 20
   (amount-only credit note tax):** the credit note's `total_taxes` has the tax given back, and the
   order shows "Tax refunded" with that figure. If `total_taxes` is empty on an automatic-tax
   invoice, the host keeps the refund's tax unknown, never a zero (built so already): record it,
   and the company's accountant reads the tax back from Stripe's reports instead.

## 7. Continuation offers: moving subscribers from another platform
The run that the course subscribers' move depends on. Use your second address.

1. As staff, create a Person with the second address (the people import, or People → New).
2. Write `offers.csv`:
   ```csv
   email,paid_up_to,reference
   <second address>,<a date three weeks away, YYYY-MM-DD>,old-sub-1
   ```
   and run, as a person with `subscriptions:manage` and `users:manage`:
   ```sh
   cos subscriptions offers import offers.csv --host https://<crm-origin> --plan courses.plan --dry-run
   cos subscriptions offers import offers.csv --host https://<crm-origin> --plan courses.plan --invite
   ```
   **Check 21:** the dry run says 1 would be created and writes nothing (Subscriptions →
   Continuation offers is empty); the import says 1 created and 1 invited; running it again says 1
   unchanged.
3. Set customer sign-up to **invite only** (Settings → Customers), sign in as the second address
   in a private window, and open the subscribe block. **Check 22:** the plan says the
   subscription is paid up to that date and offers "Continue, free until <date>"; no trial is
   offered on any plan.
4. Continue. **Check 23 (`trial_end`):** Stripe's page says nothing is charged until that date
   (00:00 in the organisation's time zone), asks for the card, and shows no 7-day trial. After
   paying, the block says "Free until <date>"; every course opens; Orders has no paid order for
   them; in Stripe the subscription's trial ends on that date.
5. Staff: Subscriptions → Continuation offers. **Check 24:** the offer is Taken, "Charged from"
   is that date, and Download CSV has the row with `status` `taken` and `charges_from`.
   `cos subscriptions offers report --host https://<crm-origin> --status taken` prints the same.
6. **The 48-hour floor.** Import a third person with a paid-up date about 47 hours away. **Check 25:**
   the import notes "under 48 hours"; the block says continuing is charged from today; Stripe's
   page asks for the first payment at once, with no trial; the report says Taken, charged at once.
   Then import a fourth with a date 49 hours away, open the provider's page, and wait more than an
   hour before paying (so the date is under 48 hours away when the page is completed).
   **Check 26:** record what Stripe does: completes with the trial end as sent, refuses the
   payment, or changes the date. The host opens the page only with at least 48 hours and 15
   minutes left; if Stripe refuses a page completed later, raise `OFFER_MIN_FREE_MS`
   (`packages/core/src/subscriptions/offers.ts`) by a day, so a page that lasts 24 hours never
   crosses it.
7. **Only its own person.** Sign in as your first address and open the subscribe block. **Check
   27:** no offer is shown. As a guest (signed out), **check 28:** no offer is shown, and the trial
   needs signing in.
8. Withdraw: import a fifth person, then Continuation offers → Withdraw, with a reason. Sign in as
   them. **Check 29:** no offer is shown.

## Afterwards
Cancel the test subscriptions, delete the test clock if you made one, set customer sign-up back to
what it was, and record the date, who ran it and every check's result in this file's status line.
Anything that answered differently from what a check expected is a change to make before a
company's subscribers move.
