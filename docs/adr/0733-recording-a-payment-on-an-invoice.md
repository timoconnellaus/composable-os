# ADR 0733: Recording a payment on an invoice: `invoices:payments`, restricted, human only, on the shared step

Status: accepted, 2026-11-25 (stage 35, build step 4; [the spec](../stages/35-invoices-quotes.md),
"A payment taken another way", decisions 7 and 8, criteria 7, 8 and 19). Amends
[ADR 0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) (an invoice's
order is paid another way only through the invoice). Built on stage 34's shared step,
[ADR 0694](0694-an-order-paid-another-way.md), which stage 34 built first: this stage does not
redesign it, and ADR 0734, reserved for building it here, stays free.

## Context
Invoices are often paid by bank transfer, cash, a card machine or a cheque, which no provider sees.
Stage 34 built one door for that, `applyOtherPayment`, with one payment row shape and one guard.
An invoice's payments must also be in its document event log, and its order is moved only through
the invoice (ADR 0731).

## Decision
- **`invoice.recordPayment { invoiceId, amount, kind, receivedOn, reference? }`**: staff, permission
  `invoices:payments` (restricted: admins, and accounts a human admin grants it to, never to
  oneself; nothing for an AI), `actors: ["human"]`, not exposed to MCP. Only on an issued invoice
  that still owes something (issued, sent or part paid). It calls `applyOtherPayment` with its own
  checked inputs: `recordedBy` is the caller, never input; the day received is a real day, not
  after today and at most a year back; any amount up to what is owed (the total less paid less
  credited), never more (`rule: "overpaid"`). The threshold over which admins are told is the
  invoice settings' (`recordedPaymentNoticeOver`, a human admin's), passed to the shared step.
- **The shared step writes the log.** Its settle path (`settle`, both doors) writes
  `payment_applied` for any invoice's order, with the payment row, its method and who recorded it,
  in the payment's batch; the invoice's state follows its order (part paid, paid) by a move hook.
  On the Person's timeline (the shared step) and, for an invoice to an organisation, the
  organisation's; audited.
- **`invoice.reversePayment { paymentId, reason }`**: the same permission, human only: the shared
  step's reversal (a second row, the order part paid again), with `payment_reversed` in the log.
  Refused for a provider's payment (`rule: "reverse_method"`: it goes back by a credit note), and
  for a payment a credit note gives money back on (`rule: "reverse_refunded"`: it was received).
- **The order's own doors refuse an invoice's order**: `order.recordPayment` and
  `order.reversePayment` (`rule: "invoice_order"`), so every payment on an invoice is in its log.

## Consequences
- No other caller can record or reverse one: an AI, an MCP client, an automation, an extension and
  an import are refused by the operation's actors, a member without the grant by its permission.
- Stage 61's "paid in the books" opens `invoice.recordPayment` filled in for a person to confirm.
- A receipt emailed to the bill-to for a recorded payment is step 7's (host mail purpose
  `invoices`).

## Checks that were broken on purpose (each made a test fail, then restored)
- `invoice.recordPayment`, `invoice.reversePayment`, `creditNote.issue` and `invoice.void` opened to
  the assistant and MCP: the two "proof d" tests failed.
