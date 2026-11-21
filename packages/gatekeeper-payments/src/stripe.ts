// The Stripe provider: Checkout Sessions for payment, Refunds for refunds, and the Stripe webhook
// for confirmation. Plain fetch against the REST API with form-encoded bodies. No Stripe-Version is
// pinned: the account's default API version applies (see README.md).
//
// Nothing here logs: request bodies carry order details and emails, responses carry customer data,
// and the headers carry the secret key.

import { ActionApplyError, ActionOutcomeUnknownError } from "@composable-os/gatekeeper-kit/actions";
import type { CheckoutInput, PaymentProvider, RefundInput, VerifiedWebhook } from "./provider.js";
import { verifySignatureHeader } from "./signature.js";
import type { PaymentsEvent, PaymentsPayment } from "./types.js";

/** Stripe's shortest Checkout Session lifetime is 30 minutes; one more absorbs clock skew. */
const CHECKOUT_LIFETIME_SECONDS = 31 * 60;
const MAX_METADATA_VALUE = 500;

export type StripeOptions = {
  secretKey: string;
  webhookSecret: string;
  /** Default https://api.stripe.com. */
  apiBase: string;
  /** A connected account id, sent as Stripe-Account; empty for the key's own account. */
  account: string;
  /** Injected by tests; the global fetch otherwise. */
  fetch?: typeof fetch;
};

type StripeResponse = { status: number; body: Record<string, unknown> };

/** A call that failed in a way that says nothing reached Stripe's books, or the opposite. */
class StripeCallError extends Error {
  constructor(
    message: string,
    /** "refused": Stripe answered 4xx. "retry": rate limited. "unknown": 5xx or network. */
    readonly outcome: "refused" | "retry" | "unknown",
  ) {
    super(message);
  }
}

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  readonly #options: StripeOptions;

  constructor(options: StripeOptions) {
    this.#options = options;
  }

  async createCheckout(
    input: CheckoutInput,
  ): Promise<{ ref: string; url: string; expiresAt: string | null }> {
    const expiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_LIFETIME_SECONDS;
    const form = new URLSearchParams();
    form.set("mode", "payment");
    form.set("line_items[0][price_data][currency]", input.currency.toLowerCase());
    form.set("line_items[0][price_data][unit_amount]", String(input.amount));
    form.set("line_items[0][price_data][product_data][name]", input.description);
    form.set("line_items[0][quantity]", "1");
    form.set("success_url", input.returnUrl);
    form.set("cancel_url", input.returnUrl);
    form.set("client_reference_id", input.orderId);
    form.set("metadata[order_id]", input.orderId);
    form.set("payment_intent_data[metadata][order_id]", input.orderId);
    if (input.customerEmail) form.set("customer_email", input.customerEmail);
    form.set("expires_at", String(expiresAt));
    const { body } = await this.#call("POST", "/v1/checkout/sessions", form, input.idempotencyKey);
    const ref = body.id;
    const url = body.url;
    if (typeof ref !== "string" || typeof url !== "string") {
      throw new Error("Stripe answered the checkout without an id or url.");
    }
    const expires = typeof body.expires_at === "number" ? body.expires_at : expiresAt;
    return { ref, url, expiresAt: new Date(expires * 1000).toISOString() };
  }

  async getPayment(ref: string): Promise<PaymentsPayment> {
    const { body } = await this.#call(
      "GET",
      `/v1/checkout/sessions/${encodeURIComponent(ref)}`,
      undefined,
      undefined,
    );
    return sessionToPayment(body, ref);
  }

  async refund(
    input: RefundInput,
  ): Promise<{ refundRef: string; status: "pending" | "succeeded" }> {
    const form = new URLSearchParams();
    form.set("payment_intent", input.paymentRef);
    form.set("amount", String(input.amount));
    form.set("reason", "requested_by_customer");
    form.set("metadata[order_id]", input.orderId);
    form.set("metadata[cos_refund_id]", input.refundId);
    form.set("metadata[reason]", input.reason.slice(0, MAX_METADATA_VALUE));
    let body: Record<string, unknown>;
    try {
      ({ body } = await this.#call("POST", "/v1/refunds", form, input.refundId));
    } catch (error) {
      if (error instanceof StripeCallError) {
        if (error.outcome === "refused") {
          throw new ActionApplyError(
            `Stripe refused the refund, so nothing was refunded: ${error.message}`,
          );
        }
        // Rate limited: Stripe did nothing, and the idempotency key makes a later retry safe.
        if (error.outcome === "retry") throw new Error(`Stripe is busy: ${error.message}`);
        throw new ActionOutcomeUnknownError(
          `Stripe failed while refunding, so the refund may or may not have gone through: ${error.message}`,
        );
      }
      throw new ActionOutcomeUnknownError(
        "The refund request to Stripe failed, so it may or may not have gone through.",
      );
    }
    const refundRef = body.id;
    if (typeof refundRef !== "string") {
      throw new ActionOutcomeUnknownError(
        "Stripe answered the refund without an id, so it may or may not have gone through.",
      );
    }
    return { refundRef, status: body.status === "succeeded" ? "succeeded" : "pending" };
  }

  verifyWebhook(
    headers: Record<string, string>,
    body: Uint8Array,
    nowSeconds: number,
  ): Promise<VerifiedWebhook> {
    return verifyStripeWebhook(this.#options.webhookSecret, headers, body, nowSeconds);
  }

  async #call(
    method: "GET" | "POST",
    path: string,
    form: URLSearchParams | undefined,
    idempotencyKey: string | undefined,
  ): Promise<StripeResponse> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#options.secretKey}`,
      accept: "application/json",
    };
    if (form) headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (this.#options.account) headers["stripe-account"] = this.#options.account;
    const doFetch = this.#options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.#options.apiBase}${path}`, {
        method,
        headers,
        ...(form ? { body: form.toString() } : {}),
      });
    } catch {
      throw new StripeCallError("the request did not complete", "unknown");
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // An unreadable body is judged by its status alone.
    }
    if (response.ok) return { status: response.status, body };
    const detail = stripeErrorSummary(response.status, body);
    if (response.status === 429) throw new StripeCallError(detail, "retry");
    if (response.status >= 400 && response.status < 500) {
      throw new StripeCallError(detail, "refused");
    }
    throw new StripeCallError(detail, "unknown");
  }
}

