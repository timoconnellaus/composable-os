import { ActionApplyError, ActionOutcomeUnknownError } from "@composable-os/gatekeeper-kit/actions";
import { describe, expect, it } from "vitest";
import { formatMinor } from "../src/money.js";
import { signatureHeader } from "../src/signature.js";
import { mapStripeEvent, StripeProvider, verifyStripeWebhook } from "../src/stripe.js";

type Recorded = { url: string; method: string; headers: Headers; form: URLSearchParams };

/** A StripeProvider whose fetch records each request and answers with `answer`. */
function provider(
  answer: (request: Recorded) => Response | Promise<Response>,
  options: { account?: string } = {},
) {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const recorded: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      form: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    };
    requests.push(recorded);
    return answer(recorded);
  }) as typeof fetch;
  const stripe = new StripeProvider({
    secretKey: "sk_test_key",
    webhookSecret: "whsec_x",
    apiBase: "https://stripe.test",
    account: options.account ?? "",
    fetch: fakeFetch,
  });
  return { stripe, requests };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const failing = (status: number) =>
  new Response(
    JSON.stringify({
      error: { type: "invalid_request_error", code: "x", message: "buyer@customer.test" },
    }),
    { status },
  );

const refundInput = {
  orderId: "ord_1",
  paymentRef: "pi_123",
  amount: 2500,
  currency: "AUD",
  reason: "Customer could not attend",
  refundId: "rf_1",
};

