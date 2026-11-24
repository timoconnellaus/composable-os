// Stage 35 criterion 5 (ADR 0732), the table: tax worked out by the host on documents. Each line's
// tax rounded half up to the minor unit; added on top when amounts are typed without tax, taken
// out when typed with it; a discount taken off before the tax; a document's tax the sum of its
// lines', by rate; a deposit's share of a quote split over its rates to the cent. Worked examples
// for a business's accountant to check, not anyone's real rates.
import { describe, expect, it } from "vitest";
import {
  depositShares,
  documentTotals,
  lineAmounts,
  mulDivHalfUp,
  unitPriceFromRecord,
} from "../src/index.ts";

type Mode = "exclusive" | "inclusive";
type Case = [
  string,
  {
    unitPrice: number;
    quantityMilli: number;
    rate: number;
    mode: Mode;
    discount?: { kind: "amount" | "percent"; value: number };
  },
  { gross: number; discount: number; net: number; tax: number; total: number },
];

const CASES: Case[] = [
  [
    "10% on top of 10.00",
    { unitPrice: 1000, quantityMilli: 1000, rate: 1000, mode: "exclusive" },
    { gross: 1000, discount: 0, net: 1000, tax: 100, total: 1100 },
  ],
  [
    "three of 3.33, tax 99.9 rounds up",
    { unitPrice: 333, quantityMilli: 3000, rate: 1000, mode: "exclusive" },
    { gross: 999, discount: 0, net: 999, tax: 100, total: 1099 },
  ],
  [
    "15% of 10.05 is 1.5075: 1.51",
    { unitPrice: 1005, quantityMilli: 1000, rate: 1500, mode: "exclusive" },
    { gross: 1005, discount: 0, net: 1005, tax: 151, total: 1156 },
  ],
  [
    "exactly half a cent rounds up",
    { unitPrice: 5, quantityMilli: 1000, rate: 1000, mode: "exclusive" },
    { gross: 5, discount: 0, net: 5, tax: 1, total: 6 },
  ],
  [
    "one and a half hours of 3.33 is 4.995: 5.00",
    { unitPrice: 333, quantityMilli: 1500, rate: 0, mode: "exclusive" },
    { gross: 500, discount: 0, net: 500, tax: 0, total: 500 },
  ],
  [
    "2.00 off, then 10% on the rest",
    {
      unitPrice: 1000,
      quantityMilli: 1000,
      rate: 1000,
      mode: "exclusive",
      discount: { kind: "amount", value: 200 },
    },
    { gross: 1000, discount: 200, net: 800, tax: 80, total: 880 },
  ],
  [
    "12.5% off 9.99 is 1.24875: 1.25 off, then tax on 8.74",
    {
      unitPrice: 999,
      quantityMilli: 1000,
      rate: 1000,
      mode: "exclusive",
      discount: { kind: "percent", value: 1250 },
    },
    { gross: 999, discount: 125, net: 874, tax: 87, total: 961 },
  ],
  [
    "a discount larger than the line takes it to nothing",
    {
      unitPrice: 100,
      quantityMilli: 1000,
      rate: 1000,
      mode: "exclusive",
      discount: { kind: "amount", value: 500 },
    },
    { gross: 100, discount: 100, net: 0, tax: 0, total: 0 },
  ],
  [
    "11.00 with 10% inside: 1.00 of tax",
    { unitPrice: 1100, quantityMilli: 1000, rate: 1000, mode: "inclusive" },
    { gross: 1100, discount: 0, net: 1000, tax: 100, total: 1100 },
  ],
  [
    "10.00 with 10% inside: 0.9090… rounds to 0.91",
    { unitPrice: 1000, quantityMilli: 1000, rate: 1000, mode: "inclusive" },
    { gross: 1000, discount: 0, net: 909, tax: 91, total: 1000 },
  ],
  [
    "0.05 with 10% inside: 0.0045… rounds to nothing",
    { unitPrice: 5, quantityMilli: 1000, rate: 1000, mode: "inclusive" },
    { gross: 5, discount: 0, net: 5, tax: 0, total: 5 },
  ],
  [
    "10% off 22.00 with tax inside, then the tax of 19.80",
    {
      unitPrice: 2200,
      quantityMilli: 1000,
      rate: 1000,
      mode: "inclusive",
      discount: { kind: "percent", value: 1000 },
    },
    { gross: 2200, discount: 220, net: 1800, tax: 180, total: 1980 },
  ],
  [
    "20% inside 7 × 1.99",
    { unitPrice: 199, quantityMilli: 7000, rate: 2000, mode: "inclusive" },
    { gross: 1393, discount: 0, net: 1161, tax: 232, total: 1393 },
  ],
  [
    "no tax",
    { unitPrice: 4999, quantityMilli: 2000, rate: 0, mode: "inclusive" },
    { gross: 9998, discount: 0, net: 9998, tax: 0, total: 9998 },
  ],
];

