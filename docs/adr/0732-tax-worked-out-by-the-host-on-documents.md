# ADR 0732: Tax worked out by the host on documents, from the business's rates

Status: accepted, 2026-11-24 (stage 35, build step 2: the rates, the arithmetic and the drafts'
totals). Amends [ADR 0479](0479-tax-at-checkout.md) (tax at checkout) for quotes, invoices and
credit notes only. Builds on [ADR 0730](0730-quotes-invoices-and-credit-notes-as-core-records.md).
Stage 35's spec: decision 2, "Tax", criterion 5, and rows 2 and 3 of the build order.

## Context
ADR 0479 says the host never calculates a tax amount: prices include tax, and the payment
provider works the tax out inside the price at checkout, payment by payment. An invoice cannot
work that way. It must show its tax before it is paid, it is often paid by transfer or in cash
where no provider is involved, and trades write amounts without tax and add it on top. Decision 2:
the business enters its own tax rates once, and the host works out the tax on each line of every
quote, invoice and credit note.

## Decision
- **The business's own rates** (`invoice.settings.update`, a human admin): each a key, a label as
  printed and a rate in hundredths of a percent (1000 is 10%), and a default. No rate ships; with
  none set, documents show no tax.
- **A rate never changes.** Once saved, a key's rate is fixed: a new rate is a new key, and the old
  one is retired (no new line may use it; documents keep it). A key on any document's line is never
  removed, only retired; its label is fixed once a sent or issued document uses it. Each line keeps
  the key, the rate and the label it used, so a document's tax is always what it was worked out
  with.
- **Per line, rounded half up.** A line is unit price × quantity (a quantity in thousandths), less
  its discount (an amount, or a percentage of the line, rounded half up), and its tax is worked out
  on what is left, rounded half up to the minor unit:
  - amounts **without tax** (`exclusive`): tax = net × rate, added on top;
  - amounts **with tax** (`inclusive`): tax = total × rate / (1 + rate), taken out.
  All in integers (BigInt products), never a float.
- **A document's tax is the sum of its lines' taxes,** shown by rate in the order its lines first
  use them; its total is its lines' totals. The document is typed in one mode (the settings'
  default, with tax unless the business chooses otherwise), and switching a draft between them
  prices every line again.
- **A record's price includes tax** (ADR 0479's rule for every price on a record, unchanged). On a
  document typed without tax a record's line takes the price with its rate's tax taken out, per
  unit, rounded half up (12.00 at 10% is 10.91), so a pass invoiced to a business adds back to
  about what the pass costs at checkout; on a document typed with tax it takes the price as it is.
  The record's price as read is kept on the line, so a change of the line's rate or of the
  document's mode works from it again.
- **A deposit's share** (used by the deposit invoice, step 6): the deposit, an amount that includes
  tax, is split over the quote's rates and its untaxed part in proportion to their totals, the
  minor units left over going to the largest remainders so the shares add up to the deposit
  exactly; each share's tax is the quote's tax at that rate in the same proportion, rounded half
  up. The final invoice's "less deposit paid" takes these off by rate (`depositShares`).
- **Checkout sales are unchanged.** The host works tax out for documents only. An invoice's order
  stores each line's tax from the document and asks the provider for none at checkout, even with
  tax at checkout on: that is step 3, which builds it on these figures. For everything else sold
  at checkout, ADR 0479 holds as written.
- **For the business's accountant.** Whether the rounding, the treatment of discounts and deposits
  and what the documents show are what its tax authority expects is for the business to confirm;
  the worked examples in `packages/core/test/invoice-tax.test.ts` are the table to show them.

## Consequences
- `packages/core/src/invoices/tax.ts` holds the arithmetic, with nothing read or written there;
  the drafts (`invoices/drafts.ts`) price every line with it and keep the totals in the document
  row (`net_total`, `tax_total`, `total`, `tax_by_rate`), recomputed in every write.
- The PDF writer draws these figures as given (ADR 0737); it does no tax arithmetic of its own.

## Checks that were broken on purpose (each made a test fail, then restored)
- `mulDivHalfUp` rounding down (no `+ c`): the half-up rows of the table failed.
- The inclusive branch taking `amount × rate / 10000`: the "with tax inside" rows failed.
