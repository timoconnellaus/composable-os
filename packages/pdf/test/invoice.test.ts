// The invoice, quote, credit note and receipt renderers and the table under them (stage 35 step 1,
// criterion 13 for the drawing; ADR 0737). Fixture businesses, people and figures only.
import { describe, expect, it } from "vitest";
import { encode, RIGHT, widthOf } from "../src/core.ts";
import {
  formatMinor,
  formatQuantity,
  type InvoicePdf,
  invoicePdf,
  invoicePdfPages,
  type PdfLine,
  type ReceiptPdf,
  receiptPdf,
} from "../src/index.ts";
import { drawn, drawnText, pageCount, structure } from "./read.ts";

const invoice: InvoicePdf = {
  kind: "invoice",
  title: "Tax invoice",
  number: "INV-0042",
  business: {
    name: "Fixture Trades",
    lines: ["1 Fixture Street, Fixtureville", "Tax number 00 000 000 000", "accounts@trades.test"],
  },
  billTo: { name: "Fixture Customer", lines: ["2 Sample Road", "Sampletown"] },
  site: { name: "Fixture site", lines: ["3 Example Lane"] },
  facts: [
    { label: "Issued", value: "24 Nov 2026" },
    { label: "Due", value: "8 Dec 2026" },
    { label: "Quote", value: "Q-0007" },
  ],
  currency: "AUD",
  digits: 2,
  taxMode: "exclusive",
  lines: [
    {
      description: "Fixture labour",
      detail: "Two people",
      quantity: 2.5,
      unit: "h",
      unitPrice: 9_000,
      taxLabel: "Rate A 10%",
      amount: 22_500,
    },
    {
      description: "Fixture part",
      quantity: 1,
      unitPrice: 123_456,
      taxLabel: "Rate A 10%",
      discount: 3_456,
      amount: 120_000,
    },
    { description: "Fixture permit fee", quantity: 1, unitPrice: 5_000, amount: 5_000 },
  ],
  adjustments: [{ label: "Less deposit paid (INV-0041)", amount: -20_000 }],
  taxes: [{ label: "Rate A 10%", amount: 12_250 }],
  total: 139_750,
  paid: 50_000,
  credited: 0,
  due: 89_750,
  payments: [{ date: "1 Dec 2026", label: "Bank transfer", amount: 50_000 }],
  bank: [
    { label: "Account name", value: "Fixture Trades" },
    { label: "Account number", value: "000 000 0000" },
    { label: "Reference", value: "INV-0042" },
  ],
  notes: ["Fixture note for the customer."],
  footer: "Fixture footer wording, as the business writes it.",
};

const receipt: ReceiptPdf = {
  title: "Receipt",
  reference: "ord_fixture1",
  business: { name: "Fixture Studio", lines: ["4 Studio Street"] },
  customer: { name: "Fixture Member" },
  facts: [{ label: "Paid", value: "24 Nov 2026" }],
  currency: "AUD",
  digits: 2,
  lines: [
    { description: "Fixture class pass", quantity: 1, unitPrice: 15_000, amount: 15_000 },
    { description: "Fixture towel", quantity: 2, unitPrice: 500, amount: 1_000 },
  ],
  taxes: [{ label: "Tax", amount: 1_455 }],
  total: 16_000,
  payments: [{ date: "24 Nov 2026", label: "Card", amount: 16_000 }],
  refunds: [{ date: "25 Nov 2026", label: "Card", amount: 1_000 }],
};

/** Where a drawn piece of text ends across the page. */
const rightEdge = (d: { x: number; text: string }, size: number, bold = false) =>
  d.x + widthOf(encode(d.text).bytes, bold ? "F2" : "F1", size);

