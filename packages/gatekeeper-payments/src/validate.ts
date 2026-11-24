// Input guards for every RPC input. No capnweb-validate decorators (the CRM's Vite dev server runs
// this Worker as an auxiliary worker and cannot transform them), so each input is checked here by
// hand and copied into a fresh object holding only the known keys.

import type {
  PaymentsCancelSubscriptionInput,
  PaymentsChangeSubscriptionInput,
  PaymentsCheckoutInput,
  PaymentsCheckoutTax,
  PaymentsCustomerEmailInput,
  PaymentsInterval,
  PaymentsPauseSubscriptionInput,
  PaymentsPortalInput,
  PaymentsPresentInput,
  PaymentsProviderName,
  PaymentsReaderAddress,
  PaymentsRefundInput,
  PaymentsRegisterReaderInput,
  PaymentsRemoveReaderInput,
  PaymentsResumeSubscriptionInput,
  PaymentsSubscriptionCheckoutInput,
  PaymentsTaxLine,
  PaymentsTaxPlace,
  PaymentsUnpauseSubscriptionInput,
  PaymentsVoidUpdateInput,
} from "./types.js";

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
  "tax",
] as const;

/** A product tax code as Stripe's list has them: `txcd_` and eight digits. */
export const TAX_CODE = /^txcd_\d{8}$/;
/** The most lines a taxed checkout may have (an order has at most 50). */
export const MAX_TAX_LINES = 50;
const LINE_REF = /^[A-Za-z0-9_-]{1,64}$/;

const COUNTRY = /^[A-Z]{2}$/;

/** An event's address for tax: a country, and the parts of an address that are given. */
export function parseTaxPlace(value: unknown, name: string): PaymentsTaxPlace {
  const input = record(value, name);
  refuseUnknownKeys(input, ["country", "region", "postcode", "city", "line1"]);
  const place: PaymentsTaxPlace = {
    country: matching(input.country, `${name}.country`, COUNTRY, "two upper-case letters"),
  };
  const part = (key: "region" | "postcode" | "city" | "line1", max: number) => {
    if (input[key] === undefined) return;
    place[key] = singleLine(boundedString(input[key], `${name}.${key}`, max), `${name}.${key}`);
  };
  part("region", 100);
  part("postcode", 20);
  part("city", 100);
  part("line1", 200);
  return place;
}

/** A taxed checkout's lines: known keys only, unique refs, amounts summing to `amount`. */
export function parseCheckoutTax(value: unknown, amount: number): PaymentsCheckoutTax {
  const input = record(value, "tax");
  refuseUnknownKeys(input, ["behavior", "lines"]);
  if (input.behavior !== "inclusive") {
    throw new TypeError('tax.behavior must be "inclusive": prices include tax.');
  }
  if (!Array.isArray(input.lines) || input.lines.length < 1) {
    throw new TypeError("tax.lines must be a list of at least one line.");
  }
  if (input.lines.length > MAX_TAX_LINES) {
    throw new TypeError(`tax.lines has at most ${MAX_TAX_LINES} lines.`);
  }
  const refs = new Set<string>();
  const lines: PaymentsTaxLine[] = input.lines.map((raw: unknown, index: number) => {
    const line = record(raw, `tax.lines[${index}]`);
    refuseUnknownKeys(line, ["ref", "name", "amount", "taxCode", "place"]);
    const ref = matching(
      line.ref,
      `tax.lines[${index}].ref`,
      LINE_REF,
      "1 to 64 characters of [A-Za-z0-9_-]",
    );
    if (refs.has(ref)) throw new TypeError(`tax.lines[${index}].ref is on two lines.`);
    refs.add(ref);
    return {
      ...(line.place !== undefined
        ? { place: parseTaxPlace(line.place, `tax.lines[${index}].place`) }
        : {}),
      ref,
      name: singleLine(
        boundedString(line.name, `tax.lines[${index}].name`, 200),
        `tax.lines[${index}].name`,
      ),
      amount: assertAmount(line.amount, `tax.lines[${index}].amount`),
      taxCode: matching(
        line.taxCode,
        `tax.lines[${index}].taxCode`,
        TAX_CODE,
        "a product tax code: txcd_ and eight digits",
      ),
    };
  });
  const sum = lines.reduce((total, line) => total + line.amount, 0);
  if (sum !== amount) {
    throw new TypeError(`tax.lines sum to ${sum} minor units; the checkout's amount is ${amount}.`);
  }
  return { behavior: "inclusive", lines };
}

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
  // Only when asked for: without it the input is exactly as before tax existed.
  if (input.tax !== undefined) parsed.tax = parseCheckoutTax(input.tax, parsed.amount);
  return parsed;
}

