# Payments with Stripe: a test-mode run by hand

Stage 25 acceptance needs one run against Stripe in test mode, which automated tests never make
(they use the fake provider). **Status: not yet run; needs a person with a Stripe account.**
Design: [ADR 0429](adr/0429-payments-gatekeeper-verified-events-and-refunds.md). The gatekeeper:
[`packages/gatekeeper-payments/README.md`](../packages/gatekeeper-payments/README.md).

Take a screenshot at each numbered check into `docs/stages/assets/stage-25-stripe/`.

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
   `refund.created`, `refund.updated`.
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

## Afterwards
Uninstall the box office extension if you installed it for this run, and delete the test-mode
webhook endpoint if you do not need it again. Record the date, who ran it and any differences in this file's status line.
