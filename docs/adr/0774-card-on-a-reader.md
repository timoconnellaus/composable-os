# ADR 0774: Card on a reader: server-driven readers, registered by a person, matched on the host's stored reference

Status: accepted, 2026-11-24 (stage 50, build step 4a: the gatekeeper's half). Amends
[ADR 0429](0429-payments-gatekeeper-verified-events-and-refunds.md) (the payments gatekeeper).
Builds on [ADR 0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md)
(paid only by a verified payment) and [ADR 0485](0485-recurring-billing-the-provider-runs-the-schedule.md)
(host-only calls on the payments session). The host's half (`order.presentOnReader`,
`order.cancelOnReader`, the `reader` checkout kind, reader events in `orders/events.ts`, readers in
Settings → Integrations) is step 4b's and amends this ADR when built.

## Context

Stage 50 (the till) takes card payments at the front desk, on a card reader connected to the
business's own payment account (issue #126 left payments in person out of stage 25). ADR 0429's
gatekeeper had one way to take money: the provider's hosted page. The spec rejected driving a
reader from the tablet (the provider's code and a connection secret on a shared device, and web
and native differing) for a reader driven from the server: the host asks, the reader shows, the
webhook reports.

## Decision

**Readers belong to the payment account and are registered by a person.** `PaymentProvider` gains
`registerReader`, `listReaders` and `removeReader`. Registering takes the code the reader shows,
the label it goes by, the host's id for it (`readerId`) and the address it is at: the gatekeeper
makes the provider's location for that address once (Stripe: a Terminal Location, kept by the
facet as tax locations are) and registers the reader there with the host's id in its metadata.
Registering and removing are the gatekeeper's actions `payments.reader.register` and
`payments.reader.remove`: never auto-approvable, described to the approver by the label and the
address (never the single-use code), and nothing reaches the provider until the action is applied.
A reader moves no money but adds a device that can take it, so it is treated as an outbound act.

**The host's own call only.** `registerReader`, `removeReader`, `presentPayment` and
`cancelPresented` are refused unless the session is the host's own orders call (`isHostOrders`,
as plan changes and the portal are, ADR 0485). The host keeps which till a reader serves and the
presentation it matches a payment on; a reader registered, or a payment presented, by Code Mode, an
extension's tool, MCP or the assistant would be one the host never asked for. `listReaders` is an
observation any session may make.

**Presenting a payment is an observation, not an action**, as opening a checkout is: no money
moves until the buyer's card does. `presentPayment({ orderId, amount, currency, description,
readerRef, idempotencyKey })` makes one card-present payment (Stripe: a PaymentIntent of type
`card_present`, captured automatically, the order id in its metadata) and hands it to the reader.
Its reference is returned; the payment event reports it as both `checkoutRef` and `paymentRef`.
The idempotency key is the presentation's: a retry with the same key finds the same payment, and
is answered `paid` if it was paid, or hands it to the reader again (a retry after a timeout, or
after a decline). One payment is paid at most once, so a retry never charges twice. A reader with
another payment on it refuses. `cancelPresented(readerRef)` clears the reader; the payment stays
unpaid.

**Events.** A card-present payment's success is the existing `payment` event, through the one
verified door (ADR 0427): Stripe's `payment_intent.succeeded`, read only when the intent is
`card_present`, since a web checkout's intent succeeds too and is reported by its session. A
reader's action that took no payment is a new event, `kind: "reader"` (`readerRef`, `checkoutRef`,
`outcome` `failed` or `cancelled`, the provider's `failureCode`, never its free-text message), so
the till can say "declined, try again". The host matches both on the reference it stored when it
presented, never on metadata. Until step 4b, the host's `PaymentSink` ignores a `reader` event (it
stores only kinds it reads), and no payment can be presented, since only the host's call presents.

**Refunds** of a card-present payment use the existing `refund` on its payment reference.

**The fake provider has fake readers.** Its ledger registers readers (a code is single-use, the
same host id returns the reader registered before) and holds the payment on each. Each reader has
a page, `/fake/reader/:ref`, with Tap card, Decline and Cancel, which delivers the provider's
signed events to `/in/fake` as the checkout page does. It shows the amount and description only,
never the order or the buyer, and is on only where the fake is (ADR 0485).

## Why

- The reader on the server keeps the provider's code and every secret off the shared tablet, and
  makes the web and native tills the same: both only poll the order.
- One verified door: a card at the desk is a `provider` payment row exactly as a web payment is,
  so refunds, grants, holds, stock and reports need nothing new.
- A person registers a device that takes money; the host-only rule keeps the host's record of its
  readers and presentations the only one.

## Consequences

- Step 4b adds `payments.reader.register` and `.remove` to the host's always-reviewed kinds, a
  `reader` kind of `core_order_checkout` holding the presented reference, the `reader` event to
  `paymentsEventSchema`, and the operations that call these methods.
- Not verified against the real provider (the stage's step 10, which needs a test account and a
  simulated or real reader): whether `card_present` intents capture automatically in the
  business's country, which reader failure codes mean a cancel (`customer_canceled`, `canceled`
  are read as one), whether `cancel_action` sends `terminal.reader.action_failed`, and whether
  every card can be refunded without the card present. The runbook's key permissions and webhook
  events for readers are listed but untested.
- Out: tipping, payments while the reader is offline, the reader printing receipts, saving a card
  from the reader, several readers per desk (built later; nothing here assumes one).