const REFUND_KEYS = [
  "orderId",
  "paymentRef",
  "amount",
  "currency",
  "reason",
  "refundId",
  "invoiceRef",
] as const;

export function parseRefundInput(value: unknown): PaymentsRefundInput {
  const input = record(value, "The refund input");
  refuseUnknownKeys(input, REFUND_KEYS);
  return {
    ...(input.invoiceRef !== undefined
      ? { invoiceRef: assertProviderRef(input.invoiceRef, "invoiceRef") }
      : {}),
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

// --- Subscriptions (stage 32a, ADR 0485) ------------------------------------------------------

const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const INTERVALS: readonly PaymentsInterval[] = ["week", "month", "year"];
/** The longest trial this gatekeeper asks for: two years (Stripe's own limit, ADR 0485). */
export const MAX_TRIAL_DAYS = 730;
/** Stripe Checkout's `subscription_data.trial_end` must be at least 48 hours ahead (ADR 0485). */
export const MIN_TRIAL_END_MS = 48 * 60 * 60 * 1000;

export function assertSubscriptionId(value: unknown): string {
  return matching(value, "subscriptionId", SUBSCRIPTION_ID, "1 to 64 characters of [A-Za-z0-9_-]");
}

const SUBSCRIPTION_CHECKOUT_KEYS = [
  "subscriptionId",
  "amount",
  "currency",
  "interval",
  "description",
  "returnUrl",
  "customerEmail",
  "customerRef",
  "trialDays",
  "trialEnd",
  "idempotencyKey",
  "tax",
] as const;

export function parseSubscriptionCheckoutInput(
  value: unknown,
  nowMs: number = Date.now(),
): PaymentsSubscriptionCheckoutInput {
  const input = record(value, "The subscription checkout input");
  refuseUnknownKeys(input, SUBSCRIPTION_CHECKOUT_KEYS);
  if (!INTERVALS.includes(input.interval as PaymentsInterval)) {
    throw new TypeError('interval must be "week", "month" or "year".');
  }
  const parsed: PaymentsSubscriptionCheckoutInput = {
    subscriptionId: assertSubscriptionId(input.subscriptionId),
    amount: assertAmount(input.amount),
    currency: assertCurrency(input.currency),
    interval: input.interval as PaymentsInterval,
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
  if (input.customerRef !== undefined) {
    parsed.customerRef = assertProviderRef(input.customerRef, "customerRef");
  }
  if (input.trialDays !== undefined && input.trialEnd !== undefined) {
    throw new TypeError("Give trialDays or trialEnd, not both.");
  }
  if (input.trialDays !== undefined) {
    const days = input.trialDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_TRIAL_DAYS) {
      throw new TypeError(`trialDays must be a whole number from 1 to ${MAX_TRIAL_DAYS}.`);
    }
    parsed.trialDays = days;
  }
  if (input.trialEnd !== undefined) {
    const text = boundedString(input.trialEnd, "trialEnd", 40);
    const at = Date.parse(text);
    if (Number.isNaN(at)) throw new TypeError("trialEnd must be an ISO 8601 moment.");
    if (at < nowMs + MIN_TRIAL_END_MS) {
      throw new TypeError("trialEnd must be at least 48 hours ahead.");
    }
    if (at > nowMs + MAX_TRIAL_DAYS * 86_400_000) {
      throw new TypeError(`trialEnd must be within ${MAX_TRIAL_DAYS} days.`);
    }
    parsed.trialEnd = new Date(at).toISOString();
  }
  if (input.tax !== undefined) {
    const tax = record(input.tax, "tax");
    refuseUnknownKeys(tax, ["behavior", "taxCode"]);
    if (tax.behavior !== "inclusive") {
      throw new TypeError('tax.behavior must be "inclusive": prices include tax.');
    }
    parsed.tax = {
      behavior: "inclusive",
      taxCode: matching(
        tax.taxCode,
        "tax.taxCode",
        TAX_CODE,
        "a product tax code: txcd_ and eight digits",
      ),
    };
  }
  return parsed;
}

export function parseCancelSubscriptionInput(value: unknown): PaymentsCancelSubscriptionInput {
  const input = record(value, "The cancel input");
  refuseUnknownKeys(input, ["subscriptionId", "subscriptionRef", "when", "reason", "askKey"]);
  if (input.when !== "period_end" && input.when !== "now") {
    throw new TypeError('when must be "period_end" or "now".');
  }
  if (
    input.askKey !== undefined &&
    (typeof input.askKey !== "string" || !/^[a-z0-9-]{1,40}$/.test(input.askKey))
  ) {
    throw new TypeError("askKey must be 1 to 40 lowercase letters, digits or hyphens.");
  }
  return {
    subscriptionId: assertSubscriptionId(input.subscriptionId),
    subscriptionRef: assertProviderRef(input.subscriptionRef, "subscriptionRef"),
    when: input.when,
    reason: boundedString(input.reason, "reason", 500),
    ...(typeof input.askKey === "string" ? { askKey: input.askKey } : {}),
  };
}

export function parseResumeSubscriptionInput(value: unknown): PaymentsResumeSubscriptionInput {
  const input = record(value, "The resume input");
  refuseUnknownKeys(input, ["subscriptionId", "subscriptionRef"]);
  return {
    subscriptionId: assertSubscriptionId(input.subscriptionId),
    subscriptionRef: assertProviderRef(input.subscriptionRef, "subscriptionRef"),
  };
}

/** The longest pause this gatekeeper asks for (stage 32b, ADR 0531). */
export const MAX_PAUSE_DAYS = 366;

function moment(value: unknown, name: string): number {
  const text = boundedString(value, name, 40);
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new TypeError(`${name} must be an ISO 8601 moment.`);
  return at;
}

export function parseChangeSubscriptionInput(value: unknown): PaymentsChangeSubscriptionInput {
  const input = record(value, "The plan change input");
  refuseUnknownKeys(input, [
    "subscriptionId",
    "subscriptionRef",
    "changeId",
    "amount",
    "currency",
    "interval",
    "description",
    "when",
    "taxed",
    "reason",
  ]);
  if (input.when !== "now" && input.when !== "next_period") {
    throw new TypeError('when must be "now" or "next_period".');
  }
  if (!INTERVALS.includes(input.interval as PaymentsInterval)) {
    throw new TypeError('interval must be "week", "month" or "year".');
  }
  if (typeof input.taxed !== "boolean") throw new TypeError("taxed must be true or false.");
  return {
    subscriptionId: assertSubscriptionId(input.subscriptionId),
    subscriptionRef: assertProviderRef(input.subscriptionRef, "subscriptionRef"),
    changeId: assertSubscriptionId(input.changeId),
    amount: assertAmount(input.amount),
    currency: assertCurrency(input.currency),
    interval: input.interval as PaymentsInterval,
    description: singleLine(boundedString(input.description, "description", 200), "description"),
    when: input.when,
    taxed: input.taxed,
    reason: boundedString(input.reason, "reason", 500),
  };
}

export function parsePauseSubscriptionInput(
  value: unknown,
  nowMs: number = Date.now(),
): PaymentsPauseSubscriptionInput {
  const input = record(value, "The pause input");
  refuseUnknownKeys(input, [
    "subscriptionId",
    "subscriptionRef",
    "pauseId",
    "from",
    "until",
    "reason",
  ]);
  const from = input.from === null ? null : moment(input.from, "from");
  if (from !== null && from <= nowMs) throw new TypeError("from must be ahead of now, or null.");
  const until = moment(input.until, "until");
  const start = from ?? nowMs;
  if (until <= start) throw new TypeError("until must be after the pause starts.");
  if (until > start + MAX_PAUSE_DAYS * 86_400_000) {
    throw new TypeError(`A pause is at most ${MAX_PAUSE_DAYS} days.`);
  }
  return {
    subscriptionId: assertSubscriptionId(input.subscriptionId),
    subscriptionRef: assertProviderRef(input.subscriptionRef, "subscriptionRef"),
    pauseId: assertSubscriptionId(input.pauseId),
    from: from === null ? null : new Date(from).toISOString(),
    until: new Date(until).toISOString(),
    reason: boundedString(input.reason, "reason", 500),
  };
}

export function parseUnpauseSubscriptionInput(value: unknown): PaymentsUnpauseSubscriptionInput {
  const input = record(value, "The unpause input");
  refuseUnknownKeys(input, ["subscriptionId", "subscriptionRef", "pauseId", "reason"]);
  return {
    subscriptionId: assertSubscriptionId(input.subscriptionId),
    subscriptionRef: assertProviderRef(input.subscriptionRef, "subscriptionRef"),
    pauseId: assertSubscriptionId(input.pauseId),
    reason: boundedString(input.reason, "reason", 500),
  };
}

export function parseVoidUpdateInput(value: unknown): PaymentsVoidUpdateInput {
  const input = record(value, "The void input");
  refuseUnknownKeys(input, ["subscriptionId", "subscriptionRef", "changeId", "reason"]);
  return {
    subscriptionId: assertSubscriptionId(input.subscriptionId),
    subscriptionRef: assertProviderRef(input.subscriptionRef, "subscriptionRef"),
    changeId: assertSubscriptionId(input.changeId),
    reason: boundedString(input.reason, "reason", 500),
  };
}

export function parsePortalInput(value: unknown): PaymentsPortalInput {
  const input = record(value, "The portal input");
  refuseUnknownKeys(input, ["customerRef", "returnUrl"]);
  return {
    customerRef: assertProviderRef(input.customerRef, "customerRef"),
    returnUrl: assertReturnUrl(input.returnUrl),
  };
}

export function parseCustomerEmailInput(value: unknown): PaymentsCustomerEmailInput {
  const input = record(value, "The customer email input");
  refuseUnknownKeys(input, ["customerRef", "email", "changeId"]);
  return {
    customerRef: assertProviderRef(input.customerRef, "customerRef"),
    email: matching(input.email, "email", EMAIL, "an email address"),
    changeId: matching(input.changeId, "changeId", /^ech_[A-Za-z0-9_-]{1,64}$/, "a change id"),
  };
}

// --- In-person payments (stage 50, ADR 0774) ---------------------------------------------------

const READER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A reader's pairing code: the provider's are words and digits joined by hyphens. */
const REGISTRATION_CODE = /^[A-Za-z0-9-]{1,100}$/;

export function assertReaderRef(value: unknown): string {
  return assertProviderRef(value, "readerRef");
}

function singleLineOf(value: unknown, name: string, max: number): string {
  return singleLine(boundedString(value, name, max), name);
}

/** A reader's address: the provider requires the street, city and postcode, and the country. */
export function parseReaderAddress(value: unknown): PaymentsReaderAddress {
  const input = record(value, "address");
  refuseUnknownKeys(input, ["country", "line1", "city", "postcode", "region"]);
  return {
    country: matching(input.country, "address.country", COUNTRY, "two upper-case letters"),
    line1: singleLineOf(input.line1, "address.line1", 200),
    city: singleLineOf(input.city, "address.city", 100),
    postcode: singleLineOf(input.postcode, "address.postcode", 20),
    ...(input.region !== undefined
      ? { region: singleLineOf(input.region, "address.region", 100) }
      : {}),
  };
}

export function parseRegisterReaderInput(value: unknown): PaymentsRegisterReaderInput {
  const input = record(value, "The reader registration input");
  refuseUnknownKeys(input, ["readerId", "registrationCode", "label", "locationName", "address"]);
  return {
    readerId: matching(
      input.readerId,
      "readerId",
      READER_ID,
      "1 to 64 characters of [A-Za-z0-9_-]",
    ),
    registrationCode: matching(
      input.registrationCode,
      "registrationCode",
      REGISTRATION_CODE,
      "1 to 100 characters of [A-Za-z0-9-]",
    ),
    label: singleLineOf(input.label, "label", 64),
    locationName: singleLineOf(input.locationName, "locationName", 100),
    address: parseReaderAddress(input.address),
  };
}

export function parseRemoveReaderInput(value: unknown): PaymentsRemoveReaderInput {
  const input = record(value, "The reader removal input");
  refuseUnknownKeys(input, ["readerId", "readerRef", "reason"]);
  return {
    readerId: matching(
      input.readerId,
      "readerId",
      READER_ID,
      "1 to 64 characters of [A-Za-z0-9_-]",
    ),
    readerRef: assertReaderRef(input.readerRef),
    reason: boundedString(input.reason, "reason", 500),
  };
}

export function parsePresentInput(value: unknown): PaymentsPresentInput {
  const input = record(value, "The presentation input");
  refuseUnknownKeys(input, [
    "orderId",
    "amount",
    "currency",
    "description",
    "readerRef",
    "idempotencyKey",
  ]);
  return {
    orderId: assertOrderId(input.orderId),
    amount: assertAmount(input.amount),
    currency: assertCurrency(input.currency),
    description: singleLineOf(input.description, "description", 200),
    readerRef: assertReaderRef(input.readerRef),
    idempotencyKey: singleLineOf(input.idempotencyKey, "idempotencyKey", 200),
  };
}

/**
 * A moment a provider reported, as ISO 8601, or null when it is absent or not a moment: what the
 * gatekeeper hands the host is always readable (stage 32a review).
 */
export function validInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}
