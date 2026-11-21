// The fake provider, for development and tests: a ledger Durable Object standing in for the
// provider's books, a hosted page with Pay and Cancel buttons, and signed webhook deliveries to the
// gatekeeper's own `/in/fake` route. It is on only when PAYMENTS_FAKE_PROVIDER is "true".
//
// It never asks for card details: its page has no card fields, and it stores nothing a customer
// typed.

import { DurableObject } from "cloudflare:workers";
import { ActionApplyError } from "@composable-os/gatekeeper-kit/actions";
import type { CheckoutInput, PaymentProvider, RefundInput, VerifiedWebhook } from "./provider.js";
import { randomId, verifySignatureHeader } from "./signature.js";
import type { PaymentsEvent, PaymentsPayment } from "./types.js";

const CHECKOUT_LIFETIME_MS = 30 * 60 * 1000;
/** Checkouts and refunds the ledger keeps; the oldest go first. */
const MAX_CHECKOUTS = 1000;
const MAX_REFUNDS = 1000;

export type FakeCheckout = {
  ref: string;
  orderId: string;
  amount: number;
  currency: string;
  description: string;
  returnUrl: string;
  status: "open" | "paid";
  paymentRef: string | null;
  idempotencyKey: string;
  /** ISO 8601. */
  createdAt: string;
  expiresAt: string;
  /** What the payment event reported, when a test overrode it. */
  paidAmount: number | null;
};

export type FakeRefund = {
  refundRef: string;
  paymentRef: string;
  amount: number;
  currency: string;
  orderId: string;
  refundId: string;
  createdAt: string;
};

export type FakeLedgerState = { checkouts: FakeCheckout[]; refunds: FakeRefund[] };

/** What `pay()` did. */
export type FakePayResult =
  | { found: false }
  | { found: true; checkout: FakeCheckout; newlyPaid: boolean };

export type FakeRefundResult =
  | { ok: true; refund: FakeRefund; created: boolean }
  | { ok: false; reason: string };

const CHECKOUT = "checkout:";
const IDEMPOTENCY = "idem:";
const REFUND = "refund:";
const REFUND_BY_ID = "refund-id:";

/** The fake provider's books: one instance, `idFromName("fake")`. */
export class FakePaymentsLedger extends DurableObject<Cloudflare.Env> {
  /** Opens a checkout, or returns the one opened before under the same idempotency key. */
  async createCheckout(input: CheckoutInput): Promise<FakeCheckout> {
    const kv = this.ctx.storage.kv;
    const existingRef = kv.get<string>(IDEMPOTENCY + input.idempotencyKey);
    if (existingRef !== undefined) {
      const existing = kv.get<FakeCheckout>(CHECKOUT + existingRef);
      if (existing) return existing;
    }
    const now = Date.now();
    const ref = randomId("fcs_");
    const checkout: FakeCheckout = {
      ref,
      orderId: input.orderId,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      returnUrl: input.returnUrl,
      status: "open",
      paymentRef: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CHECKOUT_LIFETIME_MS).toISOString(),
      paidAmount: null,
    };
    kv.put(CHECKOUT + ref, checkout);
    kv.put(IDEMPOTENCY + input.idempotencyKey, ref);
    this.#prune<FakeCheckout>(CHECKOUT, MAX_CHECKOUTS, (row) =>
      kv.delete(IDEMPOTENCY + row.idempotencyKey),
    );
    return checkout;
  }

  async getCheckout(ref: string): Promise<FakeCheckout | null> {
    return this.ctx.storage.kv.get<FakeCheckout>(CHECKOUT + ref) ?? null;
  }

  /** Marks a checkout paid, once. A second pay changes nothing. */
  async pay(ref: string, amountOverride: number | null): Promise<FakePayResult> {
    const kv = this.ctx.storage.kv;
    const checkout = kv.get<FakeCheckout>(CHECKOUT + ref);
    if (!checkout) return { found: false };
    if (checkout.status === "paid") return { found: true, checkout, newlyPaid: false };
    const paid: FakeCheckout = {
      ...checkout,
      status: "paid",
      paymentRef: randomId("fpi_"),
      paidAmount: amountOverride,
    };
    kv.put(CHECKOUT + ref, paid);
    return { found: true, checkout: paid, newlyPaid: true };
  }

  /**
   * Records a refund against a paid checkout. Refused when the payment is unknown, the currency
   * differs, or the refunds on that payment would total more than was paid. The same refundId
   * returns the refund recorded before.
   */
  async refund(input: RefundInput): Promise<FakeRefundResult> {
    const kv = this.ctx.storage.kv;
    const priorRef = kv.get<string>(REFUND_BY_ID + input.refundId);
    if (priorRef !== undefined) {
      const prior = kv.get<FakeRefund>(REFUND + priorRef);
      if (prior) return { ok: true, refund: prior, created: false };
    }
    const checkout = [...kv.list<FakeCheckout>({ prefix: CHECKOUT })]
      .map(([, row]) => row)
      .find((row) => row.paymentRef === input.paymentRef && row.status === "paid");
    if (!checkout) return { ok: false, reason: "no paid payment has that reference" };
    if (checkout.currency !== input.currency) {
      return { ok: false, reason: `the payment was in ${checkout.currency}` };
    }
    const paid = checkout.paidAmount ?? checkout.amount;
    const refunded = [...kv.list<FakeRefund>({ prefix: REFUND })]
      .map(([, row]) => row)
      .filter((row) => row.paymentRef === input.paymentRef)
      .reduce((sum, row) => sum + row.amount, 0);
    if (refunded + input.amount > paid) {
      return {
        ok: false,
        reason: `that would refund ${refunded + input.amount} of a payment of ${paid} minor units`,
      };
    }
    const refund: FakeRefund = {
      refundRef: randomId("fre_"),
      paymentRef: input.paymentRef,
      amount: input.amount,
      currency: input.currency,
      orderId: input.orderId,
      refundId: input.refundId,
      createdAt: new Date().toISOString(),
    };
    kv.put(REFUND + refund.refundRef, refund);
    kv.put(REFUND_BY_ID + input.refundId, refund.refundRef);
    this.#prune<FakeRefund>(REFUND, MAX_REFUNDS, (row) => kv.delete(REFUND_BY_ID + row.refundId));
    return { ok: true, refund, created: true };
  }

  /** Everything the ledger holds, for the dev `/fake/state` route and tests. */
  async state(): Promise<FakeLedgerState> {
    const kv = this.ctx.storage.kv;
    return {
      checkouts: [...kv.list<FakeCheckout>({ prefix: CHECKOUT })].map(([, row]) => row),
      refunds: [...kv.list<FakeRefund>({ prefix: REFUND })].map(([, row]) => row),
    };
  }

  /** Keeps the newest `max` rows under `prefix`, by `createdAt`. */
  #prune<Row extends { createdAt: string }>(
    prefix: string,
    max: number,
    alsoForget: (row: Row) => void,
  ): void {
    const kv = this.ctx.storage.kv;
    const rows = [...kv.list<Row>({ prefix })];
    if (rows.length <= max) return;
    rows.sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
    for (const [key, row] of rows.slice(0, rows.length - max)) {
      kv.delete(key);
      alsoForget(row);
    }
  }
}

