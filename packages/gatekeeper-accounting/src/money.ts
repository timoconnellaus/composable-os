// Amounts are minor units throughout; this formats them for the person approving.

/** The number of minor-unit digits of `currency` (2 for AUD, 0 for JPY), per Intl. */
export function currencyDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return typeof digits === "number" ? digits : 2;
  } catch {
    return 2;
  }
}

/** `2500, "AUD"` → `25.00 AUD`. Exact for any safe integer: no floating point division. */
export function formatMinor(amount: number, currency: string): string {
  const digits = currencyDigits(currency);
  const negative = amount < 0;
  const text = String(Math.abs(amount)).padStart(digits + 1, "0");
  const whole = digits === 0 ? text : text.slice(0, -digits);
  const fraction = digits === 0 ? "" : `.${text.slice(-digits)}`;
  return `${negative ? "-" : ""}${whole}${fraction} ${currency.toUpperCase()}`;
}
