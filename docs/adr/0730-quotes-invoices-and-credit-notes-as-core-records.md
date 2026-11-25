# ADR 0730: Quotes, invoices and credit notes as core records: numbering, immutability, retention, the document event log

Status: accepted, 2026-11-24 (stage 35, build step 2: the records, numbering, settings, drafts and
the event log). Builds on ADRs [0402](0402-staff-and-customers.md) (audiences),
[0404](0404-behaviours-are-the-vocabulary.md) (a pack composes, it does not hook writes),
[0426](0426-who-moves-a-record-and-what-follows-a-move.md) (base records and who moves them),
[0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) (priced by the
host), [0449](0449-permissions-granted-one-by-one.md) (grants) and
[0625](0625-restricted-pack-permissions.md) (restricted permissions). Stage 35's spec: "The design
in one page", "Records", "Numbers and immutability", decision 11, criteria 1 to 3, 18 and 23, and
row 2 of the build order.

## Context
A business needs quotes, invoices and credit notes that are numbered without gaps, that never
change once a customer has been sent them, whose tax is shown, and that its accountant (and later
its accounting system) can read event by event. Gapless numbers, a document nobody can change, tax
and an order in the same batch, and a recorded payment are host rules; a pack cannot hook writes
(ADR 0404). So these are core records, like Order, with their own operations.

## Decision
- **Base records in core** (`packages/core/src/invoices/`, migration 1030): `core_quote`,
  `core_invoice`, `core_credit_note` and their lines, one table each (`core_quote_line`,
  `core_invoice_line`, `core_credit_note_line`). In the field registry as base objects `quote`,
  `invoice` and `creditNote` (`fields/invoice.ts`, beside Order): known to the seam, the audit
  log and `ctx.records.list`, not walked by search, embeddings, summaries or the generic record
  operations. Ids `qt_`, `inv_`, `cn_` (lines `qtl_`, `inl_`, `cnl_`).
- **Staff only for now.** No `customer` or `public` declaration and no operation open outside the
  staff: a customer's and the public's reads are step 8, a reviewed change (ADR 0402).
- **Drafts.** A draft has no number. Staff with `invoices:write` (and the assistant for them,
  through the gate as any write) create and change one: `quote.*` and `invoice.*`'s `create`,
  `update`, `addLine`, `updateLine`, `removeLine`, `delete`; `list` and `get` are `records:read`.
  A member, a customer, the public and an extension's own account hold no `invoices:write`, so
  none of them writes one. Every write of a document moves its `version` by one from the version
  read: the trigger refuses any other write (`core_document_stale`), whatever else it changes, the
  bill-to included. The one exception is an erase's `ON DELETE SET NULL`, which nulls the
  bill-to's ids and changes nothing else. A delete first moves the version it read, so a delete
  made from an older read fails whole, never deletes some lines and reports success. The totals
  are always recomputed from the lines in the write. At most an order's lines (50) per document,
  so the largest write (starting one with all of them, moving one so that every line is
  renumbered, switching between amounts with and without tax so that every line is priced again)
  is about 70 statements with at most 38 bound variables each (a statement-count test holds it).
