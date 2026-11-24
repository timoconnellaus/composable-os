---
title: "Finance"
description: "The business's figures for the books, by the business's own day. Day summaries, Sales, Tax and Refunds, a monthly close that keeps a month exactly as it was, and one CSV file per report for its accountant."
sidebar:
  label: "Overview"
  order: 0
editUrl: false
---

The business's figures for the books, by the business's own day. Day summaries, Sales, Tax and Refunds, a monthly close that keeps a month exactly as it was, and one CSV file per report for its accountant.


## What it is for

Whoever handles the money (the owner, a manager, a bookkeeper) sees what was sold in a month or
any span of days: by kind of sale and item, by tax code and country, and every refund. They close
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

## How the pieces fit

- **Platform code** in `packages/core/src/finance/` (`day.ts`, `periods.ts`, `entries.ts`,
  `close.ts`, `book.ts`, `reports.ts`, `files.ts`, `erase.ts`), reached through the
  [operations](/capabilities/finance/operations/) named `finance.*`. Every one of them is staff
  only.
- **Tables**: `core_finance_period`, `core_finance_entry`, `core_finance_entry_line`,
  `core_finance_row` and `core_finance_counted`. They are in no `rec_*` view, so no dashboard,
  `query.sql` or record read reaches them. Triggers keep a closed version as it was, for every
  writer.
- **Reads**: orders, their lines, payments and refunds, through date indexes, so a month reads only
  its own rows. Nothing in finance writes to an order, a payment or a refund.
- **Who**: `finance:read` (see the reports, the entries and download the files) and `finance:close`
  (close and reopen). Both are admins' by default and can be granted one by one. The assistant may
  read figures for an account with `finance:read`. Closing, reopening, downloading and the settings
  are a person's only.

## Main flows

1. **Look.** A person or the assistant reads a report (`finance.report`): Sales, Tax or Refunds,
   for a month (its closed version, or a preview while it is open) or for any span of up to 366
   days. Every row lists the orders it came from.
2. **Close.** Once a month has ended and the month before it is closed, a person closes it
   (`finance.close`). One batch writes its day summaries, report rows and every payment and refund
   it counted, guarded by what it read: if anything changed meanwhile, the close fails whole and is
   tried again.
3. **Download.** A person downloads a report as a CSV file (`finance.export`). A closed version's
   file is the same every time. A preview's first row says it is a preview.
4. **Sync.** A closed version's book entries are listed, paged (`finance.entries`). This is the read
   Accounting sync will use. A preview has no entries.
5. **Reopen.** A person reopens a month, saying why (`finance.reopen`). Closing it again writes the
   next version, and each entry's fingerprint shows what changed.
6. **Set up.** Read and change the financial year's first month, the first month counted and the
   category labels (`finance.periods`, `finance.settings.get`, `finance.settings.update`).

## What is built

Stage 52's steps 1 to 3, as the code has them:

- the business's day and month, months listed with their versions, the close as one guarded
  batch, versions and reopening, the triggers, the two permissions and the settings;
- `sellable.finance` declared by Memberships, Ticketing, Bookings and Courses;
- day summaries, late entries, Sales, Tax and Refunds, the CSV files and the book entries' read;
- the erase of a person's name from closed rows and of a reopen's reason.

Not in the code yet: payouts, money owed, unearned, members, what is held for customers, and the
admin screens (steps 4 to 8).


## Reference

Generated from the code:

- [Operations](/capabilities/finance/operations/)
- [Permissions](/capabilities/finance/permissions/)
- [Behaviours](/capabilities/finance/behaviours/)
- [Screens](/capabilities/finance/screens/)
- [Decisions](/capabilities/finance/decisions/)

The specification is stage 52's, [52-finance-reports.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/52-finance-reports.md).

This page is [finance/docs/overview.md](https://github.com/timoconnellaus/composable-os/blob/main/packages/core/src/finance/docs/overview.md), written by hand beside the code.
