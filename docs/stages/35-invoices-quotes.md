# Stage 35: Invoices and quotes

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Orders,
with Tax at checkout; Agreements), [`CONTEXT.md`](../../CONTEXT.md) (Order, Sellable, Hold, Refund
owed, Deposit, Tax at checkout, Agreement document, Acceptance, Routine mail), ADRs
[0402](../adr/0402-staff-and-customers.md) (audiences),
[0404](../adr/0404-behaviours-are-the-vocabulary.md) (a pack composes, it does not hook writes),
[0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) (orders
priced by the host, paid only by a verified payment),
[0428](../adr/0428-buying-without-an-account.md) (buying without an account, the order's token),
[0429](../adr/0429-payments-gatekeeper-verified-events-and-refunds.md) (refunds),
[0449](../adr/0449-permissions-granted-one-by-one.md) (permissions granted one by one),
[0479](../adr/0479-tax-at-checkout.md) (tax at checkout),
[0486](../adr/0486-an-order-per-paid-period-and-its-refund.md) (an order per paid period),
[0552](../adr/0552-a-tool-a-person-approves.md) (a tool a person approves),
[0571](../adr/0571-a-calendar-file-made-by-the-email-gatekeeper.md) (an attachment the email
gatekeeper makes), [0590](../adr/0590-routine-mail.md) (routine mail),
[0640](../adr/0640-agreement-documents-versions-nobody-changes-published-by-a-person.md) to
[0646](../adr/0646-erase-merge-and-retention-for-agreements.md) (Agreements: documents, points,
acceptances, enforcement, the copy and the signed PDF, retention); stage specs
[34](34-offers.md) (adjustments, the pricing seam `priceLines`, and the shared step "an order paid
another way"), [44](44-agreements.md) (Agreements), [47](47-pack-screens.md) (pack screens) and
48, My account (on PR [#311](https://github.com/timoconnellaus/composable-os/pull/311), branch
`docs/stage-48-my-account`: sections, attention kinds and the receipt seam this stage fills);
`packages/core/src/orders/` (`orders.ts`, `payments.ts`, `checkout.ts`, `tax.ts`, `late.ts`,
`refunds.ts`, `refund-due.ts`, `holds.ts`, `grants.ts`), `packages/core/src/fields/order.ts`,
`packages/core/src/operations/order.ts`, `packages/core/src/agreements/`,
`packages/agreement-pdf/src/writer.ts`, `packages/gatekeeper-email-send/src/agreement.ts` and
`validate.ts`, `packages/core/src/integrations/runtime.ts` (`callAsHost`),
`apps/app/src/routes/order.$id.tsx`. GitHub issues
[#103](https://github.com/timoconnellaus/composable-os/issues/103) (this stage),
[#124](https://github.com/timoconnellaus/composable-os/issues/124) (tax and invoices beyond the
provider's receipt), [#126](https://github.com/timoconnellaus/composable-os/issues/126) (payments
taken in person) and [#198](https://github.com/timoconnellaus/composable-os/issues/198) (prices
with tax added on top).

Status: **spec agreed** (2026-11-24). No interview was needed: under the owner's standing rule
every question the draft raised was decided as best practice (decisions 1 to 10 below), and the
owner's earlier decisions in the Accounting sync interview and stage 48 (decisions 11 and 12) are
built in. Build may start with steps 1 and 2. Step 3 waits for stage 34's step 1 (adjustments) to
merge; step 4 builds on, or builds, stage 34's shared step "an order paid another way".

## Status

- **Step 1** — built — PR #331 — The PDF writer generalised: `packages/agreement-pdf` became
  `@composable-os/pdf` with a table layout, an invoice and a receipt renderer (branch
  `feat/stage-35-pdf-writer`).

- **Step 2** — built — PR #386 — Records, numbering, settings, drafts and the event log
  (`feat/stage-35-invoice-records`; migration 1030, ADRs 0730 and 0732, ADRs 0479 and 0625 amended): `core_quote`, `core_invoice`,
  `core_credit_note` and their lines, with triggers that refuse any change to a sent or issued
  document and any number but the series' next; the three series (`core_document_counter`) and
  `numberStatements`, the SQL that gives a number in the issuing batch; the append-only
  `core_invoice_event` and `eventStatement`; `rec_quote`, `rec_invoice`, `rec_credit_note`; the
  base objects in the field registry (staff only); the permissions `invoices:write`, `:send`,
  `:credit` and `:payments` (restricted); the invoice settings (`invoice.settings.get` /
  `.update`, a human admin's; a bank-details change tells every admin); the host's tax arithmetic
  and the deposit split (`invoices/tax.ts`); the draft operations `quote.*` and `invoice.*`
  (`create`, `update`, `addLine`, `updateLine`, `removeLine`, `delete`, `get`, `list`) with lines
  from a record for sale (priced by `priceLines`) or typed; `invoice.events`. Not in this step:
  issuing, sending, `invoice.fromQuote` (step 6), `creditNote.create` (step 5), a price-list item's
  category and own rate (step 10), erase and the purge (step 11). No row of the event log is
  written yet: each later step writes its own events. After review: a document holds at most an
  order's 50 lines, a record's lines are whole units checked together as one order, and until
  step 11 an erase leaves a draft's text and a merge leaves documents on the merged-away Person
  (step 11 amends the update triggers for the re-point; ADR 0730).

- **Step 3** — built — PR #460 — Issue as an order: `invoice.issue` numbers the draft and starts its
  order in one batch through `createOrder` (priced lines, line discounts as `staff` adjustments,
  the host's `prepaid` kind, no deal, the goods rules: goods refused, the document's
  tax, no expiry, its due date), `invoice.allowPartPayments`; `order.*` refuses to move it;
  migration 1031, ADR 0731

- **Step 4** — built — PR #460 — Recorded payments and reversal, on stage 34's shared step (built
  there by PR #426): `invoice.recordPayment` and `invoice.reversePayment` (`invoices:payments`,
  human only), the settle path writing the event log; ADR 0733 (0734 stays free)

- **Step 5** — built — PR #460 — Credit notes and void: `creditNote.create/get/list/delete/issue`
  and `invoice.void`, `core_order.credited`, refunds by method per payment
  (`core_credit_note_refund`), never more than was paid; ADR 0735. After review: every act that may
  wait for a person names the version read; a refund rejected or expired is owed and asked again
  (`creditNote.askRefundAgain`); reversals to nothing put the invoice back to unpaid; account
  deletion and erase never cancel an invoice's order; each payment and refund carries its share of
  the document's tax (stage 52's book); an open payment page holds credits and recorded payments

- **Step 6** — not built — needs: step 2 — Quotes and acceptance (the deposit invoice needs step 3)

- **Step 7** — not built — needs: step 1, step 2 — Sending, the `invoice` attachment, reminders

- **Step 8** — not built — needs: step 3, step 6 — Public and customer surfaces

- **Step 9** — not built — needs: step 8, stage 48 step 1, stage 48 step 4, stage 48 step 5 — My
  account

- **Step 10** — not built — needs: step 2, stage 47 — The Invoicing pack (its screens after steps
  3 to 6)

- **Step 11** — not built — needs: step 5, step 6, step 7, step 8, step 9, step 10 — Erase, merge,
  retention, export; the site

- **Step 12** — not built — needs: the first client — The first client in test mode

## Goal

A business writes a quote, sends it, and the customer accepts it online with a typed name or a
drawn signature. The business then sends invoices: a deposit when the quote is accepted, progress
or final invoices as the work is done, or a one-off invoice with no quote at all. Each quote,
invoice and credit note is a numbered PDF. The customer pays online through the payment provider,
or by bank transfer, cash, a card machine or a cheque, which a named person on the staff records.
Part payments and deposits are tracked against what is owed; overdue invoices are chased by
reminders the host sends on the business's schedule; mistakes are put right with a credit note,
never by editing what was sent. Tax is shown on every document. Underneath, every invoice is an
order, so paying, refunding, holding places and granting a pass work as they already do. The
customer sees their quotes and invoices in My account, and each invoice can go to the business's
accounting system on its own, under its customer, with its payments and credit notes against it.

## Who it is for

**Gyms and studios first** (what they need is small):
- A one-off invoice: room hire, a workshop for a company, a kids' party, a block of personal
  training for a business's staff.
- A corporate invoice for passes or event places a company pays for in one go, often by bank
  transfer, with the company's name and tax number on it.
- Occasionally a quote for a corporate package, accepted by the company's contact.
- A receipt to download for anything a member paid (stage 48, decision 7).

**Trades and services** (the next vertical; they need the whole of this stage):
- Quotes are the front door: written after a site visit, with labour, materials and call-out
  lines, valid for a set number of days, accepted (often signed) by the customer.
- A deposit on acceptance, progress or final invoices later, and changes to the work along the
  way (extra work invoiced separately, or the final invoice differing from the quote).
- The customer is often a business (an Organisation with a contact Person), sometimes a household.
  The job's site address differs from the billing address.
- Bank transfer and a card machine on site are as common as paying online. Chasing late payers is
  a large part of the office's week.
- Invoices will later take their lines from a Job (stage 39, drafted). In this stage a document may
  point at any record it is about (a deal, a booking, later a job).

What differs between them is configuration, not code: payment terms, whether amounts are typed
with or without tax, the deposit, the reminder schedule and the PDF's wording. How the gym and the
first trades business invoice today, and the numbers their series should start from, are checked
with each business during setup (decisions 9 and 10).

## What exists today (from the code, checked 2026-11-24)

- **Orders** (`packages/core/src/orders/orders.ts`): an order is priced by the host from records
  of sellable objects (`priceLines`); no operation takes a price. Lines snapshot title, unit price,
  line total, `tax_amount` and `tax_code`. States `pending`, `part_paid`, `paid`, `cancelled`,
  `expired`, `refunded` (`fields/order.ts`); every money move is the host's. Deposits (a deposit
  and a `balance_due_at` read from the record), part payments of at least a set minimum
  (`chargeFor`), overdue balances listed, never moved (`overdueOrders`, `order.overdue`). A pending
  order gets `expires_at` from `order_expiry_minutes` (default 15) and `late.ts` expires it.
- **Platform-priced lines**: `NewOrder.priced` lets platform code pass lines it priced itself
  (`order.startHeld`, ADR 0560); a subscription's paid period is an order born paid from the
  provider's invoice (`subscriptions/periods.ts`, ADR 0486). `core_order.invoice_ref` is that
  provider invoice's reference, not one of ours, and stays so.
- **Paid only by a verified payment** (`orders/payments.ts`, ADR 0427): `applyVerifiedPayment` is
  a function reached only from the gatekeeper's verified event. There is no way to record cash, a
  transfer or a card machine. Bookings' "paid another way" is a mark on a booking (ADR 0506).
- **Tax at checkout** (`orders/tax.ts`, ADR 0479): prices include tax; the provider works the tax
  out inside the price, per payment; the host stores what it said and never calculates a tax
  amount.
- **Refunds** (`orders/refunds.ts`, `refund-due.ts`): asked for by a person with `orders:refund`
  or by the host, approved by a person, confirmed by the provider.
- **Holds and grants** (`orders/holds.ts`, `grants.ts`): an unpaid order holds places; a paid line
  grants a ticket or a pass.
- **The guest's order page** (`apps/app/src/routes/order.$id.tsx`, `order.view` by token, ADR
  0428): a public page with a Pay button to the provider's page.
- **Agreements** (stage 44, `packages/core/src/agreements/`, steps 1 to 5 and 8 built): documents
  and versions only a person publishes; how a person agrees (`typed` or `drawn`) is set on the
  document; acceptances nobody can change, by a member, a guardian, a guest with their order, or
  staff from paper; the copy as host mail (purpose `agreements`) with the signed PDF. Agreement
  points are declared by packs on their objects. **No platform point exists yet**: `care` for
  stage 43 is designed (stage 44 step 9) and not built, so this stage's `quote` point is the first.
- **The PDF writer** (`packages/agreement-pdf/src/writer.ts`, 806 lines, no imports, ADR 0645):
  PDF 1.4, standard fonts, WinAnsi hex strings so no text becomes PDF structure, same values same
  bytes. It lays out rich text blocks, a record and strokes; no table, no right-aligned columns, no
  images. The email gatekeeper builds it from checked values (`gatekeeper-email-send/src/agreement.ts`,
  `validate.ts`); attachments are a closed list (the calendar file, the agreement).
- **Host mail** (`callAsHost`, purposes `orders`, `sign-in`, `agreements`,
  `packages/core/src/integrations/runtime.ts`) and **routine mail** (ADR 0590: a shipped pack's
  fixed emails, no links or free text).
- **Agreed, not built, that this stage builds on**: stage 34's adjustments (`core_order_adjustment`,
  net lines, `priceLines` as the one pricing seam; its step 1) and its shared step "an order paid
  another way" (`applyOtherPayment`, `method` on `core_order_payment`, reversal, refunds by method;
  its step 3, ADR 0694); stage 47's declared staff screens; stage 48's My account (sections,
  `me.attention`, the receipt seam; on PR #311).

## Decided (2026-11-24)

No interview was needed. Each question the draft raised was decided as best practice under the
owner's standing rule; decisions 11 and 12 are the owner's own, from other interviews.

| # | Decision |
| --- | --- |
| 1 | **Invoices live in this system**, with a file the accountant can download now. Connecting to an accounting system comes later (Accounting sync, stage 61) |
| 2 | **The business enters its own tax rates once, and the host works out the tax on each line** of every quote, invoice and credit note |
| 3 | **How a customer accepts a quote is the business's choice**: a tick and a typed name, or a drawn signature (the quote terms document's "how", stage 44) |
| 4 | **When a customer accepts a quote that asks for a deposit, the deposit invoice is issued and sent at once**, with no staff step. Staff can still credit it |
| 5 | **Reminders go automatically on a schedule the business sets** (by default on the due date, then 7 and 14 days after), stopping once the invoice is settled. Staff pause them on any one invoice; an admin can turn them off |
| 6 | **Default payment terms: 14 days.** The business changes it in its settings; staff change the due date on each invoice |
| 7 | **Recording a payment taken another way** (bank transfer, cash, a card machine, a cheque) **is for staff an admin has given that right to**: a restricted permission, `invoices:payments` |
| 8 | **Online, a customer pays the whole balance** unless staff allowed part payments on that invoice. Payments recorded by staff can be any amount up to the balance |
| 9 | How the gym invoices today was not asked: the draft's assumptions (one-off and corporate invoices, mostly by transfer) stand, checked with the business during setup |
| 10 | How the first trades business quotes and invoices today, and the next number for each series, were not asked: the draft's assumptions stand, and a human admin sets each series' next number at setup to carry on from the current ones |
| 11 | **Each invoice goes to the accounting system on its own, under its customer, with its payments and credit notes against it** (the owner, Accounting sync interview). The sending is stage 61's; this stage's records make it possible: the bill-to as printed and its ids, each line's tax rate key and source, every payment with its method, and an append-only document event log |
| 12 | **Receipts to download wait for this stage** (stage 48, decision 7): this stage adds the receipt document and fills stage 48's seam on a customer's paid order |

