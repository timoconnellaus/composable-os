// Amounts as a person reads them, shared by the tools (a check-in's message) and the headless
// entry (the blocks). Display only: what is charged and owed is the host's.

const digitsByCurrency = new Map<string, number>();

/**
 * How many decimal places `currency` has (2 for AUD, 0 for JPY), for display. The currency is
 * always the host's, from the data (a ticket type's `currency`, an order's): never the app's.
 * Asked once per currency: a list of prices asks it for every line.
 */
export function currencyDigits(currency: string | null | undefined): number {
  if (!currency) return 2;
  let digits = digitsByCurrency.get(currency);
  if (digits === undefined) {
    try {
      digits =
        new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    digitsByCurrency.set(currency, digits);
  }
  return digits;
}

const withCurrency = (amount: string, currency: string | null) =>
  currency ? `${amount} ${currency}` : amount;

/** An amount in the minor unit as the buyer reads it: `450.00 AUD`. Display only. */
export function formatMoney(minor: number, currency: string | null): string {
  const digits = currencyDigits(currency);
  return withCurrency((minor / 10 ** digits).toFixed(digits), currency);
}

/** A ticket type's price (major unit, as the record holds it) as the buyer reads it. */
export function formatPrice(price: number | null, currency: string | null): string {
  return price === null ? "" : withCurrency(price.toFixed(currencyDigits(currency)), currency);
}