describe("the Stripe provider", () => {
  it("opens a Checkout Session with the documented form fields and headers", async () => {
    const { stripe, requests } = provider(
      () =>
        ok({ id: "cs_test_1", url: "https://checkout.stripe.test/c/1", expires_at: 1_900_000_000 }),
      { account: "acct_org" },
    );
    const before = Math.floor(Date.now() / 1000);
    const checkout = await stripe.createCheckout({
      orderId: "ord_1",
      amount: 2500,
      currency: "AUD",
      description: "Two tickets",
      returnUrl: "https://shop.example.com/back",
      customerEmail: "buyer@customer.test",
      idempotencyKey: "checkout-ord_1",
    });
    expect(checkout).toEqual({
      ref: "cs_test_1",
      url: "https://checkout.stripe.test/c/1",
      expiresAt: new Date(1_900_000_000 * 1000).toISOString(),
    });
    const [request] = requests;
    expect(request?.url).toBe("https://stripe.test/v1/checkout/sessions");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer sk_test_key");
    expect(request?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(request?.headers.get("idempotency-key")).toBe("checkout-ord_1");
    expect(request?.headers.get("stripe-account")).toBe("acct_org");
    expect(request?.headers.get("stripe-version")).toBeNull();
    const form = Object.fromEntries(request?.form ?? []);
    expect(form).toMatchObject({
      mode: "payment",
      "line_items[0][price_data][currency]": "aud",
      "line_items[0][price_data][unit_amount]": "2500",
      "line_items[0][price_data][product_data][name]": "Two tickets",
      "line_items[0][quantity]": "1",
      success_url: "https://shop.example.com/back",
      cancel_url: "https://shop.example.com/back",
      client_reference_id: "ord_1",
      "metadata[order_id]": "ord_1",
      "payment_intent_data[metadata][order_id]": "ord_1",
      customer_email: "buyer@customer.test",
    });
    const expiresAt = Number(form.expires_at);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 60);
    expect(expiresAt).toBeLessThanOrEqual(before + 32 * 60);
  });

  it("sends no Stripe-Account header without a connected account", async () => {
    const { stripe, requests } = provider(() => ok({ id: "cs_1", url: "https://x.test" }));
    await stripe.createCheckout({
      orderId: "o",
      amount: 1,
      currency: "USD",
      description: "d",
      returnUrl: "https://x.test",
      idempotencyKey: "k",
    });
    expect(requests[0]?.headers.get("stripe-account")).toBeNull();
    expect(requests[0]?.form.has("customer_email")).toBe(false);
  });

  it("reads a Checkout Session as a payment", async () => {
    const { stripe, requests } = provider(() =>
      ok({
        id: "cs_1",
        status: "complete",
        payment_status: "paid",
        client_reference_id: "ord_1",
        amount_total: 2500,
        currency: "aud",
        payment_intent: "pi_1",
      }),
    );
    expect(await stripe.getPayment("cs_1")).toEqual({
      provider: "stripe",
      ref: "cs_1",
      status: "paid",
      orderId: "ord_1",
      amount: 2500,
      currency: "AUD",
      paymentRef: "pi_1",
    });
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe("https://stripe.test/v1/checkout/sessions/cs_1");

    const expired = provider(() =>
      ok({ id: "cs_2", status: "expired", payment_status: "unpaid", metadata: { order_id: "o" } }),
    );
    expect(await expired.stripe.getPayment("cs_2")).toMatchObject({
      status: "expired",
      orderId: "o",
      paymentRef: null,
    });
    const open = provider(() => ok({ id: "cs_3", status: "open", payment_status: "unpaid" }));
    expect((await open.stripe.getPayment("cs_3")).status).toBe("open");
  });

  it("ends a subscription now under one key per subscription, or one per ask when given (a cooling off's)", async () => {
    const { stripe, requests } = provider(() => ok({ id: "sub_1", status: "canceled" }));
    const base = {
      subscriptionId: "sbs_1",
      subscriptionRef: "sub_1",
      when: "now",
      reason: "x",
    } as const;
    await stripe.cancelSubscription(base);
    await stripe.cancelSubscription({ ...base, askKey: "cool-off-1" });
    await stripe.cancelSubscription({ ...base, askKey: "cool-off-2" });
    expect(requests.map((r) => r.headers.get("idempotency-key"))).toEqual([
      "cos-cancel-sbs_1-now",
      "cos-cancel-sbs_1-now-cool-off-1",
      "cos-cancel-sbs_1-now-cool-off-2",
    ]);
  });

  it("refunds with the documented fields, the refund id as idempotency key", async () => {
    const { stripe, requests } = provider(() => ok({ id: "re_1", status: "succeeded" }), {
      account: "acct_org",
    });
    expect(await stripe.refund({ ...refundInput, reason: "r".repeat(600) })).toEqual({
      refundRef: "re_1",
      status: "succeeded",
    });
    const [request] = requests;
    expect(request?.url).toBe("https://stripe.test/v1/refunds");
    expect(request?.headers.get("idempotency-key")).toBe("rf_1");
    expect(request?.headers.get("stripe-account")).toBe("acct_org");
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      payment_intent: "pi_123",
      amount: "2500",
      reason: "requested_by_customer",
      "metadata[order_id]": "ord_1",
      "metadata[cos_refund_id]": "rf_1",
      "metadata[reason]": "r".repeat(500),
    });
    const pending = provider(() => ok({ id: "re_2", status: "pending" }));
    expect((await pending.stripe.refund(refundInput)).status).toBe("pending");
  });

  it("maps a 4xx to ActionApplyError and a 5xx or network failure to ActionOutcomeUnknownError", async () => {
    const refused = provider(() => failing(400));
    const error400 = await refused.stripe.refund(refundInput).catch((e: unknown) => e);
    expect(error400).toBeInstanceOf(ActionApplyError);
    expect(String(error400)).toContain("invalid_request_error");
    // Stripe's message can quote the request; it is never repeated.
    expect(String(error400)).not.toContain("buyer@customer.test");

    const server = provider(() => failing(502));
    expect(await server.stripe.refund(refundInput).catch((e: unknown) => e)).toBeInstanceOf(
      ActionOutcomeUnknownError,
    );
    const network = provider(() => {
      throw new TypeError("connection reset");
    });
    expect(await network.stripe.refund(refundInput).catch((e: unknown) => e)).toBeInstanceOf(
      ActionOutcomeUnknownError,
    );
    // Rate limited: nothing was done, so a plain (retryable) error.
    const limited = await provider(() => failing(429))
      .stripe.refund(refundInput)
      .catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(Error);
    expect(limited).not.toBeInstanceOf(ActionApplyError);
    expect(limited).not.toBeInstanceOf(ActionOutcomeUnknownError);
  });
});