describe("a line's tax", () => {
  it.each(CASES)("%s", (_name, terms, expected) => {
    expect(lineAmounts(terms)).toEqual(expected);
  });

  it("never rounds through a float, however large the line", () => {
    // 10,000 units of 1,000,000.00 at 10% on top: exact in integers.
    expect(
      lineAmounts({
        unitPrice: 100_000_000,
        quantityMilli: 10_000_000,
        rate: 1000,
        mode: "exclusive",
      }),
    ).toEqual({
      gross: 1_000_000_000_000,
      discount: 0,
      net: 1_000_000_000_000,
      tax: 100_000_000_000,
      total: 1_100_000_000_000,
    });
    expect(mulDivHalfUp(1, 1, 2)).toBe(1);
    expect(mulDivHalfUp(1, 1, 3)).toBe(0);
    expect(() => mulDivHalfUp(-1, 1, 2)).toThrow(RangeError);
  });

  it("a record's price, which includes tax, is worked back to its net on a document without tax", () => {
    expect(unitPriceFromRecord(1200, 1000, "exclusive")).toBe(1091);
    expect(unitPriceFromRecord(1100, 1000, "exclusive")).toBe(1000);
    expect(unitPriceFromRecord(1200, 1000, "inclusive")).toBe(1200);
    expect(unitPriceFromRecord(1200, 0, "exclusive")).toBe(1200);
  });
});

describe("a document's totals", () => {
  it("are the sums of its lines, shown by rate in the order the lines use them", () => {
    const totals = documentTotals([
      { taxKey: "std", taxLabel: "Standard", taxRate: 1000, net: 1000, tax: 100, total: 1100 },
      { taxKey: "free", taxLabel: "Free", taxRate: 0, net: 500, tax: 0, total: 500 },
      { taxKey: null, taxLabel: null, taxRate: 0, net: 250, tax: 0, total: 250 },
      { taxKey: "std", taxLabel: "Standard", taxRate: 1000, net: 999, tax: 100, total: 1099 },
    ]);
    expect(totals).toEqual({
      net: 2749,
      tax: 200,
      total: 2949,
      byRate: [
        { key: "std", label: "Standard", rate: 1000, net: 1999, tax: 200, total: 2199 },
        { key: "free", label: "Free", rate: 0, net: 500, tax: 0, total: 500 },
      ],
    });
  });
});

describe("a deposit's share of a quote", () => {
  it("is split over the rates in proportion, and its tax in the same proportion", () => {
    const quote = documentTotals([
      { taxKey: "std", taxLabel: "Standard", taxRate: 1000, net: 10000, tax: 1000, total: 11000 },
      { taxKey: null, taxLabel: null, taxRate: 0, net: 5000, tax: 0, total: 5000 },
    ]);
    // A 25% deposit of 160.00.
    expect(depositShares(quote, 4000)).toEqual({
      untaxed: 1250,
      byRate: [{ key: "std", label: "Standard", rate: 1000, net: 2500, tax: 250, total: 2750 }],
    });
  });

  it("adds up to the deposit to the cent, the cent left over going to the largest remainder", () => {
    const quote = documentTotals([
      { taxKey: "a", taxLabel: "A", taxRate: 1000, net: 1000, tax: 100, total: 1100 },
      { taxKey: "b", taxLabel: "B", taxRate: 2000, net: 1833, tax: 367, total: 2200 },
    ]);
    const shares = depositShares(quote, 1000);
    expect(shares.byRate.map((r) => r.total)).toEqual([333, 667]);
    expect(shares.byRate.map((r) => r.tax)).toEqual([30, 111]);
    expect(shares.untaxed + shares.byRate.reduce((s, r) => s + r.total, 0)).toBe(1000);
    for (const deposit of [0, 1, 7, 999, 3299, 3300]) {
      const split = depositShares(quote, deposit);
      expect(split.untaxed + split.byRate.reduce((s, r) => s + r.total, 0)).toBe(deposit);
    }
    expect(() => depositShares(quote, 3301)).toThrow(RangeError);
  });
});
