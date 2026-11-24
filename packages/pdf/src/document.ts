// The layout a quote, an invoice, a credit note and a receipt share (stage 35 step 1, ADR 0737):
// the business at the top, the document's title and number, whom it is for, its facts (dates,
// references), its lines in columns, the totals with the tax by rate, what is paid and owed, the
// payments, how to pay and the business's own words at the end. Only `invoice.ts` and
// `receipt.ts` call it; each says what its document holds.
//
// Money is whole minor units (cents), drawn by this file with the currency's decimals, so a
// caller passes numbers it checked and never a formatted amount. An amount that is not a whole
// number, or a currency that is not three capital letters, is refused rather than drawn wrong.
// Dates and every label of the business's (a tax rate's name, a payment's method) are text.
import { encode, hex, Layout, LEFT, num, pdfFile, RIGHT, widthOf } from "./core.ts";
import { drawTable, type PdfCell, type PdfCellLine, type PdfColumn } from "./table.ts";

/** A business, or whom a document is for: a name and the lines under it (address, tax number). */
export interface PdfParty {
  name: string;
  lines?: readonly string[];
}

/** A label and its value: a date, a reference, a bank detail. */
export interface PdfFact {
  label: string;
  value: string;
}

/** An amount with its label: a tax rate's total, a deduction, a payment. */
export interface PdfAmount {
  label: string;
  amount: number;
}

/** A payment or a refund: when, how, and how much. */
export interface PdfPayment {
  date: string;
  label: string;
  amount: number;
}

export interface PdfLine {
  description: string;
  /** A second, grey line under the description. */
  detail?: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  /** The tax rate's name, as the business set it. */
  taxLabel?: string;
  /** Money off this line, already taken out of `amount`. */
  discount?: number;
  /** The line's amount, after any discount. */
  amount: number;
}

/** What the layout draws, as the renderers give it. */
export interface Statement {
  title: string;
  number: string;
  business: PdfParty;
  parties: { heading: string; party: PdfParty }[];
  facts: readonly PdfFact[];
  currency: string;
  /** The currency's decimals: 2 for most, 0 for some. */
  digits: number;
  /** Whether the lines' amounts are with or without tax, or no tax is shown. */
  taxMode: "exclusive" | "inclusive" | "none";
  lines: readonly PdfLine[];
  /** After the lines, before tax: a deposit paid, money off the whole. */
  adjustments?: readonly PdfAmount[];
  /** By rate. Added to the total when exclusive, inside it when inclusive. */
  taxes?: readonly PdfAmount[];
  totalLabel: string;
  total: number;
  /** After the total: paid, credited, what is owed. */
  after?: readonly (PdfAmount & { bold?: boolean })[];
  payments?: { heading: string; rows: readonly PdfPayment[] }[];
  bank?: readonly PdfFact[];
  notes?: readonly string[];
  footer?: string;
  producer: string;
}

/** A borderless table's left edge: its text flush with the margin, past the cell's padding. */
const FLUSH = LEFT - 4;

/** The most lines a document may hold: more is refused, not drawn. */
export const DOCUMENT_PDF_MAX_LINES = 1000;

