# ADR 0880: The accounting contract: one typed session, a Worker per system, a shared fake and conformance suite

Status: accepted, 2026-11-24 (stage 61 build, step 1). Builds on ADRs
[0007](0007-integrations-are-gatekeepers.md), [0050](0050-integration-host-and-connections.md),
[0111](0111-outbound-actions-in-the-approval-queue.md),
[0114](0114-own-gatekeepers-pickers-and-host-modules.md) and
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md) (payments, the provider-neutral
precedent). Spec: [stage 61](../stages/61-accounting-sync.md).

## Context
Stage 61 sends the host's money to a business's books. The first system is Xero (decision 1), but
core must never name a system, and the classic failure of any sync to the books is posting twice.
Payments put every provider behind one interface in one Worker; accounting systems each need their
own sign-in, app credentials and review, so that shape does not fit them.

## Decision

**One contract, `AccountingSession`, in `packages/gatekeeper-accounting`.** Reads are
observations: `describeBooks` (name, base currency, lock date, whether prices include tax),
`listAccounts` (ref, code, name, contract type, archived; never a bank account number),
`listTaxRates` (in hundredths of a percent), `findContacts` (every key given must match; at most
10), `documentStatus` (for documents the host posted: status, amount due, and payments in the books
the host did not send; at most 100 refs) and `findByReference`. Writes are journalled outbound
actions with `claimBeforeApply`: `upsertContact` (kind `accounting.contact`); `postSummary`,
`postTransfer`, `postInvoice`, `postCreditNote`, `postPayment` and `postRefund`
(`accounting.post`); `voidDocument` (`accounting.void`). Amounts are integers in minor units of the
books' base currency, signed debit-positive in a summary, whose lines must sum to zero; dates are
`YYYY-MM-DD`. There is **no delete and no edit of a posted entry**: the session serves exactly
these fourteen methods (`ACCOUNTING_SESSION_METHODS`).

**Every write carries the host's reference** (`cos:<kind>:<id>[:<n>]`, at most 100 characters),
and a system stores it where `findByReference` finds it again.

**The rules are shared, not each system's** (`apply.ts`, `applyWrite`). When a write is applied
the books are read first: another currency than the books' base currency is refused (`invalid`),
a date on or before the lock date is refused (`locked_period`), nothing written. A reference
already in the books writes nothing and answers that record's ref, so a write sent again after an
uncertain outcome, or after a crash between the books' answer and the host recording it, is never
written twice. A void applies only to a document `findByReference` finds under the reference the
void names, with the same ref: a record the host did not write, or an entry that is not a
document, is refused. A system (`AccountingSystem`, `system.ts`) only talks to its books.

**Refusals carry a reason code** at the front of the message, `[accounting:<code>] ` (RPC carries
an error's message, not its class): `unmapped`, `locked_period`, `invalid`, `duplicate_number`,
`contact_archived`, `rate_limited`, `unavailable`; `rate_limited` and `unavailable` are transient.
A refusal means nothing was written. Any failure after the books were reached is
`ActionOutcomeUnknownError`: the host looks the reference up before anything is sent again. The
facet's apply failures keep payments' `[apply-outcome:<refused|unknown|retryable>] ` tag in front,
which core's `parseApplyOutcome` reads; `refusalCode` finds the code behind it.

**Contacts and entries are auto-approvable; a void never is.** The host's outbox (stage 61 step 4)
does the approving, one day at a time, so each send is not its own approval; a void takes a
document out of the books' totals and always waits for a person.

**The shared session and facet** (`session.ts`, `AccountingGatekeeper`) check every input by hand
(ADR 0114: no decorators), record each read as an observation, describe each write to a person
(`describe.ts`: the books, the date, every line with its account and amount, the reference),
journal it and apply it through `applyWrite`. A gatekeeper extends it with its `system()` and its
resource URL. The action set's fence is `none`: every write is checked against the books again at
apply, so an action does not depend on the credentials it was submitted under. A system whose
reconnect can change which books a connection reaches (one sign-in can reach several Xero
organisations) re-reads them before writing; step 8 records how.

**A Worker per system.** Each accounting system is its own gatekeeper Worker,
`packages/gatekeeper-accounting-<system>`, with its own secrets, installed only where it is used;
the catalogue marks it `implements: "accounting"`. Core imports the contract's types, codes and
checks from `@composable-os/gatekeeper-accounting` and never names a system.

**A fake and a conformance suite every implementation passes.** `FakeBooks` (`fake.ts`) keeps
invented accounts, tax rates, contacts, documents and a lock date in one plain state object; it
refuses what real books refuse and lets a test make its next write fail: refused, an answer lost
with nothing written, or an answer lost after the write. It counts how many times each reference
was written. `conformance.ts` (`CONFORMANCE_CHECKS`, `runConformance`) runs every read and write,
the reference stored and found, no second write, no delete, a void only of the host's own and only
once approved, another currency and a locked day refused, against any target: the fake in memory
(`directSession`), the fake gatekeeper through its session, and, by hand with a person's account,
a real system against a test organisation (it writes real entries there, referenced
`cos:conformance:<run>:…`). Checks that need the fake's controls are skipped without them.

**The fake gatekeeper is never released.** `cos-gatekeeper-accounting-fake` (vendor
`accounting-fake`, catalogue `devOnly`) has its config in `wrangler.fake.jsonc`, which no release
reads; only the CRM's dev server and cos-runner's tests run it, bound as
`GATEKEEPER_ACCOUNTING_FAKE` (and its controls as `TEST_ACCOUNTING_BOOKS` in tests). Each resource,
`accounting-fake://books/<name>`, is its own set of books in its own Durable Object.

## Consequences
- Every write costs the system a read of the books and a look-up by reference before it is sent.
  For a system with tight request limits (Xero's are confirmed in step 8) the gatekeeper may cache
  the books' settings, never the look-up.
- Duplicate document numbers are the books' rule: the fake refuses one, and the suite checks it only
  against the fake; a real system reports `duplicate_number` only where its books refuse.
- The host's own path to the books (`callAsHost`, purpose `accounting`), `accounting.void` always
  reviewed whatever the policy, and the rule that no other caller reaches an accounting resource
  are step 3 (ADR 0881). Until then the fake is reachable like any dev-only gatekeeper.
- A receipt names the books' ref only when the write was applied within the call; the host's own
  call applies after the call returns, so the outbox finds the ref by reference.
