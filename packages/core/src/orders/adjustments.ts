// Adjustments (stage 34, ADR 0690): money off an order, kept by the host.
//
// An adjustment is on one line, or on the whole order and spread over its lines in proportion to
// what each still costs. Each line keeps its price (`line_total`) and its share of the
// adjustments (`line_discount`); the order's `total` is what is owed after them and `discount` is
// their sum. Everything downstream reads the net: the checkout and its tax shares
// (orders/tax.ts), the deposit rule (`chargeFor`), the amount a verified payment must match, and
// what a refund can give back (what was paid).
//
// This is the adjustment stage of the pricing seam: `priceLines` reads the records' prices, then
// `applyAdjustments` takes the adjustments off, in the order they were made. `createOrder` and
// every change to a pending order's adjustments (orders/staff-discounts.ts) price through it, so
// an order's lines and total are always the same function of its prices and its adjustments. The
// deal of a code or a member's price (the discount behaviour) and a delivery line (the shop) are
// the stages that join it later.
import { splitInProportion } from "./tax.ts";

/**
 * `prepaid` and `rounding` are the host's, on an invoice's order only (stage 35, ADR 0731): a
 * final invoice's "less deposit paid", and the cents a whole-unit price rounds up on a line typed
 * without tax. The database refuses them on any other order (migration 1031).
 */
export const ADJUSTMENT_KINDS = [
  "code",
  "automatic",
  "staff",
  "referral",
  "prepaid",
  "rounding",
] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/** A line as the seam prices it: its id and what it costs before adjustments. */
export interface SeamLine {
  id: string;
  total: number;
}

/** What an adjustment takes off, and where: one line, or the whole order (`lineId` null). */
export interface AdjustmentShare {
  lineId: string | null;
  amount: number;
  /**
   * Asked as a percentage: on the whole order, each line's share is the percentage of it rounded
   * down (`percentOff`), not a proportion of the sum.
   */
  percent?: number | null | undefined;
}

export interface Adjusted {
  /** Each line's share of the adjustments, in the order of `lines`. */
  discounts: number[];
  /** What the lines cost before adjustments. */
  subtotal: number;
  /** The sum of the adjustments, as taken off. */
  discount: number;
  /** What is owed after them. */
  total: number;
}

/**
 * Takes `adjustments` off `lines`, in order, in whole minor units: one on a line comes off that
 * line, one on the whole order is spread over the lines by what each still costs
 * (`splitInProportion`), or for a percentage by the percentage of each line rounded down. A line
 * never goes below nothing: what would take it further is not taken. The discounts always sum to
 * `discount`, and `total` is `subtotal - discount`.
 */
export function applyAdjustments(
  lines: readonly SeamLine[],
  adjustments: readonly AdjustmentShare[],
): Adjusted {
  const discounts = lines.map(() => 0);
  const left = (index: number) => (lines[index]?.total ?? 0) - (discounts[index] ?? 0);
  for (const adjustment of adjustments) {
    if (!Number.isSafeInteger(adjustment.amount) || adjustment.amount <= 0) continue;
    if (adjustment.lineId !== null) {
      const index = lines.findIndex((line) => line.id === adjustment.lineId);
      if (index < 0) continue;
      discounts[index] = (discounts[index] ?? 0) + Math.min(adjustment.amount, left(index));
      continue;
    }
    const remaining = lines.map((_, index) => left(index));
    const room = remaining.reduce((sum, value) => sum + value, 0);
    const amount = Math.min(adjustment.amount, room);
    // A percentage's own shares: each line's rounded down. They sum to its amount while the lines
    // cost what they did when it was given; otherwise (an earlier adjustment taken off since) its
    // amount is spread by them, or by what each line costs when they cannot hold it.
    const floors =
      adjustment.percent != null
        ? remaining.map((net) => percentOff([net], adjustment.percent as number))
        : null;
    const held = floors ? floors.reduce((sum, value) => sum + value, 0) : 0;
    const weights = floors && held >= amount ? floors : remaining;
    const shares = splitInProportion(amount, weights);
    for (const [index, share] of shares.entries()) {
      discounts[index] = (discounts[index] ?? 0) + Math.min(share, remaining[index] ?? 0);
    }
  }
  const subtotal = lines.reduce((sum, line) => sum + line.total, 0);
  const discount = discounts.reduce((sum, value) => sum + value, 0);
  return { discounts, subtotal, discount, total: subtotal - discount };
}

/**
 * What `percent` off takes from lines that still cost `nets`: rounded down to the minor unit on
 * each line, then summed.
 */
export function percentOff(nets: readonly number[], percent: number): number {
  // In hundredths of a percent, so 12.5% of 999 is exact integer arithmetic.
  const basis = Math.round(percent * 100);
  return nets.reduce((sum, net) => sum + Math.floor((net * basis) / 10_000), 0);
}
