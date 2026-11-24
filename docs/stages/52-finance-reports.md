# Stage 52: Finance reports

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Orders,
Tax at checkout, Subscriptions, Dashboards and views), [`CONTEXT.md`](../../CONTEXT.md) (Order,
Refund, Refund owed, Subscription, Pass, Allowance, Tax at checkout, Restricted permission,
Permission grant); ADRs [0010](../adr/0010-dashboards-sql-views.md) and
[0020](../adr/0020-query-sql-validator-and-csv-import.md) (read-only SQL over `rec_*` views),
[0320](../adr/0320-erase-reaches-every-store.md) (erase reaches every store),
[0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
[0429](../adr/0429-payments-gatekeeper-verified-events-and-refunds.md),
[0449](../adr/0449-permissions-granted-one-by-one.md),
[0479](../adr/0479-tax-at-checkout.md),
[0485](../adr/0485-recurring-billing-the-provider-runs-the-schedule.md),
[0486](../adr/0486-an-order-per-paid-period-and-its-refund.md),
[0511](../adr/0511-the-memberships-pack-and-passes.md),
[0532](../adr/0532-the-memberships-dashboard-and-staff-side.md),
[0560](../adr/0560-a-paid-line-moves-a-record-that-exists.md) (drop-ins and the refunds the host
owes) and [0627](../adr/0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md) (the pay
period's lock and CSV: the precedent for this stage's close and files); stages
[34](34-offers.md) (an order paid another way, gift cards and account credit, adjustments),
[37](37-shop.md) (goods, returns, the seam with the till), [47](47-pack-screens.md) (staff screens)
and [48](https://github.com/timoconnellaus/composable-os/pull/311) (My account, PR #311);
`packages/core/src/orders/`, `packages/core/src/subscriptions/`, `packages/core/src/staffing/pay.ts`
(`csvText`), `packages/core/src/time/local.ts`, `packages/gatekeeper-payments/src/provider.ts`;
issues [#306](https://github.com/timoconnellaus/composable-os/issues/306) (dashboards' "today" in
UTC), [#198](https://github.com/timoconnellaus/composable-os/issues/198) (tax added on top),
[#245](https://github.com/timoconnellaus/composable-os/issues/245) (disputes),
[#124](https://github.com/timoconnellaus/composable-os/issues/124) and
[#103](https://github.com/timoconnellaus/composable-os/issues/103) (stage 35, invoices).

Status: **spec agreed** (2026-11-24). No owner interview was needed: every question the draft
raised was decided by the coordinator the same day under the owner's standing rule that
best-practice answers are decided, not asked (decisions 1 to 10 below). The owner may override
any of them. Every step may start in the order below; step 8 waits for stage 34's shared step and
gift cards to be built.

- **Step 1 built** (PR #337, `feat/stage-52-periods-entries`): the business's day, finance months,
  the close as one guarded batch, versions and reopening, the entries tables and their triggers
  (months closed and reopened in order for every writer, the first month fixed by the first close),
  `finance:read` and `finance:close`, the finance settings, `csvText` in `packages/core/src/csv.ts`,
  and the erase of a reopen's reason and of closed rows' names. Migration 1150; ADRs 0790, 0791 and
  0794 (0449 amended). Left: until step 3 fills `periodBook` a close writes no entries; inserts are
  500 rows or 1 MB to a statement (not ADR 0627's hundred), so the biggest close fits D1's 1,000.
- **Step 2 built** (`feat/stage-52-sellable-finance`): `sellable.finance` (a category's key and
  label, and `earned`: `at_sale`, `over_period`, `per_use` or `at_date` with `at`), its contract
  checks, the field registry's copy with the defaults filled (`other`, `at_sale`), and the
  declarations in Memberships (plan `over_period`, pass type `per_use`), Ticketing (ticket type
  `at_date` on `event.startsAt`), Bookings (drop-in `at_date` on `class.startsAt`) and Courses
  (course and bundle `at_sale`; the course plan `over_period`, as a plan). No migration; ADR 0792
  (0435 amended). The ADR numbers of 0792 and 0793 in the table below are swapped from the draft.
- **Step 3 built** (`feat/stage-52-day-summaries`): the day summaries (one `day` entry per business
  day money moved, filling `periodBook`), Sales, Tax and Refunds (`finance/book.ts`, each payment
  and refund shared over its order's lines by net, its tax by the lines' tax; a one-off refund's tax
  estimated in proportion and marked), late sources from closed months in `late` entries,
  `finance.report` (a closed version, a month's preview or any span up to 366 days),
  `finance.entries` (closed versions only, paged) and `finance.export` (one CSV per report, a
  person's). Migration 1153 (indexes on the dates counted; 1151 and 1152 stay the spec's for steps
  4 and 5); ADR 0796. Left: a closed Refunds row keeps no staff reason (it could not be redacted);
  staff names in a file are read when it is downloaded; discounts show once, with an order's first
  payment; the late scan reads every earlier source's index entry. The hand-worked fixture is
  written to the order tables, plus one order paid through the order code; the full fixture of
  acceptance criterion 1 (memberships, passes, payouts) waits for steps 4 to 6.

**This is not accounting or tax advice, and the platform gives none.** The host reports what the
payment provider confirmed and what the host recorded. How a figure is treated in the business's
books (when a sale is earned, what tax is owed, what a refund or a gift card does to it) is for the
business to confirm with its accountant. Every figure below that depends on such a choice says so
on screen and in the file.

## Goal

Whoever handles the money (the owner, a manager, a bookkeeper) opens one place in the admin and
sees, for a month or any range: what was sold, by kind of sale (memberships, passes, drop-ins,
tickets, courses, goods) and by tax; every refund; each payout the payment provider sent to the
bank, matched line by line to the sales it paid for, with the provider's fees and anything that
matches nothing; what customers owe the business; what the business holds for customers (gift
cards and account credit); money taken but not yet earned, flagged for the accountant; and
membership numbers. A day is the business's day, in its own time zone, never UTC.

They **close** the month: its figures are kept exactly as they were, and the files sent to the
accountant (one CSV per report, safe to open in a spreadsheet) never change afterwards. Something
that turns up later for a closed month shows in the next open month, marked as belonging to the
closed one.

This stage owns **the figures for the books**: one summary per business day by kind of sale and
tax, each payout to the bank as its own entry, refunds, and the balances held for customers.
Accounting sync (stage 61) sends these figures, as this stage writes them, to an accounting
system, and never works them out again.

## Who it is for

- **Gyms and studios, first.** Revenue is mostly recurring memberships and passes: how much came
  in this month by plan, how much of a class pack is still unused, how many members joined, paused
  and left, which renewals are failing, and does the provider's payout match what it charged. Tax
  is inside the price (ADR 0479). Refunds are of drop-ins (owed by the host when a class is
  cancelled, ADR 0560) and of membership periods (ADR 0486).
- **Trades and services (next).** Money owed by age (30, 60, 90 days), deposits taken for work not
  yet done, progress payments on one job, and tax added on top of a price. Invoices and quotes
  (stage 35, #103), tax added on top (#198) and jobs (stage 39) are not built; this stage reads
  orders, so a trade using orders for deposits gets the deposit and balance figures at once, and
  stage 35 extends Money owed to invoices.
- **What both share:** a closed month that does not move, files an accountant can open, payouts
  matched to sales, and nothing that moves money.

## What exists today (from the code, checked 2026-11-24)

| Piece | Where | What this stage uses |
| --- | --- | --- |
| Orders, lines, payments, refunds, in integer minor units | `packages/db/migrations/0421_orders.sql` (`core_order`, `core_order_line`, `core_order_payment`), `0422_order_payments.sql` (`core_order_checkout`, `core_payment_event`, `core_order_refund`); `packages/core/src/orders/` | `core_order_payment` (`outcome` applied, mismatch or late; `payment_ref`; `received_at`, the host's time when it applied the verified event: the provider's own moment is not stored) is the cash in; `core_order_refund` (`requested`, `confirmed`, `confirmed_at`) the cash out |
| Tax at checkout: the provider's figure stored per payment, line and order | `0516_order_tax.sql`, `orders/tax.ts`, ADR 0479 | `core_order_payment.tax_amount` and `tax_country`, `core_order_line.tax_amount` and `tax_code`, `core_order.tax_refunded`. **Gap:** `core_order_refund.tax_amount` is null for a one-off refund (the provider's refund carries no tax); a membership period's refund carries it through its credit note (ADR 0486) |
| `rec_order.net` (paid less refunded, less tax still held) and `rec_order_line` | `0516_order_tax.sql` | The Memberships dashboard's revenue tile uses it. There is **no `rec_order_payment` view today**: stage 34 step 3 adds it, with the payment's method |
| The exact split of an amount over lines in proportion | `splitInProportion` in `orders/tax.ts` | Sharing a payment or refund over an order's lines, in whole minor units that add up |
| An order per paid membership period | `0530_subscriptions.sql`, ADR 0486 | Sales by plan; periods paid ahead (unearned) |
| Subscriptions mirrored from the provider | `core_subscription` (`state`, `created_at`, `canceled_at`, `ended_at`, `end_reason`), `core_subscription_change` (`0630`: upgrade, downgrade, pause) | Membership numbers. **Gap:** a subscription's state is a column, overwritten on each move, with **no history** (`core_transition_history`, `0420`, holds `states` records only). **Gap:** a failing renewal's amount due is told to staff (`subscriptions/events.ts`, `invoice_payment_failed`) but not stored |
| Passes and their uses | `packs/memberships/index.ts` (pass type, pass: uses, expiry), `core_allowance`, `core_allowance_use` (`0533`) | Unused classes on a pass bought (unearned) |
| Refunds the host owes (drop-ins) | `core_sellable_refund_due` (`0690`: `due`, `asking`, `asked`, `done`, `lapsed`, `skipped`), `orders/refund-due.ts` | Refunds owed and not yet sent |
| Late and mismatched payments | `orders/late.ts` | Money held that staff have not decided on |
| The organisation's time zone | `org_timezone` (`ORG_TIMEZONE_SETTING`, `packages/core/src/settings.ts`); `localParts`, `wallClockToInstant`, `addLocalDays` in `packages/core/src/time/local.ts` | The business's day. Rostering, pay periods and agreements already use it; dashboards do not (#306: `dashboards/params.ts` works in UTC) |
| Dashboards: read-only SQL over `rec_*` views | `packages/core/src/dashboards/`, `packs/memberships/dashboards.ts`, `packs/courses/dashboards.ts` | Charts beside the reports; not the reports |
| The pay period: lock in one batch with a fingerprint guard, versions, reopen with why, triggers that keep locked rows, a CSV with formula guards | `packages/core/src/staffing/pay.ts` (`csvText`), `0813_pay_periods.sql`, ADR 0627 | The model for the close and the files |
| The payments gatekeeper: checkout, refund, subscriptions, portal, webhooks. **No payout or fee read** | `packages/gatekeeper-payments/src/provider.ts`, `stripe.ts`, `fake.ts` | Gains read-only payout reads |
| Permissions: `orders:refund` and others admin by default, grantable one by one; `settings:manage` | `packages/core/src/principals.ts`, ADR 0449 | Two new core permissions |
| Staff screens for orders and subscriptions | `apps/app/src/routes/_app/orders`, `_app/subscriptions`, `apps/app/src/lib/nav.ts` | The reports live beside them |

Spec agreed, not built, and read by this stage: stage 34's **adjustments** (net lines after a
discount, step 1), **an order paid another way** (`core_order_payment.method`: `provider`,
`recorded`, `voucher`, `stored_value`; refunds by method; `rec_order_payment`; ADR 0694, step 3,
built once by whichever of stage 34, Invoices or the Till goes first) and **gift cards and account
credit** (`core_stored_value`, `core_stored_value_entry`, `rec_stored_value`, step 8). Stage 34
says its reports come from `rec_order_payment` by method and from `rec_stored_value`; this stage is
where those figures are made into the books.

## Decided by the coordinator (2026-11-24)

The draft's questions, each decided at its recommendation under the owner's standing rule. The
owner may override any of them.

| # | Decision |
| --- | --- |
| 1 | **The business closes every month; a quarter or a year is its closed months added up.** A refund or anything else that turns up after a month is closed shows in the next open month, marked as belonging to the closed one |
| 2 | **Who sees the reports and downloads the files: the owner and admins, plus anyone they choose one by one** (a manager, a bookkeeper), as refunds and pay already work |
| 3 | **The business sends the files to its accountant.** The accountant gets no sign-in of their own in this stage |
| 4 | **A class pass's money is not yet earned until each class is used, and is earned when the pass expires unused.** Shown as for the accountant to confirm; the money received is the same either way |
| 5 | **A paused member is still a member, shown separately as paused** |
| 6 | **A one-off refund's tax, which the provider does not report, is shown as an estimate in proportion, marked as an estimate, with a note pointing to the provider's own tax report** |
| 7 | **The assistant may answer questions about these figures for someone allowed to see them.** It never closes, reopens, downloads or sends anything |
| 8 | **Payouts are matched to the sales they paid for, with the provider's fees, in this first version** |
| 9 | **How the business gets its figures to its accountant today** was not asked: the design's assumptions stand (a month's sales, refunds and the provider's statements), to be checked with the business at setup |
| 10 | **Money taken other than through the provider** (cash, a separate card reader, transfers) was not asked: it is recorded through stage 34's shared step once built (recorded payments) and appears here by method; until then the screen says what it covers. Checked with the business at setup |

## The design in one page

- **Core, not a pack.** Orders, subscriptions, refunds, payments and stored value are core, so the
  reports are core operations and core admin screens under **Money → Reports**, in every product
  that sells. A pack adds only a declaration of what kind of sale each sellable object is and how
  it is earned (`sellable.finance`).
- **The business's day.** Every date in this stage is a local date in the organisation's time zone
  (`org_timezone`), with day boundaries worked out by `time/local.ts`, so a day across a clock
  change is 23 or 25 hours and nothing is cut at UTC midnight. A month is day 1 to its last day,
  local. Issue #306 is the same fault in dashboards; it is fixed on its own (below), not here.
- **Money is counted when the host recorded it.** A provider payment is on the business day of its
  `received_at`; a refund on the day it was confirmed; a recorded payment on the day the person
  says it was received; a stored value movement on the day of its ledger entry; a payout on its
  arrival date. Earned is a second view (Unearned), never a rewrite of Sales.
- **The figures for the books are entries.** The host writes, for each period, **book entries**:
  one **day summary** per business day (sales by kind of sale and tax, refunds, money in by method,
  gift cards and credit issued and spent), one **payout entry** per payout, and one **held for
  customers** entry at the period's end (gift card and credit balances). Each entry is
  double-sided and balances to the minor unit, has a stable key, and is frozen when the period
  closes. The reports are views of the same rows; the CSV files are the same rows; Accounting sync
  reads the same rows. Nothing is worked out twice.
- **Splitting an order's money over its lines** uses `splitInProportion`, so a deposit, a part
  payment or a partial refund is shared over the lines in proportion to their totals (net lines
  after stage 34's adjustments, once built), in whole minor units that add up exactly.
- **Closing a period** writes a versioned snapshot of its entries and report rows in one batch,
  guarded by a fingerprint of what it read (as ADR 0627's lock), into core tables nobody changes
  (triggers). **The close never refuses a money event**: payments and refunds come from the
  provider and must always be recorded. Something dated in a closed period (a recorded payment
  dated back, a payout read late, a stored value expiry run late) is counted in the first open
  period in an entry marked with the period it belongs to. Reopening (a person, with why) and
  closing again writes the next version; every version stays readable and downloadable.
- **Payouts** are read from the provider, never written: a daily read through the payments
  gatekeeper of the payouts and the lines in each (payments, refunds, fees, disputes,
  adjustments), stored in core tables, each payment and refund line matched to its order by the
  provider's reference. What matches nothing is listed, not guessed.
- **Files**: one CSV per report, from a closed version (or a preview of an open period, whose first
  row says it is a preview). Minor units and a decimal column beside them, every text cell quoted,
  formula cells neutralised with `csvText` (moved to a shared module). Each file's first rows name
  the period, the version, when it was closed and by whom.
- **Who**: two new core permissions, `finance:read` (see the reports, download files) and
  `finance:close` (close and reopen), admins by default and grantable one by one (ADR 0449). Close,
  reopen and download are a person's act at the screen; an AI may read figures and never close,
  reopen, download or send.

### The figures for the books: what Accounting sync reads

This is the seam with stage 61. This stage owns every figure; the sync owns only where each goes
in an accounting system.

- A **book entry** has: `key` (stable across versions: `day:2026-04-03`, `payout:<provider payout
  id>`, `held:2026-04`, `late:2026-04@2026-05-06`), `kind` (`day`, `payout`, `held`, `late`),
  `date` (local), `period`, `version`, `belongs_to` (a period, for a `late` entry), `fingerprint`
  (a hash of its lines, so a reader sees at once whether version 2 changed it), and its **lines**.
- A **line** has a `heading` (what it is, in the host's words, never an account code), a side
  (`debit` or `credit`) and an amount in minor units, plus the tax code and country where it is
  tax, the method where it is money in or out, and the category where it is a sale. Headings:
  `sales:<category>`, `refunds:<category>`, `tax:<code>:<country>` (and `tax_estimated:` for a
  refund's estimated tax), `money_in:provider`, `money_in:recorded:<kind>`, `money_out:<method>`,
  `held:gift_card`, `held:credit`, `held:voucher`, `credit_given`, `held_expired`,
  `fees:provider`, `bank`, `disputes`, `adjustments`, `unmatched`. Stage 34's methods add their
  headings when its step 3 lands; nothing else adds headings without amending ADR 0791.
- **Every entry balances**: its debits equal its credits. A day summary: money in by method and
  stored value or vouchers spent, against sales net of tax by category, tax by code and country,
  and gift cards, credit and vouchers issued; refunds the other way. A payout entry: the payout to
  the bank and the provider's fees, against what the provider settled (payments less refunds,
  disputes and adjustments). Unmatched lines are carried on their own heading, never folded into a
  sale.
- **The read**: `finance.entries` (staff, `finance:read`) lists a closed version's entries and
  lines, by period and version, paged; the sync's host-side job calls the same core function. A
  preview's entries are never offered to it. On a reopen and a new close, the sync sees which keys
  changed by fingerprint and which were added or dropped; how it reverses and posts them is stage
  61's.
- **What is not an entry**: Unearned and Members are reports only. The entries are counted as
  money moved; any adjustment the accountant makes for what is not yet earned is theirs.

### What was weighed and rejected

- **Reports as dashboards only** (SQL over `rec_*` views). Dashboards cannot be closed,
  versioned, split over lines with exact rounding, or matched to payouts, and their cache and row
  limits suit charts, not ledgers. Dashboards stay for charts; the Memberships dashboard keeps its
  revenue tile.
- **A Finance pack.** Everything it reads is core and spans every pack; a pack would need core
  reads opened to it one by one and would put the rules outside the host.
- **Freezing writes into a closed month** (ADR 0627's triggers on the source rows). Shifts are the
  business's own data; money events are the provider's and arrive when they arrive. The snapshot
  plus "belongs to a closed month" keeps both.
- **Counting a payment at the provider's own moment.** The host does not store it today
  (`received_at` is the host's), and the payout lines carry the provider's moment anyway. Counting
  at the host's moment means a closed month can only receive what is dated back on purpose; the few
  minutes' difference across midnight shows as a timing difference in Payouts, matched by
  reference, not date.
- **A late event written into a new column on the payment and refund rows** (the draft's idea).
  It would alter order tables that stage 34, 35, 37 and the till are all changing. Instead the
  close records in its own table every source it counted (`core_finance_counted`), so a later close
  counts what no earlier one did.
- **The host calculating tax.** The provider's figure is reported as is (ADR 0479); where it gave
  none (a one-off refund) the estimate is marked and the provider's tax report stays the authority
  (decision 6).
- **Earned-revenue entries.** Which method the books use is the accountant's; entries are cash as
  it moved, and Unearned is shown beside, flagged.
- **Accounting sync working out its own figures** from orders. Two sets of figures would disagree;
  the sync reads this stage's entries only.

### What belongs here and what belongs to Accounting sync (stage 61)

| Here (this stage) | Accounting sync (stage 61) |
| --- | --- |
| Every figure: day summaries, payout entries, held for customers, refunds, from orders, payments, refunds, stored value and payouts | Sending closed entries to an accounting system through its gatekeeper |
| The business's day, the period, the close, versions, reopening | Posting a closed version once, and what to do when a reopened period closes as a new version |
| A **category** per kind of thing sold, declared by packs and renamable by an admin; the entry headings | Mapping each heading, category, tax code and country, fee and payout to the accounting system's accounts and tax rates |
| Payouts matched to orders; unmatched lines listed | Marking the bank deposit as reconciled there |
| CSV files a person downloads | Contacts, invoices and payments created there |

## Platform work and pack work

| Piece | Kind | What |
| --- | --- | --- |
| `finance` core module and operations | Platform (new) | `packages/core/src/finance/`: the business's day, periods, entries, the reports, the close, versions, files |
| Core tables and their guard triggers | Platform (migration) | `core_finance_period`, `core_finance_entry`, `core_finance_entry_line`, `core_finance_row` (report rows of a closed version), `core_finance_counted`, `core_payout`, `core_payout_line`; no change to `core_write_guard` |
| Two core permissions | Platform | `finance:read`, `finance:close`, admin by default, grantable (`principals.ts`) |
| `sellable.finance` | Platform (new manifest key, contract check) | `category` (a key and a label for reports) and `earned`: `at_sale`, `over_period` (an order's period start to end), `per_use` (a granted allowance's uses, the rest at its expiry), `at_date` (a date field on the record or one it points to, e.g. an event's start). Missing: category `other`, `at_sale`. Runtime extensions may declare it too: it only labels their own sales. A line whose object issues stored value or a voucher (stage 34) is held for customers, whatever it declares |
| Payout reads in the payments gatekeeper | Platform (gatekeeper) | `listPayouts({ since })`, `payoutLines(payoutRef)` on the provider interface, Stripe and the fake; read-only, no money moves, the payout's bank destination never read |
| A subscription's state history | Platform (subscriptions) | `core_subscription_state`: append-only, one row per mirrored move (from, to, at, reason), written in the same batch as the move |
| The failing renewal's amount kept | Platform (subscriptions) | `core_subscription.amount_due` set from `invoice_payment_failed`, cleared when paid or ended |
| Refund tax where the provider says none | Platform (finance only) | The report and the entry compute the estimate; nothing is written to the order or refund |
| `csvText` shared | Platform (refactor) | From `staffing/pay.ts` to `packages/core/src/csv.ts`; pay imports it |
| Declarations | Pack | Memberships: plan `over_period`, pass type `per_use`; Ticketing: ticket type `at_date` (event start); Courses: `at_sale`; Bookings drop-in `at_date` (class start); Shop items `at_sale` (stage 37, when built). Categories named |
| Admin screens | Platform (core admin) | Money → Reports, under `apps/app/src/routes/_app/` |

No new behaviour. No pack hooks a write. No operation writes to an order, a payment, a refund, a
subscription's money or stored value.

## The model

### The business's day and the period

- **Day**: a local date in `org_timezone`. Its instants are `[wallClockToInstant(day 00:00),
  wallClockToInstant(next day 00:00))`. A change of the organisation's time zone applies from the
  next open period; closed periods keep the zone they were closed in (stored on the period).
- **Period**: a calendar month, local, from day 1 (decision 1). The financial year's first month is
  a setting (`finance.settings`, a human admin's), used only to add months into a year. A range
  that is not a month can be previewed, never closed.
- **States** (`core_finance_period`): open (no row), `closing`, `closed` (version n), `reopened`
  (version n kept, with who, when, why). A period is closed only once it has ended, and only when
  the period before it is closed, so "belongs to a closed month" always has an open period to land
  in. The first period is the month the stage is installed in, or an earlier month an admin picks.
- **Which period a source is in**: its date as above. If that period is closed, the first open
  period, in a `late` entry with `belongs_to` set. The close writes `core_finance_counted` (source
  kind, source id, period, version) for every source it counted, so a source is counted once
  across all versions of all periods; a reopen and close of the same period recounts its own.

### The reports

All amounts in minor units in the organisation's currency; a row in another currency is not
summed and is listed as an exception. Every report row carries the order ids it came from, so a
figure can be traced.

1. **Sales**: per category and per item (the line's object and record, by its title at the sale):
   sold, discounts (once stage 34's adjustments exist), refunded, net, tax inside, net of tax, and
   by day. Paid-late and mismatched payments are not sales until staff honour them; they are listed
   in Money owed. Gift cards, credit and vouchers issued are not sales: they are in Held for
   customers.
2. **Tax**: tax on sales by country and tax code; tax given back on refunds, as the provider
   reported or estimated in proportion (marked "estimate"), with the note "the payment provider's
   own tax report is the authority" (decision 6); untaxed sales beside, so the totals reconcile to
   Sales.
3. **Refunds**: each refund confirmed in the period: date, order, item, amount, how it went back
   (method), tax given back, who asked and who approved (staff names), reason (staff's words,
   redacted after an erase). Refunds requested and not yet confirmed are in Money owed.
4. **Payouts**: each payout arriving in the period: date, amount, its lines (payment, refund, fee,
   dispute, adjustment), each payment and refund line matched to its order; the provider's fees in
   total; lines matching nothing; and any difference between the payout and its lines (expected
   zero). Sales received but not yet paid out at the period's end, as one figure.
5. **Money owed to the business** (as at the period's end): balances on part-paid orders by due
   date and age (not due, 1 to 30, 31 to 60, 61 to 90, over 90 days, in business days from the due
   date); failing membership renewals and their amount due; late or mismatched payments held. Names
   and emails of who owes, for staff to chase.
6. **Owed and held for customers** (as at the period's end): refunds the host owes
   (`core_sellable_refund_due` in `due`, `asking`, `asked`) and refunds requested and not
   confirmed; gift card and account credit balances outstanding (from `rec_stored_value`, stage
   34), with what was issued, spent, refunded back, expired and voided in the period; vouchers
   valid and not redeemed. For the business to confirm with its accountant.
7. **Unearned** (as at the period's end; **for the business's accountant to confirm**): per
   category, money received for what is not yet delivered, by the category's `earned`: a
   membership period paid ahead, by days left in it; a pass, by unused classes over classes bought
   (decision 4), all of it earned when it expires, nothing once void; a ticket or drop-in whose
   event or class is after the date; and what became earned in the period. A pass given by staff or
   bought for nothing carries nothing.
8. **Members**: per plan and in total: members at the start and end (active, on trial, paused,
   failing), new (first entered active or trialing in the period), ended (by the provider's
   reason), paused and resumed, and churn (ended in the period over members at the start, a
   percentage with two places, from integers). A paused member is a member, shown apart (decision
   5). From `core_subscription_state`; a month before that history began is rebuilt from
   `created_at`, `ended_at`, `end_reason` and pause changes and says so.

### Records and operations

| Operation | Audience | Who may | Risk | Notes |
| --- | --- | --- | --- | --- |
| `finance.periods` | staff | `finance:read` | read | The current period and the last 24: state and versions only |
| `finance.report` | staff | `finance:read` | read | One report for a period (closed version or live preview) or a range (preview); audited as which report, period and version, never a figure |
| `finance.entries` | staff | `finance:read` | read | A closed version's book entries and lines, paged; Accounting sync's read |
| `finance.export` | staff | `finance:read`, a person (`humanOnly`) | read | One CSV; audited; tool runs store no output |
| `finance.close` | staff | `finance:close`, a person (`humanOnly`) | write | An ended period whose previous period is closed; one batch with its fingerprint guard; refused `finance_changed` when a counted source changed between read and batch; refused over 100,000 lines, never cut short |
| `finance.reopen` | staff | `finance:close`, a person (`humanOnly`) | write | With why (redacted from the audit log's input); every later closed period must be reopened first |
| `finance.settings.get` / `.update` | staff | `finance:read` / a human admin (`settings:manage`, `actors: ["human"]`) | read / write | The year's first month, the first period, category labels |
| `finance.payouts.sync` | host only (the daily cron) | the host | read | Reads new payouts through the gatekeeper, idempotent by the provider's payout id; a payout already counted in a closed period is never rewritten (its lines are the provider's, read once) |

None is open to customers or the public (ADR 0402).

### Notifications and events

- To `finance:close` holders: "April has ended and can be closed" (once, on the 5th of the next
  month, local); "A payout does not match its lines" (once per payout); "Something arrived for a
  closed month" (in the daily digest, not one per event).
- A record event for automations, "a period was closed", carrying the period and version and no
  figures (an admin may use it to tell the bookkeeper, or stage 61 to start a sync).

### Screens

- **Web admin**: Money → Reports: a period picker (closed periods show their version and who
  closed them), a tab per report with its table and a small chart, the trace from any figure to its
  orders, Close and Reopen (with why), Download for each report, Settings → Money. Core admin
  screens, listed only for `finance:read` holders. The screen says what it covers: money through
  the provider and payments recorded in the host, nothing else (decision 10).
- **Customers**: nothing here. What a customer sees of their own money (orders, receipts, a gift
  card's balance) is a section of My account (stage 48), owned by the stages that hold it.
- **Native staff**: none in this stage.

### What an AI may do

- **May** (decision 7): read report figures, entries and money owed for an account that holds
  `finance:read`, to answer "how much did passes bring in last month".
- **May not**, whatever is granted: close, reopen, download or send a file, or change the settings.
  `finance.export`, `.close` and `.reopen` are `humanOnly`; `finance.settings.update` is
  `actors: ["human"]`.

### Privacy and erase

- **Who sees**: `finance:read` holders only. Entries, payouts, fees and closed rows are core
  tables in no `rec_*` view, so no dashboard, `query.sql`, `export.csv` or assistant record read
  reaches them. Orders stay readable by staff with `records:read`, as today.
- **What is stored about people**: closed rows keep order ids, amounts and dates; Money owed,
  Owed and held for customers, and Refunds rows also keep a name and email so the file reads on its
  own. Book entries carry no names. No card data, no bank account numbers (the payout's destination
  is not read), no gift card codes.
- **Audit**: reads and downloads audited as which report, period and version; never a figure. A
  reopen's reason redacted.
- **Erase** (ADR 0320): the name and email in closed rows are replaced with "Erased person" in
  every version; amounts and order ids stay so totals do not change. A file already downloaded
  cannot be recalled: the screen says so. How long closed periods are kept is for the business to
  confirm with its accountant; the host keeps them until a human admin deletes a version (not built
  here).

## Out of scope

- Sending figures to an accounting system (stage 61).
- Invoices, quotes and their ageing (stage 35, #103); tax added on top of a price (#198).
- Disputes as anything but a payout line (#245 decides what a dispute does).
- Fixing dashboards' UTC day (#306): its own change in `dashboards/params.ts`, best landed before
  this stage's screens so the Memberships tile and the Sales report agree on "today".
- Money taken outside the provider until stage 34's shared step records it.
- Expenses, wages and profit (pay holds hours, not money, ADR 0627); stock value (stage 37 shows it
  at last cost).
- Multiple currencies; an accountant's own sign-in (decision 3); a native summary; scheduled
  emailing of files; PDF statements.

## Acceptance criteria

1. A fixture worked out by hand for one month: memberships charged monthly and yearly (one
   mid-month start, one upgrade, one pause, one ended for failed payment), class passes partly used
   and one expired, a drop-in refunded because the class was cancelled, a deposit with a balance
   due, a ticket for next month's event, tax on and off, a refund of a one-off payment and of a
   membership period. Every report's every figure and every entry's every line equals the hand
   figure, through the fake provider end to end.
2. Every book entry balances to the minor unit; the period's day summaries add up to the Sales,
   Tax and Refunds reports exactly.
3. Splitting is exact: for any order, the lines' shares of each payment and refund sum to it;
   Sales' net equals the sum of `rec_order.net` movements in the period.
4. The business's day: in a zone far from UTC, a payment at 00:30 local is on that local day; the
   months with a clock change have the right day boundaries; a closed period keeps its zone after
   the organisation's zone changes.
5. Something dated in a closed month (a recorded payment dated back, a payout read late) is counted
   once, in a `late` entry of the first open month marked with the month it belongs to; the closed
   month's entries and files are unchanged.
6. A closed version's entries, lines and rows cannot be updated, deleted or replaced by any
   statement, including `REPLACE`, upsert and `UPDATE OR REPLACE` (triggers tested on raw SQL); a
   period moves only `closing` → `closed` → `reopened` → `closing`.
7. A write to a counted source between the close's read and its batch fails the close whole
   (`finance_changed`); retried, it closes with the new row in it.
8. Closing is refused before the period ends and while the previous period is open; reopening is
   refused while a later period is closed.
9. Reopen and close again: version 2 is written; each entry's key is the same and its fingerprint
   changes only where its lines did; version 1's files still download byte for byte as before.
10. `finance.entries` returns only closed versions' entries; a preview's entries never appear in it.
11. CSV: every text cell quoted; a title beginning `=`, `+`, `-`, `@`, a full-width form, a tab, or
    `a;=1+1` is neutralised; a preview's first row says it is a preview.
12. Payouts: the fake provider's payouts are read once each (re-reading changes nothing); every
    payment line matches its order; a charge made at the provider directly is an unmatched line on
    its own heading; a payout whose lines do not sum to it raises one notification.
13. Money owed: ages are right across a month end and a clock change; a failing renewal shows the
    amount the provider said was due.
14. Unearned: a pass's unused classes and a membership's days ahead follow decision 4; an expired
    pass's rest is earned; a voided pass and a staff-given pass carry nothing; the screen and the
    file say the figures are for the business's accountant to confirm.
15. Members: a past month's counts are the same after later state changes; a paused member is
    counted as a member and shown apart.
16. A refund with no provider tax figure shows an estimate, marked, with the note pointing to the
    provider's tax report, in the report, the file and the entry's `tax_estimated:` heading.
17. A member, viewer or pack-role account without `finance:read` sees no Reports item and is
    refused every `finance.*` operation; with a grant, can read; only `finance:close` closes.
18. An assistant or MCP client may read reports and entries for an account with `finance:read`,
    and is refused export, close, reopen and settings whatever is granted.
19. Nothing in `rec_*` views, `query.sql` or the audit log carries a closed figure, an entry or a
    payout line.
20. Erase: a person's name is gone from every closed version's rows; totals and entries unchanged.
21. Cost: a month's report over 50,000 orders reads only the period's rows (statement-count test);
    the close of such a month finishes within the Worker's limits.
22. Once stage 34's step 3 and step 8 are built: a day paid partly by gift card and partly by card,
    a recorded cash payment, a refund back onto a gift card and a gift card sold all land on their
    headings and the day still balances.
23. E2E: one journey: an admin opens last month, checks Payouts, closes it, downloads Sales.

## Dependencies

- Built: stages 25 (orders, payments, refunds), 27 (sellable), 31a (drop-in refunds owed), 32
  (subscriptions, passes, Memberships), 42 (tax at checkout), 45 (the pay period's lock as the
  model).
- Spec agreed, not built: stage 34 (adjustments step 1, the shared step 3 with ADR 0694, gift cards
  step 8): this stage reads what they add and its step 8 waits for them. Stage 37 (Shop): its items
  declare `sellable.finance` when built. Stage 47 is not needed: these are core admin screens.
- Not built and not needed first: stage 35 (invoices) extends Money owed; #245 changes how a
  dispute line is shown; #306 fixes dashboards' day; stage 61 builds on the close and the entries.
- Needs a real provider account in test mode to prove payouts and fees (Risks).

## Migrations and numbers

Block **BN**: migrations 1150 to 1169, ADRs 0790 to 0799 (the coordinator adds the row to
[`parallel-work.md`](../parallel-work.md)). The ADRs the build will need:

| ADR | Decision | Amends |
| --- | --- | --- |
| 0790 | Finance periods: the business's day, money counted when the host recorded it, the monthly close as a versioned snapshot that never refuses a money event, late sources counted once | builds on 0627 |
| 0791 | The figures for the books: book entries, their keys, headings, balance and fingerprints; what Accounting sync reads | |
| 0792 | `sellable.finance`: categories and how a sale is earned | 0435 (dated note) |
| 0793 | Payout reads through the payments gatekeeper (read-only, the destination never read) | 0429 (dated note) |
| 0794 | `finance:read` and `finance:close`; what an AI may do with figures | 0449 (dated note) |
| 0795 | A subscription's state history and the amount due on a failing renewal | 0485 (dated note) |

| Migration | What |
| --- | --- |
| 1150 | `core_finance_period`, `core_finance_entry`, `core_finance_entry_line`, `core_finance_row`, `core_finance_counted`, and their guard triggers |
| 1151 | `core_payout`, `core_payout_line` |
| 1152 | `core_subscription_state`, `core_subscription.amount_due` |

No `core_write_guard` remake is expected; if one is needed it follows `parallel-work.md`'s
ordering rule.

## Suggested build order

| Step | What | Touches | Beside what it can run |
| --- | --- | --- | --- |
| 1 | The business's day helpers, periods, entries tables, the close, versions, reopen, triggers, permissions, settings; `csvText` shared | migration 1150 (new tables only), `packages/core/src/finance/`, `principals.ts`, `staffing/pay.ts` (one import), `packages/core/src/csv.ts` | Anything not editing `principals.ts` (stage 34 steps 1 and 3, stage 35, the till) or `staffing/pay.ts` (rostering): keep both sides of `principals.ts` |
| 2 | `sellable.finance`; the declarations in packs | `packages/sdk/src/sellable.ts`, the contract check, `packs/memberships`, `ticketing`, `courses`, `bookings` `index.ts` | Collides with stage 47 step 4 and stage 34 steps 5 and 10 (the same `packs/*/index.ts`), stage 37 (`sellable` keys) and any other sdk manifest change |
| 3 | Day summaries, Sales, Tax, Refunds, `finance.entries`, their files | `finance/` (reads `core_order*` only) | Beside steps 4 to 6; reads `orders/` without editing it, so beside stage 34 step 1 (re-check net lines when it lands) |
| 4 | Payout reads, payout entries, the Payouts report | `packages/gatekeeper-payments` (provider interface, `stripe.ts`, `fake.ts`), `gatekeeper-interface` types, the daily cron, migration 1151 | Collides with any payments gatekeeper work: stage 34 steps 6, 8 and 9, disputes (#245), invoices' payment links, stage 61's gatekeeper reads. Beside 3, 5, 6 |
| 5 | Money owed (with `amount_due` kept), Unearned | `subscriptions/events.ts`, migration 1152, `finance/` | Collides with any `subscriptions/` work (stage 34 steps 2 and 6). Needs step 2 for Unearned |
| 6 | Members (with the state history) | `subscriptions/` (the history written with each move), `finance/` | Collides with step 5 and any `subscriptions/` work; build after 5 or in the same session |
| 7 | Admin screens, notifications, the "period closed" event, e2e | `apps/app/src/routes/_app/`, `components/app-sidebar.tsx`, `lib/nav.ts`, notifications | Collides with stage 47 steps 2 and 3 (the sidebar and routes). Best after #306 |
| 8 | Payment methods and Held for customers: headings by method, stored value and vouchers in day summaries, balances in the `held` entry | `finance/` | **Waits for stage 34 step 3 (or whichever stage builds the shared step) and step 8.** Beside anything else |

**What can start first:** step 1, then steps 2, 3 and 4 together, then 5 and 6 in one session
beside 7. Step 1 collides only on `principals.ts`; step 2 on packs' `index.ts`; step 4 on the
payments gatekeeper.

## Size

**Large.** Platform-heavy (a core module, three migrations, a gatekeeper read, a manifest key, a
subscription history) with a hand-worked fixture as the proof. Up to three build sessions at once
after step 1.

## Decided by this spec, open to override

- Core module and core admin screens, not a pack.
- Money counted on the business day the host recorded it; earned shown beside it, never instead.
- The figures for the books are balanced book entries with stable keys; reports, files and
  Accounting sync all read them; nothing works them out twice.
- Entries carry headings, never account codes; mapping is stage 61's.
- Refunds sit in the day summary of the day they were confirmed, and each is also listed in
  Refunds; there is no separate entry per refund.
- Gift cards, credit and vouchers issued are held for customers, not sales; what they pay for is a
  sale on the day it is paid, with its method. For the business to confirm with its accountant.
- Discounts reduce sales (net lines); the Sales report shows them beside.
- Late sources are tracked in the finance tables (`core_finance_counted`), not on order rows.
- A closed month never refuses a money event; closing in order; previews of any range.
- One CSV per report; no zip, no PDF, no scheduled email.
- Payouts, entries and closed rows in no `rec_*` view; the payout's bank destination never read.
- Churn is members ended in the month over members at its start.
- Money owed is aged from the due date in business days.
- Members before the state history began are rebuilt from start and end dates and marked so.
- One currency; a row in another is listed apart.
- The financial year's first month is a setting used only to add months into a year.

## Questions for the owner

None. The two facts the draft asked about (how figures reach the accountant today, and money
taken other ways) are checked with the business at setup (decisions 9 and 10).

## For the business to confirm with its accountant

- Whether the books are kept on cash as it moved (what the entries are) or adjusted for what is
  earned (the Unearned report is offered for that).
- How a pass, a membership period paid ahead, a deposit and a ticket for a later event are treated.
- How gift cards, account credit and vouchers are treated, when they are taxed (stage 34's choice
  per gift card type), and what happens to a balance at expiry.
- Whether the estimated tax on a one-off refund or the provider's tax report is used for the
  return.
- How long closed periods and files must be kept.

## Risks

- **Money and correctness**: a wrong split or rounding is a wrong figure sent to an accountant.
  Integer splits that sum exactly, balanced entries and the hand-worked fixture mitigate it; the
  first real month must still be checked against the provider's own reports by a person.
- **Payout matching on the real provider**: the payment reference stored is the payment's; payout
  lines carry the provider's balance records. Whether every line (subscription invoices, credit
  notes, checkout with tax) resolves to a stored reference must be checked on a **real test-mode
  account**; the fake cannot prove it. `payment_ref` may be null on some rows today: those lines
  are unmatched until fixed. Fees and currency conversion are only real there.
- **Refund tax** is an estimate where the provider gives none; the provider's tax report stays the
  authority.
- **Day boundaries**: until #306 ships, a dashboard's "today" and this stage's day differ for a
  business far from UTC; the screens should not sit side by side before then.
- **Members before the history**: months before step 6 ships are rebuilt and less exact; marked.
- **Money outside the provider** is invisible until stage 34's shared step records it; the screen
  says what it covers.
- **Privacy**: names in the files leave the host when downloaded; erase cannot follow them. Who may
  download is a human admin's grant.
- **Security**: a new outbound read to the provider runs in the gatekeeper with its key; no new
  write path to the provider. The CSV guard covers every text cell, including titles staff typed.
- **Scale**: the close is one batch; a busy month writes a hundred lines to a statement, as ADR
  0627, with a cost test.
- **Needs a real client**: the first gym's accountant to say whether the files are what they need,
  before stage close-out.
