// Input guards for every RPC input. No capnweb-validate decorators (the CRM's Vite dev server runs
// this Worker as an auxiliary worker and cannot transform them), so each input is checked here by
// hand and copied into a fresh object holding only the known keys.

import type { PaymentsCheckoutInput, PaymentsProviderName, PaymentsRefundInput } from "./types.js";

export const PROVIDER_NAMES: readonly PaymentsProviderName[] = ["stripe", "fake"];

/** The resource URL pattern: one payment account per provider. */
export const MERCHANT_URL_PATTERN = "payments://merchant/:provider";

const MERCHANT_URL = /^payments:\/\/merchant\/(stripe|fake)$/;
const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REFUND_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A provider reference (checkout, payment, refund): Stripe ids are `[A-Za-z0-9_]`. */
const PROVIDER_REF = /^[A-Za-z0-9_-]{1,255}$/;
const CURRENCY = /^[A-Za-z]{3}$/;
// Deliberately loose: the provider validates the address; this only keeps out what is plainly not one.
const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[^\s@<>()",;:]{1,63}$/;

export function isProviderName(value: unknown): value is PaymentsProviderName {
  return value === "stripe" || value === "fake";
}

export function assertProviderName(value: unknown): PaymentsProviderName {
  if (!isProviderName(value)) throw new TypeError('provider must be "stripe" or "fake".');
  return value;
}

export function merchantUrl(provider: PaymentsProviderName): string {
  return `payments://merchant/${provider}`;
}

/** The provider of a `payments://merchant/<provider>` URL. */
export function providerFromUrl(url: unknown): PaymentsProviderName {
  const match = typeof url === "string" ? MERCHANT_URL.exec(url) : null;
  if (!match) {
    throw new TypeError(
      "Not a payment account URL: expected payments://merchant/stripe or payments://merchant/fake.",
    );
  }
  return match[1] as PaymentsProviderName;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function refuseUnknownKeys(input: Record<string, unknown>, known: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!known.includes(key)) throw new TypeError(`Unrecognized key: ${key.slice(0, 40)}`);
  }
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new TypeError(`${name} must be a string of 1 to ${max} characters.`);
  }
  return value;
}

function matching(value: unknown, name: string, pattern: RegExp, rule: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${name} must be ${rule}.`);
  }
  return value;
}

export function assertOrderId(value: unknown): string {
  return matching(value, "orderId", ORDER_ID, "1 to 64 characters of [A-Za-z0-9_-]");
}

export function assertProviderRef(value: unknown, name = "ref"): string {
  return matching(value, name, PROVIDER_REF, "1 to 255 characters of [A-Za-z0-9_-]");
}

/** A positive safe integer amount in minor units. */
export function assertAmount(value: unknown, name = "amount"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer of minor units.`);
  }
  return value;
}

/** An ISO 4217 code, returned in upper case. */
export function assertCurrency(value: unknown): string {
  return matching(value, "currency", CURRENCY, "a three-letter ISO 4217 code").toUpperCase();
}

/** An absolute https URL, or http on localhost or 127.0.0.1 (any port). */
export function assertReturnUrl(value: unknown): string {
  const text = boundedString(value, "returnUrl", 2000);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError("returnUrl must be an absolute URL.");
  }
  const local =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !local) {
    throw new TypeError("returnUrl must be https, or http on localhost or 127.0.0.1.");
  }
  if (url.username || url.password) throw new TypeError("returnUrl must not carry credentials.");
  return text;
}

/** Whether `text` is a line of plain text: no control characters. */
function singleLine(value: string, name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${name} must be a single line.`);
  return value;
}

const CHECKOUT_KEYS = [
  "orderId",
  "amount",
  "currency",
  "description",
  "returnUrl",
  "customerEmail",
  "idempotencyKey",
] as const;

export function parseCheckoutInput(value: unknown): PaymentsCheckoutInput {
  const input = record(value, "The checkout input");
  refuseUnknownKeys(input, CHECKOUT_KEYS);
  const parsed: PaymentsCheckoutInput = {
    orderId: assertOrderId(input.orderId),
    amount: assertAmount(input.amount),
    currency: assertCurrency(input.currency),
    description: singleLine(boundedString(input.description, "description", 200), "description"),
    returnUrl: assertReturnUrl(input.returnUrl),
    idempotencyKey: singleLine(
      boundedString(input.idempotencyKey, "idempotencyKey", 200),
      "idempotencyKey",
    ),
  };
  if (input.customerEmail !== undefined) {
    parsed.customerEmail = matching(
      input.customerEmail,
      "customerEmail",
      EMAIL,
      "an email address",
    );
  }
  return parsed;
}

const REFUND_KEYS = ["orderId", "paymentRef", "amount", "currency", "reason", "refundId"] as const;

export function parseRefundInput(value: unknown): PaymentsRefundInput {
  const input = record(value, "The refund input");
  refuseUnknownKeys(input, REFUND_KEYS);
  return {
    orderId: assertOrderId(input.orderId),
    paymentRef: assertProviderRef(input.paymentRef, "paymentRef"),
    amount: assertAmount(input.amount),
    currency: assertCurrency(input.currency),
    reason: boundedString(input.reason, "reason", 500),
    refundId: matching(
      input.refundId,
      "refundId",
      REFUND_ID,
      "1 to 64 characters of [A-Za-z0-9_-]",
    ),
  };
}
