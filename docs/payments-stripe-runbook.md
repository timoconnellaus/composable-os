# Payments with Stripe: a test-mode run by hand

Stage 25 acceptance needs one run against Stripe in test mode, which automated tests never make
(they use the fake provider). **Status: not yet run; needs a person with a Stripe account.**
Design: [ADR 0429](adr/0429-payments-gatekeeper-verified-events-and-refunds.md). The gatekeeper:
[`packages/gatekeeper-payments/README.md`](../packages/gatekeeper-payments/README.md).

Take a screenshot at each numbered check into `docs/stages/assets/stage-25-stripe/`.

Subscriptions (stage 32a: trials, renewals, the portal, continuation offers) have their own run,
which starts from this one's part 3: [`subscriptions-stripe-runbook.md`](subscriptions-stripe-runbook.md).

## You need
- A Stripe account in **test mode** (the toggle top right of the Stripe Dashboard). Never use live
  keys for this run.
- A deployment of the CRM you can reach over https (Stripe sends webhooks to it), with the email
  channel set in Settings → Notification delivery if you want to see the confirmation email.
- Wrangler logged in to the deployment's Cloudflare account.

## 1. Keys
1. In Stripe (test mode) → Developers → API keys, create a **restricted key** with write access to
   Checkout Sessions and Refunds and read access to Payment Intents (or use the test secret key,
   `sk_test_…`).
2. Deploy the gatekeeper and set its secrets (they live only in this Worker):
   ```sh
   pnpm --filter @composable-os/gatekeeper-payments exec wrangler deploy
   pnpm --filter @composable-os/gatekeeper-payments exec wrangler secret put STRIPE_SECRET_KEY
   ```
3. Set its `BASE_URL` var to `https://<crm-origin>/gatekeeper/payments` and leave
   `PAYMENTS_FAKE_PROVIDER` at `"false"`. If the org's account is a Stripe Connect connected account
   of a platform account whose key you set above, set `STRIPE_ACCOUNT` to its `acct_…` id: every
   call then carries `Stripe-Account`, and the money goes to that account.
4. Bind it to cos-runner: in `apps/runner/wrangler.jsonc` `services`, add
   `{ "binding": "GATEKEEPER_PAYMENTS", "service": "cos-gatekeeper-payments", "entrypoint": "GatekeeperVendor" }`,
   and deploy cos-runner.

## 2. The webhook
1. Stripe → Developers → Webhooks → Add endpoint:
   `https://<crm-origin>/gatekeeper/payments/in/stripe`.
2. Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `refund.created`, `refund.updated`. For card readers at the desk (stage 50, ADR 0774) also
   `payment_intent.succeeded` and `terminal.reader.action_failed`, and the restricted key needs
   write access to Terminal readers and locations and to Payment Intents (the reader run itself
   is the till's step 10: not yet tried against Stripe).
3. Copy the signing secret (`whsec_…`) and set it:
   `wrangler secret put STRIPE_WEBHOOK_SECRET` (in `packages/gatekeeper-payments`).

## 3. Connect and set up
1. As an admin, Settings → Integrations: enable **Payments**, create the org connection, add the
   resource **Payment account** → Stripe. **Check 1:** the connection is active with one resource.
2. Settings → Orders: currency (the one your test prices are in), and under "Sites a buyer may
   come back to" the CRM's own origin (`https://<crm-origin>`) and any shop site.
3. Make something sellable: an object that declares `sellable` (ADR 0435), which only a pack or
   the org's own extension may do (one written in the workspace is refused). For this run, copy
   the box office fixture (`packages/core/test/fixtures/boxoffice/index.ts`) into the client
   repo's `extensions/boxoffice/` and `cos deploy`, then install it as an admin
   (`extension.install { id: "boxoffice", shipped: true }`), and create an Event with places and a
   Ticket type of it with a price (for example 12.00).

## 4. Pay
1. In a private window (no session) open
   `https://<crm-origin>/buy?object=boxoffice.tickettype&id=<ticket type id>`,
   give an email address you can read, Continue. **Check 2:** the order page shows Pending.
2. Pay. You are on Stripe's own Checkout page (the address is `checkout.stripe.com`). Pay with the
   test card `4242 4242 4242 4242`, any future date, any CVC.
3. You come back to the order page. **Check 3:** it says it is waiting for the provider, then
   shows Paid within a few seconds (only after Stripe's webhook was verified and applied).
4. **Check 4:** in Stripe → Developers → Webhooks → your endpoint, the `checkout.session.completed`
   delivery was answered 200. Resend it from Stripe: it is answered 200 again (a duplicate) and
   the order's Money section still shows one payment.
5. **Check 5:** the confirmation email arrived with a link that opens this order.
6. **Check 6 (no card data):** search the CRM's audit log and the order's page for `4242`: nothing.

## 5. A bad signature
`curl -X POST https://<crm-origin>/gatekeeper/payments/in/stripe -H 'Stripe-Signature: t=1,v1=00' -d '{}'`
**Check 7:** answered 401; nothing changes.

## 6. Refund
1. As staff, open the order (Orders → the order), Refund, enter part of the amount (for example
   5.00) and a reason. **Check 8:** Approvals shows a `Refund a payment` item with the amount and
   the payment it goes back to; nothing has changed in Stripe yet.
2. Approve it. **Check 9:** Stripe → Payments shows the partial refund; the order shows Refunded
   5.00 and is still Paid.
3. Refund the rest the same way. **Check 10:** after Stripe's `refund.updated` arrives, the order is
   Refunded.

## 7. Expiry and a late payment
1. Start another order and open its payment page, but do not pay. Wait for the order to expire (15
   minutes by default; set a shorter time in Settings → Orders if allowed). Stripe's page lasts at
   least 30 minutes, so it can still be paid.
2. Pay on the Stripe page. **Check 11:** the order stays Expired, appears under Orders → Paid
   late, and admins get a notice. Honour it or refund it; it leaves the list.

## 8. Tax at checkout (stage 42 criterion 13; ADR 0479)
**Status: not yet run; needs a person with a Stripe account.** Automated tests use the fake
provider only. Take screenshots into `docs/stages/assets/stage-42-tax/`.

### What the company sets up in its own Stripe account (not the platform's work)
- **Stripe Tax on, with its head office address** (Dashboard → Tax → Settings, or the Tax
  Settings API: `head_office`). Until it is set, Stripe Tax's settings are `pending` and nothing
  is calculated.
- **A registration for every place it must collect** (Dashboard → Tax → Registrations): for
  online courses, where its buyers are; for events, each place it holds them. Stripe collects only
  where a registration is active: a host that turns tax on with none charges no tax anywhere, and
  the order says zero.
- **The product tax codes.** The packs declare Stripe's `txcd_20060158` (on-demand online
  courses, streamed) and `txcd_50010001` (admission, participant). Which code fits its courses and
  events (a camp with lodging may need another treatment, a workshop may be `txcd_20060044`
  Training) is the company's call with its accountant. Change one in Settings → Orders → Tax at
  checkout. Stripe's default product tax code (Tax → Settings) cannot be an event code; set it to
  something general, such as `txcd_20030000`.
- **Who files and pays the returns.** Stripe reports; filing is the company's or a partner's.
- **Stripe Tax's fee** is the company's: on the Australian price page (read 2026-11-22), 0.5% per
  transaction where it is registered, for Checkout. Check the current page for its country.
- **The API version.** The gatekeeper sends `Stripe-Version: 2026-09-30.endive` on its tax calls
  only (the version Stripe documents for event tax). Nothing to set.
- **A restricted key** also needs write access to Tax Locations and read access to Checkout
  Session line items (check the permission names in the Dashboard; not checked by the build).

### The run (test mode)
1. In test mode: set the head office and add a test registration, for example Australia (GST)
   and, for the event check, New Zealand.
2. As a human admin, Settings → Orders → Tax at checkout: turn it on. **Check 12:** the screen
   says the provider charges only where the company is registered, and lists Ticket type
   (`txcd_50010001`, taxed where the event is held) and any course object.
3. Course: sell something whose object declares `txcd_20060158` (the fixture
   `packages/core/test/fixtures/onlinecourse`, installed as the box office is in part 3, until the
   Courses pack exists), priced 99.00. Buy it with a billing address in Australia.
   **Check 13:** Stripe's page asks for the billing address and shows the price, tax included
   (not added); the order shows Paid 99.00 with "Including tax" 9.00 (10% inside); Stripe →
   the payment → Tax shows the same. Buy it again from a country with no registration (for
   example the United States). **Check 14:** no tax; the order says tax 0.
4. Event: create a Ticketing event with Country (for tax) `NZ` and its region and postcode, on
   sale, with a ticket type priced 45.00. Buy two from an Australian billing address.
   **Check 15:** Stripe calculates New Zealand tax (15% inside: 11.74 on 90.00), by the event's
   place, not the buyer's; the order and each line show it. Stripe → Tax → Locations lists the
   venue once, and a second order reuses it.
5. Deposit: a ticket type with a deposit; pay the deposit, then the balance in two parts.
   **Check 16:** each payment carries its own tax; the order's tax is their sum; the amount owed is
   as without tax.
6. Refund one payment. **Check 17:** the refund goes through; Stripe's tax report shows the
   reversal; the host records the refund with its tax as not reported (Stripe's Refund carries no
   tax field, ADR 0479). Note what Stripe's reports show for the refunded tax: it decides how
   criterion 12c is met.
7. An event with no Country (for tax): **Check 18:** checkout is refused while tax is on, with
   a message that the event has no country for tax.
8. Turn tax off. **Check 19:** a new checkout is exactly as before (Stripe's page asks for no
   address unless Stripe needs one for the card).

## 9. A drop-in class (stage 31a step 8; ADR 0560)
Proved only against the fake provider so far. Needs Programs and Bookings installed, a class type
with a drop-in price (or the organisation's Bookings setting "Drop-in price"), and a one-off class
a few hours ahead with 1 place. The site's `bookings-drop-in` block (or `x.bookings.buy` then
`order.checkout`) opens Stripe's page.
1. In a private window, pay for the class as a visitor. **Check 20:** the class shows 1 held
   before you pay; after Stripe's `checkout.session.completed` arrives the booking is Booked, the
   class shows 1 taken, and the order line's title is the class's.
2. With tax on (part 8), pay for another class. **Check 21:** the line carries
   `txcd_50021003` (or the code the admin set for `bookings.booking`), Stripe's page shows the tax
   inside the price, and the order's tax is Stripe's figure.
3. Start a drop-in, open Stripe's page, do not pay; wait for the order to expire. **Check 22:** the
   booking is Expired and the place is free. Pay on the page you kept open: the order stays
   Expired, appears under Paid late, Honour is refused, and within a minute its refund waits in
   Approvals, requested by the host; approve it.
7. As a visitor (not signed in), start a drop-in with the address of a member who already booked
   that class, and pay. **Check 26:** the visitor was told nothing different before paying; after
   Stripe's event the drop-in is Expired, not a second booking, and its refund waits in Approvals.
8. Reject one of these refunds in Approvals. **Check 27:** within a minute admins are told it was
   not approved; Refund on the order asks again.
4. Pay for a class, then cancel the booking in time from the member's account (or as staff).
   **Check 23:** within a minute a refund of the whole amount waits in Approvals, requested by the
   host; an AI assistant cannot approve it; a person with the refund permission approves it and
   Stripe → Payments shows the refund to the card.
5. Pay for a class, then cancel the class (a closure over its date, or staff cancelling it).
   **Check 24:** the booking is Cancelled by the gym and the refund waits in Approvals as in 4. A
   drop-in left unpaid on that class has its order Cancelled; paying on its Stripe page afterwards
   is a late payment, refunded by hand.
6. Cancel a paid drop-in late (inside the class type's late-cancel time). **Check 25:** nothing is
   asked for; the payment is kept.

## 10. Payouts (stage 52 step 4; ADR 0793)
Never run against real Stripe in the tests: this is the only check of the payout read on the real
provider.
1. The key needs read access to **Payouts** and **Balance** (and Charges and Disputes, for the
   expansion). With a restricted key without them, Finance → Payouts says payouts are not
   available for this connection, and nothing else breaks.
2. Take a few payments of the kinds the business takes (a checkout with and without tax, a
   subscription period, a payment on a reader), refund one, and let Stripe's test payout schedule
   pay them out (or create a payout in the dashboard: a manual payout lists no lines).
3. Once the payout's arrival day has passed, wait for the minute cron's daily read (from 06:00 in
   the business's zone) or run it as the host. **Check 26:** the Payouts report lists the payout,
   its amount equal to its lines' net less fees; every payment and refund line is matched to its
   order; a charge made in the dashboard is a line matching nothing; the provider's fees are as
   Stripe's payout reconciliation report says.
4. **Check 27:** record which balance transactions (subscription invoices, credit notes, checkout
   with tax, Terminal) did not resolve to a payment the host stored, and fix their `payment_ref`
   or the mapping before the first real month is closed.
5. **Check 28:** a payout's `arrival_date` is a calendar day at 00:00 UTC, and the report shows
   that day (the host keeps the provider's day, not the business's zone's).
6. **Check 29:** with a restricted key missing **Balance: read**, Stripe answers 403 (the report
   says payouts are not available); with a revoked key it answers 401 (the read fails and the
   report says the connection needs attention). Restore the key: every payout of the outage is
   read.
7. **Check 30:** fail a test payout (Stripe's test bank account numbers that fail payouts): its
   `payout_failure` balance transaction (`reporting_category` `payout_reversal`, source the failed
   `po_…`) lands in a later payout, the report shows the failure and the bank at what landed.
8. **Check 31:** an account that settles in a currency other than the organisation's shows every
   payout apart, summed nowhere: confirm the account's settlement currency at setup.

## Afterwards
Uninstall the box office extension if you installed it for this run, and delete the test-mode
webhook endpoint if you do not need it again. Record the date, who ran it and any differences in this file's status line.
