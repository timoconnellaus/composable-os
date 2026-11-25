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

- **Every reversed: unpaid again** (the coordinator's decision, 2026-11-26, review of PR #460).
  When reversals leave nothing paid on an invoice's order, it goes back to `pending` (a new host
  move, `paid`/`part_paid` → `pending`), in the reversal's own batch, and its invoice to `issued`
  (or `sent`): `invoice.void` and a full credit note then work as for any unpaid invoice. Its
  payment's tax share comes off with it. What it granted stays; paid again, it grants nothing more
  (the grants hook grants an invoice's order once), and its places, confirmed by the first payment,
  go back if it is then voided. Any other order stays part paid, as ADR 0694 says.
- **What a person approves is what was asked.** `invoice.recordPayment` names the invoice's
  version it was read at (required), as `invoice.issue`, `invoice.allowPartPayments`,
  `creditNote.issue` and `invoice.void` do: a call that waits for approval (the deploy-time floor
  can hold a person's) and is applied after the invoice changed is refused. Recording a payment, or
  a credit note, while a payment page opened in the last day has had no payment is refused
  (`checkout_open`): that page asks for the old amount.

- **Recorded as decided** (the coordinator, 2026-11-26, the second review of PR #460):
  `checkout_open` may stop staff recording a transfer, crediting or voiding for up to a day after a
  payment page is opened, because the host cannot close a provider's page; an expire-page action at
  the payments gatekeeper is a follow-up. A bounced recorded payment leaves a ticket or pass valid
  until staff void the invoice (ADR 0694's "what it gave stays"); paying again does not grant twice.
  The database lets only an invoice's order move from paid or part paid back to pending.

## Consequences
- No other caller can record or reverse one: an AI, an MCP client, an automation, an extension and
  an import are refused by the operation's actors, a member without the grant by its permission.
- Stage 61's "paid in the books" opens `invoice.recordPayment` filled in for a person to confirm.
- A receipt emailed to the bill-to for a recorded payment is step 7's (host mail purpose
  `invoices`).

## Checks that were broken on purpose (each made a test fail, then restored)
- `invoice.recordPayment`, `invoice.reversePayment`, `creditNote.issue` and `invoice.void` opened to
  the assistant and MCP: the two "proof d" tests failed.
