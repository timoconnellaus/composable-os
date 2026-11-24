// A quote, an invoice or a credit note as a PDF (stage 35 step 1, ADR 0737), on the layout the
// documents share (`document.ts`). The host builds these values from an issued document's own
// snapshot (bill-to as printed, lines, tax by rate, the business's and bank details at issue) and
// the email gatekeeper will draw the same values for the `invoice` attachment (step 7), so a
// download and the attachment are the same bytes. Every word that is the business's (the
// document's title, a tax rate's name, the footer) is given; the renderer adds only its column
// and total labels.
import {
  type PdfAmount,
  type PdfFact,
  type PdfLine,
  type PdfParty,
  type PdfPayment,
  type Statement,
  statementPages,
  statementPdf,
} from "./document.ts";

export interface InvoicePdf {
  kind: "quote" | "invoice" | "credit_note";
  /** The heading, as the business words it: "Tax invoice", "Quote", "Credit note". */
  title: string;
  number: string;
  business: PdfParty;
  billTo: PdfParty;
  /** Where the work is, when it is not the bill-to's address. */
  site?: PdfParty;
  /** Issued, due, valid until, the invoice a credit note credits, a reference. */
  facts: PdfFact[];
  currency: string;
  digits: number;
  taxMode: "exclusive" | "inclusive" | "none";
  lines: PdfLine[];
  /** "Less deposit paid (INV-0041)", as negative amounts. */
  adjustments?: PdfAmount[];
  /** The tax by rate. */
  taxes?: PdfAmount[];
  total: number;
  /** An invoice's: what is paid, credited and still owed. */
  paid?: number;
  credited?: number;
  due?: number;
  payments?: PdfPayment[];
  /** How to pay: the bank details as at issue. */
  bank?: PdfFact[];
  notes?: string[];
  footer?: string;
}

const TOTAL: Record<InvoicePdf["kind"], string> = {
  quote: "Total",
  invoice: "Total",
  credit_note: "Total credited",
};

function statement(doc: InvoicePdf): Statement {
  const after: (PdfAmount & { bold?: boolean })[] = [];
  if (doc.kind === "invoice") {
    if (doc.paid !== undefined) after.push({ label: "Paid", amount: doc.paid });
    if (doc.credited) after.push({ label: "Credited", amount: doc.credited });
    if (doc.due !== undefined) after.push({ label: "Amount due", amount: doc.due, bold: true });
  }
  return {
    title: doc.title,
    number: doc.number,
    business: doc.business,
    parties: [
      { heading: doc.kind === "quote" ? "For" : "Bill to", party: doc.billTo },
      ...(doc.site ? [{ heading: "Site", party: doc.site }] : []),
    ],
    facts: doc.facts,
    currency: doc.currency,
    digits: doc.digits,
    taxMode: doc.taxMode,
    lines: doc.lines,
    adjustments: doc.adjustments,
    taxes: doc.taxes,
    totalLabel: TOTAL[doc.kind],
    total: doc.total,
    after,
    payments: doc.kind === "invoice" ? [{ heading: "Payments", rows: doc.payments ?? [] }] : [],
    bank: doc.kind === "credit_note" ? [] : doc.bank,
    notes: doc.notes,
    footer: doc.footer,
    producer: "Composable OS invoices",
  };
}

/** How many pages `doc` takes, or throws when it is longer than the writer draws. */
export function invoicePdfPages(doc: InvoicePdf): number {
  return statementPages(statement(doc));
}

/** The PDF file of a quote, an invoice or a credit note. The same `doc` gives the same bytes. */
export function invoicePdf(doc: InvoicePdf): Uint8Array<ArrayBuffer> {
  return statementPdf(statement(doc));
}
