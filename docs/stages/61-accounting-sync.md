# Stage 61: Accounting sync

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md) (Gatekeeper, Connection, Integration host, Outbound action, Order,
Refund, Tax code, Permission grant, Erase), [`docs/integrations.md`](../integrations.md); ADRs
[0007](../adr/0007-integrations-are-gatekeepers.md),
[0050](../adr/0050-integration-host-and-connections.md),
[0051](../adr/0051-outbound-approvals.md),
[0110](../adr/0110-integration-host-per-connection.md),
[0111](../adr/0111-outbound-actions-in-the-approval-queue.md),
[0114](../adr/0114-own-gatekeepers-pickers-and-host-modules.md),
[0151](../adr/0151-provider-keys-as-workers-secrets-or-byok.md) (secrets never in D1),
[0169](../adr/0169-gatekeepers-in-releases.md) and
[0452](../adr/0452-gatekeeper-settings-in-product-ts.md) (gatekeeper secrets set by a person, never
in `product.ts`), [0170](../adr/0170-automation-run-as-bindings.md),
[0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
[0429](../adr/0429-payments-gatekeeper-verified-events-and-refunds.md) (`callAsHost`; payments as
the provider-neutral precedent), [0449](../adr/0449-permissions-granted-one-by-one.md),
[0479](../adr/0479-tax-at-checkout.md),
[0627](../adr/0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md) (a lock, versions
and a reopen); `packages/gatekeeper-payments/src/`, `packages/core/src/integrations/`,
`apps/runner/src/integrations/host.ts`; the specs of stage 34
([`34-offers.md`](34-offers.md), "An order paid another way") and, when they land, stage 35
(Invoices and quotes) and stage 52 (Finance reports), both specced in parallel.

Status: **spec agreed** (owner interviewed 2026-11-24: decisions 1 to 8). Build may start with
steps 1 to 4 and 8; summaries wait for stage 52, documents for stage 35.

## Status

- **Step 1** — built — PR #338 — The contract, fake and conformance suite: `packages/gatekeeper-accounting`,
  the fake in the runner, `implements` in the catalogue.

- **Step 2** — built — PR #361 — Core records, settings, mapping, `accounting:manage`
  (`feat/stage-61-accounting-core`, migration 1330, no ADR): the core tables
  `core_accounting_settings`, `_map`, `_link`, `_post`, `_item` and `_match`, guarded by triggers
  against every form of write, `UPDATE OR REPLACE` included (a post's id and reference never change;
  a sent or skipped post never changes but for an erase clearing its `detail`, and is never deleted;
  one being sent or of unknown outcome moves only as its outcome allows; a reference is queued once,
  a link is unique both ways, an item once per source, one open question per bill-to; the start date
  is fixed in the database once a post to those books may be in them); `accounting:manage` (admins,
  grantable, never a pack role's); `packages/core/src/accounting/settings.ts` and
  `accounting.settings.get`, `accounting.settings.update` (a human admin: the books, the start date,
  fixed once a post to these books is sent, being sent or of unknown outcome, approval of 14 to 365
  days and `restartApproval`, which starts the count again (an update writes only what it changes,
  so a day counted meanwhile is kept), the settle delay of 1 to 14 days, on or off: on needs the
  books, an active connection and a start date; the books change only while off) and
  `accounting.map.set`, `accounting.map.clear` (a person, per connection). Left for later steps:
  `accounting.options` and checking a mapped ref against the books' live lists and base currency
  (they need purpose `accounting`, step 3); every other operation, the runner and the screens.

- **Step 3** — built — PR #425 — The host path (`feat/stage-61-host-path`, ADR 0881, no migration): `callAsHost` purpose
  `accounting` (core `IntegrationRuntime`, the integration host and its queue): the system user's
  session on the books, its contacts and entries applied at once unless the deploy-time floor
  denies them, its writes in the outbound audit as the system's (`system.accounting`), never read
  by the outbound check; `accounting.void` in `ALWAYS_REVIEWED_KINDS` (`ACCOUNTING_VOID_KINDS`),
  approved only by a human admin (`integrations:manage`; `accounting:manage` is step 2's, see
  ADR 0881); the host-only rule: the integration host opens a session on a connection whose
  gatekeeper `implements: "accounting"` (`keepsBooks`) only for that purpose and that purpose only
  on books, so `integration.call` (refused first, `forbidden` with rule `accounting_host_only`),
  the host's `call` (Code Mode's and an extension's `codemode:<gatekeeper>`) and `openSession` are
  refused for every caller; `integration.types` still reads the contract's types. Tests:
  `apps/runner/test/accounting-host-path.test.ts`.

- **Step 4** — in progress — branch `feat/stage-61-outbox-runner` — The outbox runner
  (migration 1332, ADR 0882): `queuePost` (`accounting/outbox.ts`: an entry once by its reference,
  the mapping's keys and its dependency's books ref resolved when sent, nothing before the start
  date, `awaiting_approval` until approval is over) and the runner (`accounting/runner.ts`, the
  minute cron's `runAccountingDue`: claimed before it is sent and recorded after; an uncertain
  outcome or a claim left `sending` ten minutes looked up by reference before anything is sent
  again; refusals held with their reason, transient ones retried after 1, 5, 30 minutes, 2 and 12
  hours, sending paused meanwhile; the books unreachable touch nothing; dependencies wait, are held
  behind a held or skipped one and released when it is sent; dated past the books' lock with the
  real date in the text; blocked by an inactive connection or another currency, told once; told
  once when approval ends; the daily pass from 02:00 in the organisation's zone with step 5's
  builders, seven days a run; at most 25 sends and 25 look-ups a run), `accounting.approveDay`,
  `accounting.post.retry` and `accounting.post.skip` (a person with `accounting:manage`), and the
  fake books' outage control (`setUnavailable`). `accounting.run` is host code, not an operation
  (ADR 0882). Tests: `apps/runner/test/accounting-outbox*.test.ts`, `accounting-approval.test.ts`.

- **Step 5** — not built — needs: step 4, stage 52 — Summaries and payouts: daily, late events, the
  reopen adjustment, transfers (needs stage 52's figures, close and payouts).

- **Step 6** — not built — needs: step 4, stage 35, stage 34 step 3 — Contacts, documents, paid in the
  books (migration 1331).

- **Step 7** — not built — needs: step 4 — Admin screens, notifications, e2e, the site.

- **Step 8** — not built — needs: step 1, a person with a Xero test organisation — The Xero gatekeeper.

- **Step 9** — not built — needs: step 5, step 6 — Erase, merge, retention (last).

**This is not accounting or tax advice.** The host sends what it recorded to the accounts a person
chose. Which accounts and tax rates, and how a figure is treated, are for the business to confirm
with its accountant. The setup screen says so.

## Goal

A business connects its accounting system once, and a person chooses which of its accounts and
tax rates each kind of sale, refund, fee and payout goes to. From then on the host sends its money
to the books on its own: card sales, refunds and tax as one summary per day; each payout from the
payment provider as its own transfer to the bank, with the provider's fees as an expense; and, once
invoicing exists, each invoice, payment and credit note as its own document under the right
customer, matched to the contact already in the books instead of a duplicate. For the first two
weeks a person approves each day before it goes. Nothing is sent twice, nothing is sent into a
period the books have locked, and nothing already in the books is changed or deleted, only put
right by a new entry. When something cannot be sent, it waits in a short list for a person, and the
rest carries on. The bookkeeper stops typing the month in by hand.

The first connection is to **Xero** (decision 1). Core never names it: it speaks one accounting
contract, and Xero is the first gatekeeper that implements it.

## Who it is for

- **Gyms and studios, first.** Their money is many small card payments (memberships, passes,
  drop-ins, tickets, courses), so what the books need is **totals, not customers**: sales and tax
  per day per category, refunds, the provider's fees, and each payout matched to the bank line it
  lands as. Customers are not named in the books. Occasional invoices (a company paying for staff
  passes, room hire) go as documents once stage 35 exists.
- **Trades and services (the next vertical).** Their money is **invoices**: a deposit invoice,
  progress and final invoices, part payments by transfer or card machine, credit notes. The books
  need each invoice under its customer (often a business), each payment against it, and the contact
  matched to the one the bookkeeper already has. They also need to know when an invoice was marked
  paid in the books (a transfer seen in the bank feed) and not yet here. Jobs (stage 39) later give
  an invoice its job reference, sent as text.
- **What both share:** a person sets every account and tax rate; a locked period is respected; a
  failure holds only what it touches; credentials are a person's, never an AI's.

How the first client's figures get into its books today (who enters them, how often, in what
form) is not known. It is checked with the business at setup (below, "Setting up the first
client"); nothing in the design waits on it.

## What exists today (from the code)

| Piece | Where | What this stage uses |
| --- | --- | --- |
| Gatekeepers: Workers that mediate one outside service; accounts, resources, sessions, journalled outbound actions with kinds, simulation | `packages/gatekeeper-interface/src/gatekeeper.ts` (vendored), `packages/gatekeeper-kit/src/` (`actions.ts`, `action-journal.ts`, `credentials.ts`, `oauth-client.ts`, `credential-expiry.ts`) | The contract's session runs on these unchanged |
| A provider-neutral gatekeeper with a provider behind one interface, plus a fake | `packages/gatekeeper-payments/src/provider.ts` (`PaymentProvider`), `stripe.ts`, `fake.ts`, `worker.ts` | The model for the contract, the fake and the action descriptions |
| OAuth gatekeepers with client id and secret as Worker secrets | `packages/gatekeeper-google/deploy-inputs.json`, `packages/gatekeeper-microsoft/` | The shape of the Xero gatekeeper's secrets and sign-in |
| The catalogue of shipped gatekeepers, enabled per deployment | `packages/core/src/integrations/catalogue.ts` (`CatalogueEntry`) | Gains "implements accounting" |
| One integration host per connection; the connect handoff; credentials expiry mirrored | `apps/runner/src/integrations/host.ts` (`startConnect`, `redeem`, `credentialsChanged`), `apps/runner/src/integrations/runtime.ts`; ADR 0110 | The connect flow, as is |
| The host calling a gatekeeper as itself | `callAsHost` in `packages/core/src/integrations/runtime.ts`, purposes `orders`, `sign-in`, `agreements`; `hostMessage` makes a call apply unless the floor denies (`outbound.ts`) | A new purpose `accounting` |
| Kinds always reviewed whatever the policy | `ALWAYS_REVIEWED_KINDS` (today `payments.refund`) in `packages/core/src/integrations/outbound.ts` | `accounting.void` joins it |
| Orders, payments, refunds, tax, one currency per deployment, integer minor units | `packages/core/src/orders/`, `packages/core/src/currencies.ts`, migrations `0421_orders.sql`, `0422_order_payments.sql`, `0516_order_tax.sql` | The source of every figure, read through stage 52's figures |
| The duplicate finder's name keys | `packages/core/src/duplicates/normalise.ts` (`personNameKey`, `organisationNameKey`) | Contact matching by name |
| Erase and merge | `packages/core/src/records/erase.ts`, `person.merge` in `packages/core/src/operations/person.ts` | Links removed on erase, re-pointed on merge |

Not built, specced or being specced: **stage 52** (Finance reports: report categories, per-period
figures, the monthly close and reopen, payouts and their lines read from the provider), **stage 35**
(invoices, credit notes, recorded payments, `invoices:payments`), and stage 34's shared step **an
order paid another way** (`applyOtherPayment`, `method` and `recorded_kind` on a payment, ADR 0694
or the block of whichever stage builds it first).

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | **The first connection is to Xero.** The design is one contract any accounting system can implement; Xero's gatekeeper is the first and the only one built in this stage. How the first client's figures get into its books today is not known and is checked with the business at setup |
| 2 | **Card sales go as one summary for each day**, by kind of sale and tax, and **each payout to the bank is its own entry** |
| 3 | **Each invoice goes on its own**, under the right customer, with each payment and credit note against it |
| 4 | **A person approves each day for the first two weeks**, then entries go automatically |
| 5 | **When the bookkeeper marks an invoice paid in the books and nobody recorded it here**, the staff who handle payments are told, and they record it here with one press. Nothing is marked paid here by itself |
| 6 | **On first connecting, nothing before a start date the business chooses is sent** |
| 7 | **A late refund dated inside a locked period is sent on the first day the books are open**, with its real date in the description |
| 8 | **When a customer might already exist in the books but the match is unsure**, a person chooses one of the possible matches or creates a new customer |

## The design in one page

- **One gatekeeper contract, many accounting systems.** The contract (`AccountingSession`) is a
  small, typed session every accounting gatekeeper implements: read the books' accounts, tax
  rates, lock date and contacts; post a summary, a transfer, a contact, an invoice, a payment, a
  credit note or a refund; void only what it posted. Each accounting system is its own gatekeeper
  Worker, installed only where it is used, with its own credentials. The first is
  `packages/gatekeeper-accounting-xero`. They share one package (`packages/gatekeeper-accounting`)
  holding the contract's types, input validation, the action descriptions, a **fake accounting
  system** and a **conformance suite** every implementation must pass. Core speaks only the
  contract and never names a system.
- **Core owns the sync, not a pack** (`packages/core/src/accounting/`). Everything it sends is core
  (orders, refunds, payouts, invoices), and the rules (what is sent, once, to which account) are the
  host's. No pack hooks a write; no pack adds anything.
- **It sends stage 52's figures; it does not work them out again.** A day's sales by category and
  tax, its refunds and each payout's lines come from Finance reports' functions. This stage adds no
  figure of its own except the rounding line that makes an entry balance.
- **An outbox in the host.** Every entry to send is a row (`core_accounting_post`) built by host
  code from host records, with a fixed reference (`cos:<kind>:<source id>:<n>`). A runner sends rows
  through the accounting connection with `callAsHost` (purpose `accounting`), records the books'
  reference, and never sends a row twice: an uncertain outcome is resolved by looking the reference
  up in the books before any resend.
- **Two shapes of entry, by source:**
  - **a daily summary** for card sales through the provider: one entry per day, per category and
    tax rate, sales and refunds against a **clearing account**, no customer named (decision 2);
  - **documents** for invoices (stage 35): each invoice, payment, credit note and void as its own
    document under the matched contact (decision 3);
  - and **each payout** as its own transfer from the clearing account to the bank, with the
    provider's fees as an expense, so the books' bank line reconciles to it (decision 2).
- **A person sets the mapping.** Each category, each tax code, fees, the clearing account, the bank
  account for payouts, each recorded-payment method's account and a rounding account are chosen by
  a person with `accounting:manage` from the books' own lists, read live through the gatekeeper. A
  day with anything unmapped is held, never guessed.
- **Two weeks of approval, then automatic** (decision 4). The first fourteen days' entries wait as
  one batch per day for a person to approve; after the fourteenth approved day they go on their
  own. A void always waits for a person.
- **Locks are respected twice.** The books' lock date is read before each run: nothing is ever
  dated on or before it; an entry that would be is dated the first open day, with its real date in
  the text (decision 7). Stage 52's closed month is never re-sent: a reopen and re-close that
  changes a figure sends the difference as a new, dated adjustment.
- **A start date** (decision 6): nothing dated before it is sent, ever.
- **Failures hold only what they touch.** Transient errors retry with backoff; an error a person
  must fix (a mapping, a contact, a refusal) holds that row and what depends on it (a payment waits
  for its invoice), and the rest carries on. One daily notice lists what is held.
- **Credentials are a person's.** The Xero app's client id and secret are Worker secrets set by a
  person at deploy; the business's consent is a human admin connecting in Settings → Integrations.
  The tokens stay in the gatekeeper. An AI cannot connect, map, turn on, approve, retry, skip or
  void.
- **The accounting connection is the host's alone.** It is not callable through `integration.call`,
  Code Mode or an extension's `ctx.gatekeeper`: only `accounting.*` operations and the runner use
  it. So no AI and no extension can write to the books.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **One Worker with every system behind it** (as payments does) | Payments has one provider and a deployment-wide key. Accounting systems each need their own sign-in, app credentials and review. Separate Workers keep each system's secrets and code apart and installable one by one; the shared package keeps one contract and one fake |
| **Sending through the generic MCP gatekeeper** to an accounting system's own server | Untyped tools, no idempotency guarantee, no conformance, and the host could not refuse a delete. The contract is the point |
| **Each card sale as its own entry** under one "card customer" contact (offered at question 2) | Thousands of tiny entries a month for a gym, and fees still need a summary. Not built, not a setting |
| **One summary per closed month only** (offered at question 2; stage 52's first sketch) | Simple, but the bookkeeper waits a month and ticks payouts off against nothing. Not a setting: the daily summary and the reopen adjustment cover a closed month |
| **Invoices folded into the daily summary** (offered at question 3) | The books would not show who owes what. Not a setting |
| **Sending automatically from the first day**, or **approving every day for ever** (offered at question 4) | The first days are when a wrong account choice is caught; after that, approving every day is a chore people stop doing properly (decision 4) |
| **Each send as its own outbound action a person approves** | Dozens of approvals a day for entries the host composed from its own records. The approval is one per day, in the outbox |
| **Marking an invoice paid here when the books say paid** (offered at question 5) | Could release passes or places on another system's word. ADR 0427 and stage 34: an order is paid only by a verified payment or a person recording one |
| **Sending everything since the business started using the host** (offered at question 6) | The bookkeeper has usually entered past months by hand; sending them again counts the money twice |
| **Holding a late entry for a locked period until a person decides** (offered at question 7) | Leaves the books incomplete until someone acts. Nothing is written inside the lock either way |
| **Always creating a new customer, or taking the closest name** (offered at question 8) | Duplicates in the books, or the wrong customer: two businesses with similar names are common |
| **Pulling invoices from the accounting system** | Stage 35 makes the host the source; two masters for one invoice is the duplicate problem this stage exists to avoid. Reads from the books are limited to statuses, the lock date, accounts, tax rates and contacts |
| **Editing or deleting an entry once it is in the books** | The books may be locked or already reconciled; changing history there is the accountant's call. The host only adds entries |
| **A pack** ("Accounting pack") | Everything read is core and spans every pack; the rules would sit outside the host |

## Platform work and pack work

| Piece | Kind | What |
| --- | --- | --- |
| The accounting contract, validation, descriptions, fake, conformance suite | **Platform** (new package) | `packages/gatekeeper-accounting/`: `AccountingSession` types, hand-written input validation (as ADR 0114's own gatekeepers), the fake books (accounts, tax rates, contacts, documents, a lock date, injectable failures and uncertain outcomes), `conformance.ts` |
| The Xero gatekeeper | **Platform** (new gatekeeper) | `packages/gatekeeper-accounting-xero/`: OAuth sign-in and choosing the organisation, its API mapped to the contract, `deploy-inputs.json` (`CLIENT_ID`, `CLIENT_SECRET`), README; passes the conformance suite against a Xero demo or test organisation |
| Catalogue: "implements accounting" | **Platform** | `CatalogueEntry` gains `implements?: "accounting"`; Settings → Integrations shows such entries under Accounting; at most one active accounting connection per deployment |
| `callAsHost` purpose `accounting` | **Platform** (integrations) | `runtime.ts`, `host.ts`, `queue.ts`: the host's call applies unless the floor denies (as `orders`); `accounting.void` in `ALWAYS_REVIEWED_KINDS` |
| The accounting connection closed to every other caller | **Platform** (integrations) | `IntegrationHost.call`, `codemode:<gatekeeper>` and `integration.call` refuse a resource of an `implements: "accounting"` gatekeeper (`accounting_host_only`) |
| `accounting` core module: settings, mapping, links, outbox, runner, contacts, read-back | **Platform** (new) | `packages/core/src/accounting/`, operations in `operations/accounting.ts`, migrations (new tables only; no `core_write_guard` kind) |
| A core permission | **Platform** | `accounting:manage` (`principals.ts`): admins by default, granted one by one (ADR 0449); never to a pack role |
| Seams stage 52 and stage 35 expose | **Platform** (in their stages) | Stage 52: per-day figures, the close and reopen events, payouts and their lines. Stage 35: an append-only document event log (below) |
| Admin screens | **Platform** (core admin) | Money → Accounting, beside stage 52's Money → Reports |
| Pack work | **None** | A pack's report category (stage 52) is the only thing a pack contributes, and it exists by then |

No new behaviour. No pack hooks a write.

## The model

### The contract (`AccountingSession`)

All amounts are integers in minor units in the books' base currency; connecting books whose base
currency is not the deployment's is refused. Every write carries the host's `reference`; a
gatekeeper must store it on the system's record (a reference field, a note, or the system's own
idempotency key) so that `findByReference` finds it.

Reads (observations):
- `describeBooks()` → name, base currency, lock date or none, whether prices are stored with or
  without tax.
- `listAccounts()` → ref, code, name, type (`revenue`, `expense`, `bank`, `current_asset`,
  `current_liability`, `equity`, `other`), archived. Never a bank account number.
- `listTaxRates()` → ref, name, rate in hundredths of a percent, archived.
- `findContacts({ reference?, email?, taxNumber?, name? })` → at most 10 candidates (ref, name,
  email, tax number, archived).
- `documentStatus(refs[])` → for documents it posted: status (`open`, `paid`, `part_paid`, `void`),
  amount due, and payments recorded in the books that the host did not send.
- `findByReference(reference)` → the record the host posted with it, or none.

Outbound actions (journalled, simulated, `claimBeforeApply: true`, each with a description a person
can read):

| Action | Kind | What |
| --- | --- | --- |
| `upsertContact` | `accounting.contact` | Create a contact, or update the name, email, address and tax number of one the host linked |
| `postSummary` | `accounting.post` | A dated entry with balanced lines (account, tax rate, net, tax, text); a contact only where the system needs one |
| `postTransfer` | `accounting.post` | A payout: clearing to bank, with fee lines to the fees account |
| `postInvoice`, `postCreditNote` | `accounting.post` | A document with its number, dates, contact and lines (account, tax rate, quantity, unit price, net, tax) |
| `postPayment`, `postRefund` | `accounting.post` | Money against one posted document, into or out of a mapped account |
| `voidDocument` | `accounting.void` | Voids a document the host posted (its reference starts `cos:`); refused for anything else |

The contract has **no delete and no edit of a posted entry**, and refuses a void of a record whose
reference the host did not write. `accounting.contact` and `accounting.post` are auto-approvable
(the outbox does the approving, below); `accounting.void` is not, and is always reviewed.

A gatekeeper reports `ActionApplyError` (refused, nothing written, with a reason code: `unmapped`,
`locked_period`, `invalid`, `duplicate_number`, `contact_archived`, `rate_limited`, `unavailable`)
or `ActionOutcomeUnknownError` (it may have gone through), as payments does.

### The Xero gatekeeper (decision 1)

- **The app registration**, made once by a person on the platform's side: its client id and secret,
  declared in `deploy-inputs.json`, set as Worker secrets by a person (`wrangler secret put` or the
  installer's `--secret`); `cos deploy` names each missing one and never prints a value (ADR 0452).
  Its sign-in return address is `https://<host>/gatekeeper/accounting-xero/oauth`, added to the
  app's list of return addresses by a person for each host, as for the other OAuth gatekeepers.
- **The business's consent**: a human admin enables the gatekeeper and connects it (an org
  connection) in Settings → Integrations, signs in to Xero in the popup, and chooses which
  organisation (one sign-in can reach several) in the gatekeeper's picker. Tokens are held by the
  gatekeeper's account (`gatekeeper-kit` credentials, Durable Object storage), never in D1, the
  audit log or a response. Refreshing them is the gatekeeper's; an expired or revoked grant marks
  the connection expired (`credentialsChanged`), holds every row and tells the admins.
- **How it meets the contract** is the build's to confirm against Xero's own developer
  documentation and a demo or test organisation, and its README records each: how the reference is
  stored and found again (a reference field and, where offered, an idempotency key), which entry
  type carries the daily summary and the transfer (a journal where there is no sales-summary type),
  how the lock date is read, its request-rate and daily limits and how the runner stays inside them,
  page sizes, and any limit on how many organisations an app may connect before it is approved by
  Xero. A limit that affects the platform's plans is reported to the owner, not worked around.
- **No key-based path** in this gatekeeper. The contract allows one (a key typed only in the
  configurator's own screen, as the webhook secret, ADR 0113) for a later system.

### Records

- **Settings** (`core_accounting_settings`, one row; human admin, `actors: ["human"]`): the
  connection and books resource; the **start date** (decision 6; required before turning on);
  **approval**: `approved_days` (count) and `approve_until` (the number of approved days after
  which sending is automatic, 14 by default, decision 4); the settle delay (2 days by default); on
  or off.
- **Mapping** (`core_accounting_map`; `accounting:manage`, human only): `kind` (`category`, `tax`,
  `fees`, `clearing`, `bank` for payouts, `method` for each recorded-payment kind, `rounding`,
  `refunds`, `invoice_default`), the host key (a category key, a tax code or stage 35's rate key, a
  `recorded_kind`, or none), the books' ref and its name as read. Changing a mapping affects only
  rows not yet sent; the change is audited and shown on the log.
- **Link** (`core_accounting_link`): a host object and id (Person, Organisation, invoice, credit
  note, payment, payout, summary) to the books' ref; unique both ways per connection.
- **Post** (`core_accounting_post`): the outbox row: kind, source (kind and id), the date it
  carries and the date it belongs to, the lines as sent (amounts, mapping refs), reference,
  `depends_on` (another post), state, attempts, next attempt, last error code and text, the books'
  ref once sent, who approved and when, who skipped and why. Lines are kept so a log entry shows
  exactly what was sent.
- **Item** (`core_accounting_item`): each money event to the post it went in, unique by source, so
  nothing is counted in two days and order tables are not altered.
- **Contact match** (`core_accounting_match`): a bill-to waiting for a person, with its candidates.
- **Paid in the books** (`core_accounting_readback`): a payment the books show on an invoice the
  host posted that the host did not send, until a person records it or dismisses it.

### States of a post

`queued` → `sending` → `sent`; or → `retrying` (transient: `rate_limited`, `unavailable`; backoff
1, 5 and 30 minutes, 2 and 12 hours, then `held`) → `sending`; or → `held` (a person must act:
`unmapped`, `invalid`, `contact_archived`, `duplicate_number`, a contact to match); or
`awaiting_approval` (in the first two weeks, until the day is approved); or `unknown` (outcome
unknown: the next run calls `findByReference`; found → `sent` with its ref; not found → `queued`,
never resent before the look-up); or `skipped` (a person, with why: never sent; a skipped summary's
money is listed on the log as not in the books). A post that depends on a held one is `held` with
"waits for …".

### Approval for the first two weeks (decision 4)

- From the first day sent, each day's posts (that day's summary, transfers, contacts and
  documents) are `awaiting_approval`. Money → Accounting shows the day's batch: each entry as it
  will appear in the books, with its accounts by name. A person with `accounting:manage` approves
  the day (`accounting.approveDay`), and its posts become `queued`.
- **Two weeks means fourteen approved days**, not fourteen calendar days: a day nobody approved
  does not count, so the books never go automatic unchecked. After the fourteenth, sending is
  automatic and the admins are told once ("entries now go to the books without approval").
- A human admin may set the number higher or put approval back on (`accounting.settings.update`),
  for example after changing accounting systems. A day not approved after three days is in the
  daily digest. Nothing in the batch is sent until the whole day is approved; a person may skip one
  entry in it (with why) first.
- A void is always reviewed, before and after the two weeks (the outbound approval queue, ADR 0111).

### Summaries (card sales, decision 2)

- **Daily.** At 02:00 in the organisation's zone, the runner builds day D − settle delay (so a day
  is sent once its late webhooks have arrived), from stage 52's per-day figures: one `postSummary`
  for the day: per category, revenue net of tax to the category's account; tax per tax code to the
  mapped tax rate; refunds confirmed that day to the refunds account; the total to the clearing
  account. Before sending, lines are checked to balance and to equal stage 52's Sales and Refunds
  for the day; a rounding difference (at most one minor unit per line) goes to the rounding
  account; anything more holds the day.
- **Late events.** An event whose moment is in a day already sent (a webhook three days late, a
  late refund) goes into the next day not yet built, with "belongs to D" in its line text. This is
  stage 52's own rule for a closed month, at day size.
- **Locked periods** (decision 7). If the day an entry would carry is on or before the books' lock
  date, it carries the first open day and its text says "dated 12 March, the books are locked to
  31 March". Nothing is ever dated inside the lock.
- **A reopened month.** When stage 52 reopens a closed month and closes it again with a different
  figure, the host compares the new version's totals with what it sent for that month's days and
  sends one adjustment for the difference, dated the first open day of the books, text "adjustment
  to April, version 2". Nothing sent is changed.
- **Payouts.** Each payout stage 52 reads (`core_payout` and its lines) becomes one `postTransfer`
  on its arrival date: clearing to the payout bank account for the amount paid out, fees and fee
  refunds to the fees account, disputes and adjustments as their own lines against the clearing
  account, listed for the bookkeeper. A payout whose lines do not sum to it is held.

### The start date (decision 6)

- Set by a human admin before turning the sync on; nothing dated before it is ever sent.
- A day before the start date is not built. A late event that belongs before it is not sent (the
  log lists it as "before the start date").
- The first payouts after it may carry money from sales before it. They are sent in full; Setup
  shows the amount in transit at the start date (from stage 52's payouts and sales) so the
  bookkeeper can enter it as the clearing account's opening balance. How to enter it is for the
  business to confirm with its accountant.
- An invoice issued before the start date is not sent, and neither are its payments or credit
  notes; the log lists it, so the bookkeeper knows it lives in the books by hand already.

### Documents (invoices, from stage 35, decision 3)

- On **issue** of an invoice (not on draft): its contact first (below), then `postInvoice` with its
  number, issue and due dates, lines (a price-list line to its category's account, a typed line to
  `invoice_default`), tax by the mapping of stage 35's rate key, totals as the host worked them out.
- Each **payment** on its order → `postPayment` against it: a provider payment into the clearing
  account (it arrives in a payout); a recorded payment (stage 34's `recorded_kind`: transfer, cash,
  cheque, card machine, other) into the account mapped for that kind. A reversal → a payment out of
  the same account. Depends on the invoice's post.
- A **credit note** → `postCreditNote`; its refund, once confirmed, → `postRefund`. A **void** →
  `voidDocument`, always approved by a person.
- Dates in a locked period move as summaries do (decision 7).

### Paid in the books (decision 5)

- Twice a day the runner calls `documentStatus` for the open invoices the host posted. A payment
  in the books that the host did not send becomes a `core_accounting_readback` row.
- It is shown to staff with `invoices:payments` (stage 35's permission for recording a payment) on
  the invoice ("paid in the books on 3 May, 450.00") and in their daily digest. **One press** opens
  `invoice.recordPayment` filled in (amount, date, kind transfer, the books' reference), which the
  person confirms. Nothing is applied by itself (ADR 0427; stage 34's second door is human only).
- The payment the person records is linked to the books' payment and is not sent back. A person
  may dismiss the row (with why) when the books are wrong.

### Contacts without duplicates (decision 8)

Only for documents. For each bill-to (an Organisation, or a Person), in order:

1. A link already held → use it (and update the books' contact if the name, email, address or tax
   number changed since it was sent).
2. `findContacts({ reference: "cos:<object>:<id>" })` (a contact the host made earlier, link lost).
3. Exactly one candidate with the same tax number, or the same email → link it.
4. Candidates by name (the duplicate finder's name keys), or several by email → **a person
   chooses** in Match contacts: one of them, or "create new". The invoice waits (`held`).
5. No candidate at all → `upsertContact` creates one, referenced `cos:<object>:<id>`.

An archived candidate is never linked by itself. A **merge** in the host re-points links to the
survivor; if both had different contacts in the books, the pair is listed for a person ("two
contacts in the books for one customer"), never merged in the books by the host.

### Operations

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `accounting.settings.get` | staff | `accounting:manage` | read |
| `accounting.settings.update` (on and off, start date, approval) | staff | human admin (`settings:manage`, `actors: ["human"]`) | write |
| `accounting.options` (the books' accounts, tax rates, lock date, read live) | staff | `accounting:manage` | read |
| `accounting.map.set`, `accounting.map.clear` | staff | `accounting:manage`, human only | write |
| `accounting.log` (posts by day, state, what was sent), `accounting.issues` | staff | `accounting:manage`; `finance:read` (stage 52) reads the log | read |
| `accounting.approveDay` | staff | `accounting:manage`, human only | write |
| `accounting.post.retry`, `accounting.post.skip` (with why) | staff | `accounting:manage`, human only | write |
| `accounting.contacts.pending`, `accounting.contact.match` | staff | `accounting:manage`, human only | read / write |
| `accounting.paidInBooks.list`, `accounting.paidInBooks.dismiss` (with why) | staff | `invoices:payments` (stage 35), human only for dismiss | read / write |
| `accounting.void.request` | staff | `accounting:manage`, human only; the void itself is the gatekeeper's always-reviewed action | outbound |
| `accounting.run`, `accounting.readBack` | host (the cron, `automation` actor) | the host | write |

None is open to customers or the public (ADR 0402). No operation here writes to an order, a
payment, a refund, an invoice or a subscription; recording a payment is stage 35's own operation.

### Seams with stage 52 and stage 35

- **Stage 52 (Finance reports)** exposes: (a) a per-day figure function in its module, with the same
  categories and tax split as Sales, Tax and Refunds, and its "reported in" rule callable for
  day-sized buckets; (b) record events "a period was closed" and "reopened", with period and
  version; (c) `core_payout` and `core_payout_line`, read by the host (not in `rec_*`). This stage
  writes none of its tables.
- **Stage 35 (Invoices and quotes)** exposes an append-only **document event log**
  (`core_invoice_event`: seq, invoice or credit note, `issued`, `payment_applied`,
  `payment_reversed`, `credited`, `voided`, the payment id, the method) written in the same batch as
  each event, so this stage reads by cursor and never edits `invoices/` or `orders/`. Also: stage
  35's rate key on each line, and the bill-to as printed.
- Where the other spec, once agreed, names these differently, the build follows that spec and
  notes it here.

### Screens

- **Web admin** (core screens, Money → Accounting, shown only to `accounting:manage` and, for the
  log, `finance:read`): Connect (links to Settings → Integrations); Setup (the mapping, every row
  chosen from the books' own lists, each missing one marked; the start date and the amount in
  transit at it; approval); Today's batch, while approval is on; Log (each day and document, what
  was sent, the books' reference, state); Issues (held rows with the reason in plain words and what
  to do: map, match, retry, skip); Match contacts.
- **Staff on an invoice** (stage 35's screen): "In the books" with its state, and "paid in the
  books" with Record.
- **Customers**: nothing. Nothing about this module is a section or an attention kind in My
  account (stage 48). **Staff native**: none in this stage. These are core admin screens, not a
  pack's (stage 47 is for packs' screens).

### Notifications

To `accounting:manage` holders: a daily digest when anything is held or a day waits for approval
(counts by reason, a link); at once when the connection's credentials expire or the books' base
currency or lock date blocks everything; once when sending turns automatic; once when a payout does
not sum. To `invoices:payments` holders: in the daily digest, invoices paid in the books and not
here. The digest uses today's notices; when Notifications (stage 30) is built it rides on it.

### What an AI may do

- **May**: read the log and the issues for a person who holds the right, and explain in plain words
  why a day is held and what to choose.
- **May not**, whatever is granted: connect or disconnect, set credentials, change settings or the
  mapping, approve a day, match a contact, retry, skip, request a void, record or dismiss a payment
  found in the books, or reach the accounting connection through `integration.call`, Code Mode or an
  extension. These are `actors: ["human"]`, admin settings, or refused by the host-only rule. No
  preset loosens them.

### Privacy, audit and erase

- **What leaves**: summaries and transfers carry amounts, categories, tax and dates, no customer.
  Documents carry the bill-to's name, email, address and tax number and the invoice's lines; Setup
  says so, and a human admin turns the sync on.
- **Who sees**: `accounting:manage` and, for the log, `finance:read`. Posts, links and matches are
  in no `rec_*` view, `query.sql`, export or search.
- **Audit**: every settings and mapping change, approval, skip (with why), retry, match, dismissal
  and void request, with ids and amounts; never a token, a secret or the books' contact details in
  full. Each send is audited as the host's, with the post id and outcome.
- **Erase**: the host deletes its links, matches and read-back rows for the person and keeps posts
  with the person removed (amounts and ids stay, so the log adds up). The contact and documents
  already in the books are **not** deleted or changed by the host; the erase result says "a copy
  remains in the accounting system", and the person is listed for staff to deal with there. Whether
  and how long the books may keep it is for the business to confirm with its accountant or lawyer.
- **Retention**: posts as long as their stage 52 periods are kept; read-back rows 90 days after
  they are recorded or dismissed.

### Setting up the first client

Checked with the business when it is connected, by the person setting it up, not asked of the
owner now: who enters the figures in the books today, how often and in what form; which accounts
and tax rates they use for each kind of sale; whether the books are locked and to when; the start
date; for a trades business, how many customers are already in the books and whether the
bookkeeper matches payments from the bank feed there. The answers set the mapping and the start
date; none changes the design.

## Out of scope

- Importing anything from the books but statuses, the lock date, accounts, tax rates and contacts
  (no bank feed, no invoices made there, no bills or expenses).
- Wages and pay (stage 58 and the pay periods, ADR 0627), stock and the cost of goods (stage 37),
  gift card and credit balances (stage 34) beyond mapping their category.
- Marking a bank deposit as reconciled in the books: the bookkeeper ticks the transfer off there.
- More than one accounting connection per deployment, several currencies, tracking categories or
  departments in the books.
- A second accounting system: the contract allows it; each is its own small stage.
- Staff native screens; scheduled files to the accountant (stage 52's files stay).

## Acceptance criteria

1. The conformance suite passes against the fake: every read and action, the reference stored and
   found, no delete, a void of a record not referenced `cos:` refused, a wrong currency refused.
2. With no mapping, a day is `held` with "map Passes to an account"; once mapped it sends; a mapping
   change affects only rows not yet sent.
3. Daily: a fixture day (memberships, passes, a drop-in refunded, two tax codes, tax off on one
   sale) sends one balanced summary whose lines equal stage 52's Sales and Refunds for that day to
   the minor unit.
4. A payment whose moment is in a day already sent goes into the next day built, marked "belongs
   to"; the sent day is unchanged; no event is counted twice (unique item).
5. A reopen and re-close of a month that changes a figure sends one adjustment for the difference
   and changes nothing sent.
6. A payout becomes one transfer whose bank and fee lines sum to it; one that does not sum is held.
7. Idempotency: the fake answering "outcome unknown" then holding the record → the next run finds
   it by reference and marks it sent; never sent twice (counted at the fake). A retry after a crash
   between send and record sends nothing new.
8. Transient errors retry on the schedule and then hold; a held invoice holds its payment; an
   unrelated day still sends.
9. Lock date: a late refund dated on or before the books' lock date is sent on the first open day
   with its real date in the text; nothing is ever dated inside the lock.
10. Start date: no day, event, payout line, invoice or payment dated before it is sent; the amount
    in transit at it is shown on Setup.
11. Approval: for the first fourteen approved days nothing is sent until a person with
    `accounting:manage` approves the day; a day not approved does not count; after the fourteenth,
    days send without review and the admins are told once; a void always waits for a person.
12. Contacts: an exact tax number or email links; a name-only or several candidates wait in Match
    contacts; none creates one; an archived candidate is never linked by itself; a merge re-points
    the link; twenty invoices for one new customer create one contact.
13. An invoice issued, part paid by transfer, part by card, credited and its refund confirmed sends
    an invoice, two payments, a credit note and a refund, each depending on the first.
14. Paid in the books: a payment recorded in the fake's books shows on the invoice and in the
    digest of `invoices:payments` holders; the order is unchanged until a person records it with
    one press; then nothing is sent back.
15. An AI actor, an MCP client and an extension are refused every write operation here, and
    `integration.call` or `codemode` on the accounting resource is refused for every caller
    (`accounting_host_only`).
16. Credentials: no token or secret appears in any D1 row, audit row or response (read every table,
    as ADR 0151's test); an expired connection holds every row and tells the admins once.
17. A member, viewer or pack-role account without `accounting:manage` sees no Accounting item and
    is refused; a grant opens it; the log is readable with `finance:read`.
18. Erase: the person's links go, posts keep amounts without the person, the result names the copy
    in the books.
19. Cost: a day's build and send read a bounded number of rows (statement-count test); a busy day
    (5,000 payments) builds one entry within the Worker's limits.
20. The Xero gatekeeper passes the conformance suite against a demo or test organisation (by hand,
    with a person's account; recorded in its README).
21. E2E: one journey: an admin maps the fake books, approves a day of sales and it is sent, a held
    day is fixed and retried, the log shows both.

## Dependencies

- **Built**: stage 6 (integrations, the integration host, the catalogue, outbound actions), stage 25
  (orders, payments, refunds, `callAsHost`), tax at checkout (ADR 0479), stage 16 (the name keys).
- **Not built, needed**: **stage 52** (Finance reports): its categories, per-day figures, close and
  payouts; summaries and transfers cannot be built without it. **Stage 35** (Invoices and quotes)
  and stage 34's shared "an order paid another way": documents, contacts and paid in the books
  cannot be built without them. Summaries ship first.
- **Not needed**: stage 47 (these are core admin screens), stage 30 (the digest uses today's
  notices), stage 39 (an invoice's job reference is text when it exists).
- **Needs a person**: the Xero app registration and its secrets, a Xero demo or test organisation
  for the conformance run, and each host's return address added to the app.

## Migrations and numbers

Block **BW** in [`parallel-work.md`](../parallel-work.md): migrations 1330–1349, ADRs 0880–0889.

- Migration 1330: `core_accounting_settings`, `core_accounting_map`, `core_accounting_link`,
  `core_accounting_post`, `core_accounting_item`, `core_accounting_match` (step 2).
- Migration 1331: `core_accounting_readback` (step 6).
- New tables only; no `x_*` table and no `core_write_guard` kind; the permission `accounting:manage`
  is code in `principals.ts`.

ADRs the build writes:

1. **ADR 0880**: the accounting contract: one typed session, a Worker per system, the shared fake
   and conformance suite, no delete, voids only of the host's own (step 1).
2. **ADR 0881**: the accounting connection is the host's alone: purpose `accounting`, the host-only
   rule, voids always reviewed, `accounting:manage` (step 3).
3. **ADR 0882**: the outbox: references, once only, uncertain outcomes, holds and dependencies, the
   lock date, the start date, two weeks of approval then automatic (step 4).
4. **ADR 0883**: what is sent: a daily summary through a clearing account, each payout as a
   transfer, the reopen adjustment; sends stage 52's figures (step 5). Amends stage 52's ADR on
   the close with a dated note if it says "a closed version only".
5. **ADR 0884**: documents, contacts without duplicates, and paid in the books suggested, never
   applied (step 6). Cites ADR 0427 and stage 34's ADR for the second door.
6. **ADR 0885**: the Xero gatekeeper: how it meets the contract and its limits (step 8).
7. **ADR 0886**: erase, merge and retention for accounting (step 9).

## Suggested build order

| Step | What | Files and areas | Beside what (collides with) |
| --- | --- | --- | --- |
| 1 | **The contract, fake and conformance suite** | `packages/gatekeeper-accounting/` (new), the fake bound in the runner for dev and tests, `catalogue.ts` (`implements`) | Beside anything; `catalogue.ts` is one line, any integrations work |
| 2 | **Core records, settings, mapping, `accounting:manage`** | migration 1330, `packages/core/src/accounting/`, `operations/accounting.ts`, `principals.ts` | Beside 1. Collides with **`principals.ts`** and the operations registry (stage 52 step 1, stage 35's permissions step) |
| 3 | **The host path**: purpose `accounting`, `accounting.void` always reviewed, the host-only rule | `packages/core/src/integrations/outbound.ts`, `runtime.ts`; `apps/runner/src/integrations/host.ts`, `queue.ts` | After 1. **Collides with any integrations runtime work**: stage 35's sending purpose, email gatekeeper purposes, routine mail |
| 4 | **The outbox runner**: references, retries, uncertain outcomes, holds, dependencies, lock date, start date, approval, the daily cron | `accounting/runner.ts`, the runner's cron | After 2 and 3. Free otherwise |
| 5 | **Summaries and payouts**: daily, late events, the reopen adjustment, transfers | `accounting/summaries.ts`, `payouts.ts`; reads `finance/` | Needs stage 52's figures, close and payouts merged. Beside 6 |
| 6 | **Contacts, documents, paid in the books** | migration 1331, `accounting/contacts.ts`, `documents.ts`, `readback.ts`; reads stage 35's event log | Needs stage 35 and stage 34's shared step merged. Beside 5 |
| 7 | **Admin screens, notifications, e2e, the site** | `apps/app/src/routes/_app/money/accounting*`, the sidebar and `lib/nav.ts`, `apps/marketing`, `SITE.md` | Collides with stage 52's screens step and stage 47's navigation step (**the sidebar**) |
| 8 | **The Xero gatekeeper** | `packages/gatekeeper-accounting-xero/`, `deploy-inputs.json`, `docs/integrations.md` | Beside 2 to 7 once 1 is merged; needs a person with a Xero test organisation |
| 9 | **Erase, merge, retention** | `packages/core/src/records/erase.ts`, `person.merge` | Last. Collides with other erase work |

Three build sessions can run at once after step 1: core and the runner (2 to 4), the Xero
gatekeeper (8), then summaries (5) and documents (6) as their dependencies land. Without stage 35
the stage still ships summaries and payouts.

## Decided by this spec, open to override

- One contract, a Worker per accounting system, a shared package with the fake and conformance
  suite; Xero named only in its own gatekeeper and here.
- Core module and core admin screens, not a pack.
- Card sales, documents and locked periods as one fixed way each (decisions 2, 3, 7); the options
  the owner did not choose are not settings.
- A settle delay of 2 days before a day is sent.
- "Two weeks" is fourteen approved days, not calendar days; the count can be raised and approval
  put back on by a human admin; the approval is one per day in the outbox, not one per entry.
- Before the start date: nothing is sent; payouts after it go in full and Setup shows the amount in
  transit for the bookkeeper; an invoice issued before it is not sent, nor its payments.
- Paid in the books is shown to `invoices:payments` holders (stage 35's recording permission) and
  can be dismissed with why.
- **Customers' details in the books after an erase** (asked as best practice, answer yes): an
  invoice in the books says who it is for and the books are the business's own records; the host
  cannot delete that copy, and Setup and the erase result say so. How long the books keep it is
  for the business to confirm with its accountant or lawyer.
- **The first trades business's books** (not asked): the design's assumptions stand and are checked
  at setup ("Setting up the first client").
- Nothing in the books is edited or deleted by the host; corrections are new entries.
- The accounting connection is usable by the host only, never by an AI, Code Mode or an extension.
- One accounting connection per deployment, in the deployment's currency.
- Deviation from stage 52's draft: it said "post a closed version only, and a reversal and the new
  version on a reopen". This spec sends daily (decision 2) and sends a difference on a reopen, not a
  reversal, because the books may have locked the month.

## Questions for the owner

None. How the first client's figures reach its books today is a fact checked at setup and changes
no part of the design.

## Risks

- **Money and correctness**: a wrong mapping sends correct figures to wrong accounts, at scale.
  Mitigations: every row mapped by a person from the books' own lists, nothing guessed, the log
  shows what went where, two weeks of approved days.
- **Double posting** is the classic failure. References on every write, `findByReference` before
  any resend, unique items, and the conformance suite's uncertain-outcome tests guard it.
- **Locks and reconciliation**: an entry moved past a lock date lands in a different period from
  its money; the text says so, and whether that suits the business is for it to confirm with its
  accountant.
- **Security**: the gatekeeper holds a token that can write the business's books. It is the host's
  alone, its Worker has only its own secrets, voids are always reviewed, and there is no delete in
  the contract. A leaked app secret is the platform's to rotate (the gatekeeper's README says how).
- **The app's own limits at Xero** (connections before approval, request rates) are confirmed in
  step 8 and reported if they affect the hosted fleet.
- **Privacy**: customers' details copied into the books cannot be erased by the host; Setup and the
  erase result say so.
