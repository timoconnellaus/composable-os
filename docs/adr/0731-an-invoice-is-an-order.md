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
  assistant and MCP) names the invoice's `version` it was asked on (required), so an approval
  applied after the draft changed (a line added, a discount raised past the limit) is refused,
  never issued as it now stands. It queues, in one batch: the invoice's number and fixed columns
  (`numberStatements`: state `issued`, issue date, due date, the bill-to as printed, the business
  snapshot, its order's id), then its order through **`createOrder`** with the invoice's lines as
  the host priced them (`priced`), then the `issued` row of the event log. A trigger makes an
  invoice's order only after its invoice is issued in the same batch and names it, for the
  invoice's total and currency (`core_order_invoice_new`, migration 1031), so a draft deleted or
  changed meanwhile, or issued twice, makes no order and takes no number.
- **One order line per invoice line, costing exactly what it says.** A record's line is the record
  (its object, id and quantity), so its places are held, its stock held and sold, and what it
  grants granted, as on any order; its price is read again at issue (`priceLines`) and must be the
  draft's (`rule: "price_changed"`: remove the line and add it again). A typed line is a line of
  the invoice itself (object `invoice`, record the invoice's id), of its quantity when whole and its
  amount divides by it, else of one. The order lines cost the invoice line's amount **with tax
  before its discount**, exactly; with amounts typed without tax that is its net plus its tax as the
  document worked it out (ADR 0732). When a record's amount does not divide by its quantity (two at
  45.45 plus 10% are 99.99) it is two order lines of the record, some units a cent dearer than the
  rest (one at 49.99, one at 50.00; `orderPieces`), so nothing is rounded and no cents show as a
  discount (review of PR #460). Each order line keeps its share of the line's tax
  (`core_order_line.tax_amount`).
- **The invoice's money off is adjustments** (ADR 0690), taken off by the same seam
  (`applyAdjustments`): a line's discount is a `staff` adjustment on its order line for its amount
  with tax, given by the person who issues (who needs `orders:discount`; above the staff discount
  limit a human admin set, the issue waits for approval, `reviewWhen`, as `order.adjust` does), so
  the adjustments staff see add up to the order's discount. One kind only the host writes, on an
  invoice's order only (the database refuses it on any other, and refuses taking any of an
  invoice's adjustments off): **`prepaid`**, a final invoice's "less deposit paid" on the whole
  order (step 6 writes the deduction lines, and adds the kind to `order.get`'s contract; a
  deduction line is taken off the document's totals, by its rate). `createOrder` checks the order
  comes to the invoice's total and the trigger checks it again.
- **Tax on what was paid** (review of PR #460). The order's `tax_amount` is, as for any order, the
  tax on its applied payments: each payment on an invoice's order carries its share of the
  document's tax (in proportion to the invoice's total, half up, the payment that settles an order
  nothing was credited on taking what is left, `invoiceTaxShare`), a reversal takes its payment's
  share back off, and each refund carries the refunded payment's share (`invoiceRefundTax`), added
  to `tax_refunded`. So stage 52's book counts the tax collected on invoice payments, a refund's
  own tax (an 11.00 refund of a 110.00 invoice gives back 1.00, not 10.00), and `rec_order.net` is
  nothing for an invoice nothing was paid on. The database holds both to what the payment and
  refund rows carry (`core_order_invoice_tax`).
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
  `order.removeCode` refuse an invoice's order (`rule: "invoice_order"`), and the database refuses,
  for any writer: any change to its total, discount, currency, invoice and expiry, its tax but by
  its payments and refunds, its lines' prices, quantities, discounts and tax; deleting it or a line
  of it; and adding a line once it exists. `order.refund` gives back only a payment that was not
  applied to it (late or not matching), whatever the order's state: what was applied goes back by a
  credit note (ADR 0735). Until the customer's side is built (step 8), only staff open its
  checkout. Deleting the customer's account and erasing the bill-to never cancel it: the invoice
  stays owed (the delete-account preview says so, `invoicesOwed`), and an erase detaches it as it
  does a part-paid order; what step 11's retention does to an issued invoice is step 11's.
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
- `order.get` lists an invoice's staff discounts among its adjustments; `prepaid` joins its
  contract with step 6.
- A 50-line invoice issues in 81 statements (a test bounds it at 90), each binding fewer than 100
  values.
- An invoice whose lines split for their cents may come to more than an order's 50 lines: it is
  refused at issue (`too_many_lines`), to be split in two.
- Stage 52's book counts a reversed recorded payment with no tax of its own (as for any order); the
  order's tax goes down with it.

## Checks that were broken on purpose (each made a test fail, then restored)
- The number queued in a batch of its own before the order's: "a failed issue takes no number"
  failed (the series moved on for an invoice that stayed a draft).
- `core_order_invoice_fixed`'s test of the total turned off: the raw write of an invoice's order's
  total went through and the "any write path" test failed.
- From the review of PR #460: the version check left out of `invoice.issue`: both approval tests
  (a line added after the ask, a discount raised after it) issued what was not asked; the delete
  trigger turned off: the "database holds an invoice's order" test failed; the account delete's
  and the erase's invoice exclusions taken out: both tests saw the order cancelled; the refund's
  tax share left out: the finance test's 1.00 was 0.
