// Tax worked out by the host on quotes, invoices and credit notes, from the business's own rates
// (stage 35 decision 2, ADR 0732). Integers in the currency's minor unit throughout; a quantity in
// thousandths; a rate in hundredths of a percent. Each line's tax is rounded half up to the minor
// unit; a document's tax is the sum of its lines', shown by rate. With amounts typed without tax,
// the tax is added on top of the line; with amounts typed with tax, it is taken out of it. A
// staff discount lowers the line before its tax is worked out. Nothing here reads or writes.
import type { TaxMode } from "../fields/invoice.ts";

/** `a / b` rounded half up, for a ≥ 0 and b > 0 (in BigInt, so a large product never rounds). */
export function divHalfUp(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b <= 0) {
    throw new RangeError(`divHalfUp(${a}, ${b})`);
  }
  return Number((BigInt(a) * 2n + BigInt(b)) / (BigInt(b) * 2n));
}

/** `a × b / c` rounded half up, without a float in between. */
export function mulDivHalfUp(a: number, b: number, c: number): number {
  if (![a, b, c].every(Number.isSafeInteger) || a < 0 || b < 0 || c <= 0) {
    throw new RangeError(`mulDivHalfUp(${a}, ${b}, ${c})`);
  }
  return Number((BigInt(a) * BigInt(b) * 2n + BigInt(c)) / (BigInt(c) * 2n));
}

export interface Discount {
  kind: "amount" | "percent";
  /** An amount in minor units, or a percentage in hundredths of a percent (1000 = 10%). */
  value: number;
}

export interface LineTerms {
  unitPrice: number;
  quantityMilli: number;
  /** The rate, hundredths of a percent; 0 for no tax. */
  rate: number;
  mode: TaxMode;
  discount?: Discount | null;
}

export interface LineAmounts {
  /** Unit price × quantity, before the discount, in the document's mode. */
  gross: number;
  discount: number;
  net: number;
  tax: number;
  total: number;
}

/** What one line comes to. */
export function lineAmounts(terms: LineTerms): LineAmounts {
  const gross = mulDivHalfUp(terms.unitPrice, terms.quantityMilli, 1000);
  const off = terms.discount
    ? Math.min(
        gross,
        terms.discount.kind === "amount"
          ? terms.discount.value
          : mulDivHalfUp(gross, terms.discount.value, 10000),
      )
    : 0;
  const amount = gross - off;
  if (terms.mode === "exclusive") {
    const tax = mulDivHalfUp(amount, terms.rate, 10000);
    return { gross, discount: off, net: amount, tax, total: amount + tax };
  }
  const tax = mulDivHalfUp(amount, terms.rate, 10000 + terms.rate);
  return { gross, discount: off, net: amount - tax, tax, total: amount };
}

/**
 * A record's price (which includes tax, ADR 0479) as a unit price on a document typed without
 * tax: the price with the rate's tax taken out, rounded half up. On a document typed with tax it
 * is the price as it is.
 */
export function unitPriceFromRecord(price: number, rate: number, mode: TaxMode): number {
  return mode === "inclusive" ? price : mulDivHalfUp(price, 10000, 10000 + rate);
}

export interface RateTotal {
  key: string;
  label: string;
  rate: number;
  net: number;
  tax: number;
  total: number;
}

export interface DocumentTotals {
  net: number;
  tax: number;
  total: number;
  /** One entry per rate the lines use, in the order the lines first use them. */
  byRate: RateTotal[];
}

export interface TotalledLine {
  taxKey: string | null;
  taxLabel: string | null;
  taxRate: number;
  net: number;
  tax: number;
  total: number;
}

/** A document's totals: the sums of its lines, and by rate. Lines with no rate are in no rate. */
export function documentTotals(lines: readonly TotalledLine[]): DocumentTotals {
  const byRate = new Map<string, RateTotal>();
  let net = 0;
  let tax = 0;
  for (const line of lines) {
    net += line.net;
    tax += line.tax;
    if (line.taxKey === null) continue;
    const entry = byRate.get(line.taxKey) ?? {
      key: line.taxKey,
      label: line.taxLabel ?? line.taxKey,
      rate: line.taxRate,
      net: 0,
      tax: 0,
      total: 0,
    };
    entry.net += line.net;
    entry.tax += line.tax;
    entry.total += line.total;
    byRate.set(line.taxKey, entry);
  }
  return { net, tax, total: net + tax, byRate: [...byRate.values()] };
}

/**
 * A deposit's share of a quote, by rate (ADR 0732): the deposit (an amount that includes tax) is
 * split over the quote's rates, and its untaxed part, in proportion to their totals, the cents left
 * over going to the largest remainders so the shares add up to the deposit exactly; each share's
 * tax is the quote's tax at that rate in the same proportion, rounded half up. Used by the deposit
 * invoice (stage 35 step 6); the final invoice's "less deposit paid" takes these off by rate.
 */
export function depositShares(
  quote: DocumentTotals,
  deposit: number,
): { untaxed: number; byRate: RateTotal[] } {
  if (!Number.isSafeInteger(deposit) || deposit < 0 || deposit > quote.total) {
    throw new RangeError("A deposit is between nothing and the quote's total");
  }
  const taxedTotal = quote.byRate.reduce((sum, r) => sum + r.total, 0);
  const parts = [...quote.byRate.map((r) => r.total), quote.total - taxedTotal];
  if (quote.total === 0) {
    return { untaxed: 0, byRate: quote.byRate.map((r) => ({ ...r, net: 0, tax: 0, total: 0 })) };
  }
  const exact = parts.map((p) => BigInt(p) * BigInt(deposit));
  const whole = exact.map((e) => Number(e / BigInt(quote.total)));
  let left = deposit - whole.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, rem: e % BigInt(quote.total) }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of order) {
    if (left <= 0) break;
    whole[i] = (whole[i] ?? 0) + 1;
    left -= 1;
  }
  return {
    untaxed: whole.at(-1) ?? 0,
    byRate: quote.byRate.map((r, i) => {
      const total = whole[i] ?? 0;
      const tax = r.total === 0 ? 0 : Math.min(total, mulDivHalfUp(r.tax, total, r.total));
      return { ...r, net: total - tax, tax, total };
    }),
  };
}
