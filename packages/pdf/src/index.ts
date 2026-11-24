// The platform's PDF writer (ADR 0645, generalised by stage 35 step 1, ADR 0737): one safe core
// (`core.ts`: fonts, encoding, pages, the file), a table layout, and a renderer per document. No
// dependencies, so neither the host's core nor its runner carries more than it imports.
export * from "./agreement.ts";
export {
  DOCUMENT_PDF_MAX_LINES,
  formatMinor,
  formatQuantity,
  type PdfAmount,
  type PdfFact,
  type PdfLine,
  type PdfParty,
  type PdfPayment,
} from "./document.ts";
export * from "./invoice.ts";
export * from "./receipt.ts";
export type { PdfCell, PdfCellLine, PdfColumn, PdfTable } from "./table.ts";
