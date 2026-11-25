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
  manual payout is recorded with no lines. A key that may not read them (HTTP 401 or 403: a
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
- A failure is noticed only while its payout is within the 14 days each pass re-reads.
- Stage 61 step 5 reads `core_payout` (id, arrival day, amount), `core_payout_line` (amount, fee,
  kind, references) and `core_payout_failure`, or the closed `payout` entries; a payout whose
  `lines_net` differs from its `amount` is the one to hold.
- Disputes are only a payout line here (#245 decides what a dispute does).
