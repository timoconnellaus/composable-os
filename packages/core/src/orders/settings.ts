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

/** One setting of core_settings, parsed; null when it is missing or unreadable. */
export async function loadSetting<T>(
  db: Kysely<CoreDatabase>,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  return load(db, key, schema);
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

// --- Tax at checkout (ADR 0479) -----------------------------------------------------------------

/**
 * Whether the payment provider calculates tax at checkout. Off until a human admin turns it on.
 * A line is taxed only when this is on and its object declares a product tax code.
 */
export const ORDER_TAX_SETTING = "order_tax";
/** A human admin's product tax code per sellable object, over the one its manifest declares. */
export const ORDER_TAX_CODES_SETTING = "order_tax_codes";

export const taxCodeSchema = z
  .string()
  .trim()
  .regex(/^txcd_\d{8}$/, "A product tax code is txcd_ and eight digits, from Stripe's list");
export const taxCodesSchema = z.record(z.string().min(1).max(80), taxCodeSchema);

export async function loadOrderTax(db: Kysely<CoreDatabase>): Promise<boolean> {
  return (await load(db, ORDER_TAX_SETTING, z.boolean())) ?? false;
}

export async function loadOrderTaxCodes(db: Kysely<CoreDatabase>): Promise<Record<string, string>> {
  return (await load(db, ORDER_TAX_CODES_SETTING, taxCodesSchema)) ?? {};
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

// --- Staff discounts (stage 34, ADR 0691) -------------------------------------------------------

/**
 * How much staff may take off one order on their own (`order.adjust`): a percentage of what the
 * order costs before adjustments and an amount in minor units, both at once. Above either, the
 * discount waits for a human admin's approval. Set only by a human admin; until then nothing is
 * within it, so every staff discount waits.
 */
export const ORDER_DISCOUNT_LIMIT_SETTING = "order_discount_limit";
export const discountLimitSchema = z
  .object({
    percent: z.number().min(0).max(100).describe("At most this percentage of the order"),
    amount: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .describe("And at most this much, in the currency's minor unit"),
  })
  .strict();
export type DiscountLimit = z.infer<typeof discountLimitSchema>;
export const NO_DISCOUNT_LIMIT: DiscountLimit = { percent: 0, amount: 0 };

export async function loadDiscountLimit(db: Kysely<CoreDatabase>): Promise<DiscountLimit> {
  return (await load(db, ORDER_DISCOUNT_LIMIT_SETTING, discountLimitSchema)) ?? NO_DISCOUNT_LIMIT;
}

// --- Payments taken another way (stage 34, ADR 0694) ---------------------------------------------

/**
 * Admins are told of a payment a person records (`order.recordPayment`) for more than this, in
 * minor units. Set only by a human admin; until then it is nothing, so every recorded payment is
 * told.
 */
export const ORDER_RECORDED_NOTICE_SETTING = "order_recorded_payment_notice";
export const recordedPaymentNoticeSchema = z.number().int().min(0).max(100_000_000);

export async function loadRecordedPaymentNotice(db: Kysely<CoreDatabase>): Promise<number> {
  return (await load(db, ORDER_RECORDED_NOTICE_SETTING, recordedPaymentNoticeSchema)) ?? 0;
}
