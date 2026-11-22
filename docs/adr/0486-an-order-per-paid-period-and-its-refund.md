# ADR 0486: An order per paid period, and a period's refund credited on its invoice

Status: accepted, 2026-11-22 (stage 32a, build step 2; interview decision 3). Builds on ADRs
[0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md),
[0479](0479-tax-at-checkout.md) and [0485](0485-recurring-billing-the-provider-runs-the-schedule.md).

## Context
The interview decided that every paid period is an order (decision 3), so revenue, `rec_order`,
tax reports, the confirmation email, refunds and dashboards stay one path. Orders are made paid
only by a verified payment (ADR 0427); a subscription's period is paid by the provider on its own
schedule, with no checkout the host opened for that order. ADR 0479 could not record the tax a
Checkout payment's refund gave back: Stripe's Refund carries no tax figure.

## Decision

**A paid invoice with money on it is an order born paid.** When a verified subscription event
says an invoice is paid and its amount is more than zero, the host writes, in the event's batch:
the order `pending` and at once `paid`, both moves `host` (two history rows), with the payer as its
Person and address, one line for the plan (its title as agreed, quantity one, the amount paid), the
period's dates (`period_start`, `period_end`), the subscription, the provider's invoice reference,
and a `core_order_payment` row (applied, with the invoice's payment reference and invoice
reference). The confirmation email is sent as for any paid order. The trial's zero invoice and a
free continuation's are no order.

**One invoice, one order.** A unique index on `core_order (provider, invoice_ref)` holds it under
two deliveries at once; a later report of the same invoice (another event, or a redelivery after
the event table forgot it) is `period_duplicate`. A period's order is written even when the
subscription read it came with is older than the record's (the invoice is a fact; the read moves
nothing).

**Money paid never vanishes from orders.** A period paid other than as agreed is an order for what
was actually paid, in the currency it was paid in, flagged (`core_order.period_flag`, staff only):
`paid_less` (a coupon, or the payer's balance at the provider), `paid_more`, or `not_as_agreed`
(another currency, or a subscription whose price, currency or interval was changed at the
provider). Staff are told once for the subscription, not once per period. A first event on terms
that are not the checkout's makes no subscription (ADR 0485), but a paid invoice it carries is
still an order, flagged, with no subscription and the checkout's payer. (Amended after review,
2026-11-22: the first build wrote no order and told staff each time, so money taken could be
missing from revenue.)

**Tax on each period.** A subscription opened with tax (ADR 0485) keeps the provider's figure on
each period's order, line and payment, as a taxed checkout does, while it is no more than what was
paid. One opened without tax keeps none.

**A period's refund is `order.refund` on its order, through approval, as built.** The payment's
invoice reference goes with the refund request (`invoiceRef`). The gatekeeper then makes the
refund (Refunds API, the host's refund id as metadata and idempotency key, as before) and credits
the invoice with a credit note of the same amount linked to that refund (`refunds[0][refund]`,
`amount`), with the host's refund id as its metadata. The credit note's `credit_note.created`
event says the tax the refund gave back (`total_taxes`); the gatekeeper delivers it as a refund
event marked `creditNote`, which confirms nothing (the refund's own event does). Whichever arrives
first:
- the credit note first: its tax waits on the refund asked for (`reported_tax`) and is applied
  when the refund is confirmed;
- the confirmation first: the credit note fills in the refund's tax and the order's
  `tax_refunded`.
Either way the figure is kept only while it fits the payment's tax (ADR 0479's rule). A refund
does not end the subscription; ending it is its own action.

A credit note that fails after the refund went through leaves the action pending, with words
saying the refund went through and its credit note is owed: the refund's reference is kept in the
gatekeeper's own storage before the credit note is asked for, so applying the action again sends
only the credit note (its own idempotency key), never a second refund. It never reports that
nothing happened, nor "outcome unknown". (Amended after review, 2026-11-22: the first build marked
it "outcome unknown", which nothing retries.)

**A tax figure that is not said is unknown, not zero.** A credit note whose `total_taxes` is empty
or absent is delivered with no tax; the host then keeps the refund's tax unknown (null), as for a
Checkout payment's refund (ADR 0479).

## Deviation from the spec, and why
The spec guessed that only a credit note makes the provider give back the tax, and that the credit
note's tax figure reaches the host on its event. Stripe's documentation (docs.stripe.com/tax/
invoicing/refunds, docs.stripe.com/tax/reports, read 2026-11-22) says otherwise on the first: a
refund through the Refunds API on an invoice's payment already reduces the tax reported, in
proportion; a credit note keeps its reduction even if the refund later fails, and is the documented
record of it. The second holds: `credit_note.created` carries the whole credit note, `total_taxes`
included. So the build keeps the credit note, for the tax figure and the record, but makes the
refund first and links the credit note to it, instead of letting the credit note's `refund_amount`
make the refund: a Refund the credit note makes would not carry the host's refund id (no document
says a credit note's metadata reaches the Refund), so the confirmation could not be matched to the
refund asked for.

## Consequences
- Revenue by month, net of tax, reads `rec_order` as for everything else; `rec_order` gains
  `subscription_id`, `period_start`, `period_end`.
- A period's refund costs two Stripe calls; both use idempotency keys from the host's refund id.
- To check in Stripe's test mode by hand (step 4): that `amount` with `refunds[0][refund]` and
  `refunds[0][amount_refunded]` equal to it is accepted on an invoice paid in full, and that the
  credit note's `total_taxes` matches the tax Stripe reports as given back; and that an amount-only
  credit note on an automatic-tax invoice comes back with `total_taxes` filled at all (if empty,
  the host keeps the tax unknown, as above).
