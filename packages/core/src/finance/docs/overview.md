---
id: finance
title: Finance
summary: The business's figures for the books, by the business's own day. Day summaries, Sales, Tax, Refunds and the payment provider's payouts, a monthly close that keeps a month exactly as it was, and one CSV file per report for its accountant.
stage: 52
spec: docs/stages/52-finance-reports.md
adrs: [0790, 0791, 0792, 0793, 0794, 0796]
operations: [finance.]
---

## What it is for

Whoever handles the money (the owner, a manager, a bookkeeper) sees what was sold in a month or
any span of days: by kind of sale and item, by tax code and country, every refund, and each payout
the payment provider sent to the bank, line by line, with its fees and what matches nothing. They close
the month, and its figures and files stay exactly as they were. Something that turns up later for a
closed month is counted in the next open month, marked as belonging to the closed one. Each report
downloads as a CSV file for the business's accountant.

The host reports what the payment provider confirmed and what the host recorded. It gives no
accounting or tax advice. How a figure is treated in the books is for the business to confirm with
its accountant, and the reports and files say so.

Finance is core, not a pack. Orders, payments and refunds are core, and the reports span every
pack. A pack only says what kind of sale each of its sellable objects is
(`sellable.finance`: a category, and how its money is earned).

## Concepts

- **Business day**: a local date in the organisation's time zone. A day across a clock change is 23
  or 25 hours long. Money is counted on the day the host recorded it: a payment on the day it was
  applied, a late payment staff honoured on the day they honoured it, a refund on the day it was
  confirmed.
- **Finance month**: a calendar month of business days. It is open; closed, as version 1, 2 and
  so on; or reopened, with the old version kept.
- **Book entry**: the figures for the books. There is one **day summary** for each business day
  money moved. Each line has a heading in the host's words (`money_in:provider`,
  `sales:<category>`, `tax:<code>:<country>`, `refunds:<category>`,
  `tax_estimated:<code>:<country>`, `money_out:provider`), a side and an amount in minor units.
  Debits equal credits. Each entry has a key that is the same in every version and a fingerprint of
  its lines. A **late** entry carries what arrived for a closed month.
- **Shares**: each payment and refund is split over its order's lines by what each line costs
  after its discounts. The shares are whole minor units that add up exactly. Its tax is split by
  the tax each line carries.
- **Estimate**: a refund the provider gave no tax figure for carries tax in proportion to the
  order's, marked as an estimate. The provider's own tax report is the authority.
- **Payout**: money the payment provider sent to the bank, counted on the day it arrives, with its
  **lines**: the payments, refunds, disputes, adjustments and fees it settled. Each payment and
  refund line is matched to what the host recorded by the provider's reference; what matches
  nothing is listed apart, never guessed. Each payout is one book entry (`bank` and
  `fees:provider` against `money_in:provider`, `money_out:provider`, `disputes`, `adjustments` and
  `unmatched`). A payout the bank returned later is an entry of its own. **Not yet paid out** is
  the provider's money received that no payout has settled yet. A payment recorded by hand (a
  transfer, cash) never reaches the provider and is in no payout.

## How the pieces fit

- **Platform code** in `packages/core/src/finance/` (`day.ts`, `periods.ts`, `entries.ts`,
  `close.ts`, `book.ts`, `payouts.ts`, `payout-sync.ts`, `reports.ts`, `files.ts`, `erase.ts`),
  reached through the [operations](/capabilities/finance/operations/) named `finance.*`. Every one
  of them is staff only, but `finance.payouts.sync`, which only the host runs.
- **Tables**: `core_finance_period`, `core_finance_entry`, `core_finance_entry_line`,
  `core_finance_row` and `core_finance_counted`; the payouts as read, `core_payout`,
  `core_payout_line` and `core_payout_failure`, and the read's place, `core_payout_sync`. They are
  in no `rec_*` view, so no dashboard, `query.sql` or record read reaches them. Triggers keep a
  closed version and a recorded payout as they were, for every writer.
- **Reads**: orders, their lines, payments and refunds, through date indexes, so a month reads only
  its own rows. Nothing in finance writes to an order, a payment or a refund.
- **The payments gatekeeper**: once a business day the minute cron reads the provider's payouts
  (`listPayouts`, `payoutLines`: read only, the host's own call, the bank account never read), at
  most 20 calls a run, carrying a backlog on from its place the next minute. A key that may not
  read payouts makes the report say so; a failing provider is tried again later.
- **Who**: `finance:read` (see the reports, the entries and download the files) and `finance:close`
  (close and reopen). Both are admins' by default and can be granted one by one. The assistant may
  read figures for an account with `finance:read`. Closing, reopening, downloading and the settings
  are a person's only.

## Main flows

1. **Read the payouts.** Once a business day the host reads the provider's new payouts and their
   lines through the payments gatekeeper (`finance.payouts.sync`, the minute cron's step), each
   once by the provider's id. A payout whose lines do not sum to it tells whoever may close the
   books, once.
2. **Look.** A person or the assistant reads a report (`finance.report`): Sales, Tax, Refunds or
   Payouts, for a month (its closed version, or a preview while it is open) or for any span of up
   to 366 days. Every row lists the orders it came from.
3. **Close.** Once a month has ended and the month before it is closed, a person closes it
   (`finance.close`). One batch writes its day summaries, payout entries, report rows and every
   payment, refund and payout it counted, guarded by what it read: if anything changed meanwhile,
   the close fails whole and is tried again. A payout read after its month closed is counted in the
   next open month, marked as belonging to the closed one.
4. **Download.** A person downloads a report as a CSV file (`finance.export`). A closed version's
   file is the same every time. A preview's first row says it is a preview.
5. **Sync.** A closed version's book entries are listed, paged (`finance.entries`). This is the read
   Accounting sync will use. A preview has no entries.
6. **Reopen.** A person reopens a month, saying why (`finance.reopen`). Closing it again writes the
   next version, and each entry's fingerprint shows what changed.
7. **Set up.** Read and change the financial year's first month, the first month counted and the
   category labels (`finance.periods`, `finance.settings.get`, `finance.settings.update`).

## What is built

Stage 52's steps 1 to 4, as the code has them:

- the business's day and month, months listed with their versions, the close as one guarded
  batch, versions and reopening, the triggers, the two permissions and the settings;
- `sellable.finance` declared by Memberships, Ticketing, Bookings and Courses;
- day summaries, late entries, Sales, Tax and Refunds, the CSV files and the book entries' read;
- payouts read from the provider, payout entries and the Payouts report;
- the erase of a person's name from closed rows and of a reopen's reason.

Not in the code yet: money owed, unearned, members, what is held for customers, and the admin
screens (steps 5 to 8).