- **Lines.** A line is a record of a sellable object, priced by the host when it is added with the
  read an order's line has (`priceLines`: the price, the currency, the sale window, the most per
  order), or a typed line (description, quantity in thousandths, unit, unit price, tax rate). A
  record's line takes no price from the caller, ever; money off is a discount on the line (an
  amount or a percentage, with why), never a negative line. A deduction line ("less deposit paid")
  is the host's only, on an invoice, naming the deposit invoice. Each line keeps its rate's key,
  rate and label as used, and where it came from (`source`, the record's object and id, its price
  as read). A record's line is whole units, at most an order line's most (1000), and every write
  that adds or changes one checks the document's record lines together as the one order an invoice
  becomes (`checkRecordLines`: the same `priceLines` as `order.start`, so the same item on two
  lines, more than a record's most per order and more grants than an order holds are refused):
  a draft that passes can be issued. A typed line may have a quantity to three decimals; how such
  a line becomes an order line is step 3's.
- **Numbering.** One series each (`core_document_counter`: `quote`, `invoice`, `credit_note`;
  `Q-`, `INV-`, `CN-` and 1 to start). A number is given in the batch that sends a quote or issues
  an invoice or a credit note, by SQL against the series row (`numberStatements`), never read first
  and written later: D1 runs batches one at a time, so twenty issues at once take twenty
  consecutive numbers, and a batch that fails takes none. The series moves on only while the
  document is still a draft, so one deleted meanwhile takes no number. The document's trigger
  refuses any number but the one the series just moved past, printed as the prefix and at least
  four digits (`INV-0042`), and a second number. A draft has no number, and a document that is not
  a draft has both the number and its seq; the printed number never changes apart from its seq. An
  `UPDATE OR REPLACE` onto another document's number (whose delete would fire no trigger) is
  refused before it runs. A unique index on the number holds it too.
- **The next number only goes up, and only by a human admin** (`invoice.settings.update`,
  `settings:manage`, `actors: ["human"]`), naming the series' version it read: a number given
  meanwhile moves the version and the change is refused. The counter's trigger refuses a lower
  number, a version that does not move by one, and any insert or delete of a series row. This is
  how a business carries on from the numbers it used before (decision 10).
- **Immutability.** Once a quote is sent, or an invoice or a credit note is issued, its trigger
  refuses any change to what it says: the number, the bill-to and the bill-to as printed, the site
  and what it is about, title and notes, the lines, totals and tax by rate, the currency and the
  tax mode, the dates it was given, the quote it came from, its order, its payment terms and the
  snapshot of the business. It never goes back to a draft and is never deleted; a final state
  (a quote accepted, declined, expired or withdrawn; an invoice credited or void) never moves.
  What may still
  move, by host code with the version moving: its state, the reminders, part payments allowed,
  and an invoice's due date (`invoice.setDueDate` changes it on an issued invoice, step 7; the
  spec's criterion 3 lists "dates": the issue date is fixed, the due date is not). Its lines'
  triggers refuse an insert, update or delete while the document is anything but a draft. Every
  table refuses an insert over an existing key, so an `INSERT OR REPLACE` (whose delete fires no
  trigger in D1) cannot get round them.
- **An erase detaches, it does not change.** The bill-to's ids reference `core_person` and
  `core_organisation` with `ON DELETE SET NULL`; that is the one change to an issued document's
  bill-to the trigger lets through, and the bill-to as printed stays.
- **Not yet: erase and merge (step 11).** Until step 11, an erase of a Person billed on a draft
  only nulls the id: the draft's site address, notes and line text stay, and a merge leaves
  documents on the merged-away Person (an issued document's bill-to cannot be re-pointed: the
  trigger refuses it). Step 11 deletes drafts and unsent quotes at erase, keeps issued documents
  for the settings' `retentionYears` (default 7), and amends both the delete triggers (for the
  purge) and the update triggers (for merge's re-point to the surviving Person). Nothing before
  step 11 is sent to a customer, so what a draft holds is staff's own working copy until then.
- **The document event log** (`core_invoice_event`, decision 11): one row per issue, send, payment
  applied or reversed, credit, refund confirmed, paid back and void, with the document (kind and
  id), the invoice it concerns, the payment row and its method, the amount, when and the staff
  account (null for the host's own). Host code queues it in the event's own batch
  (`eventStatement`), so the log and the documents always agree. `seq` is an AUTOINCREMENT key: it
  only grows and is never reused. The database refuses any update or delete of a row, an insert
  over an existing one, and a row below the newest (so a reader that has read up to a seq never
  misses one written after). `invoice.events` reads it by cursor, oldest first; it needs
  `invoices:payments` (what was paid, and how, is that permission's). Stage 52's `finance:read`
  joins it when stage 52 adds that permission. No row is written by this step: the events are
  written by the steps that make them (issue, payments, credits, sending).
- **A bill-to's organisation has its contact at it**: the contact Person has a current affiliation
  with the organisation (a customer later sees their organisation's documents where they are its
  named contact, step 8).
- **What dashboards and `query.sql` read**: `rec_quote`, `rec_invoice`, `rec_credit_note` carry
  numbers, states, kinds, dates, amounts and the bill-to's ids. Never an address, a tax number, an
  email, the title or notes, or the snapshot of the business (its bank details).
- **Permissions.** `invoices:write` (drafts), `invoices:send` (send, issue, an issued invoice's
  due date, part payments and reminders), `invoices:credit` (credit notes and void, a person only)
  and `invoices:payments` (recorded payments, the event log, the export) are core permissions:
  admins by role, grantable one by one (ADR 0449). `invoices:payments` is **restricted** (decision
  7, ADR 0625's rule for a core permission): a human admin grants it to another account, never to
  their own (`RESTRICTED_PERMISSIONS`).
- **The settings** (`invoice.settings.get`: `records:read`; `.update`: a human admin) are one row
  of `core_settings` (`invoice_settings`): the business's details and bank details as printed, the
  tax rates and the default (ADR 0732), whether amounts are typed with or without tax (with, by
  default, as every price on a record is, ADR 0479), payment terms (14 days, decision 6), quote
  validity (30 days), deposit invoices' terms (due on issue), the reminder schedule (on, the due
  date then 7 and 14 days after, decision 5), the threshold over which a recorded payment tells
  the admins (0: every one), the PDF footer and the retention period (7 years). No rate, wording or
  bank detail ships. **A change of bank details tells every admin** (a notice to each); the audit
  log and the notice show the labels and the last three characters of each detail, never the
  details in full (the input and the result are redacted in the audit log). Reading the settings,
  bank details included, is `records:read` as the spec says: they are printed on every invoice a
  customer is sent. The spec's "posted on the timeline": an
  org's settings have no record to post on, so the audit log is their history.

## Consequences
- Steps 3 to 7 build on this without a schema change for the documents: issuing calls
  `numberStatements` with the issue's columns (state, dates, the printed bill-to, the snapshot,
  the order), and each event step queues `eventStatement`.
- `invoice.fromQuote` (a draft from a sent quote) waits for step 6, where quotes are sent, and
  `creditNote.create` for step 5: the credit note's tables are here, its operations are not.
- A price-list item's category and own tax rate (the Invoicing pack's `invoicing.item`, step 10)
  are read when the pack declares them; until then a record's line has no category and takes the
  rate the caller names, or the default.
- Migration 1030 adds about 50 rows to `sqlite_master` (eight tables, their indexes and triggers,
  three views); the rows-read budgets no longer count the schema (PR #347), so none was raised.

## Checks that were broken on purpose (each made a test fail, then restored)
- The number trigger's `next_number - 1` made `next_number`: the twenty-at-once test failed.
- The counter's `NEW.version IS NOT OLD.version + 1` removed: the raw write that does not move the
  version passed, and the series test failed.
- `bill_to_name` left out of the invoice trigger's fixed columns: the immutability test failed.
- The event log's `AFTER INSERT` order check removed: the "row below the newest" test failed.
- The review of PR #386 (2026-11-24) found four ways round these rules, each now a test that
  failed on the code before its fix: a stale draft write that also changed the bill-to (the
  stale check exempted any bill-to change); a document issued with a number but no seq (outside
  the series); an `UPDATE OR REPLACE` onto a sent quote's number, which deleted it; a delete from
  an older read that deleted some lines and reported success. Also fixed then: record lines
  checked as one order, final states held by the trigger, an organisation's contact at it.

## Amendment, 2026-11-25 (stage 35 steps 3 to 5, ADRs 0731, 0733 and 0735)
Issuing (`invoice.issue`) calls `numberStatements` with the issue's columns and starts the order
after it in the same batch; the database makes an invoice's order only after its invoice is issued
and names it. A record's lines are checked with the goods rules too (`checkRecordLines`): goods are
refused on a document (they need a delivery). A deduction line is taken off the document's totals,
by its rate. Credit notes are drafted, issued and voided by their own operations. Every document
is read through the seam first (its `rec_*` view), then its table for the columns the view leaves
out and its lines (review of PR #460: step 2's table map is left for writes only, and the seam test lists these
reads). The event log's rows for payments,
credits, refunds confirmed, paid back and void are written by those steps.
