# ADR 0731: An invoice is an order: due, not expiring; its own adjustments; moved only through the invoice

Status: accepted, 2026-11-25 (stage 35, build step 3; [the spec](../stages/35-invoices-quotes.md),
"How an invoice sits on an order", "Tax", decision 8, criteria 4 to 7). Amends
[ADR 0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) (orders priced
by the host), [ADR 0690](0690-adjustments-on-orders-net-lines-and-the-pricing-seam.md) (two new
adjustment kinds) and [ADR 0693](0693-the-discount-behaviour-codes-automatic-prices-one-deal-limits-held-by-the-database.md)
(no deal on an invoice's order). Builds on ADRs [0730](0730-quotes-invoices-and-credit-notes-as-core-records.md),
[0732](0732-tax-worked-out-by-the-host-on-documents.md), [0682](0682-goods-on-an-order-where-sold-the-channel-and-the-delivery.md)
and [0644](0644-enforcement-nobody-pays-or-books-without-what-is-due.md).

## Context
An invoice must be paid, refunded, hold places and grant passes exactly as any order does, and an
order's lines and total are fixed when it starts. So each issued invoice is its own order, made in
the batch that gives the invoice its number. What an order lacks the invoice adds: a number, a
bill-to, a due date in place of a 15-minute expiry, the tax worked out on the document, and the
staff's own discounts on its lines. Earlier reviews asked for one pricing path (every order made by
`createOrder` through `priceOrder`) and for the goods rules on every order.

## Decision
- **`invoice.issue`** (`invoices:send`; an AI asks and a person approves: `alwaysReview` for the
  assistant and MCP) queues, in one batch: the invoice's number and fixed columns
  (`numberStatements`: state `issued`, issue date, due date, the bill-to as printed, the business
  snapshot, its order's id), then its order through **`createOrder`** with the invoice's lines as
  the host priced them (`priced`), then the `issued` row of the event log. A trigger makes an
  invoice's order only after its invoice is issued in the same batch and names it, for the
  invoice's total and currency (`core_order_invoice_new`, migration 1031), so a draft deleted or
  changed meanwhile, or issued twice, makes no order and takes no number.
- **One order line per invoice line.** A record's line is the record (its object, id and quantity),
  so its places are held, its stock held and sold, and what it grants granted, as on any order;
  its price is read again at issue (`priceLines`) and must be the draft's (`rule: "price_changed"`:
  remove the line and add it again). A typed line is a line of the invoice itself (object
  `invoice`, record the invoice's id), of its quantity when whole and its amount divides by it, else
  of one. Each order line costs the invoice line's amount **with tax before its discount**; with
  amounts typed without tax that is its net plus its tax as the document worked it out (ADR 0732).
  Each keeps the line's tax (`core_order_line.tax_amount`) and the order the document's
  (`tax_amount`).
- **The invoice's money off is adjustments** (ADR 0690), taken off by the same seam
  (`applyAdjustments`): a line's discount is a `staff` adjustment on its order line for its amount
  with tax, given by the person who issues (who needs `orders:discount`; above the staff discount
  limit a human admin set, the issue waits for approval, `reviewWhen`, as `order.adjust` does).
  Two kinds only the host writes, on an invoice's order only (the database refuses them on any
  other, and refuses taking any of an invoice's adjustments off): **`rounding`**, the cents a
  whole-unit price of a record's line typed without tax rounds up (two at 45.45 with 10% tax are
  99.99, so the order line is two at 50.00 less 0.01), and **`prepaid`**, a final invoice's
  "less deposit paid" on the whole order (step 6 writes the deduction lines; a deduction line is
  taken off the document's totals, by its rate). `createOrder` checks the order comes to the
  invoice's total and the trigger checks it again.
- **No deal.** An invoice's order is priced with `noDeal`: the customer is sent the invoice as staff
  wrote it, and a member's price or a code found at issue would make the order differ from the
  document. Money off an invoice is its line discounts. The goods rules hold (`applyGoodsRules`,
  ADR 0682): a goods record needs a delivery, which an invoice does not choose, so it is refused at
  draft and at issue (`rule: "goods_need_delivery"`); goods handed over another way are a typed
  line. Agreements are asked for as at any purchase (ADR 0644).
- **Due, not expiring.** An invoice's order has no `expires_at` (the database refuses one), so the
  expiry sweep never moves it; its `balance_due_at` is the end of the invoice's due date in the
  business's time zone; `order.overdue` lists it once past that date, unpaid or part paid. Its
  places are held until it is paid, credited or voided.
- **Moved only through the invoice.** `order.recordPayment`, `order.reversePayment`, `order.cancel`,
  `order.extendBalanceDue`, `order.adjust`, `order.unadjust`, `order.applyCode` and
  `order.removeCode` refuse an invoice's order (`rule: "invoice_order"`), and the database refuses
  any change to its total, discount, lines' prices and quantities, its invoice and its expiry, for
  any writer. `order.refund` gives back only a payment that was not applied to it (late or not
  matching): what was applied goes back by a credit note (ADR 0735). Until the customer's side is
  built (step 8), only staff open its checkout.
- **Part payments** (decision 8): online, the checkout asks for the whole balance (total less paid
  less credited) unless staff allowed part payments on the invoice (`invoice.allowPartPayments`,
  `invoices:send`), then at least the set minimum; the verified payment is held to the same rule.
- **Its checkout asks the provider for no tax**, tax at checkout on or off (ADR 0732's amendment of
  ADR 0479). Its verified payment writes `payment_applied` to the event log in its batch (the one
  settle path, ADR 0694), and the invoice's state follows its order's moves (a move hook): part paid
  and paid.

## Consequences
- An invoice's order is in the bill-to's orders as any order is, so a signed-in customer reads it
  (`order.get`, `order.list`); paying it, its token and the hosted page are step 8.
- `order.get` lists an invoice's staff discounts among its adjustments, and leaves `rounding` and
  `prepaid` to the invoice, so the customer's and the public's contract is unchanged.
- The order's `tax_amount` is the document's from issue, before anything is paid, and its payments
  carry no tax figure (the provider was asked for none). Finance reports (stage 52) read an
  invoice's tax from the invoice, not the payments, when they count invoices.

## Checks that were broken on purpose (each made a test fail, then restored)
- The number queued in a batch of its own before the order's: "a failed issue takes no number"
  failed (the series moved on for an invoice that stayed a draft).
- `core_order_invoice_fixed`'s test of the total turned off: the raw write of an invoice's order's
  total went through and the "any write path" test failed.