describe("Stripe event mapping", () => {
  const session = {
    id: "cs_1",
    payment_status: "paid",
    amount_total: 2500,
    currency: "aud",
    payment_intent: { id: "pi_1" },
    metadata: { order_id: "ord_meta" },
  };

  it("maps paid checkouts, falling back to metadata for the order", () => {
    expect(
      mapStripeEvent(
        { type: "checkout.session.completed", created: 1_800_000_000, data: { object: session } },
        "evt_1",
      ),
    ).toEqual({
      kind: "payment",
      provider: "stripe",
      eventId: "evt_1",
      orderId: "ord_meta",
      checkoutRef: "cs_1",
      amount: 2500,
      currency: "AUD",
      paymentRef: "pi_1",
      occurredAt: new Date(1_800_000_000_000).toISOString(),
    });
    expect(
      mapStripeEvent(
        {
          type: "checkout.session.async_payment_succeeded",
          data: { object: { ...session, payment_status: "unpaid", payment_intent: null } },
        },
        "evt_2",
      ),
    ).toMatchObject({ kind: "payment", paymentRef: null });
  });

  it("skips unpaid checkouts, checkouts without an order and unsucceeded refunds", () => {
    const skipped = [
      {
        type: "checkout.session.completed",
        data: { object: { ...session, payment_status: "unpaid" } },
      },
      { type: "checkout.session.completed", data: { object: { ...session, metadata: {} } } },
      {
        type: "refund.created",
        data: { object: { id: "re_1", status: "pending", amount: 1, currency: "aud" } },
      },
      { type: "charge.refunded", data: { object: {} } },
      { type: "refund.updated" },
    ];
    for (const event of skipped) expect(mapStripeEvent(event, "evt")).toBeNull();
  });

  it("maps a refund without metadata", () => {
    expect(
      mapStripeEvent(
        {
          type: "refund.created",
          data: { object: { id: "re_1", status: "succeeded", amount: 5, currency: "jpy" } },
        },
        "evt_r",
      ),
    ).toMatchObject({
      kind: "refund",
      orderId: null,
      refundId: null,
      refundRef: "re_1",
      paymentRef: null,
      amount: 5,
      currency: "JPY",
    });
  });

  it("accepts any matching v1 signature and refuses a malformed body", async () => {
    const body = JSON.stringify({ id: "evt_multi", type: "customer.created" });
    const t = Math.floor(Date.now() / 1000);
    const good = (await signatureHeader("whsec_x", body, t)).split("v1=")[1];
    const header = `t=${t},v1=${"0".repeat(64)},v1=${good},v0=ignored`;
    const bytes = new TextEncoder().encode(body);
    expect(await verifyStripeWebhook("whsec_x", { "stripe-signature": header }, bytes, t)).toEqual({
      ok: true,
      eventId: "evt_multi",
      events: [],
    });
    const notJson = new TextEncoder().encode("not json");
    const signed = await signatureHeader("whsec_x", "not json", t);
    expect(
      await verifyStripeWebhook("whsec_x", { "stripe-signature": signed }, notJson, t),
    ).toEqual({ ok: false, reason: "malformed body" });
    expect(await verifyStripeWebhook("", { "stripe-signature": header }, bytes, t)).toEqual({
      ok: false,
      reason: "not configured",
    });
  });
});

describe("money", () => {
  it("formats minor units with the currency's digits", () => {
    expect(formatMinor(2500, "AUD")).toBe("25.00 AUD");
    expect(formatMinor(5, "usd")).toBe("0.05 USD");
    expect(formatMinor(500, "JPY")).toBe("500 JPY");
    expect(formatMinor(1234, "KWD")).toBe("1.234 KWD");
    expect(formatMinor(9_007_199_254_740_991, "AUD")).toBe("90071992547409.91 AUD");
  });
});
