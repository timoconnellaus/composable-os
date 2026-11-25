# ADR 0735: Credit notes and void: what is owed reduced, refunds by method, never more than was paid

Status: accepted, 2026-11-25 (stage 35, build step 5; [the spec](../stages/35-invoices-quotes.md),
"Credit notes", criteria 9 and 19). Amends [ADR 0429](0429-payments-gatekeeper-verified-events-and-refunds.md)
(an invoice's applied payments go back only by a credit note) and
[ADR 0694](0694-an-order-paid-another-way.md) (a recorded payment's money goes back on an invoice's
order as its credit note says). Builds on ADRs [0730](0730-quotes-invoices-and-credit-notes-as-core-records.md)
and [0731](0731-an-invoice-is-an-order.md).

## Context
An issued invoice is never edited (ADR 0730): a mistake is put right with a numbered credit note.
A credit note may reduce what is still owed, give back what was paid, or both; voiding an unpaid
invoice is a full credit note. Money goes back the way it came (ADR 0694), and a credit note and a
provider refund of the same order must never both give the same money back.

## Decision
- **A draft** (`creditNote.create`, `invoices:write`; the assistant may draft one for a person):
  some of the invoice's lines (a quantity of each, or all that is left of it) or an amount at one
  of the invoice's rates (as the invoice's amounts are typed; its tax worked out as the invoice's
  was, ADR 0732), a reason, and how it settles (`reduce`, `refund`, or `both`: what is owed first,
  then what was paid). A part of a line is the line's amount and tax in proportion, rounded half
  up; the rest of a line is exactly what is left of it. Never more than is left to credit of a line
  (quantity and amount), of a rate (total and tax) or of the invoice, against the credit notes
  issued before; checked again at issue. `creditNote.get`, `creditNote.list` (`records:read`),
  `creditNote.delete` (a draft).
- **`creditNote.issue`** (`invoices:credit`, a person only): in one batch, its number
  (`numberStatements`, series `credit_note`), the bill-to as printed on its invoice and the
  business snapshot; then
  1. **what is owed reduced**: `core_order.credited` up by the part it takes off (balance = total -
     paid - credited; the database refuses `paid + credited` over the total, and `credited` going
     down or on any other order); `reduce` refuses more than is owed, `refund` refuses while
     anything is owed;
  2. **the rest given back**, payment by payment, newest first, from what was applied and not yet
     given back, asked for or owed back: a provider's payment through the existing refund approval
     (`requestRefund`: the gatekeeper's `payments.refund`, approved by a person with
     `orders:refund`), a recorded one owed until a person records it paid back (`order.recordRefund`,
     `orders:refund`, for exactly what the credit note owes on that payment). Each is a row of
     `core_credit_note_refund` (migration 1031), written only beside its issued credit note and
     never changed but for a recorded one's paid back, once. More than can go back is refused
     (`rule: "credit_beyond_paid"`), and a guard after the split refuses a credit note that would
     give back other than it says;
  3. **the order and the invoice**: credited in full with nothing paid, the order is cancelled (its
     places given back) and the invoice `credited`; paid and credited until nothing is owed, the
     order (and so the invoice) is paid. The write always moves the order's version, so two credit
     notes issued at once are never judged against the same read;
  4. **the log**: `issued` and `credited` for the credit note, `refund_confirmed` when the provider
     confirms its refund, `paid_back` when a person records it.
- **`invoice.void`** (`invoices:credit`, a person only): an issued invoice nothing was paid on gets a
  credit note for everything still owed on it (each line in full, or, after earlier credit notes,
  what is left at each rate), issued in the same batch; the invoice is `void`, its order cancelled,
  its places given back; `voided` in the log. With something paid it is refused: credit it.
- **Never more back than was paid.** Credit notes together credit at most the invoice; what they
  give back is at most what was applied to its order and not already given back or owed back; and
  `order.refund` refuses an invoice's applied payments (`rule: "invoice_order"`: only a late or
  unmatched payment is refunded there), so a credit note and a provider refund never both give the
  same money back. A recorded payment a credit note gives money back on cannot be reversed.
- Account credit instead of money back waits for stage 34's account credit (its step 8).

- **A refund that did not go through is owed, and asked for again** (review of PR #460). Each of a
  credit note's refunds is `given_back` (confirmed, or recorded paid back), `asked` (waiting for a
  person or the provider) or `owed` (a recorded one not yet paid back; a provider's a person
  rejected, whose approval expired or that failed). `creditNote.get` shows each and what is owed
  back, and `invoice.get` the invoice's (`money.owedBack`). A person with `orders:refund` asks again
  (`creditNote.askRefundAgain`, human only): the same amount on the same payment, through the same
  approval, the row naming the new refund and its attempt moving on by one (the database refuses
  anything else, and a second ask at once fails its batch on the order's version). What credit
  notes owe back is never given back by another: a later credit note can give back only what was
  paid less what is given back, asked for or owed back. The event log says what went back
  (`refund_confirmed`, `paid_back`) and nothing else, so until then it never says money went back.
- **Asked again without refunding twice** (the second review of PR #460). A refund that never left
  the approval (rejected, or its approval expired) is asked for as a new refund. One that may have
  reached the provider (it failed when it was applied, or the provider has not confirmed it within
  five days of its approval, `CREDIT_REFUND_CONFIRM_DAYS`: a provider's refund is confirmed in
  seconds and its webhook is retried for up to three days) is asked again under the **same refund
  id**, the provider's idempotency key, so a refund that did happen is answered as the same one,
  never made twice. Each owed one says why (`not_paid_back`, `rejected`, `expired`, `failed`,
  `unconfirmed`), and the admins are told once per attempt of one unconfirmed (the minute cron,
  `tellUnconfirmedCreditRefunds`).
- **A credit note's refund carries its own tax** (ADR 0731's `invoiceTaxFor`): giving back a
  GST-free line gives back no tax.
- **A payment that never applied is refunded in any state.** `order.refund` gives back a late or
  unmatched payment on an invoice's order whatever the order's state (it is not what was paid).
- **The invoice's state after it is credited in full and everything paid goes back** stays `paid`
  (nothing is owed) while its order is `refunded`, as the spec words it: its credit notes say what
  went back.
- A credit note may not be issued while a payment page opened in the last day has had no payment
  (`checkout_open`, ADR 0733).
- Every act here that may wait for a person names the version read: `creditNote.issue` the credit
  note's, `invoice.void` the invoice's.

## Consequences
- Erase and retention of credit notes are step 11's.

## Checks that were broken on purpose (each made a test fail, then restored)
- The issue-time room check and the `back > available` check both turned off: a second credit note
  for the same line was issued, giving back more than was paid, and the "proof c" test failed.
- `order.refund` let through an invoice's applied payments: the same test failed (the refund was
  asked beside the credit notes).
- From the review of PR #460: a rejected or expired provider refund read as still asked: both
  "refund that did not go through" tests failed; the reversal to nothing left the order part paid:
  the void and full credit after a bounced transfer failed.