export function fakeLedger(env: Cloudflare.Env): DurableObjectStub<FakePaymentsLedger> {
  return env.FAKE_PAYMENTS.get(env.FAKE_PAYMENTS.idFromName("fake"));
}

/** What the fake provider posts to `/in/fake`. */
export type FakeWebhookBody =
  | {
      id: string;
      type: "payment.succeeded";
      created: number;
      data: {
        orderId: string;
        checkoutRef: string;
        amount: number;
        currency: string;
        paymentRef: string | null;
      };
    }
  | {
      id: string;
      type: "refund.succeeded";
      created: number;
      data: {
        orderId: string | null;
        refundId: string | null;
        refundRef: string;
        paymentRef: string | null;
        amount: number;
        currency: string;
      };
    };

export type FakeProviderOptions = {
  ledger: DurableObjectStub<FakePaymentsLedger>;
  /** The public base, for the hosted page URL. */
  baseUrl: string;
  webhookSecret: string;
  /** Posts a signed delivery to the gatekeeper's own `/in/fake` route, in process. */
  deliver(body: FakeWebhookBody): Promise<void>;
  /** Runs work after the current call returns (a Durable Object's `ctx.waitUntil`). */
  defer(work: Promise<unknown>): void;
};

export class FakeProvider implements PaymentProvider {
  readonly name = "fake" as const;
  readonly #options: FakeProviderOptions;

  constructor(options: FakeProviderOptions) {
    this.#options = options;
  }

  async createCheckout(
    input: CheckoutInput,
  ): Promise<{ ref: string; url: string; expiresAt: string | null }> {
    const checkout = await this.#options.ledger.createCheckout(input);
    return {
      ref: checkout.ref,
      url: fakePayUrl(this.#options.baseUrl, checkout.ref),
      expiresAt: checkout.expiresAt,
    };
  }

  async getPayment(ref: string): Promise<PaymentsPayment> {
    const checkout = await this.#options.ledger.getCheckout(ref);
    if (!checkout) throw new Error("The fake provider has no checkout with that reference.");
    return checkoutToPayment(checkout);
  }

  /** Records the refund, then confirms it by webhook once this call has returned. */
  async refund(
    input: RefundInput,
  ): Promise<{ refundRef: string; status: "pending" | "succeeded" }> {
    const result = await this.#options.ledger.refund(input);
    if (!result.ok) {
      throw new ActionApplyError(
        `The fake provider refused the refund, so nothing was refunded: ${result.reason}.`,
      );
    }
    const { refund } = result;
    if (result.created) {
      const delivery = this.#options.deliver({
        id: `fevt_refund_${refund.refundRef}`,
        type: "refund.succeeded",
        created: Math.floor(Date.now() / 1000),
        data: {
          orderId: refund.orderId,
          refundId: refund.refundId,
          refundRef: refund.refundRef,
          paymentRef: refund.paymentRef,
          amount: refund.amount,
          currency: refund.currency,
        },
      });
      this.#options.defer(
        delivery.catch(() => console.warn("payments: the fake refund webhook was not accepted")),
      );
    }
    return { refundRef: refund.refundRef, status: "pending" };
  }

  verifyWebhook(
    headers: Record<string, string>,
    body: Uint8Array,
    nowSeconds: number,
  ): Promise<VerifiedWebhook> {
    return verifyFakeWebhook(this.#options.webhookSecret, headers, body, nowSeconds);
  }
}

