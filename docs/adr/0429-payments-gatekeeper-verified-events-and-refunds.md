# ADR 0429: The payments gatekeeper, verified events in the host, and refunds a person approves

Status: accepted, 2026-11-21 (stage 25 build, the gatekeeper half). Builds on ADRs
[0007](0007-integrations-are-gatekeepers.md), [0051](0051-outbound-approvals.md),
[0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
[0428](0428-buying-without-an-account.md) and stage 26's [0432](0432-holds-have-no-clock.md).

## Context
ADR 0427 made `applyVerifiedPayment` the only way an order becomes paid and left its caller, the
webhook handler, to this half of the stage, with the checkout, refunds, expiry, late payments, the
confirmation email and the admin screens. The interview decided: Stripe first behind a
provider-neutral interface, on the org's own account, paying on the provider's hosted page, a
refund proposed by anyone with the permission and approved by a person, never by an AI.

## Decision

**`gatekeeper-payments` is one gatekeeper with two providers behind one interface**
(`PaymentProvider`: create a checkout, read a payment, refund a payment, verify a webhook):
Stripe, and a fake provider with its own hosted page for development and tests (only when
`PAYMENTS_FAKE_PROVIDER` is `"true"`). The resource is the payment account,
`payments://merchant/<provider>`. Stripe's keys are this Worker's secrets (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`); with `STRIPE_ACCOUNT` every call is made on that connected account, so
the money goes to the org's own account. Nothing reaches the host or a client app but references,
amounts and currencies. Connecting is as for the other auto-provisioned gatekeepers: an admin
enables Payments in Settings → Integrations, creates the org connection and binds the account.

**The webhook is verified by the gatekeeper and applied by the host from what the host stored.**
The gatekeeper checks the provider's signature (`/gatekeeper/payments/in/<provider>`), drops a
replayed event id, and delivers a typed event to the hook the integration host bound when the
account was bound. The host's adapter (`PaymentSink`) stores it in `core_payment_event` and then
calls `order.applyPaymentEvent { provider, eventId }`. That operation takes the key alone and reads
the event from the table, which no operation writes: so it is an operation (audited, with record
events for automations), and still nothing a caller sends can describe a payment. It is open to
the `automation` actor only and not to MCP. The order is the one the host opened the checkout for
(`core_order_checkout`), not what the event's metadata says. On `order_stale` the adapter applies
it again; the minute cron applies anything left. A payment applied twice changes nothing (ADR
0427's primary key); a refund reported twice counts once (its provider reference is unique).

**The return page never marks anything paid.** `order.checkout` returns the provider's page; the
buyer comes back to `returnUrl`, which must be on an origin in the deployment's list
(`order_return_origins`, set by a human admin), https or localhost.

**The host's own calls.** Opening a checkout and sending the confirmation email are calls no
person or agent makes: `IntegrationRuntime.callAsHost` opens the session as the host for the org
connection. An outbound action submitted on that path is the host's message, composed from a
fixed template, and applies unless the deploy-time floor denies it (`hostMessage` in
`submitOutbound`). Only platform code reaches `callAsHost`; it is not an operation.

**A refund is the gatekeeper's outbound action `payments.refund`, always reviewed, approved only by
a person with `orders:refund`.** `order.refund` (permission `orders:refund`, risk `outbound`,
`bookkeeping`) splits the amount over the order's payments, newest first, and asks the gatekeeper
for one refund per payment as the caller. Asking is never queued itself, so a refund is reviewed
once, as the gatekeeper's action, with its description of what goes back to which payment.
`payments.refund` is in `ALWAYS_REVIEWED_KINDS`: no preset, floor, admin auto-approve or host path
applies it without review. `approveActions` refuses any approval of it by an actor that is not a
person (the assistant relaying a yes included) and by a person without `orders:refund`. The order
moves to `refunded` (as the host) only when the provider's refund event arrives and everything
paid has gone back; a part refund is an amount (`core_order.refunded`, `core_order_refund`).

**Late payments and expiry.** The minute cron runs `order.expireDue` as the host. A payment for an
order that had closed stays on the paid-late list (`order.paidLate`) until staff honour it
(`order.honourLate`: a person with `orders:refund`; it makes the order paid, or part paid for a
late deposit, which adds `expired → part_paid` to the machine) or it is refunded in full. The
daily maintenance tells admins once a day about undecided late payments and balances past due.

**Holds** (with stage 26). `createOrder` claims a line's places in the order's batch; the order's
move hook confirms them on `pending → part_paid | paid`, releases held ones on `cancelled` and
`expired` and confirmed ones when a part-paid order is cancelled, releases confirmed ones on
`refunded` unless the object says `releaseOnRefund: false`, and claims again when a late payment
is honoured (refused, and nothing moves, when the places have gone). A guest told there are not
enough places is told only that.

**The confirmation email** goes when a payment is applied, to the address the order was placed
with, through the email channel an admin chose in Settings → Notification delivery, with a fresh
link to that one order (`email_link_hash`, kept beside the guest's start token; ADR 0428's
window applies to both).

**An order's moves post on its Person's timeline**, in the move's batch.

## Why
- Storing the verified event first, then applying it by key, gives the audit log and automation
  events of an operation without an operation whose input could be a payment.
- Reviewing the gatekeeper's action and not the request avoids two reviews of one refund, and
  puts the approver in front of what the provider will be told.
- `callAsHost` keeps the host's own messages out of the approvals inbox without giving any actor
  a way to send unreviewed.

## Consequences
- `IntegrationRuntime` gains the optional `callAsHost`; a hostInternal core operation's handler on
  a customer's or the public's call now gets the integration runtime (`order.checkout`).
- New hostInternal operation: `order.checkout` (in open-operations.json).
- The deployment's own guest page (`/order/<id>?token=`) and a plain buy page (`/buy`) are in the
  host. They call the public HTTP surface (`/api/v1/op/*`, stage 23) from the browser, like any
  client app. Until stage 27's `sellable`, local development sells Deals through `ORDERS_DEV_SELLABLE`.
- Stripe has been checked by hand only through its documentation: `docs/payments-stripe-runbook.md`
  is the test-mode run a person makes.
- `core_payment_event` keeps applied events; their retention joins the purge later.

## Amendment, 2026-11-21 (stage 27, ADR 0435)
- `ORDERS_DEV_SELLABLE` is gone with `registerSellable`. Local development and the orders
  end-to-end spec sell the box office fixture extension (`packages/core/test/fixtures/boxoffice`),
  whose ticket type declares `sellable`, delivered as local dev's own org extension by
  `scripts/dev-setup.mjs` and installed by an admin.
