# ADR 0791: The figures for the books: book entries, their keys, headings, balance and fingerprints

Status: accepted, 2026-11-24 (stage 52, build step 1: the shape and the tables; the entries
themselves are written by steps 3, 4 and 8). Builds on ADR
[0790](0790-finance-periods-the-business-day-and-the-monthly-close.md). Migration 1150.

## Context
Stage 52 owns every figure for the books; Accounting sync (stage 61) sends them to an accounting
system and never works them out again. The reports, the CSV files and the sync must read the same
rows, or two sets of figures would disagree. A reopened and closed-again month must let the sync see
at once which figures changed.

## Decision

A month's close writes **book entries** (`core_finance_entry`) with their **lines**
(`core_finance_entry_line`), into the version being closed (`packages/core/src/finance/entries.ts`):

- **Kinds and keys**: one `day` entry per business day (`day:2026-04-03`: sales by kind of sale and
  tax, refunds, money in by method, gift cards and credit issued and spent), one `payout` entry per
  payout (`payout:<the provider's payout id>`), one `held` entry at the month's end (`held:2026-04`:
  gift card and credit balances), and one `late` entry per day something arrived for a closed month
  (`late:2026-04@2026-05-06`, with `belongs_to`). A key is the same in every version. An entry's
  date is local (ADR 0790).
- **A line** has a heading in the host's words, never an account code, a side (`debit`, `credit`)
  and an amount in whole minor units above zero (a line of nothing is dropped), plus the tax code
  and country where it is tax, the method where it is money in or out, and the category where it is
  a sale. **Headings**: `sales:<category>`, `refunds:<category>`, `tax:<code>:<country>`,
  `tax_estimated:<code>:<country>` (a refund's tax the provider did not report, decision 6),
  `money_in:provider`, `money_in:recorded:<kind>`, `money_out:<method>`, `held:gift_card`,
  `held:credit`, `held:voucher`, `credit_given`, `held_expired`, `fees:provider`, `bank`,
  `disputes`, `adjustments`, `unmatched`. Stage 34's payment methods add theirs when its step 3
  lands; nothing else adds a heading without amending this ADR.
- **Every entry balances**: its debits equal its credits, to the minor unit. An entry that does not,
  or with an unknown heading, a key that does not fit its kind and date, or a fractional amount, is
  a fault in the host's own figures: the close refuses it (`finance_entry`) rather than store it.
- **A fingerprint**: SHA-256 of the entry's lines in a fixed order, so lines made in any order give
  the same fingerprint, and a later version's entry with the same key and lines has the same one.
- **What the sync reads**: `finance.entries` (step 3, `finance:read`) lists a closed version's
  entries and lines; a preview's entries are never offered. On a reopen and a new close the sync
  compares keys and fingerprints: changed, added, dropped. How it reverses and posts them is
  stage 61's.
- **What is not an entry**: Unearned and Members are reports only. Entries are money as it moved.
  An entry names nobody.

## Why
- One set of rows read by reports, files and sync cannot disagree with itself.
- Headings rather than account codes keep the mapping to a chart of accounts stage 61's.
- Stable keys plus fingerprints let a reader diff versions without recomputing anything.

## Proof
`packages/core/test/finance-periods.test.ts`: balance to the minor unit, unknown headings, keys and
fractional amounts refused; fingerprints independent of order and changed by one minor unit; a
version 2 whose unchanged entry keeps its fingerprint and whose changed entry does not, version 1
unchanged.