export function fakePayUrl(baseUrl: string, ref: string): string {
  return `${baseUrl}/fake/pay/${ref}`;
}

export function checkoutToPayment(checkout: FakeCheckout): PaymentsPayment {
  const expired = checkout.status === "open" && Date.parse(checkout.expiresAt) < Date.now();
  return {
    provider: "fake",
    ref: checkout.ref,
    status: checkout.status === "paid" ? "paid" : expired ? "expired" : "open",
    orderId: checkout.orderId,
    amount: checkout.amount,
    currency: checkout.currency,
    paymentRef: checkout.paymentRef,
  };
}

function field(data: Record<string, unknown>, name: string): unknown {
  return data[name];
}

function idOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(value) ? value : undefined;
}

/** Verifies a fake provider delivery and maps the event it carries. */
export async function verifyFakeWebhook(
  secret: string,
  headers: Record<string, string>,
  body: Uint8Array,
  nowSeconds: number,
): Promise<VerifiedWebhook> {
  const check = await verifySignatureHeader(secret, headers["x-fake-signature"], body, nowSeconds);
  if (!check.ok) return check;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, reason: "malformed body" };
  }
  const event = mapFakeEvent(parsed);
  if (!event) return { ok: false, reason: "malformed body" };
  return { ok: true, eventId: event.eventId, events: [event] };
}

/** The PaymentsEvent a fake delivery stands for, or null when it is malformed. */
export function mapFakeEvent(value: unknown): PaymentsEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const eventId = idOrNull(body.id);
  const data = body.data;
  if (!eventId || !data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  const amount = field(fields, "amount");
  const currency = field(fields, "currency");
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return null;
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) return null;
  const created =
    typeof body.created === "number" && Number.isSafeInteger(body.created) && body.created >= 0
      ? body.created * 1000
      : Date.now();
  const occurredAt = new Date(created).toISOString();
  const paymentRef = idOrNull(field(fields, "paymentRef") ?? null);
  if (paymentRef === undefined) return null;

  if (body.type === "payment.succeeded") {
    const orderId = idOrNull(field(fields, "orderId"));
    const checkoutRef = idOrNull(field(fields, "checkoutRef"));
    if (!orderId || !checkoutRef) return null;
    return {
      kind: "payment",
      provider: "fake",
      eventId,
      orderId,
      checkoutRef,
      amount,
      currency: currency.toUpperCase(),
      paymentRef,
      occurredAt,
    };
  }
  if (body.type === "refund.succeeded") {
    const orderId = idOrNull(field(fields, "orderId") ?? null);
    const refundId = idOrNull(field(fields, "refundId") ?? null);
    const refundRef = idOrNull(field(fields, "refundRef"));
    if (orderId === undefined || refundId === undefined || !refundRef) return null;
    return {
      kind: "refund",
      provider: "fake",
      eventId,
      orderId,
      refundId,
      refundRef,
      paymentRef,
      amount,
      currency: currency.toUpperCase(),
      occurredAt,
    };
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The fake hosted page: self-contained, no external assets, no card fields. */
export function fakePayPage(checkout: FakeCheckout, formattedAmount: string): string {
  const paid = checkout.status === "paid";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fake payment page</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem 1rem; background: #f6f6f4; color: #1d1d1b; }
  main { max-width: 26rem; margin: 0 auto; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  .amount { font-size: 2rem; font-weight: 600; margin: 0.5rem 0 1rem; }
  .note { color: #666; font-size: 0.85rem; }
  .actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
  button { font: inherit; padding: 0.6rem 1.2rem; border-radius: 6px; border: 1px solid #1d1d1b; cursor: pointer; }
  button.pay { background: #1d1d1b; color: #fff; }
  button.cancel { background: #fff; color: #1d1d1b; }
</style>
</head>
<body>
<main>
  <h1>Fake payment page</h1>
  <p>${escapeHtml(checkout.description)}</p>
  <p class="amount">${escapeHtml(formattedAmount)}</p>
  ${paid ? '<p class="note">This checkout is already paid.</p>' : ""}
  <div class="actions">
    <form method="post">
      <input type="hidden" name="outcome" value="pay">
      <button type="submit" class="pay">Pay</button>
    </form>
    <form method="post">
      <input type="hidden" name="outcome" value="cancel">
      <button type="submit" class="cancel">Cancel</button>
    </form>
  </div>
  <p class="note">A development stand-in for a payment provider. No card details are asked for or stored.</p>
</main>
</body>
</html>`;
}
