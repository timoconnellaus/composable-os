# ADR 0793: Payout reads through the payments gatekeeper, kept once as the provider reported them

Status: accepted, 2026-11-26 (stage 52, build step 4; decision 8 of the spec). Builds on ADRs
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md) (the payments gatekeeper),
[0790](0790-finance-periods-the-business-day-and-the-monthly-close.md) (the close, late sources),
[0791](0791-the-figures-for-the-books-book-entries.md) (book entries, headings) and
[0796](0796-day-summaries-and-the-first-reports.md) (the day summaries). Amends 0429 (dated note).
Migration 1151.

## Context
A business ties what landed in its bank to what it sold: each payout the payment provider sends is
made of payments, refunds, disputes, adjustments and the provider's fees. The host had no payout
or fee read: the gatekeeper took checkouts, refunds and verified events only. Stage 61 (Accounting
sync, step 5) posts each payout as a transfer and reads this stage's payouts as written. Money
must be neither invented nor dropped, a payout must never be rewritten, and the read must be
bounded in the minute cron, whose idle cost is tested.

## Decision

**Two read-only gatekeeper calls, the host's own.** The payments gatekeeper's session gains
`listPayouts({ since, after })` (payouts arriving on or after a day, 100 a page, newest first, with
a cursor) and `payoutLines({ payoutRef, after })` (what one payout settled, 100 a page), on the
provider interface, Stripe and the fake. Both record an observation, move nothing, and are refused
on any queue but the host's own orders call (`callAsHost`, purpose `orders`): Code Mode, an
extension's tool, MCP and the assistant cannot read payouts through the gatekeeper; staff read
them as finance figures, with `finance:read`. A payout is its provider id, amount, currency,
arrival day, status, creation moment and whether it is itemised; a line is its provider id, kind
(`payment`, `refund`, `dispute`, `adjustment`, `fee`), amount (signed, before the fee), fee,
currency, the payment reference the host stores and a refund's own reference. **The bank
destination is never read**: Stripe's payout `destination` is not mapped or expanded, and of a
balance transaction's expanded source only the payment intent and the refund id are passed on (a
charge carries billing details).

