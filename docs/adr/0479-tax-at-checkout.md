# ADR 0479: Tax at checkout: the provider's tax inside the price, payment by payment

Status: accepted, 2026-11-22 (stage 42, build step 1; section 4 of
[the spec](../stages/42-courses.md)). Builds on ADRs
[0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md) and
[0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md).

## Context
Stage 25 left tax out: a price is what the buyer pays. The owner decided (stage 42 interview and
follow-up, 2026-11-23) that the payment provider calculates tax at checkout (Stripe Tax), for
online courses and for event tickets; that it is a human admin's setting, off until turned on;
and that prices are tax-inclusive, so what a buyer sees and pays does not change and turning tax
on changes what the company keeps. Courses do not exist yet: the mechanism is proved with the
Ticketing pack and a fixture object.

## Decision

**Two switches, both needed.** A line is taxed only when a human admin has turned tax on
(`order.settings.update { tax: true }`, core setting `order_tax`, default off) and the line's
object declares a product tax code (`sellable.tax: { code }`). A human admin may override an
object's code (`taxCodes`, setting `order_tax_codes`), only for an object that declares one.
`order.settings.update` stays `settings:manage`, `actors: ["human"]`, audited. Otherwise the
checkout is exactly as before: no `tax` key reaches the gatekeeper, and Stripe is sent the same
form, with no API version header.

**Decided per payment, at checkout.** The host reads the setting and codes when it opens each
checkout, so turning tax on mid-sale changes nothing paid and taxes a part-paid order's later
payments. Each payment is split over the order's lines in proportion to their totals, in whole
minor units that sum to the payment (largest remainder), so each share carries its line's code.
The amount asked for is unchanged (`chargeFor`), so ADR 0427's rule that a verified payment must
match its order holds as built.

**An in-person event's place.** `sellable.tax.place` names text fields (`country`, and optionally
`region`, `postcode`, `city`, `line1`) of the object or of the record its relation `via` points
at. Ticketing's ticket type declares `txcd_50010001` with its event's tax address (new event
fields `taxCountry`, `taxRegion`, `taxPostcode`, `taxCity`, `taxAddress`, beside the free-text
`venue`). An event with no two-letter country refuses checkout while tax is on
(`rule: "tax_place"`): Stripe requires a performance location for that code.

**The gatekeeper.** `PaymentsCheckoutInput.tax: { behavior: "inclusive", lines: [{ ref, name,
amount, taxCode, place? }] }`, validated (codes `txcd_` and eight digits, lines summing to the
amount). Stripe: `automatic_tax[enabled]=true`, `billing_address_collection=required`, one line
item per share with `price_data[tax_behavior]=inclusive`,
`product_data[tax_details][tax_code]`, `product_data[metadata][cos_line]`, and for a place
`product_data[tax_details][performance_location]`, a tax location (`POST /v1/tax/locations`,
`type=performance`) made once per address and kept in the facet's storage. Those calls, and the
read of a paid session's line items, carry `Stripe-Version: 2026-09-30.endive`, the version
Stripe documents for event tax; nothing else does. A paid taxed session's event carries
`total_details.amount_tax` and `customer_details.address.country`; the route then reads each
line's `amount_tax` from the session's line items before storing the event, and answers 500 (so
Stripe redelivers) when it cannot.

**What is stored is the provider's figure, never the host's.** `core_order_payment.tax_amount`
and `tax_country` per payment; `core_order.tax_amount` (the sum), `tax_country` (the latest
taxed payment's); `core_order_line.tax_amount` and `tax_code`; `core_order_checkout.tax_lines`
(what was asked). A report that does not fit what was asked (a taxed checkout without one, one
on an untaxed checkout, lines that do not sum, a line over its share, an unknown line) makes the
payment a `mismatch`: nothing moves and staff are told, as for an amount. `rec_order` gains
`tax_amount`, `tax_refunded`, `tax_country` and `net` (paid less refunded, less tax still held);
`rec_order_line` gains `tax_amount` and `tax_code` (migration 0516).

**Refunds.** Each refund is of one payment, as built. The tax it gave back is recorded
(`core_order_refund.tax_amount`, `core_order.tax_refunded`) only when the provider's refund event
says it, and only up to that payment's tax less what its earlier refunds gave back. Stripe's
Refund object has no tax field, so with Stripe it is recorded as not known (null); the fake
provider behaves the same. Stripe's own reports reduce the tax for a refunded Checkout charge.

**The fake provider behaves like Stripe.** With `tax` it requires a billing country on its page
(400 without one), calculates inclusive tax per line at a fixed registration table (AU 10%, NZ
15%, GB 20%; elsewhere nothing, as Stripe collects only where registered), taxes a line with a
place where the place is, reports the total, the country and each line's tax, and reports no tax
on refunds.

**An order mixing lines with a code and lines without one is refused at checkout while tax is on**
(`rule: "tax_mixed"`): Stripe would tax the second kind at the account's default code, a guess
the host does not make.

## Checks that were broken on purpose (each made a test fail, then restored)
In `packages/core/test/order-tax.test.ts`:
1. Tax only when the setting is on: ignoring the setting in `checkoutTax` failed "sends the
   checkout exactly as before".
2. Tax only when the object declares a code: giving undeclared objects a code failed the same
   test and "refuses an order mixing lines".
3. The provider's figure is what is stored: storing `amount / 11` instead failed the course, the
   seats and the deposit tests.
4. The tax report must fit the checkout: dropping `taxReportFits` failed "moves nothing when the
   provider's tax does not fit" and the untaxed-checkout case.
5. A payment must still match its order: dropping the amount from `chargeFor` failed "still moves
   nothing when the amount paid is not the order's".
6. A refund reverses its own payment's tax: checking against the order's tax instead of the
   payment's failed "records a refund's tax only as the provider said".
7. The setting is human-only: removing `actors: ["human"]` failed "only a human admin changes it
   or a code".

## Consequences
- Prices, totals, what is owed, holds, grants, check-in and the order's states are unchanged; the
  stage 25, 26 and 27 tests pass unchanged with tax off.
- A refund's tax is unknown with Stripe until a way to read it is chosen (spec criterion 12c
  asks for it): reading Stripe Tax's reversal for a Checkout refund was not found in Stripe's
  documentation, and the host does not work it out.
- `Stripe-Version` is now sent on tax calls only; the account's default still applies elsewhere.
- Not run against Stripe: no account was used. The runbook has the test-mode steps.

## Sources (read 2026-11-22)
- Checkout Session create: `automatic_tax`, `billing_address_collection`,
  `line_items.price_data.tax_behavior`, `product_data.tax_details.{tax_code,performance_location}`:
  https://docs.stripe.com/api/checkout/sessions/create
- Tax for tickets, the Checkout path ("based on where the event takes place"; "requires API
  version `2026-09-30.endive` or later"; tax locations of type `performance`):
  https://docs.stripe.com/tax/tax-for-tickets/integration-guide?tax-api-path=checkout and
  https://docs.stripe.com/tax/location-sales
- Product tax codes, `txcd_20060158` (no performance location) and `txcd_50010001`
  (performance location required): https://docs.stripe.com/tax/tax-codes
- The session's `total_details.amount_tax`, `customer_details.address`, `automatic_tax.status`:
  https://docs.stripe.com/api/checkout/sessions/object and https://docs.stripe.com/tax/checkout/page
- The Refund object (no tax field): https://docs.stripe.com/api/refunds/object; refunds reduce
  reported tax: https://docs.stripe.com/tax/reports
- Registrations, the head office, pricing: https://docs.stripe.com/tax/settings-api,
  https://stripe.com/tax/pricing