## The design in one page

- **Quotes, invoices and credit notes are core base records**, like Order
  (`packages/core/src/invoices/`; `core_quote`, `core_invoice`, `core_credit_note` and their
  lines), with their own operations. A **draft** has no number and can be edited; **issuing** gives
  it the next number in its series in the issuing batch. An issued document is never changed: the
  database refuses it.
- **An invoice is an order.** Issuing an invoice starts one order in the same batch with the
  invoice's lines as the host priced them (the `priced` path), so paying, refunding, places and
  grants are the order's. The invoice adds what an order lacks: a number, a bill-to, a due date in
  place of a 15-minute expiry, the tax worked out on the document, and a PDF.
- **Lines** come from a record of a sellable object (a pass type, a ticket type, or an item from
  the business's price list in the Invoicing pack), priced by the host when added, or are typed by
  a person on the staff (description, quantity, unit, unit price, tax rate). A customer or the
  public never sets a price: only staff write a draft, which keeps ADR 0427's point. Money off is a
  stage 34 staff adjustment, never a negative line.
- **Accepting a quote is an Agreements acceptance.** The business's quote terms are a document at
  a new platform point, `quote`; the quote itself (number, lines, totals, valid-until) is the
  acceptance's `context` under `shown_hash`. A typed name or a drawn signature (decision 3), the
  copy by email and the signed PDF all come from stage 44.
- **Deposits** are their own invoice, issued and sent when the quote is accepted (decision 4). A
  final invoice made from the quote shows "less deposit paid" for what each deposit invoice was
  paid; on its order that is a host-written adjustment (stage 34's table, a new kind `prepaid`).
  Extra work or a progress claim is another invoice from the same quote.
- **Paying** online opens the order's checkout from the invoice's page. **A payment taken another
  way** is recorded through `invoice.recordPayment` by a person with `invoices:payments`, on stage
  34's shared step (`applyOtherPayment`, ADR 0694): one door into paid for every stage, not a
  second one written here.
- **Credit notes** reduce what is owed, or give back what was paid through the existing refund
  approval (or as recorded money paid back). Voiding an unpaid invoice is a full credit note.
- **Tax** is worked out by the host on documents from the business's rates (decision 2); an
  invoice's checkout asks the provider for no tax. ADR 0479 is amended for invoices only.
- **Reminders** are host mail on the business's schedule (decision 5).
- **PDF**: the agreement writer becomes a shared package with a table layout; an invoice renderer
  sits beside the agreement one; the email gatekeeper gains an `invoice` attachment built from
  checked values.
- **The customer's side is My account** (stage 48): a base section "Invoices and quotes" and two
  attention kinds, `quote_waiting` and `invoice_due`. A customer without an account opens one
  document from the link in its email, as a guest opens an order today.
- **For the books** (decision 11): every issued document keeps its bill-to as printed and the ids
  of whom it bills; every line keeps its rate key and where it came from; and an append-only event
  log, written in the same batch as each event, lets Finance reports (stage 52) and Accounting sync
  (stage 61) read by cursor without touching `invoices/` or `orders/`.
- **An Invoicing pack** (`packs/invoicing`) carries the price list, the staff screens (stage 47),
  dashboards and views. It composes; the rules are the host's.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **Invoices as a pack's own objects** (`x_invoicing_*`) | Gapless numbers, a document nobody can change, tax and an order in the same batch, and a recorded payment are host rules; a pack cannot hook writes (ADR 0404). Same finding as Agreements |
| **One order per job, with the deposit as the order's deposit** | An order's lines and total are fixed when it starts; trades' final invoices differ from the quote. Each invoice its own order keeps orders unchanged in shape |
| **An invoice over several orders** (a monthly statement) | No current need; it would split a payment across orders. Later, if a client asks |
| **Invoices kept only at the payment provider** (its invoicing product) | Card-only: transfers and cash would not reach it, numbering and tax would be the provider's, and the record would live outside the host. Subscriptions keep the provider's invoices, unchanged |
| **Invoices made in an accounting system and read back** | Decision 1. Quotes, acceptance, deposits and chasing need to be where the customer and the work are; two masters for one invoice is the duplicate problem stage 61 avoids |
| **Tax worked out by the payment provider** (ADR 0479's way) | It works out tax only inside a card checkout; an invoice must show its tax before it is paid, and many are paid by transfer (decision 2) |
| **A negative line for the deposit deducted, or for money off** | Stage 34 rejected negative lines (tax split, refunds by line, "nothing to pay", reports). The document shows "less deposit paid"; the order carries an adjustment |
| **This stage's own "paid another way"** | Stage 34 decided one shared step, one payment row shape, one guard, one ADR. `invoice.recordPayment` is its own operation with its own rules on top of it |
| **A quote's acceptance as a field on the quote** | A second, weaker signature record beside stage 44's, which already gives evidence nobody can change, the copy and the PDF |
| **A separate customer area for invoices** | Stage 48: what a customer sees is a section and an attention kind in My account |
| **A PDF made by a headless browser**, or **a second PDF writer** | A new service on every deployment, rejected in stage 44; or two writers to keep safe when the hex-string rule and fonts are the hard part and exist |

## Platform work and pack work

| Piece | Platform or pack | Why |
| --- | --- | --- |
| Quote, invoice and credit note records, lines, numbering, immutability, settings, the event log | **Platform** (`packages/core/src/invoices/`, `packages/db` migrations) | Evidence and money; one rule for every path |
| An order started by an invoice: no expiry, its due date, its tax, the `prepaid` adjustment, part payments when allowed, the move hook to the invoice | **Platform** (`orders/orders.ts`, `checkout.ts`, `tax.ts`, `late.ts`; amends ADRs 0427 and 0479, and stage 34's adjustment kinds) | Orders are core |
| `invoice.recordPayment` / `reversePayment` on the shared step | **Platform** (`invoices/`, calling `applyOtherPayment` in `orders/payments.ts`) | Only the host moves money states. If this stage is first, it builds the shared step to stage 34's design |
| Credit notes: what is owed reduced (`credited` on an order), refunds through the existing approval or by method | **Platform** (`orders/`, `invoices/`) | Same |
| The `quote` platform point and the quote as an acceptance's context | **Platform** (`agreements/`) | Stage 44's machinery |
| Reminders: the schedule, the sweep, the host mail | **Platform** (`invoices/reminders.ts`, the daily cron, `callAsHost` purpose `invoices`) | Carries a pay link: host mail, not routine mail |
| The generalised PDF writer, the invoice and receipt renderers, the gatekeeper's `invoice` attachment | **Platform** (`packages/pdf`, `packages/gatekeeper-email-send`) | The attachment rule (ADRs 0571, 0645) |
| Public reads by token; customer reads; the "Invoices and quotes" section, its attention kinds, the receipt on a paid order | **Platform** (operations, the HTTP surface, the typed client, base blocks in `blocks/`) | Core records, so a base section (as Orders is); opening to customer and public is a reviewed change (ADR 0402) |
| The price list (`invoicing.item`: name, unit, price, tax rate key, category; `sellable`, staff-only) | **Pack** (`packs/invoicing`) | Composition |
| Staff screens: quotes, invoices, the editor, record a payment, credit note, overdue, a record screen on Person and Organisation | **Pack** (declared screens, stage 47) | Staff screens are pack screens |
| Dashboards (money owed by age, invoiced and paid by month, quotes won) and views | **Pack** | Read-only SQL over `rec_invoice`, `rec_quote`, `rec_credit_note` |
| Wording on the PDF, the quote terms, bank details | **The business** | No legal wording ships |

## The model

### Words (for `CONTEXT.md`, written by the build)

- **Quote**: an offer of work or goods at stated prices, valid until a date, accepted or declined
  by the customer. Avoid: estimate (Jobs' estimate lines are what a quote is made from).
- **Invoice**: a numbered request for payment, issued to a bill-to, with its own order. Kinds
  `standard`, `deposit`, `final`.
- **Credit note**: a numbered document that reduces what an invoice asks for, in part or in full.
  Avoid: refund for it (a refund is money going back, which a credit note may cause).
- **Bill-to**: whom a document is addressed to: a Person, or an Organisation with a contact
  Person; printed with its name, address and tax number as at issue.
- **Issue**: giving a draft its number and making it final. **Void**: a full credit note on an
  unpaid invoice.
- **Overdue**: an unsettled invoice past its due date. Not a state.
- **Receipt**: the PDF of a paid order and its payments, for an order that has no invoice.

### Records

- **Quote** (`core_quote`, `qt_…`): bill-to (Person, or Organisation and contact Person) and the
  bill-to as printed (name, address, tax number, email; fixed at send), an optional site address,
  an optional `about` (object and id of any record), title, notes for the customer, valid-until,
  deposit (none, an amount, or a percentage), the tax mode it was written in (amounts with or
  without tax), lines, totals by rate, total, state, number once sent, the quote it replaces, the
  acceptance once accepted.
- **Invoice** (`core_invoice`, `inv_…`): the same bill-to and bill-to as printed, issue date, due
  date, payment terms, `kind` (`standard`, `deposit`, `final`), the quote it came from, the order
  it started, whether part payments are allowed online, reminders paused (with why), the tax mode,
  lines, totals by rate, total, a snapshot of the business's details and bank details at issue,
  state, number once issued.
- **Credit note** (`core_credit_note`, `cn_…`): the invoice it credits, lines (some of the
  invoice's lines, part quantities, or an amount at a rate), reason, how it settles (`reduce` what
  is owed, `refund` what was paid, or both, in that order), the refund or paid-back rows it caused,
  number, the snapshot as for an invoice.
- **Line** (one table per document): position, description, quantity (up to three decimals, for
  hours and metres), unit, unit price, tax rate key, line net, line tax, line total; its source:
  the sellable record it came from (object and id, and a price-list item's category), or `custom`;
  an optional staff discount (an amount or a percentage, and why) that becomes a stage 34 `staff`
  adjustment at issue. A **deduction line** ("less deposit paid") is written only by the host and
  names the deposit invoice it deducts.
- **Counters** (`core_document_counter`): one row per series (`quote`, `invoice`, `credit_note`):
  prefix, next number, a version.
- **The document event log** (`core_invoice_event`, decision 11): seq (increasing), the document
  (kind and id), the event (`issued`, `sent`, `payment_applied`, `payment_reversed`, `credited`,
  `refund_confirmed`, `paid_back`, `voided`), the payment row and its method where there is one,
  the amount, when. Written in the same batch as the event, by host code only; the database refuses
  any update or delete. A provider's verified payment on an invoice's order writes
  `payment_applied` from the order's move hook, so no path is missed.
- **Settings** (human admin only, `settings:manage`, `actors: ["human"]`): the business's legal
  name, address and tax number; **bank details** (a change is announced to every admin and posted
  on the timeline); each series' prefix and next number (it can only go up); tax rates (key, label,
  rate in hundredths of a percent, a default; a rate used on an issued document is never edited,
  only retired and replaced by a new key); whether amounts are typed with or without tax; default
  payment terms (14 days, decision 6); default quote validity (30 days); deposit invoices' terms
  (due on issue); the reminder schedule (decision 5) and reminders on or off; the threshold over
  which a recorded payment tells the admins; the PDF footer; the retention period.

### States

- Quote: `draft` → `sent` → `accepted` | `declined` | `expired` (host, at valid-until) |
  `withdrawn` (staff). `accepted`, `declined`, `expired` and `withdrawn` are final; a sent quote is
  changed only by withdrawing it and sending a new one (a new number, "replaces Q-0041":
  `quote.reviseAs`).
- Invoice: `draft` → `issued` (number, order started) → `sent` → `part_paid` → `paid`; or
  `credited` (credited in full with nothing paid); `void` (a full credit note on an unpaid
  invoice). Money states follow the order (its move hook), never set by a caller.
- Credit note: `draft` → `issued`.

### Numbers and immutability

- One series each for quotes, invoices and credit notes (`Q-`, `INV-`, `CN-` by default). A human
  admin sets the prefix and the next number, which can only go up. Numbers are given in the issuing
  batch from the series' counter row with a version check, under a unique index, so two issues at
  once never share a number and a failed batch uses none.
- Once issued, a trigger refuses any change to the bill-to, lines, totals, tax, number, dates and
  snapshots; only state, what is paid or credited, and the reminder fields change, by host code.
  Drafts are deleted freely; issued documents are never deleted except by the retention purge.
- Whether these rules are what the business's tax authority expects of numbering and corrections
  is for the business to confirm with its accountant.

### Tax (decision 2)

- On every document, from the business's own rates, **worked out by the host**: each line's tax
  rounded half up to the minor unit, the document's tax the sum of its lines, shown by rate. With
  "amounts without tax" the tax is added on top; with "amounts with tax" it is taken out of the
  price. The order's total is the document's total including tax, so a payment matches it exactly
  (this answers issue #198 for invoices only).
- The order an invoice starts stores each line's tax (`tax_amount`) from the document and **asks
  the provider for none at checkout**, even with tax at checkout on. ADR 0479 is amended: the host
  works tax out for invoices, never for checkout sales (stage 34's "the host never calculates tax"
  stays true of checkout sales). With no rates set, documents show no tax.
- A staff discount on a line (stage 34's adjustment) lowers that line's net, and the tax is worked
  out on the net. A deposit invoice's tax is the quote's tax split in proportion to the deposit;
  the final invoice's "less deposit paid" takes off the deposit invoice's tax by rate.
- What a document must show to count as a tax invoice, and how rounding, discounts and deposits are
  taxed, are for the business to confirm with its accountant. The settings cover the usual choices;
  no rate ships.

### How an invoice sits on an order

- `invoice.issue` calls `createOrder` with `priced` lines built from the invoice (one order line
  per invoice line), its staff discounts and any `prepaid` deduction as stage 34 adjustments,
  `placedAs: "staff"`, the bill-to's contact Person, and an access token for the invoice's link.
- The order is **due, not expiring**: an invoice's order has no `expires_at`; the expiry sweep
  skips it; its due date is `balance_due_at`; `order.overdue` lists it. Places it holds are held
  until it is paid, credited or voided, and staff see what is held on the invoice.
- `order.recordPayment`, `order.cancel` and `order.adjust` refuse an invoice's order: its money is
  moved through the invoice's own operations, so the event log and the document always agree.
- Agreements still apply: an invoice for a pass type whose point needs a waiver is refused at issue
  with the list, and staff send the link, use the desk or record paper (stage 44).
- **Part payments** (decision 8): online, the amount asked for is the whole balance unless staff
  allowed part payments on that invoice (then at least the set minimum, `chargeFor`). A recorded
  payment may be any amount up to the balance. Overpaying is refused; a provider payment that
  arrives for more than is owed (a checkout opened before a recorded payment) goes the existing
  way: recorded, staff told, a refund owed.

### Deposits and the final invoice (decision 4)

- Accepting a quote with a deposit issues a `deposit` invoice for it in the acceptance's batch and
  queues its email; the accept page then offers "Pay the deposit now".
- "Make an invoice from this quote" (`invoice.fromQuote`) copies the quote's lines into a draft of
  kind `final` or `standard` (a progress claim or extra work); staff edit them. The quote shows what
  has been invoiced against it so far.
- Issuing a `final` invoice adds one deduction line per deposit invoice of that quote for what that
  invoice was **paid** at the moment of issue (never more, never what was only invoiced). A deposit
  invoice still unpaid at that point is listed for staff to credit or chase; it is not deducted.

### A payment taken another way (decision 7)

- **Built on stage 34's shared step** ([34-offers.md](34-offers.md), "An order paid another way";
  ADR 0694): the payment row's `method` `recorded` with its `recorded_kind` (`transfer`, `cash`,
  `cheque`, `card_machine`, `other`), `recorded_by`, `received_on` and `reference`; the order moved
  by the host in the same batch through `applyOtherPayment`; reversal by a second row; refunds by
  method. This stage does not redesign it. Whichever of stage 34, this stage or the till builds it
  first builds it to that design; if it is this stage, it writes that ADR in this block (0734) and
  0694 stays free, as stage 34's table says.
- `invoice.recordPayment { invoiceId, amount, kind, receivedOn, reference? }`: staff, permission
  **`invoices:payments`** (restricted and grantable: admins and the people a human admin grants it
  to), `actors: ["human"]`. Only on an issued invoice with a balance. Writes `payment_applied` to
  the event log; audited; on the Person's or Organisation's timeline; admins told when over the
  threshold; a receipt emailed to the bill-to.
- `invoice.reversePayment { paymentId, reason }`: same permission, human only; the shared step's
  reversal, plus `payment_reversed` in the log. Refused for a provider's payment (that is a refund).
- No other caller (an AI, an MCP client, an automation, an extension, an import) can record one.
  Stage 61's "paid in the books" opens `invoice.recordPayment` filled in for a person to confirm.

### Credit notes

- `creditNote.issue { creditNoteId }` after a draft made by `creditNote.create { invoiceId, lines |
  amount, reason, settle }`: issue is `invoices:credit`, human only (drafts: `invoices:write`). In
  one batch it reduces what is owed first (`core_order.credited`; balance = total − paid −
  credited); what it credits beyond the unpaid part becomes a refund owed per payment row (stage
  34's refunds by method): a provider payment through the existing refund approval (a person with
  `orders:refund`), a recorded payment recorded as paid back by the person. Account credit instead
  of money back is offered once stage 34's account credit (its step 8) is built.
- An invoice credited in full with nothing paid moves to `credited` (its order to `cancelled`, its
  places released); with something paid, to `paid` once nothing is owed. `invoice.void` is the
  shortcut for a full credit note on an unpaid invoice.

### Operations

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `quote.create`, `.update`, `.addLine`, `.updateLine`, `.removeLine`, `.delete` (drafts) | staff | `invoices:write` | write |
| `quote.send` (number, PDF, email) | staff | `invoices:send`; an AI may ask, a person approves | outbound |
| `quote.withdraw`, `quote.reviseAs` | staff | `invoices:send` | write |
| `quote.list`, `.get`, `.pdf` | staff | `records:read` | read |
| `quote.view`, `.pdf` (by the link's token) | **public** (reviewed) | holder of the token | read |
| `quote.accept`, `quote.decline` (by token, with the acceptance or a reason) | **public** (reviewed) | holder of the token | write |
| `me.quotes.list`, `.get`, `.pdf`, `.accept`, `.decline` | **customer** (reviewed) | their own, and their organisation's where they are the named contact | read / write |
| `invoice.create`, `.update`, `.addLine`, `.updateLine`, `.removeLine`, `.delete`, `invoice.fromQuote` (drafts) | staff | `invoices:write` | write |
| `invoice.issue`, `invoice.send`, `invoice.resend` | staff | `invoices:send` (a line discount also needs `orders:discount`, within stage 34's limit or approved); an AI may ask, a person approves | outbound |
| `invoice.recordPayment`, `invoice.reversePayment` | staff | `invoices:payments`, human only | write |
| `invoice.allowPartPayments`, `invoice.setDueDate`, `invoice.pauseReminders` | staff | `invoices:send` | write |
| `creditNote.create` (draft); `creditNote.issue`, `invoice.void` | staff | `invoices:write`; issue and void `invoices:credit`, human only | write (a refund in it: outbound, approved) |
| `invoice.list`, `.get`, `.pdf`, `invoice.overdue`, `invoice.export` (CSV) | staff | `records:read`; export `invoices:payments` | read |
| `invoice.view`, `.pdf`, `invoice.checkout` (by token) | **public** (reviewed) | holder of the token | read / write |
| `me.invoices.list`, `.get`, `.pdf`, `.checkout` | **customer** (reviewed) | their own, and their organisation's where they are the named contact | read / write |
| `order.receipt` (a paid order with no invoice) | staff; **customer** (own); **public** (with the order's token) (reviewed) | as `order.get` / `order.view` | read |
| `invoice.events` (the log, by cursor) | staff | `invoices:payments` or `finance:read` (stage 52's); host code | read |
| `invoice.settings.get` / `.update` | staff | read: `records:read`; update: human admin | read / write |
| `invoice.sendReminders`, `quote.expireDue` | host (`automation` actor) | the cron | write |

`invoices:write`, `invoices:send` and `invoices:credit` are core permissions held by admins and
grantable one by one (ADR 0449); `invoices:payments` is restricted (decision 7). Customer and
public operations are `mcp: { expose: false }`, rate limited and never queued.

Tokens are per document, kept as a hash, shown only in the emailed link, and stop working 90 days
after the document is settled, and at erase.

### Notifications and email

- **Host mail, purpose `invoices`** (applied at once unless the deploy-time floor holds it, as an
  order's confirmation is): the quote, the invoice, a credit note, a receipt for a recorded payment,
  and reminders. Each carries the document's PDF as the gatekeeper's `invoice` attachment, built
  from checked values, and a link to the document. No AI writes or reads their text; the approval
  card, when one is shown, says "Invoice INV-0042 to [bill-to], [total], due [date]".
- **Reminders** (decision 5): the schedule (days before due, on the due date, days after; by
  default the due date, then 7 and 14 days after) is a setting; each step is sent once per invoice
  (idempotency key `invoice-reminder:<id>:<step>`); paused per invoice; stopped when settled,
  credited or voided; none go while reminders are off. Reminders move onto Notifications (stage 30)
  when it is built; consent to be contacted is stage 30's, and a reminder about money owed is
  transactional mail.
- **Staff told**: a quote accepted or declined; an online payment; an invoice overdue past the last
  reminder; a recorded payment over the threshold (admins); a bank-details change (every admin).

### In My account (stage 48)

- **A base section, "Invoices and quotes"** (web and native base blocks in `blocks/`), shown by
  `me.portal` when the caller has a quote or an invoice, their own or their organisation's as its
  named contact. Invoices and quotes are core records, so this is a base section as Orders is, not
  a pack's `portal` declaration. It lists open quotes (read, download, accept with the quote terms'
  capture, decline with a reason) and invoices (read, download, what is paid and owed, Pay, bank
  details), newest first.
- **Two attention kinds in core** (the names stage 48 reserved): `quote_waiting` (a sent quote
  for them, before valid-until; shown until accepted, declined, expired or withdrawn) and
  `invoice_due` (an issued invoice with a balance, due within `account.attentionDays` or overdue;
  shown until settled, credited or voided). An invoice's order never also shows as stage 48's
  `balance_due` or `finish_paying`.
- **Orders**: an invoice's order appears in the Orders section with the invoice's number and links
  to the invoice; its receipt is the invoice's PDF (paid).
- **The receipt seam** (stage 48, decision 7): the customer's order read reports `receipt` for a
  paid order (the invoice's PDF for an invoice's order, else `order.receipt`), and the Orders row
  shows "Download receipt". A receipt shows the business's details, the order's reference, lines,
  the tax the provider worked out at checkout (ADR 0479) when there was any, payments and refunds.
  What a receipt must contain is for the business to confirm with its accountant.
- **Without an account**: the emailed link opens that one document (a hosted page on the host's
  address, as the guest order page, built from the section's detail blocks). Nothing else is
  reachable from it.
- **In the app**: the native section shows quotes and invoices and accepts a quote (stage 44's
  signature pad); Pay opens the website's page (stage 48: money in the app is the website's).
- **Deleting an account** (stage 48 step 6) does not cancel an issued invoice's order: the invoice
  stays owed and the preview says so.

### Screens (staff, web)

The Invoicing pack's declared screens (stage 47): Quotes; Invoices (draft, sent, overdue, paid);
the editor for each (lines from the price list or typed, tax per line, totals, a preview of the
PDF); Record a payment; Credit note; Overdue (oldest first, last reminder sent, pause); Settings →
Invoices; a record screen "Invoices and quotes" on Person and Organisation. Stage 61 adds "In the
books" to the invoice screen. Staff native screens are later; the web screens work in a phone's
browser.

### What an AI may do

- **May**: draft quotes, invoices and credit notes (lines, wording, quantities from a job's notes);
  read documents and the overdue list with the person's own rights; ask to send a quote or issue
  and send an invoice, which a person approves.
- **May not**: issue a credit note or void, record or reverse a payment, accept or decline a quote
  for a customer, change numbering, tax rates, bank details or the reminder schedule, or write the
  text of host mail. These are `actors: ["human"]` or a human admin's settings; no preset loosens
  them.

### Privacy, audit and erase

- Documents are not in search, embeddings, summaries or the generic object walk (as orders).
  `rec_invoice`, `rec_quote` and `rec_credit_note` carry numbers, states, dates, amounts and the
  bill-to's ids, not addresses, tax numbers or notes, for dashboards and `query.sql`.
- Every issue, send, payment recorded or reversed, credit and settings change is audited with
  amounts and ids, never bank details in full.
- **Erase**: drafts, unsent quotes and declined, expired or withdrawn quotes are deleted. Issued
  invoices and credit notes, and accepted quotes, are kept for the retention period (default 7
  years, the same as agreements' acceptances), detached from the Person, with the bill-to as
  printed; then purged. Links stop working at once. Copies already in an accounting system are
  the business's (stage 61; the owner accepted that). How long to keep them, and whether the name
  may stay on a kept invoice, are for the business to confirm with its accountant or lawyer. Quote
  acceptances follow stage 44's rule.
- Merge re-points documents to the surviving Person or Organisation.

## Out of scope

- Statements over several invoices; recurring invoices; late fees and interest; card surcharges;
  a customer's account to buy on and pay monthly (the till's "on account", or a later step here).
- Discounts and account credit themselves (stage 34; this stage uses its adjustment and, later,
  its account credit).
- Sending to an accounting system (stage 61); the figures for the books (stage 52). A CSV export
  ships now.
- A card reader connected to the host (a payment on a card machine is recorded by a person).
- Several currencies; a document in a language or script the standard fonts cannot draw.
- A logo on the PDF (later: a small, checked JPEG is simple to add).
- Memberships billed by invoice instead of by card (subscriptions stay as they are).
- Staff native screens.
- Taking lines from a job's billable records (stage 39's proposed `billable` seam): `about` points
  at a job when it exists.

## Acceptance criteria

1. A person with `invoices:write` drafts an invoice with a price-list line and a typed line; it has
   no number; a customer, the public and a runtime extension cannot create or change one.
2. Issuing gives `INV-<next>`; twenty issues at once give twenty different consecutive numbers; a
   failed issue uses none; the next number can only be raised, by a human admin.
3. An issued invoice's lines, totals, tax, bill-to, dates and snapshots cannot be changed by any
   operation or by a direct update (the trigger refuses it).
4. Issuing starts one order in the same batch whose total equals the invoice's, which does not
   expire, whose due date is the invoice's, and which appears in `order.overdue` after it.
   `order.recordPayment`, `order.cancel` and `order.adjust` refuse it.
5. Tax: with rates set, amounts typed without tax and with tax, each line's tax and the document's
   totals by rate are as specified (a table test, discounts and deposits included); with tax at
   checkout on, an invoice's checkout asks the provider for no tax and the order keeps the
   invoice's tax.
6. The invoice's link opens its page without sign-in; Pay opens the provider's page for the
   balance; the verified payment moves the invoice to `paid` and writes `payment_applied`; a paid
   line granting a pass grants it.
7. Part payments: refused online unless allowed on the invoice, then at least the minimum; a
   recorded payment of any amount up to the balance moves it to `part_paid`; overpaying is refused.
8. `invoice.recordPayment` by a person with `invoices:payments` writes a `recorded` payment row on
   the shared step naming them and its kind, and moves the order; by anyone without it, an AI, an
   MCP client, an automation, an extension or an import it is refused; it is audited, on the
   timeline and in the event log; a reversal adds a row and changes nothing else.
9. A credit note for part of an unpaid invoice reduces what is owed; one beyond the unpaid part
   creates a refund owed that waits for a person's approval (a provider payment) or a person's
   "paid back" (a recorded one); voiding an unpaid invoice credits it in full, cancels its order and
   releases its places.
10. A quote sent by email with its PDF; its page shows it; the customer accepts with the quote
    terms' capture (typed or drawn, as the document says); the acceptance's `context` holds the
    quote's number, lines and total under its hash; the copy is emailed; a quote past valid-until
    cannot be accepted and becomes `expired`.
11. A quote with a deposit, once accepted, issues and emails a deposit invoice in the same batch;
    the final invoice made from the quote deducts what each deposit invoice was paid, never more,
    and an unpaid deposit invoice is listed, not deducted.
12. Reminders go on the schedule's days, once each, and stop when the invoice is paid, credited,
    voided or paused; with reminders off, none go.
13. The PDF of an invoice and of a credit note shows the business's details, the number, dates,
    lines in columns, tax by rate, totals, what is paid and owed, and bank details as at issue; the
    same values make the same bytes; text containing PDF syntax is drawn as text.
14. The agreements PDF's bytes are unchanged by the writer's generalisation (a golden test).
15. The email gatekeeper refuses an `invoice` attachment on anything but the host's invoices mail.
16. A signed-in customer sees only their own invoices and quotes, and their organisation's where
    they are the named contact; a token opens one document only; tokens stop after the period and
    at erase.
17. My account: the "Invoices and quotes" section appears only for a customer who has one;
    `quote_waiting` and `invoice_due` appear and clear as specified; an invoice's order shows no
    `balance_due`; a paid order's row offers its receipt.
18. The event log has one row per issue, send, payment applied or reversed, credit, refund
    confirmed, paid back and void, in order, written in the event's batch; the database refuses
    an update or delete of a row.
19. An AI may draft and ask to send; it cannot issue a credit note, void, record a payment, accept
    a quote or change settings (each refused with the rule).
20. A bank-details change by a human admin notifies every admin; an AI or a non-admin is refused.
21. Erase deletes drafts and open quotes and keeps issued invoices detached for the retention
    period; the purge removes them after it.
22. With Invoicing installed, its screens appear in the admin's navigation for people who may use
    them (stage 47), and the money-owed dashboard's ages add up to the overdue list.
23. Statement-count tests: issuing, recording a payment, `me.attention`'s two kinds and the
    reminder sweep read a bounded number of rows.
24. E2E, one per journey: quote sent, accepted and deposit paid; invoice issued and paid online;
    payment recorded; credit note.

## Dependencies

- **Built**: stage 25 (orders, payments gatekeeper, refunds), 26 (holds), 42 (tax at checkout),
  44 steps 1 to 5 and 8 (documents, acceptances, enforcement, the copy and PDF, the blocks,
  retention), 23 (the HTTP surface and typed client).
- **Agreed, not built**: **34 step 1** (adjustments: this stage's step 3 needs it merged) and
  **34 step 3** (the shared step: this stage's step 4 builds on it, or builds it to its design);
  **47** (pack screens) for the staff screens; **48** (My account, PR #311) for the section and
  attention kinds (steps 1 to 7 here do not need it).
- **Not specced**: **30** (notifications): reminders use host mail now and move to it later; **39**
  (jobs): `about` is ready, and the `billable` seam waits for its spec; **52** and **61** (finance
  reports, accounting sync) read this stage's views and event log.

## Migrations and numbers

Block **BH** (claimed in `parallel-work.md` by the coordinator): migrations 1030 to 1049, ADRs
0730 to 0739. Migrations from 1030, one or more per step. If a step needs a `core_write_guard`
kind, it follows the ordering rule in `parallel-work.md` (carry every earlier kind, sort after
0851); none is expected (the immutability rules are triggers on the new tables). The ADRs the
build will need:

| ADR | Decision | Amends |
| --- | --- | --- |
| 0730 | Quotes, invoices and credit notes as core records: numbering, immutability, retention, the document event log | |
| 0731 | An invoice is an order: due, not expiring; the `prepaid` adjustment; its order moved only through the invoice | 0427; stage 34's 0690 (a new adjustment kind) |
| 0732 | Tax worked out by the host on documents, from the business's rates | 0479 |
| 0733 | Recording a payment on an invoice: `invoices:payments`, restricted, human only, on the shared step | 0427 |
| 0734 | Reserved: the shared step "an order paid another way", written here only if this stage builds it first (then 0694 stays free) | 0427, 0429, 0479 |
| 0735 | Credit notes and void: what is owed reduced, refunds by method | 0429 |
| 0736 | Accepting a quote is an agreement acceptance: the `quote` platform point, the quote as context | 0641, 0642 |
| 0737 | The shared PDF writer, the `invoice` attachment, host mail purpose `invoices` | 0571, 0645 |
| 0738 | The customer's side: tokens, the My account section, `quote_waiting` and `invoice_due`, receipts | 0402, 0428; fills stage 48's seam (0710, 0711) |
| 0739 | Reminders on the business's schedule | |

## Suggested build order

| Step | What | Files and areas | Beside what (collides with) |
| --- | --- | --- | --- |
| 1 | **The PDF writer generalised**: rename to `@composable-os/pdf`, split the safe core (fonts, encoding, pages) from the agreement renderer, add a table layout, an invoice renderer and a receipt renderer; golden test for agreements | `packages/agreement-pdf` → `packages/pdf`; imports in `packages/core`, `gatekeeper-email-send`, `apps/app` | Beside 2 and anything not touching those imports. **Collides** with stage 44 PDF work and any branch editing `gatekeeper-email-send` imports |
| 2 | **Records, numbering, settings, drafts, the event log**: tables and triggers, the field registry, draft operations, settings, permissions, the price list's `sellable` read | `packages/db` migrations (from 1030), new `packages/core/src/invoices/`, `fields/`, the operations registry, `principals.ts` | Beside 1. **Collides** on the registry file and `principals.ts` (stage 34 steps 1 and 3, stage 52 step 1, accounting sync) |
| 3 | **Issue as an order**: `priced` lines, no expiry, due date, the invoice's tax, staff discounts and the `prepaid` adjustment, part payments allowed, the order's move hook to the invoice and the log | `orders/orders.ts`, `checkout.ts`, `tax.ts`, `late.ts`, `fields/order.ts`, `operations/order.ts` | After 2 and **after stage 34 step 1 merges**. **Collides with anything in `orders/`** (stage 34, 37's delivery and returns, the till, stage 44 step 7 cooling off, stage 48 step 6) |
| 4 | **Recorded payments and reversal** on the shared step (building it to stage 34's design if nobody has) | `orders/payments.ts`, `orders/refunds.ts`, `invoices/` | Same session as 3. **Collides** with stage 34 step 3 and the till's payment step: whichever starts first owns the shared step, the others wait for it to merge |
| 5 | **Credit notes and void** | `orders/` (`credited`), `refund-due.ts`, `invoices/` | After 3 and 4, same session |
| 6 | **Quotes and acceptance**: the `quote` platform point, the context, accept and decline, expiry, the deposit invoice | `agreements/` (points, accept), `invoices/quotes.ts` | After 2; beside 3 to 5 (the deposit invoice needs 3 to finish). **Collides** with `agreements/` work (stage 44 steps 6, 7 and 9) |
| 7 | **Sending, the `invoice` attachment, reminders** | `gatekeeper-email-send` (`validate.ts`, a renderer call), `integrations/runtime.ts` (purpose `invoices`), the cron, `invoices/reminders.ts` | After 1 and 2; beside 3 to 6. **Collides** with email gatekeeper work |
| 8 | **Public and customer surfaces**: token reads, `me.quotes.*`, `me.invoices.*`, checkout from an invoice, `order.receipt`, the hosted document page, the typed client | operations, `packages/core/src/http/`, `packages/client`, `open-operations.json`, `apps/app/src/routes/` | After 3 and 6. **Collides** with the HTTP surface, the route tree and `open-operations.json` |
| 9 | **My account**: the base section blocks (web and native), the two attention kinds, the receipt field on the customer's order read, the Orders row | `blocks/`, `packages/core/src/customers/attention.ts` | After 8 and stage 48 steps 1, 4 and 5. **Collides** with stage 48's blocks and `attention.ts` |
| 10 | **The Invoicing pack**: price list, screens, dashboards, views, record screens | `packs/invoicing` | After 2 for the price list; screens after stage 47 and 3 to 6. Beside any other pack (`pack-roles.ts` if it declares roles) |
| 11 | **Erase, merge, retention, export; the site** | `records/erase.ts`, `retention.ts`, `apps/marketing`, `SITE.md` | Last. **Collides** with erase work |
| 12 | **The first client** in test mode | — | — |

**What can start first:** steps 1 and 2 together. Then, once stage 34 step 1 has merged, one
session on orders (3, 4, 5), one on quotes and Agreements (6), one on sending (7); 8 and 9 after
them; the pack's price list beside all of it.

## Size

**Large.** Three build sessions can run at once after step 2 (orders; quotes; the PDF and
sending), and a fourth on the pack.

## Decided by this spec, open to override

- Quotes, invoices and credit notes are core records; the Invoicing pack carries the price list,
  the screens and the dashboards.
- Every invoice is its own order; a deposit is its own invoice; the final invoice deducts what the
  deposit invoices were paid, as a host adjustment on its order (stage 34's table, kind `prepaid`),
  never a negative order line.
- Money off a document line is stage 34's staff adjustment, with its permission and limit.
- An invoice's order is moved only through the invoice's operations; `order.recordPayment`,
  `order.cancel` and `order.adjust` refuse it.
- The host works out tax on documents from the business's rates; rounding is half up per line; a
  rate once used is retired, never edited.
- Staff may type a line and its price; customers and the public never set a price.
- Accepting a quote is an Agreements acceptance with the quote as its context; the business
  publishes its quote terms before the first quote is sent; how they accept is set on that
  document.
- Recording a payment is a person's act with `invoices:payments`; an AI never records one.
- Credit notes, not edits; voiding is a full credit note.
- Reminders are host mail without approval, on the business's schedule.
- The default quote validity is 30 days; a deposit invoice is due when issued.
- An issued document keeps a snapshot of the business's details and bank details.
- The PDF writer is generalised and renamed, not copied; no logo yet.
- A customer sees their organisation's documents only where they are its named contact, and may
  accept such a quote.
- "Invoices and quotes" is a base section of My account (core records), not a pack's `portal`
  declaration; an invoice's order also appears in Orders, linked to its invoice.
- Deleting a customer account never cancels an issued invoice.
- Issued documents and accepted quotes are kept 7 years after erase, detached, then purged.
- Staff screens on the web only; native for customers.

## Questions for the owner

None open. Every question the draft raised was decided under the owner's standing rule (decisions
1 to 10); the facts it asked about each business are checked at setup.

## For the business to confirm with its accountant or lawyer

- What a quote, an invoice, a credit note and a receipt must show; how numbering and corrections
  must work.
- Which tax rates apply, and how rounding, discounts and deposits are taxed.
- How long invoices are kept, and whether a name may stay on a kept invoice after a customer asks
  to be forgotten.
- The wording of the quote terms and of the PDF footer.

## Risks

- **Money**: a recorded payment is a path into a paid order that a provider did not confirm. A
  wrong or fraudulent entry gives away goods (a pass, a ticket). Mitigations: restricted
  permission, human only, audit, threshold notice, reversal, the shared step's guard trigger.
- **Fraud**: changed bank details on invoices is a known way to divert payments. Human admin only,
  every admin told, on the timeline; issued documents keep the details they were issued with; no
  email ever asks a customer to use new details.
- **Tax**: the host working out tax is new (ADR 0479 said never). A table of worked examples should
  be checked by the business's accountant before the first real invoice.
- **Holds**: an invoice for event places holds them until it is paid or credited, possibly weeks.
- **Public reads**: token pages show names and addresses; tokens must be long, hashed and expire.
- **The PDF rename** touches three packages that stage 44 just stabilised; the golden test guards it.
- **Sequencing**: step 3 waits for stage 34 step 1, and step 4 shares a step with stage 34 and the
  till; both need the full order test suite and a review before anything builds on them.
- **Needs real things to verify**: the provider's checkout for an invoice's balance in test mode;
  the PDF opened in common viewers and printed; a real business's numbering and tax with its
  accountant; a customer accepting on a phone; reminders reaching real inboxes.

## Overlaps

- **Stage 34** (Offers): this stage uses its adjustment (staff discounts on lines, and the new
  `prepaid` kind) and its shared step "an order paid another way" (ADR 0694); it adds `credited`
  on an order. Its account credit later becomes a way to settle a credit note.
- **Stage 48** (My account, PR #311): the section, `quote_waiting` and `invoice_due`, the receipt
  seam, invoice orders kept out of `balance_due` and `finish_paying`, and deleting an account
  leaving issued invoices owed (its step 6). Whichever builds second applies these.
- **Stage 52** (Finance reports) and **stage 61** (Accounting sync): they read `rec_invoice`,
  `rec_credit_note`, the payments by method and the event log; stage 61 adds "In the books" to the
  invoice screen and opens `invoice.recordPayment` for "paid in the books". Neither writes to
  `invoices/` or `orders/`.
- **Stage 39** (Jobs, drafted): `about` points at a job; its proposed `billable` seam (lines claimed
  once by an invoice, released on void; a quote's acceptance moving the job) is built once, by
  whichever of 39 and a later step here comes first, when 39 is specced.
- **The till** (point of sale, drafted): the same shared payment step; a trade customer's monthly
  statement or account is out of scope here.
- **Issue #126** (payments taken in person): `invoice.recordPayment` covers invoices; the shared
  step's `order.recordPayment` covers other staff orders.
- **Stage 30** (Notifications): reminders move onto it when it exists.