/**
 * Stripe's error type and code, never its message: a message can quote the request, which may
 * carry an email address.
 */
function stripeErrorSummary(status: number, body: Record<string, unknown>): string {
  const error = body.error;
  const parts = [`HTTP ${status}`];
  if (error && typeof error === "object") {
    const { type, code } = error as { type?: unknown; code?: unknown };
    if (typeof type === "string") parts.push(type.slice(0, 60));
    if (typeof code === "string") parts.push(code.slice(0, 60));
  }
  return parts.join(", ");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A field that is an id string, or an expanded object with an id. */
function idOf(value: unknown): string | null {
  if (typeof value === "string") return stringOrNull(value);
  if (value && typeof value === "object" && "id" in value) {
    return stringOrNull((value as { id: unknown }).id);
  }
  return null;
}

function metadataOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function currencyOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;
}

/** A Checkout Session as a PaymentsPayment. */
export function sessionToPayment(session: Record<string, unknown>, ref: string): PaymentsPayment {
  const status: PaymentsPayment["status"] =
    session.payment_status === "paid" ? "paid" : session.status === "expired" ? "expired" : "open";
  const metadata = metadataOf(session.metadata);
  return {
    provider: "stripe",
    ref: stringOrNull(session.id) ?? ref,
    status,
    orderId: stringOrNull(session.client_reference_id) ?? stringOrNull(metadata.order_id),
    amount: nonNegativeInteger(session.amount_total) ?? 0,
    currency: currencyOf(session.currency) ?? "",
    paymentRef: idOf(session.payment_intent),
  };
}

/** Verifies a Stripe webhook delivery and maps the event it carries. */
export async function verifyStripeWebhook(
  secret: string,
  headers: Record<string, string>,
  body: Uint8Array,
  nowSeconds: number,
): Promise<VerifiedWebhook> {
  const check = await verifySignatureHeader(secret, headers["stripe-signature"], body, nowSeconds);
  if (!check.ok) return check;
  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, reason: "malformed body" };
  }
  const parsed = metadataOf(event);
  const eventId = stringOrNull(parsed.id);
  if (eventId === null || eventId.length > 255) return { ok: false, reason: "malformed body" };
  const mapped = mapStripeEvent(parsed, eventId);
  return { ok: true, eventId, events: mapped ? [mapped] : [] };
}

/** The PaymentsEvent a Stripe event stands for, or null for one this gatekeeper ignores. */
export function mapStripeEvent(
  event: Record<string, unknown>,
  eventId: string,
): PaymentsEvent | null {
  const type = event.type;
  const data = metadataOf(event.data);
  const object = metadataOf(data.object);
  const created = nonNegativeInteger(event.created);
  const occurredAt = new Date(created !== null ? created * 1000 : Date.now()).toISOString();
  const metadata = metadataOf(object.metadata);

  const paid =
    (type === "checkout.session.completed" && object.payment_status === "paid") ||
    type === "checkout.session.async_payment_succeeded";
  if (paid) {
    const orderId = stringOrNull(object.client_reference_id) ?? stringOrNull(metadata.order_id);
    const checkoutRef = stringOrNull(object.id);
    const amount = nonNegativeInteger(object.amount_total);
    const currency = currencyOf(object.currency);
    if (orderId === null || checkoutRef === null || amount === null || currency === null) {
      return null;
    }
    return {
      kind: "payment",
      provider: "stripe",
      eventId,
      orderId,
      checkoutRef,
      amount,
      currency,
      paymentRef: idOf(object.payment_intent),
      occurredAt,
    };
  }

  if ((type === "refund.created" || type === "refund.updated") && object.status === "succeeded") {
    const refundRef = stringOrNull(object.id);
    const amount = nonNegativeInteger(object.amount);
    const currency = currencyOf(object.currency);
    if (refundRef === null || amount === null || currency === null) return null;
    return {
      kind: "refund",
      provider: "stripe",
      eventId,
      orderId: stringOrNull(metadata.order_id),
      refundId: stringOrNull(metadata.cos_refund_id),
      refundRef,
      paymentRef: idOf(object.payment_intent),
      amount,
      currency,
      occurredAt,
    };
  }
  return null;
}