describe("an invoice's PDF", () => {
  it("shows the business, the number, the dates, the lines, tax by rate, totals, paid and owed, and bank details", () => {
    const text = drawnText(invoicePdf(invoice));
    for (const words of [
      "Fixture Trades",
      "Tax number 00 000 000 000",
      "Tax invoice",
      "INV-0042",
      "Bill to",
      "Fixture Customer",
      "Site",
      "3 Example Lane",
      "Issued",
      "24 Nov 2026",
      "Due",
      "8 Dec 2026",
      "Description",
      "Qty",
      "Unit price",
      "Amount AUD",
      "Fixture labour",
      "Two people",
      "2.5 h",
      "90.00",
      "225.00",
      "1,234.56",
      "Less 34.56 off",
      "1,200.00",
      "Subtotal (excluding tax)",
      "1,475.00",
      "Less deposit paid (INV-0041)",
      "-200.00",
      "Rate A 10%",
      "122.50",
      "Total AUD",
      "1,397.50",
      "Paid",
      "500.00",
      "Amount due",
      "897.50",
      "Payments",
      "Bank transfer",
      "How to pay",
      "Account number",
      "000 000 0000",
      "Fixture note for the customer.",
      "Fixture footer wording",
      "page 1 of 1",
    ]) {
      expect(text, words).toContain(words);
    }
    // Nothing credited is not shown; amounts exclude tax and the file says so.
    expect(text).not.toContain("Credited");
    expect(text).toContain("Amounts exclude tax.");
  });

  it("draws the amounts in right-aligned columns", () => {
    const pieces = drawn(invoicePdf(invoice));
    const amounts = ["225.00", "1,200.00", "50.00"].map((t) =>
      pieces.findLast((d) => d.text === t),
    );
    const header = pieces.find((d) => d.text === "Amount AUD");
    expect(header).toBeDefined();
    const edges = [
      rightEdge(header as never, 9.5, true),
      ...amounts.map((d) => rightEdge(d as never, 9.5)),
    ];
    // Every amount ends where its column ends, at the margin less the cell's padding.
    for (const edge of edges) expect(edge).toBeCloseTo(RIGHT - 4, 0);
    // And each line's cells sit on its own baseline, the rows going down the page.
    const labour = pieces.find((d) => d.text === "Fixture labour");
    expect(amounts[0]?.y).toBe(labour?.y);
    expect((amounts[1]?.y ?? 0) < (amounts[0]?.y ?? 0)).toBe(true);
  });

  it("makes the same bytes from the same values, and different bytes from different ones", () => {
    const a = invoicePdf(invoice);
    expect([...invoicePdf(structuredClone(invoice))]).toEqual([...a]);
    expect([...invoicePdf({ ...invoice, due: 89_751 })]).not.toEqual([...a]);
    expect(structure(a)).toContain("/Producer (Composable OS invoices)");
  });

  it("turns nothing in the business's or the customer's words into PDF structure", () => {
    const hostile = [
      ") Tj ET BT /F1 99 Tf (owned) Tj ET (",
      "\\) Tj\nendstream\nendobj\n9 0 obj << /Type /Action /S /JavaScript /JS (app.alert(1)) >>",
      "<< /OpenAction << /S /URI /URI (https://evil.test) >> >>",
      "%%EOF\nxref\ntrailer << /Root 9 0 R >>",
      "‮gnp.exe‬ and ​​",
    ];
    const bytes = invoicePdf({
      ...invoice,
      title: hostile[0] as string,
      number: hostile[1] as string,
      business: { name: hostile[2] as string, lines: hostile },
      billTo: { name: hostile[3] as string, lines: hostile },
      facts: hostile.map((value, i) => ({ label: `Fact ${i}`, value })),
      lines: hostile.map((description) => ({
        description,
        detail: description,
        quantity: 1,
        unit: description,
        unitPrice: 100,
        taxLabel: description,
        amount: 100,
      })),
      taxes: hostile.map((label) => ({ label, amount: 1 })),
      bank: hostile.map((value) => ({ label: value, value })),
      notes: hostile,
      footer: hostile[4],
    });
    const file = structure(bytes);
    expect(file.match(/\d+ 0 obj/g)?.length).toBe(file.match(/endobj/g)?.length);
    expect(file.match(/endstream/g)?.length).toBe(pageCount(bytes));
    expect(file.match(/trailer/g)?.length).toBe(1);
    expect(file.match(/%%EOF/g)?.length).toBe(1);
    for (const word of ["/JavaScript", "/OpenAction", "/URI", "/Action", "owned", "evil"]) {
      expect(file, word).not.toContain(word);
    }
    const text = drawnText(bytes);
    expect(text).toContain("/S /JavaScript");
    expect(text).toContain("gnp.exe and");
    expect(text).not.toMatch(/[‪-‮​]/);
  });

  it("runs onto more pages with the column headers again on each, and every page numbered", () => {
    const lines = Array.from({ length: 140 }, (_, i) => ({
      description: `Fixture line ${i} `.repeat(i % 7 === 0 ? 12 : 1),
      quantity: 1,
      unitPrice: 100,
      amount: 100,
    }));
    const bytes = invoicePdf({ ...invoice, lines });
    const pages = pageCount(bytes);
    expect(pages).toBeGreaterThan(3);
    expect(invoicePdfPages({ ...invoice, lines })).toBe(pages);
    const text = drawnText(bytes);
    expect(text.split("Unit price").length - 1).toBe(pages);
    expect(text).toContain(`Tax invoice INV-0042 · page ${pages} of ${pages}`);
    for (let i = 0; i < 140; i++) expect(text).toContain(`Fixture line ${i}`);
  });

  it("breaks a line taller than a page between its lines, never losing a word", () => {
    const words = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" ");
    const bytes = invoicePdf({
      ...invoice,
      lines: [{ description: words, quantity: 1, unitPrice: 1, amount: 1 }],
    });
    expect(pageCount(bytes)).toBeGreaterThan(1);
    const text = drawnText(bytes);
    expect(text).toContain("w0 ");
    expect(text).toContain("w3999");
  });

  it("draws what the standard fonts cannot as ?, and says so", () => {
    const text = drawnText(invoicePdf({ ...invoice, billTo: { name: "名前 Zoë" } }));
    expect(text).toContain("?? Zoë");
    expect(text).toContain("could not be drawn in this file");
    expect(drawnText(invoicePdf(invoice))).not.toContain("could not be drawn");
  });

  it("refuses money it cannot draw exactly, rather than drawing it wrong", () => {
    expect(() => invoicePdf({ ...invoice, total: 1.5 })).toThrow(/whole number/);
    expect(() => invoicePdf({ ...invoice, due: Number.NaN })).toThrow(/whole number/);
    expect(() => invoicePdf({ ...invoice, currency: "aud" })).toThrow(/currency/);
    expect(() => invoicePdf({ ...invoice, digits: 4 })).toThrow(/decimals/);
    expect(() =>
      invoicePdf({
        ...invoice,
        lines: [{ ...(invoice.lines[0] as PdfLine), quantity: Number.POSITIVE_INFINITY }],
      }),
    ).toThrow(/quantity/);
  });

  it("with amounts including tax, shows the tax inside the total", () => {
    const text = drawnText(
      invoicePdf({ ...invoice, taxMode: "inclusive", adjustments: [], total: 152_000 }),
    );
    expect(text).toContain("Includes Rate A 10%");
    expect(text).toContain("Amounts include tax.");
    expect(text).not.toContain("Subtotal");
  });

  it("with no tax, shows no tax column and no tax line", () => {
    const text = drawnText(invoicePdf({ ...invoice, taxMode: "none", taxes: [], adjustments: [] }));
    expect(text).not.toContain("Rate A");
    expect(text).not.toContain("Amounts ");
  });
});

