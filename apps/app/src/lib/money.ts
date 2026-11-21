// Order amounts (stage 25) are integers in the currency's minor unit (cents). These turn them into
// text and back, with the currency's own number of decimal places (2 for AUD, 0 for JPY).

/** How many decimal places `currency` has. */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** An amount in minor units as money, e.g. 12345 AUD → "A$123.45". */
export function formatMoney(amount: number, currency: string): string {
  const major = amount / 10 ** currencyDigits(currency);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

/** Minor units as a plain number in major units, for a form field ("123.45"). */
export function toMajorInput(amount: number, currency: string): string {
  const digits = currencyDigits(currency);
  return (amount / 10 ** digits).toFixed(digits);
}

/** What someone typed in major units as minor units, or null when it is not an amount. */
export function fromMajorInput(value: string, currency: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const digits = currencyDigits(currency);
  const scaled = Number(trimmed) * 10 ** digits;
  const minor = Math.round(scaled);
  return Math.abs(scaled - minor) < 1e-6 && Number.isSafeInteger(minor) ? minor : null;
}

export const ORDER_STATE_LABELS = {
  pending: "Pending",
  part_paid: "Part paid",
  paid: "Paid",
  cancelled: "Cancelled",
  expired: "Expired",
  refunded: "Refunded",
} as const;

export type OrderStateName = keyof typeof ORDER_STATE_LABELS;

/** The badge look for each state. */
export const ORDER_STATE_VARIANTS: Record<OrderStateName, "default" | "secondary" | "outline"> = {
  pending: "outline",
  part_paid: "secondary",
  paid: "default",
  cancelled: "outline",
  expired: "outline",
  refunded: "secondary",
};
