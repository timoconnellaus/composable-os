# ADR 0790: Finance periods: the business's day, the monthly close, versions, and late sources counted once

Status: accepted, 2026-11-24 (stage 52, build step 1; decisions 1 and 2 of the spec). Builds on ADR
[0627](0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md) (the pay period's lock:
one batch with a fingerprint guard, versions, reopening with why, triggers that keep locked rows,
a CSV with formula guards). Migration 1150.

## Context
Whoever handles the money closes each month: its figures are kept exactly as they were, and the
files sent to the accountant never change afterwards. Unlike shifts, money events are the payment
provider's and arrive when they arrive: a refund confirmed in May for an April sale, a payout read
late, a payment recorded with an earlier date. They must always be recorded. A day is the
business's day in its own zone, never UTC (issue #306 is the same fault in dashboards).

## Decision

**The business's day** (`packages/core/src/finance/day.ts`). Every finance date is a local date in
the organisation's zone (`org_timezone`); a day runs from its local midnight to the next
(`wallClockToInstant`), so a day across a clock change is 23 or 25 hours. A month is day 1 to its
last day, local. **Money is counted when the host recorded it**: a provider payment on the business
day of its `received_at`, a refund on the day it was confirmed, a recorded payment on the day the
person says it was received, a stored value movement on its ledger entry's day, a payout on its
arrival date (each counted by the step that reads it).

**The period is a calendar month** (decision 1); a quarter or a year is its closed months added up,
from the financial year's first month (a setting used only for that). A range that is not a month
can be previewed, never closed. **The first month** is the month finance was installed in
(migration 1150 stores the instant, `finance_installed_at`, read in the organisation's zone), or an
earlier month a human admin picks (`finance.settings.update`) before anything is closed.

**States** (`core_finance_period`, one row per version): open (no row, or the latest version
reopened), `closing` (inside the close's batch only), `closed` (version n), `reopened` (version n
kept, with who, when and why). A month is closed only once it has ended and the month before it is
closed (or it is the first), so "belongs to a closed month" always has an open month to land in;
it is reopened only while no later month is closed. A month with a version keeps the zone, dates and
instants it was first closed with; an open month is in the organisation's zone now, starting at
the very instant the stored month before it ends (and ending where a stored month after it starts),
so a change of zone applies from the next open month and leaves no hour in two months or in none.

**The close** (`finance.close`, `packages/core/src/finance/close.ts`) writes, in one batch: the
guards, the version `closing`, its book entries and their lines (ADR 0791), its report rows
(`core_finance_row`), every source it counted (`core_finance_counted`), then `closed` with its
counts (a trigger checks them against what was written). Before the batch it reads what its
figures came from (integer SQL each report declares, as ADR 0627's fingerprint) and guards each in
the batch (`core_finance_guard`): a write in between fails the close whole, answered
`finance_changed`; retried, the close counts the new row. Rows are written 500 to a statement, one
JSON parameter each; a month of more than 100,000 lines, report rows or counted sources is refused
(`finance_too_large`), never cut short, so the biggest close is about 600 statements (D1 allows
1,000 an invocation).

**The close never refuses a money event.** Nothing guards an order, a payment or a refund against
a closed month (ADR 0627's triggers on source rows were rejected: the provider's events are not the
business's to refuse). Instead, the close records every source it counted; a source dated in a
closed month and not counted by it is counted by the first open month's close in a `late` entry
naming the month it belongs to. A trigger refuses counting a source in two months' closed versions;
a reopened month closed again counts its own again.

**A closed version never changes, for every writer** (migration 1150): `core_finance_period` moves
only `closing` → `closed` → `reopened` (and a new version starts `closing`); entries, lines, rows
and counted sources are written only into a version being closed and never updated, deleted or
replaced. Each table's `BEFORE INSERT` also refuses a REPLACE or upsert onto a row it protects, and
its `BEFORE UPDATE` an `UPDATE OR REPLACE`, since D1 runs with recursive triggers off. The one change
a closed row takes is an erase of its person (ADR 0320): its name becomes "Erased person" and its
email is cleared; its amounts, dates and order ids stay. Refused as `conflict`, `rule:
"finance_period_fixed"`, naming no figure.

**Reopening** (`finance.reopen`) is a person's, with why (kept on the version, redacted from the
audit log). Closing again writes the next version; every version stays readable and its files
downloadable as they were.

**Cost**: listing the months (`finance.periods`: the current one and 24 before, never before the
first) reads the versions once, not once per month.

## Why
- Money events must always land: a snapshot plus "belongs to a closed month" keeps the closed
  month unchanged and the late event counted, once.
- Counting at the host's moment means only what is dated back on purpose lands in a closed month;
  the provider's own moment is not stored, and the payout lines carry it anyway.
- Closing in order gives every late source an open month to land in.
- Tracking what was counted in the finance tables, not on the order rows, keeps the order tables
  that stages 34, 35, 37 and the till are changing out of this stage.

## Proof
- `packages/core/test/finance-periods.test.ts`: the business's day far from UTC and across clock
  changes; months listed from the first; closing in order, only once ended (at local midnight),
  never before the first month; reopening only with no later month closed, its reason out of the
  audit log; version 2; a closed month keeping its zone after the organisation's changes, the next
  month starting at its very instant; every table's triggers against raw UPDATE, DELETE, REPLACE,
  upsert and `UPDATE OR REPLACE`; the erase of a row's person; a source counted twice across months;
  the guard (`finance_changed`) and the retry; the size refusal; no `rec_*` view reading the tables.
- `packages/core/test/finance-close-cost.test.ts`: a close of 100,000 lines, 100,000 rows and
  100,000 sources in one batch of 605 statements with one parameter each; the months listed in a
  handful of statements.

## Consequences
- Until stage 52's report steps land (3 to 6 and 8), a close writes a version with no entries
  (`periodBook` returns none). A month closed then holds nothing; what it should have held is
  counted later as late for it, once, so no figure is lost, but such a month should not be closed
  on a live host before step 3 (no screen offers it before step 7).
- The erase's statement for closed rows lands with the first report that keeps a name (step 3);
  the trigger already allows it.
- How long closed versions are kept is the business's to confirm with its accountant; deleting a
  version is not built.
