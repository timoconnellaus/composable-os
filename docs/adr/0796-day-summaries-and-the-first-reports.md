# ADR 0796: Day summaries and the first reports: what a day counts, how an order's money is shared, and the files

Status: accepted, 2026-11-24 (stage 52, build step 3). Builds on ADRs
[0790](0790-finance-periods-the-business-day-and-the-monthly-close.md) (the close, late sources),
[0791](0791-the-figures-for-the-books-book-entries.md) (book entries, headings),
[0479](0479-tax-at-checkout.md) (the provider's tax, stored as it said it) and
[0690](0690-adjustments-on-orders-net-lines-and-the-pricing-seam.md) (net lines). Migration 1153. The spec's ADR table names
0793 (payouts) and 0795 (subscription history) for steps 4 and 5, so this step took the next free
number.

## Context
Step 1 built the close, versions and the entries' shape, with an empty book. This step fills it
with the first figures: one day summary per business day, and the Sales, Tax and Refunds reports,
their files and `finance.entries`, Accounting sync's read. The reports, the files and the entries
must never disagree, a closed month's must never move, and a figure must be exact to the minor
unit.

## Decision

**What a month counts** (`packages/core/src/finance/book.ts`): payments the host applied
(`outcome = 'applied'`) on the business day of `received_at`; a late payment staff honoured on the
day they honoured it (`resolved_at`: it became a sale then); a refund on the day it was confirmed
(`confirmed_at`). A late or mismatched payment not honoured is not a sale, and a refund that gives
one back (same order, provider and payment reference) is not a refund of a sale: neither is
counted here (Money owed lists the first, step 5; Payouts shows both, step 4). One currency, the
organisation's (`order_currency`); a source in another is listed apart in Sales and summed nowhere.
Migration 1153 indexes the three dates (partial indexes on the rows counted), so a month reads its
own rows only; no column, row or trigger of the order tables changes.

**How a payment or refund is shared over its order's lines**: by each line's net after
adjustments (`line_total - line_discount`), with `splitInProportion`, so the shares add up to it
exactly. Its tax, by the tax each line carries (`core_order_line.tax_amount`, the provider's own
per-line figures summed), so a line at another rate takes its own share; never more than a line's
share of the money (else in proportion to the money). A line's code is its `tax_code`; the country
is the payment's (a refund's: the order's). Where the provider gave neither, the heading part is
`none` or `XX` (ISO's user-assigned code), so no heading is invented. A refund with no tax figure
from the provider (a one-off refund) carries an **estimate**: the refund times the order's tax over
what was paid, rounded half up, exactly (decision 6), shared the same way and marked
(`tax_estimated:` in the entry, `taxRefundedEstimated` and "estimate" in the reports and files).
A credit note's tax that arrives later replaces it in the next version (guarded, below).

**A day summary** (a `day` entry, `day:<date>`) for each business day money moved (a day with none
has no entry): `money_in:provider` (debit, method `provider`) for each payment against
`sales:<category>` (its shares net of tax, credit) and `tax:<code>:<country>` (credit); for each
refund `refunds:<category>` and `tax:` or `tax_estimated:` (debit) against `money_out:provider`
(credit). Lines of one heading, side and detail are summed. It balances by construction. The
category is the line's object's `sellable.finance` key (`other` when it declares none or is no
longer installed).

**Late** (ADR 0790): a month's book also reads the closed months before it for sources none of
their closed versions counted (`core_finance_counted`), and counts each in a `late` entry dated the
month's first day, naming the month it belongs to (`late:<month>@<first day>`). The report rows
carry the same `belongsTo`. A source a reopened month's new version counts is no longer late
anywhere. This scan reads every earlier source's index entry: a month's preview and close cost
grows with the business's history, by an index read each.

**The reports' rows**, made from the same shares as the entries, so the day summaries add up to
them exactly (the test sums the entries):
- **Sales**: per item (category, object, record, the line's title at the sale, and `belongsTo`)
  and per day and category: sold, discounts, refunded, net, tax on sales, tax refunded (reported
  and estimated apart), tax, net of tax; and the sources in another currency. A line's discount is
  shown once, with the order's first payment, beside the figures (sales are already net of it).
- **Tax**: per code and country, and untaxed beside (a payment the provider did not tax, an order
  with no tax), so its totals reconcile to Sales; with the note that the provider's own tax report
  is the authority.
- **Refunds**: one row per confirmed refund: date, refund, order, items, categories, amount,
  method, tax given back (reported or estimate), who asked and who approved (staff account ids,
  named as the accounts are named when read), and the customer's name and email kept apart for an
  erase (ADR 0320). **Staff's reason is not kept in a closed row**: a closed row's figures cannot
  be redacted (ADR 0790's trigger), and the reason is staff's free text that an erase must reach; it
  stays on the order.
- Every row lists the orders it came from, up to 200 (`orders`), with their count (`orderCount`),
  so a closed row of a busy item stays under ADR 0790's 100 KB a row; the full trace is the
  version's counted sources.

**Category labels**: an admin's label from the finance settings, else the label of the first
installed object (by registry order) declaring the key, else "Other" for `other`. A closed version
keeps the label it was closed with.

**The guard** (ADR 0790): the close guards the count, sum and tax of the payments and refunds it
read (its own and the late ones), the tax of the lines it shared them by and the orders' tax and
paid it estimated from: a payment, refund, credit note or late source landing between the read and
the batch fails the close (`finance_changed`).

**Reading them**: `finance.report` (staff, `finance:read`, `risk: read`, audited as which report,
month, span and version, never a figure) answers a month's closed version as stored (or a given
version, reopened since included), a preview of an open month (with its late sources), or a
preview of a span of up to 366 days (no late sources: a span is never closed). `finance.entries`
(the same permission and audit) lists a closed or since-reopened version's entries and lines,
200 to a page, in their stored order; asked of a month with no closed version it is refused
(`finance_period_not_closed`): a preview has no entries. Both are open to the assistant and MCP
for an account holding `finance:read` (decision 7).

**The files** (`finance.export`, `packages/core/src/finance/files.ts`): one CSV per report, a
person's only (`actors: ["human"]`, not exposed over MCP), audited without figures. A preview's
first row says so; then the report, the period (month, first and last day, zone), the version with
when it was closed and by whom (or `preview`), the currency and the notes; then its tables. Every
amount is in minor units with a decimal column beside it (exact, no floating point); every text
cell is quoted and guarded against formulas with `csvText`. A closed version's file is made only
from its stored rows, so it downloads the same every time; the names in it (who closed it, who asked
for and approved a refund) are the accounts' names when downloaded, and a customer's name is
"Erased person" after an erase: those cells, never a figure, can differ between downloads.

## Why
- Sharing every source over its lines once, and making entries and rows from the same shares, is
  what makes "nothing worked out twice" true inside the host, not only between host and sync.
- Weighing tax by the lines' own tax keeps a mixed order's codes apart; the provider's per-payment
  per-line figures are not stored, and storing them would change the order tables other stages are
  editing.
- Counting an honoured late payment when it was honoured, and leaving out what was never a sale,
  keeps Sales equal to the movement of `rec_order.net` (but for the marked estimate).
- Indexes, not new columns, keep the order tables as stages 34, 35, 37 and the till have them.

## Proof
- `packages/core/test/finance-day-summaries.test.ts`: April by hand in Auckland (00:30 local on the
  first of the month and on a day before the clocks go back, a payment at 00:30 on 1 May that is in
  May, two codes and a discount on one order, a deposit, an estimated and a reported refund tax, a
  late payment and its refund left out, another currency apart): every Sales, Tax and Refunds
  figure, every day summary's lines, every entry balanced and the entries summing to the reports;
  Sales' net of tax against `rec_order.net`; spans; the files (preview row, version rows, a formula
  title neutralised, decimals, the same bytes twice); a payment dated in closed April counted once,
  late, in May, April unchanged; reopen and close again (keys kept, only changed fingerprints move,
  version 1's entries and file as before, May no longer counting it); the erase; the guard and the
  retry; a member refused, the assistant and MCP reading, the assistant refused the file; no figure
  in the audit log.
- `packages/core/test/finance-through-orders.test.ts`: an order checked out with tax and paid by a
  verified payment through the order code, its lines' shares and the provider's tax in Sales and
  Tax.
- `packages/core/test/finance-report-cost.test.ts`: a month of 50,000 orders reported in a handful
  of statements, the months either side read not at all, and closed in one batch under 450
  statements.

## Consequences
- Discounts are shown once per order, with its first payment; a deposit's balance paid next month
  shows no discount there.
- An order paid in parts shares a later payment's tax by its lines' tax so far, so a reopened and
  closed-again month may move a minor unit of tax between two of its lines (and so between their
  headings); the day's money in and its total tax do not change.
- Steps 4, 5, 6 and 8 add their entries, rows, sources and guards to `periodBook`; stage 34's step
  3 adds headings by method and turns recorded payments into sources of their own.

## Amended 2026-11-24 (the review of PR #423, before merge)
- **A guest's address is not kept.** A closed Refunds row keeps a name and email only when the
  order has a Person: the erase and migration 1150's trigger reach a closed row by its Person
  only, so a guest's address (an order with no Person) could never be erased from it. The order
  holds the address until the erase reaches it there.
- **An erase racing the close fails it.** The guards also cover who the refunds' orders name (their
  Person and email, and the Person's name): an erase between the close's read and its batch fails
  the close (`finance_changed`); retried, the row carries what the erase left.
- **A refund is checked against its own order's payments.** Whether a refund gives back a payment
  that was never a sale is looked up through `core_order_payment_order_idx` (`+q.provider`): the
  planner had taken the primary key's provider prefix, reading every payment the provider ever
  made for each refund (50 refunds over 90,000 payments: 4.5 million rows; now a few hundred).
- **Names are read by one JSON parameter**, so a report naming more than 100 staff (a year's
  refunds) is not refused by D1's 100 variables.
- **A closed file is byte for byte the same after a reopen.** The header no longer marks a
  reopened version, so version 1's file downloads as it did (acceptance criterion 9). What can
  still differ between downloads is a name, never a figure: who closed it and the staff on a refund
  are read as their accounts are named when it is downloaded, and an erased customer reads "Erased
  person". This is a deviation from the spec's "byte for byte", recorded here: storing staff names
  in a closed row would put names an erase could not reach in its figures.
- **An order with no lines keeps its tax**, under `tax:none:<country>`, instead of the whole payment
  being booked to `sales:other`.
- Proof: `packages/core/test/finance-review.test.ts` (each sequence the review reproduced, failing
  without its fix, and a late payment honoured in a later month), the refunds case in
  `finance-report-cost.test.ts`, and the full-file comparison in `finance-day-summaries.test.ts`.
