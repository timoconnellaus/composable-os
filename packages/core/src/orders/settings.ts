// Order settings (stage 25, ADR 0427): the deployment's one currency, how long an order nothing
// has been paid on lasts, and the least a buyer may pay towards a balance. Product settings in
// core_settings. Only a human admin changes them (order.settings.update).
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";

export const ORDER_CURRENCY_SETTING = "order_currency";
export const ORDER_EXPIRY_SETTING = "order_expiry_minutes";
export const ORDER_MIN_PART_SETTING = "order_min_part_payment";

/** ISO 4217, upper case. */
export const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/, "A currency is three letters, such as AUD"))
  .refine(isKnownCurrency, "Not a currency this platform knows");

export const DEFAULT_ORDER_EXPIRY_MINUTES = 15;
export const orderExpiryMinutesSchema = z.number().int().min(5).max(1440);

/** In the currency's minor unit. Default 10.00 of a two-decimal currency. */
export const DEFAULT_MIN_PART_PAYMENT = 1000;
export const minPartPaymentSchema = z.number().int().min(1).max(100_000_000);

function isKnownCurrency(code: string): boolean {
  // Intl formats any three letters, so the list of real ones is what is asked.
  return Intl.supportedValuesOf("currency").includes(code);
}

/** How many decimal places `currency` has (2 for AUD, 0 for JPY). */
export function currencyDecimals(currency: string): number {
  return (
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * A price as a record holds it (a number in the currency's major unit) as an integer in its
 * minor unit, or null when it is not a price: negative, not finite, or with more decimal places
 * than the currency has.
 */
export function toMinorUnits(price: unknown, currency: string): number | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;
  const scaled = price * 10 ** currencyDecimals(currency);
  const minor = Math.round(scaled);
  return Math.abs(scaled - minor) < 1e-6 && Number.isSafeInteger(minor) ? minor : null;
}

async function load<T>(
  db: Kysely<CoreDatabase>,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  if (!row) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The deployment's currency, or null until an admin sets one: nothing can be sold before. */
export function loadOrderCurrency(db: Kysely<CoreDatabase>): Promise<string | null> {
  return load(db, ORDER_CURRENCY_SETTING, currencySchema);
}

export async function loadOrderExpiryMinutes(db: Kysely<CoreDatabase>): Promise<number> {
  return (
    (await load(db, ORDER_EXPIRY_SETTING, orderExpiryMinutesSchema)) ?? DEFAULT_ORDER_EXPIRY_MINUTES
  );
}

export async function loadMinPartPayment(db: Kysely<CoreDatabase>): Promise<number> {
  return (await load(db, ORDER_MIN_PART_SETTING, minPartPaymentSchema)) ?? DEFAULT_MIN_PART_PAYMENT;
}

// --- Where a buyer comes back to ----------------------------------------------------------------

/**
 * The origins a checkout's `returnUrl` may be on (ADR 0429): the sites and apps that sell for
 * this deployment. A list of `https://host[:port]` origins (or `http://localhost:port` while
 * developing), set by a human admin. Empty: no checkout can be opened.
 */
export const ORDER_RETURN_ORIGINS_SETTING = "order_return_origins";
export const ORDER_RETURN_ORIGINS_MAX = 20;

/** An origin a buyer may be sent back to: https, or http on localhost, and nothing after it. */
export const returnOriginSchema = z
  .string()
  .trim()
  .max(200)
  .transform((value, ctx) => {
    const origin = originOf(value);
    if (!origin || origin !== value.replace(/\/+$/, "")) {
      ctx.addIssue({
        code: "custom",
        message: "An origin is https://host (or http://localhost:port), with no path",
      });
      return z.NEVER;
    }
    return origin;
  });
export const returnOriginsSchema = z.array(returnOriginSchema).max(ORDER_RETURN_ORIGINS_MAX);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin of `url` when it is one a buyer may be sent to (https, or http on localhost). */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol === "https:") return parsed.origin;
  if (parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname)) return parsed.origin;
  return null;
}

export async function loadReturnOrigins(db: Kysely<CoreDatabase>): Promise<string[]> {
  return (await load(db, ORDER_RETURN_ORIGINS_SETTING, returnOriginsSchema)) ?? [];
}

/** Whether a buyer may be sent back to `url` after paying: its origin is on the list. */
export function isAllowedReturnUrl(url: string, origins: readonly string[]): boolean {
  const origin = originOf(url);
  return origin !== null && url.length <= 2000 && origins.includes(origin);
}
