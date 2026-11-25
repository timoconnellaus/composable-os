---
id: invoices
title: Invoices
summary: Quotes, invoices and credit notes with numbers nobody reuses and documents nobody changes. An issued invoice is an order, paid online or recorded by a person, and put right with a credit note.
stage: 35
spec: docs/stages/35-invoices-quotes.md
adrs: [0730, 0731, 0732, 0733, 0735, 0737]
operations: [invoice., quote., creditNote.]
---

## What it is for

A business writes a quote, invoices a company for room hire or a block of passes, records a bank
transfer when it arrives, and puts a mistake right with a credit note. Each document has its
number, the next of its series, and once issued it never changes. Underneath, every issued invoice
is an order, so paying it, refunding it, the places it holds and the passes it grants work as they
do for anything sold.

Quotes, invoices and credit notes are core, not a pack: gapless numbers, documents nobody changes,
tax and an order in one write, and a payment a person records are rules of the host. Whether the
numbering, the tax and the documents are what the business's tax authority expects is for the
business to confirm with its accountant.

## Concepts

- **Draft**: a quote or invoice with no number, changed freely by staff with `invoices:write` (and
  the assistant for them). Its lines are records for sale, priced by the host, or typed lines with
  a quantity, a unit price, a tax rate and an optional discount.
- **Issue**: giving an invoice the next number of its series (`INV-0042`) and making it final. Two
  issued at once get consecutive numbers; one that fails takes none.
- **Tax**: worked out by the host on every line from the business's own rates, rounded half up,
  added on top or taken out as the amounts were typed.
- **An invoice's order**: started in the issuing write, one order line per invoice line, its line
  discounts as staff discounts, the document's tax kept on it. It never expires: it is due on the
  invoice's due date and is overdue after it. It takes no promo code or member's price.
- **Recorded payment**: money a person says they received (a transfer, cash, a cheque, a card
  machine), recorded on the invoice by someone an admin gave `invoices:payments`; never an AI.
- **Credit note**: a numbered document against an issued invoice, for some of its lines or an
  amount at one of its rates. It takes off what is still owed first, then gives back what was paid,
  the way it came.
- **Void**: a full credit note on an invoice nothing was paid on.
- **Event log**: every issue, payment applied or reversed, credit, refund confirmed, paid back and
  void, in order, written in the same write as the event, never changed.

## How the pieces fit

- **Platform code** in `packages/core/src/invoices/`: `drafts.ts` (drafts and their lines),
  `issue.ts` (an invoice issued as an order), `credit.ts` (credit notes and void), `hooks.ts` (the
  invoice's state following its order), `tax.ts`, `numbering.ts`, `events.ts`, `settings.ts`.
  Money moves only through the order code in `packages/core/src/orders/`: `createOrder` starts the
  order, stage 34's `applyOtherPayment` records a payment, and the existing refund approval gives
  money back.
- **Tables**: `core_quote`, `core_invoice`, `core_credit_note` and their lines,
  `core_document_counter`, `core_invoice_event`, `core_credit_note_refund`, and `invoice_id` and
  `credited` on `core_order`. Triggers refuse any change to an issued document, any number out of
  turn, any change to an invoice's order's price, and anything that would credit more than is owed.
- **Reads for reports**: `rec_quote`, `rec_invoice` and `rec_credit_note` carry numbers, states,
  dates, amounts and the bill-to's ids, never addresses, notes or bank details.
- **Who**: `invoices:write` (drafts), `invoices:send` (issue; part payments), `invoices:credit`
  (issue a credit note, void; a person only) and `invoices:payments` (record and reverse a payment,
  the event log; restricted, a person only). All are admins' by default and granted one by one. A
  line discount also needs `orders:discount`. Everything here is for staff only.

## Main flows

1. **Draft.** Staff write a draft invoice (`invoice.create`, `invoice.addLine`, …) with lines from
   records for sale or typed. Goods are refused: they are sold on an order with a delivery.
2. **Issue.** A person issues it (`invoice.issue`): the number, the bill-to as printed, the
   business's details and bank details as they are, the due date, and its order, in one write. A
   price changed since a line was added, an agreement the bill-to still needs, or a discount over
   the limit an admin set stops it (the last waits for approval). An AI asks; a person approves.
3. **Get paid.** Online, staff open its order's checkout for the whole balance, or a part when
   allowed (`invoice.allowPartPayments`). A transfer or cash is recorded (`invoice.recordPayment`);
   one entered in error is reversed (`invoice.reversePayment`). The invoice becomes part paid, then
   paid, with its order.
4. **Put it right.** Staff draft a credit note (`creditNote.create`) and a person issues it
   (`creditNote.issue`): what is still owed goes down, and what was paid beyond it goes back, a
   payment made online through Approvals, one taken another way paid back by a person and recorded
   (`order.recordRefund`). An unpaid invoice is voided in one step (`invoice.void`).
5. **Read.** Staff read documents (`invoice.get` with its money, `invoice.list`, `creditNote.get`,
   `creditNote.list`) and the event log by cursor (`invoice.events`).

## What is built

Stage 35's steps 1 to 5: the PDF writer, the records, numbering, settings and drafts, issuing as an
order, recorded payments and their reversal, credit notes and void.

Not in the code yet: sending and reminders, quotes' acceptance and deposits, the customer's pages
and My account, the Invoicing pack's price list and screens, and erase and retention (steps 6 to
11).
