// Amounts as a person reads them, shared by the tools (a check-in's message) and the headless
// entry (the blocks). Display only: what is charged and owed is the host's.

/**
 * How many decimal places `currency` has (2 for AUD, 0 for JPY), for display. The currency is
 * always the host's, from the data (a ticket type's `currency`, an order's): never the app's.
 */
export function currencyDigits(currency: string | null | undefined): number {
  if (!currency) return 2;
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** An amount in the minor unit as the buyer reads it: `450.00 AUD`. Display only. */
export function formatMoney(minor: number, currency: string | null): string {
  const digits = currencyDigits(currency);
  return `${(minor / 10 ** digits).toFixed(digits)}${currency ? ` ${currency}` : ""}`;
}
