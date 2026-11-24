// A receipt as a PDF (stage 35 step 1, ADR 0737): a paid order that has no invoice, with its
// lines, the tax the payment provider worked out at checkout when there was any (ADR 0479: inside
// the prices, never the host's own figure), its payments and refunds. On the layout the documents
// share (`document.ts`). An invoice's order has no receipt of its own: its receipt is the
// invoice's PDF.
import {
  type PdfAmount,
  type PdfFact,
  type PdfParty,
  type PdfPayment,
  type Statement,
  statementPages,
  statementPdf,
} from "./document.ts";

export interface ReceiptPdf {
  /** The heading, as the business words it: "Receipt", "Tax receipt". */
  title: string;
  /** The order's reference. */
  reference: string;
  business: PdfParty;
  /** Whom it was for, when the order names someone. */
  customer?: PdfParty;
  /** The date it was paid, the order's date. */
  facts: PdfFact[];
  currency: string;
  digits: number;
  lines: {
    description: string;
    detail?: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }[];
  /** Money off the whole order, as negative amounts. */
  adjustments?: PdfAmount[];
  /** The provider's tax at checkout, inside the total. */
  taxes?: PdfAmount[];
  total: number;
  payments: PdfPayment[];
  refunds?: PdfPayment[];
  /** What is still owed, when anything is. */
  balance?: number;
  footer?: string;
}

function statement(doc: ReceiptPdf): Statement {
  const paid = doc.payments.reduce((sum, p) => sum + p.amount, 0);
  const refunded = (doc.refunds ?? []).reduce((sum, p) => sum + p.amount, 0);
  const after: (PdfAmount & { bold?: boolean })[] = [{ label: "Paid", amount: paid }];
  if (refunded) after.push({ label: "Refunded", amount: refunded });
  if (doc.balance) after.push({ label: "Still owed", amount: doc.balance, bold: true });
  return {
    title: doc.title,
    number: doc.reference,
    business: doc.business,
    parties: doc.customer ? [{ heading: "For", party: doc.customer }] : [],
    facts: doc.facts,
    currency: doc.currency,
    digits: doc.digits,
    taxMode: doc.taxes?.length ? "inclusive" : "none",
    lines: doc.lines,
    adjustments: doc.adjustments,
    taxes: doc.taxes,
    totalLabel: "Total",
    total: doc.total,
    after,
    payments: [
      { heading: "Payments", rows: doc.payments },
      { heading: "Refunds", rows: doc.refunds ?? [] },
    ],
    footer: doc.footer,
    producer: "Composable OS receipts",
  };
}

/** How many pages `doc` takes, or throws when it is longer than the writer draws. */
export function receiptPdfPages(doc: ReceiptPdf): number {
  return statementPages(statement(doc));
}

/** The PDF file of a receipt. The same `doc` always gives the same bytes. */
export function receiptPdf(doc: ReceiptPdf): Uint8Array<ArrayBuffer> {
  return statementPdf(statement(doc));
}