/** `amount` minor units as text with `digits` decimals: `-1,234.50`. */
export function formatMinor(amount: number, digits: number): string {
  if (!Number.isSafeInteger(amount)) throw new Error("An amount is a whole number of minor units");
  const negative = amount < 0;
  const raw = String(Math.abs(amount)).padStart(digits + 1, "0");
  const whole = raw.slice(0, raw.length - digits);
  const fraction = raw.slice(raw.length - digits);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${digits ? `.${fraction}` : ""}`;
}

/** A quantity: up to three decimals, trailing zeros dropped. */
export function formatQuantity(quantity: number): string {
  if (!Number.isFinite(quantity)) throw new Error("A quantity is a number");
  return (Math.round(quantity * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "") || "0";
}

function checkMoney(doc: Statement): void {
  if (!/^[A-Z]{3}$/.test(doc.currency)) throw new Error("A currency is three capital letters");
  if (!Number.isInteger(doc.digits) || doc.digits < 0 || doc.digits > 3) {
    throw new Error("A currency has 0 to 3 decimals");
  }
  if (doc.lines.length > DOCUMENT_PDF_MAX_LINES) throw new Error("The document has too many lines");
}

function heading(layout: Layout, text: string): void {
  layout.space(10);
  layout.ensure(40);
  layout.paragraph([[{ font: "F2", text }]], LEFT, 11, { leading: 15 });
  layout.space(1);
}

const partyCell = (heading: string, party: PdfParty): PdfCellLine[] => [
  { text: heading, bold: true, grey: true },
  { text: party.name, bold: true },
  ...(party.lines ?? []).map((text) => ({ text })),
];

function facts(layout: Layout, rows: readonly PdfFact[]): void {
  if (!rows.length) return;
  drawTable(layout, {
    columns: [
      { header: "", width: 130, align: "left" },
      { header: "", width: "fill", align: "left" },
    ],
    rows: rows.map((f) => [[{ text: f.label, bold: true }], f.value]),
    header: false,
    rules: false,
    left: FLUSH,
  });
}

function linesTable(layout: Layout, doc: Statement): void {
  const money = (n: number) => formatMinor(n, doc.digits);
  const anyTax = doc.taxMode !== "none" && doc.lines.some((l) => l.taxLabel);
  const columns: PdfColumn[] = [
    { header: "Description", width: "fill", align: "left" },
    { header: "Qty", width: 52, align: "right" },
    { header: "Unit price", width: 72, align: "right" },
    ...(anyTax ? [{ header: "Tax", width: 64, align: "left" as const }] : []),
    { header: `Amount ${doc.currency}`, width: 82, align: "right" },
  ];
  const rows = doc.lines.map((line): PdfCell[] => {
    const description: PdfCellLine[] = [{ text: line.description }];
    if (line.detail) description.push({ text: line.detail, grey: true });
    if (line.discount) description.push({ text: `Less ${money(line.discount)} off`, grey: true });
    return [
      description,
      `${formatQuantity(line.quantity)}${line.unit ? ` ${line.unit}` : ""}`,
      money(line.unitPrice),
      ...(anyTax ? [line.taxLabel ?? ""] : []),
      money(line.amount),
    ];
  });
  if (!rows.length) {
    layout.paragraph([[{ font: "F3", text: "No lines." }]], LEFT, 9.5);
    return;
  }
  drawTable(layout, { columns, rows });
  if (doc.taxMode !== "none") {
    layout.space(2);
    layout.paragraph(
      [
        [
          {
            font: "F3",
            text: doc.taxMode === "inclusive" ? "Amounts include tax." : "Amounts exclude tax.",
          },
        ],
      ],
      LEFT,
      8.5,
      { grey: true },
    );
  }
}

function totals(layout: Layout, doc: Statement): void {
  const money = (n: number) => formatMinor(n, doc.digits);
  const rows: PdfCell[][] = [];
  const taxes = doc.taxMode === "none" ? [] : (doc.taxes ?? []);
  const adjustments = doc.adjustments ?? [];
  if (adjustments.length || (taxes.length && doc.taxMode === "exclusive")) {
    const subtotal = doc.lines.reduce((sum, l) => sum + l.amount, 0);
    rows.push([
      "",
      doc.taxMode === "exclusive" ? "Subtotal (excluding tax)" : "Subtotal",
      money(subtotal),
    ]);
  }
  for (const a of adjustments) rows.push(["", a.label, money(a.amount)]);
  if (doc.taxMode === "exclusive") for (const t of taxes) rows.push(["", t.label, money(t.amount)]);
  rows.push([
    "",
    [{ text: `${doc.totalLabel} ${doc.currency}`, bold: true }],
    [{ text: money(doc.total), bold: true }],
  ]);
  if (doc.taxMode === "inclusive") {
    for (const t of taxes) {
      rows.push([
        "",
        [{ text: `Includes ${t.label}`, grey: true }],
        [{ text: money(t.amount), grey: true }],
      ]);
    }
  }
  for (const a of doc.after ?? []) {
    rows.push(["", [{ text: a.label, bold: a.bold }], [{ text: money(a.amount), bold: a.bold }]]);
  }
  layout.space(4);
  drawTable(layout, {
    columns: [
      { header: "", width: "fill", align: "left" },
      { header: "", width: 190, align: "right" },
      { header: "", width: 82, align: "right" },
    ],
    rows,
    header: false,
    rules: false,
    size: 10,
  });
}

function payments(layout: Layout, doc: Statement): void {
  for (const group of doc.payments ?? []) {
    if (!group.rows.length) continue;
    heading(layout, group.heading);
    drawTable(layout, {
      columns: [
        { header: "Date", width: 110, align: "left" },
        { header: "How", width: "fill", align: "left" },
        { header: `Amount ${doc.currency}`, width: 82, align: "right" },
      ],
      rows: group.rows.map((p) => [p.date, p.label, formatMinor(p.amount, doc.digits)]),
    });
  }
}

function footer(doc: Statement, index: number, count: number): string {
  const size = 7.5;
  const tail = ` · ${doc.title} ${doc.number} · page ${index + 1} of ${count}`;
  const tailBytes = encode(tail).bytes;
  let name = encode(doc.business.name).bytes;
  const room = RIGHT - LEFT - widthOf(tailBytes, "F1", size);
  if (widthOf(name, "F1", size) > room) {
    const dots = encode("...").bytes;
    while (name.length && widthOf([...name, ...dots], "F1", size) > room) name = name.slice(0, -1);
    name = [...name, ...dots];
  }
  return [
    "0.35 g",
    `BT /F1 ${num(size)} Tf ${num(LEFT)} 40 Td ${hex([...name, ...tailBytes])} Tj ET`,
    "0 g",
  ].join("\n");
}

function layoutPages(doc: Statement): string[] {
  checkMoney(doc);
  const layout = new Layout("The document is too long for a PDF");
  layout.paragraph([[{ font: "F2", text: doc.business.name }]], LEFT, 13, { leading: 17 });
  for (const line of doc.business.lines ?? []) {
    layout.paragraph([[{ font: "F1", text: line }]], LEFT, 9, { grey: true });
  }
  layout.space(12);
  layout.paragraph([[{ font: "F2", text: doc.title }]], LEFT, 18, { leading: 23 });
  layout.paragraph([[{ font: "F1", text: doc.number }]], LEFT, 12, { leading: 16 });
  layout.rule(LEFT, RIGHT, 0.75);
  if (doc.parties.length) {
    const half = (RIGHT - LEFT) / 2;
    drawTable(layout, {
      columns: doc.parties.map((_, i) => ({
        header: "",
        width: i === doc.parties.length - 1 ? ("fill" as const) : half,
        align: "left" as const,
      })),
      rows: [doc.parties.map((p) => partyCell(p.heading, p.party))],
      header: false,
      rules: false,
      size: 10,
      left: FLUSH,
    });
    layout.space(4);
  }
  facts(layout, doc.facts);
  layout.space(8);
  linesTable(layout, doc);
  totals(layout, doc);
  payments(layout, doc);
  if (doc.bank?.length) {
    heading(layout, "How to pay");
    facts(layout, doc.bank);
  }
  if (doc.notes?.length) {
    heading(layout, "Notes");
    for (const note of doc.notes) {
      layout.paragraph([[{ font: "F1", text: note }]], LEFT, 10);
      layout.space(3);
    }
  }
  if (doc.footer) {
    layout.space(10);
    layout.paragraph([[{ font: "F1", text: doc.footer }]], LEFT, 8.5, { grey: true });
  }
  if (layout.lossy) {
    layout.space(8);
    layout.paragraph(
      [
        [
          {
            font: "F3",
            text: "Some characters could not be drawn in this file and are shown as ?.",
          },
        ],
      ],
      LEFT,
      9,
    );
  }
  const count = layout.pages.length;
  return layout.pages.map((ops, i) => `${ops.join("\n")}\n${footer(doc, i, count)}\n`);
}

/** How many pages the document takes. */
export function statementPages(doc: Statement): number {
  return layoutPages(doc).length;
}

/** The PDF file of the document. The same values always give the same bytes. */
export function statementPdf(doc: Statement): Uint8Array<ArrayBuffer> {
  return pdfFile(layoutPages(doc), { title: `${doc.title} ${doc.number}`, producer: doc.producer });
}
