# ADR 0737: The shared PDF writer, the `invoice` attachment, host mail purpose `invoices`

Status: accepted, 2026-11-24 (stage 35, build step 1: the writer). Amends
[ADR 0645](0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md) (one PDF writer
of our own) and, at step 7, [ADR 0571](0571-a-calendar-file-made-by-the-email-gatekeeper.md) (the
gatekeeper's attachments). Stage 35's spec: "PDF" in the design, the platform work table, criteria
13 and 14, and row 1 of the build order.

## Context
Stage 44 built a PDF writer for the signed agreement (`packages/agreement-pdf`): PDF 1.4 with the
standard fonts, every text a hex string of WinAnsi bytes so nothing given becomes PDF structure,
the same values always the same bytes, no imports. Quotes, invoices, credit notes and receipts
need PDFs too, laid out in columns with right-aligned amounts, which the writer could not draw.
A second writer, or a library, would mean two things to keep safe where the hard part (the
encoding, the fonts, the file) already exists and is tested; a headless browser was rejected in
stage 44. A signed agreement's PDF is evidence, and its copy is already in people's inboxes: its
bytes must not move.

## Decision
- **One writer, renamed and split, not copied.** `packages/agreement-pdf` becomes
  `packages/pdf` (`@composable-os/pdf`), still with no dependencies:
  - `core.ts`, the safe core: the fonts and their widths, the WinAnsi encoding (control,
    bidirectional and zero-width characters dropped, what cannot be drawn is `?` and remembered),
    hex strings, fixed-precision numbers, the page and its cursor with line wrapping, and the file
    (`pdfFile`: catalog, pages, fonts, the info dictionary, the cross-reference table). The
    producer written into the file is a renderer's constant, checked to be plain words.
  - `table.ts`, a table layout: columns of a fixed width or the width left, aligned left or right,
    cells that wrap inside their column, a header row drawn again on every page the table runs
    onto, a row kept on one page when it fits and broken between its lines when it is taller than
    a page.
  - `agreement.ts`, the agreement renderer moved unchanged onto the core.
  - `document.ts`, the layout the money documents share, and two renderers on it:
    `invoice.ts` (`invoicePdf`: a quote, an invoice or a credit note) and `receipt.ts`
    (`receiptPdf`: a paid order that has no invoice, with the provider's tax at checkout inside
    the total, its payments and refunds).
  - `estimate.ts`, the agreement page estimate the host's core asks at publish, unchanged.
- **The agreements PDF's bytes are pinned.** `test/agreement-golden.test.ts` holds the SHA-256 of
  73 agreement fixtures (every block, mark, answer state, the blank form, hostile text, text the
  fonts cannot draw, long titles, many pages, odd strokes and seeded random documents) as the
  writer drew them before the split; the split changed none.
- **Money is drawn by the writer from minor units.** A renderer takes amounts as whole minor units
  with the currency (three capital letters) and its decimals (0 to 3), and formats them itself
  (`1,234.50`), so a caller never passes a formatted amount; an amount that is not a whole number
  is refused, never drawn wrong. Quantities are numbers, drawn with up to three decimals. The
  renderers do no tax arithmetic: the tax by rate, the total, what is paid and owed are the
  host's figures (ADR 0732), drawn as given; only the subtotal is the sum of the lines drawn.
- **Words that are the business's are given; the writer adds only its own labels.** The title
  ("Tax invoice", "Quote", "Receipt"), the business's and the bill-to's lines, a tax rate's name,
  dates, bank details, notes and the footer are values; the column headers and the total labels
  ("Subtotal (excluding tax)", "Total", "Amount due", "Includes …") are the writer's. No legal
  wording ships.
- **What each document shows.** An invoice: the business's details, title and number, bill-to and
  an optional site, its facts (issued, due, the quote it came from), the lines in columns (a tax
  column only when a line has a rate), deductions, tax by rate (added when amounts exclude tax,
  "includes" when they include it), the total, paid, credited when any and the amount due, its
  payments, how to pay and notes. A quote: the same without payments or amount due. A credit
  note: "Total credited", without payments or bank details. A logo is not drawn yet (out of
  scope).

### Built later in this stage, decided here
- **The `invoice` attachment** (step 7, amending ADR 0571 as ADR 0645 did): the email gatekeeper
  draws `invoicePdf` from values it checks and rebuilds (`validate.ts`), only for the host's
  invoices mail, as the agreement attachment is only for the host's agreements mail.
- **Host mail purpose `invoices`** (step 7): the quote, the invoice, a credit note, a receipt for
  a recorded payment and reminders go through `callAsHost` with it.
Step 7 amends this ADR with what it builds.

## Consequences
- The gatekeeper's bundle and the host's download route carry the invoice and receipt renderers
  beside the agreement one (a few hundred lines more); the host's core still carries only the
  estimate.
- Any change to `core.ts` or `agreement.ts` that moves a byte of an agreement fails the golden
  test. A deliberate change would need its own ADR and new hashes in the same PR; a signed copy
  already sent stays as it was.
- What an invoice, a credit note or a receipt must show to count as a tax invoice or a receipt is
  for each business to confirm with its accountant; the renderers draw what the host gives them.
- Not yet verified: the files opened in common viewers and printed (the tests read the file back
  and one render was checked by eye in a PDF library; spec risk "needs real things to verify").
