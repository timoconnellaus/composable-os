# @composable-os/gatekeeper-accounting

The accounting contract (stage 61, [ADR 0880](../../docs/adr/0880-the-accounting-contract.md)):
what every accounting gatekeeper serves, whatever system keeps the books. Not a gatekeeper of its
own. Each system is its own Worker (`packages/gatekeeper-accounting-<system>`) built on this.

| File | What |
| --- | --- |
| `src/types.d.ts` | `AccountingSession` and its inputs, served to agents as the resource's types |
| `src/validate.ts` | The hand-written input checks (ADR 0114) and the contract's limits |
| `src/refusal.ts` | `refuse(code, …)` and `refusalCode(message)`: why a write was refused, nothing written |
| `src/apply.ts` | `applyWrite`: the books' currency and lock date first, a reference never written twice, a void only of the host's own document |
| `src/describe.ts` | What a person reads before a write goes |
| `src/session.ts` | `AccountingGatekeeper`, the facet a gatekeeper extends: observations, journalled actions (`accounting.contact`, `accounting.post` auto-approvable; `accounting.void` never) |
| `src/system.ts` | `AccountingSystem`, what a gatekeeper implements to talk to its books |
| `src/fake.ts` | `FakeBooks`: invented books in one plain state, with failures a test can ask for |
| `src/conformance.ts` | The suite every implementation passes |
| `src/direct.ts` | The session's rules without a Worker, to run the suite against a system object |
| `src/fake-worker.ts`, `wrangler.fake.jsonc` | `cos-gatekeeper-accounting-fake`, development and tests only, never released |

## A new accounting system

1. A package `packages/gatekeeper-accounting-<system>` with its own `wrangler.jsonc`,
   `deploy-inputs.json` (its secrets, set by a person) and a catalogue entry with
   `implements: "accounting"`.
2. Implement `AccountingSystem` against the system's API: store the host's `reference` where
   `findByReference` finds it again; throw `refuse(code, …)` when nothing was written and
   `ActionOutcomeUnknownError` when it may have been.
3. Extend `AccountingGatekeeper` with its `system()` and `resourceUrl()`.
4. Pass the conformance suite: in tests against a stand-in of the system's API, and by hand against
   a test organisation with a person's account (`runConformance(target, { run })`; it writes real
   entries there, so never against a business's books). Record the run in the package's README.

## The fake books

In tests, run the suite in memory (`directSession(new FakeBooks())`) or through the fake gatekeeper.
In development the CRM's dev server binds the fake to cos-runner as `GATEKEEPER_ACCOUNTING_FAKE`:
connect **Fake books (development)** for the org in Settings → Integrations and bind
`accounting-fake://books/<name>`. cos-runner's tests reach its controls (`FakeBooksControl`) as
`TEST_ACCOUNTING_BOOKS`: reset a set of books, lock them, make the next write fail, take them down
(`setUnavailable`: every read and write refused `unavailable`, nothing written, as an outage), make
their reference search lag (`setLookupLag`: each reference written is missed by its next n
look-ups), make the next write hang (`hangNext`), count how many times a reference was written, add
the bookkeeper's own payments and invoices.

The contract promises read after write: once a write is applied, `findByReference` finds it on the
next call (ADR 0880, as amended 2026-11-26; checked by the conformance suite). A system whose search
lags reads the record by its own key or keeps the reference until the search catches up. The facet
keeps each applied write's books ref for the host (`appliedRef`). A gatekeeper's refusal words never
carry a request's or response's headers, body or credentials.