- **Stripe**: `GET /v1/payouts?arrival_date[gte]=` and `GET /v1/balance_transactions?payout=` with
  `expand[]=data.source`, the account's default API version. A line's kind is its
  `reporting_category` (`charge` a payment, `refund`, `dispute` and `dispute_reversal` a dispute,
  `fee` a fee, `payout` left out as the payout's own, anything else an adjustment). Only an
  automatic payout can be itemised (Stripe lists balance transactions by payout for those only); a
  manual payout is recorded with no lines. A key that may not read them (HTTP 403: a
  restricted key needs **Payouts: read** and **Balance: read**, and Charges and Disputes read for
  the expansion) is answered `{ unavailable: true, reason }`, never thrown; a full secret key reads
  them, so a business connected with one need not reconnect.
- **The fake**: payouts of the ledger's paid checkouts, subscription invoice payments and refunds,
  each settled once, with a development fee of 1.75% and 30 minor units per payment; a test adds a
  dispute, an adjustment or a charge the host never saw, skews a payout so its lines do not sum, makes
  one by hand (no lines), fails one after it arrived, or turns the reads unavailable or failing
  (`FakePaymentsControl`, a service binding only: no route reads the ledger). Development pays out,
  on a first page read, everything settled before today.

**Kept once, as the provider reported them** (migration 1151): `core_payout` (recorded when it has
arrived, `paid`, with every line read; its line count and lines' net checked against the lines by
a trigger), `core_payout_line` (written as its pages are read, before its payout is recorded, once
each by the provider's id, never after), `core_payout_failure` (a recorded payout the provider
later reports failed or cancelled, on the business day the host saw it). Every insert is
conditional on the provider's id and every table refuses an update, a delete, a replace and an
upsert, so reading the same payouts again, a retried run and two runs at once record nothing twice,
and nothing the provider says later rewrites a recorded payout: a failure is a correction of its own.
A difference between a payout and its lines is the provider's: shown, told, never adjusted.

**The daily read** (`finance.payouts.sync`, the host's step in the minute cron, `hostStep`,
automation only, `risk: write` because it writes the host's copy and its marker). `core_payout_sync`
holds, per provider, the pass in progress (from which arrival day, the provider's page cursor, the
payout whose lines are being read), the day the pass started and whether it finished, the state
(`ok`, `unavailable`, `failing`) and `next_at`. A pass reads from 14 days before the last pass's day
(late arrivals and a bank's return of a payout are re-read; a first pass reads from the first month
finance counts, less 14 days). A run makes at most 20 provider calls; what it leaves, the next
minute carries on from the marker, so a year of payouts is read over many minutes and a payout of
thousands of lines over several. A quiet minute reads the marker by its key (before the first
read, whether a payment account is bound) and calls nothing. A pass runs from the business's 06:00.
A refusal marks the connection `unavailable` until the next day (the Payouts preview says payouts
are not available for this connection); a failure is retried after 15 minutes, an hour, six hours,
then daily, keeping its place; neither stops the cron's other steps.

**Matched when the figures are worked out, not when read** (`finance/payouts.ts`): a payment line
to the provider payment the host stored with that reference (`core_order_payment`, method
`provider`, by a new partial index), a refund line to the refund the provider confirmed with that
reference (`core_order_refund.provider_refund_ref`). Each payment or refund is settled by one line;
a second claim, and every line with no match, is listed and carried on `unmatched`. A dispute is
traced to the payment it disputes and carried on `disputes`; it never settles anything. A payment
whose event reached the host after its payout matches then; a closed version keeps the match it was
closed with.

**In the books** (ADR 0791): one `payout` entry per payout on its arrival day
(`payout:<the provider's id>`): `bank` and `fees:provider` (the lines' fees, and fee lines) against
matched payments on `money_in:provider`, matched refunds on `money_out:provider`, `disputes`,
`adjustments`, and on `unmatched` what matched nothing and any difference between the payout and
its lines; a side flips with its sign, so it balances by construction. A failure is its own
`payout` entry on the day it was seen (`payout:<id>:failed`): `bank` back against `adjustments`
(the money returns to the balance and comes back in a later payout as an adjustment). A payout or
failure dated in a closed month that no closed version counted is counted in the first open month's
`late` entry for that month (`late:<month>@<first day>`, merged with the late day lines), its rows
marked `belongsTo`; the closed month never changes. Sources counted: `payout` and `payout_failure`,
by `<provider>:<id>`. The close guards the payouts, failures and matches it read.

**The Payouts report** (`finance.report`, `report: "payouts"`; its file through `finance.export`):
per payout arriving in the span, its amount, payments, refunds, disputes, adjustments, what matches
nothing, fees, lines' net and difference (expected zero), and its orders; per line, its kind, amount,
fee, net and what it matched (payment or refund, and order); failures after arrival; payouts in
another currency apart, summed nowhere; and **not yet paid out**: the provider's payments the host
received in the 92 days before the span's end, less its refunds confirmed then, that no payout
arriving by the span's end settled, with the sources it came from. A payment recorded by hand (a
transfer, cash, stage 34's `recorded`) never reaches the provider: it is in no payout and not in
this figure. Staff only, `finance:read`; the assistant reads it for an account that holds it; the
file is a person's.

**Told once.** A payout whose lines do not sum to it (or a payout made by hand, which lists none)
notifies the human admins and the accounts granted `finance:close`, once per payout (its dedupe
key), when it is recorded.

## Why
- Reading through the gatekeeper keeps the provider's key there; the host's own queue keeps payout
  figures out of every surface but the finance operations, where `finance:read` governs them.
- Keeping the provider's report as it was, by its own ids, makes re-reading safe and a correction
  visible; matching at report time lets late webhooks match without editing what was read.
- A marker and a call cap make a new connection's year of history and a busy day's payout cost the
  same per minute, and an idle day one call.

## Proof
- `packages/core/test/finance-payouts.test.ts`: April by hand (two payments, a late payment never
  honoured, a refund, a charge made at the provider, a dispute with its fee, an adjustment; a payout
  whose lines do not sum; one paid out in May; one in transit): every Payouts figure and line,
  every payment and refund in exactly one payout or not yet paid out, a transfer recorded by hand in
  neither; two runs at once and a second day's read record nothing again; the mismatch told once;
  the entries balanced, line by line; every write path refused on raw SQL; the provider reporting a
  new amount rewrites nothing; a payout arriving in closed April read in May is May's late entry,
  April's entries and file unchanged; a failure after arrival a new entry; a refused read noted in
  the report and retried next day; a failing provider retried after 15 minutes; a member refused,
  the assistant reading.
- `packages/core/test/finance-payouts-backlog.test.ts`: a year of payouts and one of 250 lines read
  over many runs of at most 20 calls each, every payout and line once; the next day one call.
- `packages/gatekeeper-payments/__tests__/payouts.test.ts`: the fake's payouts (each payment once,
  fees, paging, no bank account), host only, refusals and failures; Stripe's mapping, paging and
  expansion, 403 as unavailable, 503 thrown.
- `apps/runner/test/finance-payouts.test.ts`: through the real gatekeeper and the minute cron, a
  backlog over many minutes with at most 20 calls and a bounded number of statements each and no
  table scan; a quiet minute one keyed read; the next day one call; a failing provider retried
  while the other steps run. `idle-minute-cost.test.ts` passes with its budgets unchanged.

## Consequences
- **Not proved against a real provider.** Whether every Stripe balance transaction (subscription
  invoices, credit notes, checkout with tax, Terminal) resolves to a reference the host stored must
  be checked on a test-mode account (`docs/payments-stripe-runbook.md`); `payment_ref` may be null on
  some rows, and such lines are unmatched until it is fixed. Fees and currency conversion are only
  real there.
- "Not yet paid out" looks back 92 days: a provider payment still not paid out after that drops out
  of the figure (it is not normal; the provider's own balance report is the authority). A payment
  in a payout that later failed counts as paid out; the failure shows beside it.
- A failure is noticed by the payout's status within the 14 days each pass re-reads, and at any
  time by the reversal line that pays its money again (amended below).
- Stage 61 step 5 reads `core_payout` (id, arrival day, amount), `core_payout_line` (amount, fee,
  kind, references) and `core_payout_failure`, or the closed `payout` entries; a payout whose
  `lines_net` differs from its `amount` is the one to hold.
- Disputes are only a payout line here (#245 decides what a dispute does).

## Amended 2026-11-26 (the review of PR #474, before merge)
Migration 1151 was edited in place (unmerged). Where this section and the text above differ, this
section holds.

- **No payout lost to an outage.** A pass reads from 14 days before `last_ok_date`, the day of the
  last pass that read everything (a new account: the first month finance counts), not the last
  pass attempted. A key without the permission, one that lists payouts but not their lines
  (Payouts: read without Balance: read), or a refused key, for any length of time, is read in full
  once it works again, over as many runs as the 20-call cap needs. The review proved the loss
  (40 daily payouts during an outage, 15 recorded); `finance-payouts-outage.test.ts` now records
  all 40, and fails with the old start.
- **A revoked key is a failure, not "unavailable".** Only Stripe's 403 (the key lacks the
  permission) is answered `unavailable`, with the scopes to add. A 401 (revoked, expired or wrong)
  is thrown as "the connection needs attention": the sync is `failing`, keeps its place, retries,
  and the report says the connection needs attention. The gatekeeper answers a provider's failure
  as `{ failed }` rather than throwing it over RPC (a thrown error left unhandled rejections on
  the hops); the host treats it as a failure.
- **Failed payouts, whenever they fail.** Stripe's `payout_failure` balance transaction
  (`reporting_category` `payout_reversal`, its source the failed payout) is a line of its own kind,
  `payout_reversal`, with `reversalOf`. When the sync reads one: the failed payout, if recorded,
  gets its failure (however long after it arrived); if never recorded (it failed before it
  arrived, or before it was read), it is read with its lines and recorded `failed` (arrival day:
  the reversal's day), with its failure, so the payments it settled are explained and leave "not
  yet paid out". Its money, paid again, is the reversal line on `adjustments`, against the
  failure's `adjustments` debit: the bank shows what landed (the review's example: 25,000 that fails
  and is paid again shows 25,000, not 50,000). A payout listed as `failed` or `canceled` within the
  lookback is handled the same way. `core_payout.status` is `paid` or `failed`.
- **Matching only what the books counted.** A payment line matches a provider payment the books
  counted (applied, or a late payment staff honoured), for the amount and currency the host
  recorded; a refund line a confirmed refund, likewise. Anything else is carried on `unmatched`,
  its row naming the reason: `no_record`, `not_counted` (a late or mismatched payment never
  honoured, a refund not confirmed), `amount_differs`, `currency_differs`, `already_settled` (a
  second claim). "Not yet paid out" counts only what the books counted. The late payment in the
  April fixture is now an unmatched line.
- **The difference has a heading of its own**, `payout_difference` (ADR 0791 amended), so it is
  never mistaken for lines matching nothing in the entries Accounting sync sends.
- **A page cursor that does not move** fails the run (`failing`, "the provider answered a page
  cursor that did not move"), so no run calls without end; the fake refuses a cursor it does not
  know rather than answering page one again.
- **One history per account.** `core_payout_sync` is keyed by provider and account (the
  connection and the resource it binds). Another account starts from its own first month; the
  marker of an account no longer bound is retired (a `next_at` of 9999-12-31), so it is not due
  every minute; a switch is picked up when the old marker is next due (within a day).
- **A month closed while the read is behind says so.** What the read says of itself (refused,
  failing, part-way through a backlog or pending reads) is a `note` row of the Payouts report: in a
  preview as it is now, in a closed version as it was when the month closed.
- **Older money counted.** Beside "not yet paid out", the provider's counted payments and
  confirmed refunds older than the 92-day window and still in no payout are counted (a number and a
  total, one aggregate read over those older index entries).
- **A line in another currency than its payout's** matches nothing (`currency_differs`).
- **A line the gatekeeper cannot read** is counted, never dropped silently: the gatekeeper counts
  each balance transaction it cannot map (the payout's own excepted) in the page's `unreadable`, the
  host adds lines it cannot read, and the payout keeps the number (`unreadable_lines`), shown on its
  row and in the mismatch notice (which a payout with any is sent).
- **The close's size.** A closed version keeps one row per payout and the lines that matched
  nothing, as they stood; a matched line stays in `core_payout_line` and is read from there by the
  closed report (a recorded line never changes, and a match cannot: it settles a payment the books
  counted or a confirmed refund, for its amount). So a month's rows grow with its payouts and
  exceptions, not with every line, and a month of 60,000 provider transactions closes. A month
  whose rows still pass `MAX_CLOSE_LINES` (100,000 unmatched lines) is refused, plainly
  (`finance_too_large`: "This month holds more than 100,000 lines, rows or payments, the most one
  close writes, so it was not closed"), never cut short.
- **Not detected**: a provider changing a recorded payout other than by failing it (Stripe does not
  change a paid payout's amount). The arrival day stays the provider's calendar day; that it is
  always 00:00 UTC is for the test-mode run to confirm (runbook section 10).
- The mismatch notice stays readable to a `finance:read` holder's assistant: it holds business
  figures, not a person's (the coordinator's decision).
- Proof added: `finance-payouts-outage.test.ts` (each outage, the close while failing, the stuck
  cursor, the account switch), `finance-payouts-failures.test.ts` (a failure 21 days after arrival
  and one before arrival through reversal lines, the bank at what landed, every match rule, unreadable
  lines, older money), the gatekeeper's 401 and reversal and unknown-cursor cases, and
  `apps/runner/test/finance-payouts-real-path.test.ts` (a checkout and a subscription period paid on
  the fake's own pages and a refund confirmed by webhook, paid out by the fake's defaults, every line
  matched by the references the host stored).