describe("a quote's and a credit note's PDF", () => {
  it("a quote is for its customer and has no payments or amount due", () => {
    const text = drawnText(
      invoicePdf({
        ...invoice,
        kind: "quote",
        title: "Quote",
        number: "Q-0007",
        facts: [{ label: "Valid until", value: "24 Dec 2026" }],
      }),
    );
    expect(text).toContain("Quote");
    expect(text).toContain("Valid until");
    expect(text).toContain("For");
    expect(text).not.toContain("Bill to");
    expect(text).not.toContain("Amount due");
    expect(text).not.toContain("Payments");
  });

  it("a credit note says what it credits and carries no bank details", () => {
    const text = drawnText(
      invoicePdf({
        ...invoice,
        kind: "credit_note",
        title: "Credit note",
        number: "CN-0003",
        facts: [{ label: "Credits", value: "INV-0042" }],
        adjustments: [],
      }),
    );
    expect(text).toContain("CN-0003");
    expect(text).toContain("Credits");
    expect(text).toContain("Total credited AUD");
    expect(text).not.toContain("How to pay");
    expect(text).not.toContain("Amount due");
  });
});

describe("a receipt's PDF", () => {
  it("shows the order's lines, the provider's tax inside the total, payments and refunds", () => {
    const bytes = receiptPdf(receipt);
    const text = drawnText(bytes);
    for (const words of [
      "Fixture Studio",
      "Receipt",
      "ord_fixture1",
      "Fixture Member",
      "Fixture class pass",
      "150.00",
      "Total AUD",
      "160.00",
      "Includes Tax",
      "14.55",
      "Payments",
      "Card",
      "Refunds",
      "Refunded",
      "10.00",
    ]) {
      expect(text, words).toContain(words);
    }
    expect(text).not.toContain("Still owed");
    expect(structure(bytes)).toContain("/Producer (Composable OS receipts)");
    expect([...receiptPdf(structuredClone(receipt))]).toEqual([...bytes]);
  });

  it("without tax at checkout shows no tax", () => {
    const text = drawnText(receiptPdf({ ...receipt, taxes: [], refunds: [] }));
    expect(text).not.toContain("Includes");
    expect(text).not.toContain("Refunds");
  });
});

describe("money and quantities", () => {
  it.each([
    [0, 2, "0.00"],
    [5, 2, "0.05"],
    [-5, 2, "-0.05"],
    [123_456_789, 2, "1,234,567.89"],
    [1_000, 0, "1,000"],
    [1_234_567, 3, "1,234.567"],
    [-100_000, 2, "-1,000.00"],
  ])("%d minor units with %d decimals is %s", (amount, digits, shown) => {
    expect(formatMinor(amount, digits)).toBe(shown);
  });

  it.each([
    [1, "1"],
    [2.5, "2.5"],
    [0.3333, "0.333"],
    [10.1, "10.1"],
  ])("quantity %d is %s", (quantity, shown) => {
    expect(formatQuantity(quantity)).toBe(shown);
  });
});
