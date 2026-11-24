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

describe("the Stripe provider's card readers (stage 50, ADR 0774)", () => {
  const registration = {
    readerId: "rdr_1",
    registrationCode: "simulated-code",
    label: "Front desk",
    locationName: "The studio",
    address: { country: "AU", line1: "1 Example Street", city: "Exampleton", postcode: "3000" },
  };
  const present = {
    orderId: "ord_1",
    amount: 450,
    currency: "AUD",
    description: "A drink",
    readerRef: "tmr_1",
    idempotencyKey: "present-ord_1-1",
  };
  const refused = (code: string) =>
    new Response(JSON.stringify({ error: { type: "invalid_request_error", code } }), {
      status: 400,
    });

  it("registers a reader at a Location made once per address", async () => {
    const store = new Map<string, string>();
    const requests: Recorded[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const recorded: Recorded = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        form: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      };
      requests.push(recorded);
      return recorded.url.endsWith("/v1/terminal/locations")
        ? ok({ id: "tml_1" })
        : ok({
            id: "tmr_1",
            label: "Front desk",
            location: "tml_1",
            status: "online",
            device_type: "simulated_wisepos_e",
            metadata: { cos_reader: "rdr_1" },
          });
    }) as typeof fetch;
    const stripe = new StripeProvider({
      secretKey: "sk_test_key",
      webhookSecret: "whsec_x",
      apiBase: "https://stripe.test",
      account: "",
      fetch: fakeFetch,
      store: { get: (k) => store.get(k), put: (k, v) => void store.set(k, v) },
    });
    expect(await stripe.registerReader(registration)).toEqual({
      provider: "stripe",
      ref: "tmr_1",
      readerId: "rdr_1",
      label: "Front desk",
      locationRef: "tml_1",
      status: "online",
      deviceType: "simulated_wisepos_e",
    });
    const [location, reader] = requests;
    expect(location?.form.get("display_name")).toBe("The studio");
    expect(location?.form.get("address[postal_code]")).toBe("3000");
    expect(location?.headers.get("idempotency-key")).toMatch(/^[0-9a-f]{64}$/);
    expect(reader?.url).toBe("https://stripe.test/v1/terminal/readers");
    expect(reader?.form.get("registration_code")).toBe("simulated-code");
    expect(reader?.form.get("location")).toBe("tml_1");
    expect(reader?.form.get("metadata[cos_reader]")).toBe("rdr_1");
    expect(reader?.headers.get("idempotency-key")).toBe("cos-reader-rdr_1");
    await stripe.registerReader({ ...registration, readerId: "rdr_2" });
    expect(requests.filter((r) => r.url.endsWith("/v1/terminal/locations"))).toHaveLength(1);
  });

  it("a refused code registered nothing; a reader already gone is removed", async () => {
    const { stripe } = provider(() => refused("invalid_request"));
    await expect(stripe.registerReader(registration)).rejects.toBeInstanceOf(ActionApplyError);
    const gone = provider(() => refused("resource_missing"));
    await gone.stripe.removeReader({ readerId: "rdr_1", readerRef: "tmr_1", reason: "Replaced" });
    expect(gone.requests[0]?.method).toBe("DELETE");
    const other = provider(() => failing(500));
    await expect(
      other.stripe.removeReader({ readerId: "rdr_1", readerRef: "tmr_1", reason: "Replaced" }),
    ).rejects.not.toBeInstanceOf(ActionApplyError);
  });

  it("presents a card_present PaymentIntent on the reader, keyed by the presentation", async () => {
    const { stripe, requests } = provider((r) =>
      r.url.endsWith("/v1/payment_intents")
        ? ok({ id: "pi_1", status: "requires_payment_method" })
        : ok({ id: "tmr_1" }),
    );
    expect(await stripe.presentPayment(present)).toEqual({
      ref: "pi_1",
      readerRef: "tmr_1",
      status: "presented",
    });
    const [intent, process] = requests;
    expect(intent?.form.get("amount")).toBe("450");
    expect(intent?.form.get("currency")).toBe("aud");
    expect(intent?.form.get("payment_method_types[0]")).toBe("card_present");
    expect(intent?.form.get("capture_method")).toBe("automatic");
    expect(intent?.form.get("metadata[order_id]")).toBe("ord_1");
    expect(intent?.headers.get("idempotency-key")).toBe("present-ord_1-1:intent");
    expect(process?.url).toBe(
      "https://stripe.test/v1/terminal/readers/tmr_1/process_payment_intent",
    );
    expect(process?.form.get("payment_intent")).toBe("pi_1");
    expect(process?.headers.get("idempotency-key")).toBeNull();
  });

  it("a retry after a timeout charges once: paid is answered paid, on the reader is presented", async () => {
    const paid = provider(() => ok({ id: "pi_1", status: "succeeded" }));
    expect((await paid.stripe.presentPayment(present)).status).toBe("paid");
    expect(paid.requests).toHaveLength(1);

    const onReader = provider((r) => {
      if (r.url.endsWith("/v1/payment_intents"))
        return ok({ id: "pi_1", status: "requires_payment_method" });
      if (r.url.endsWith("/process_payment_intent")) return refused("terminal_reader_busy");
      return ok({
        id: "tmr_1",
        action: {
          type: "process_payment_intent",
          status: "in_progress",
          process_payment_intent: { payment_intent: "pi_1" },
        },
      });
    });
    expect((await onReader.stripe.presentPayment(present)).status).toBe("presented");

    const busy = provider((r) => {
      if (r.url.endsWith("/v1/payment_intents"))
        return ok({ id: "pi_1", status: "requires_payment_method" });
      if (r.url.endsWith("/process_payment_intent")) return refused("terminal_reader_busy");
      if (r.url.includes("/v1/payment_intents/pi_1"))
        return ok({ id: "pi_1", status: "requires_payment_method" });
      return ok({
        id: "tmr_1",
        action: {
          type: "process_payment_intent",
          status: "in_progress",
          process_payment_intent: { payment_intent: "pi_other" },
        },
      });
    });
    await expect(busy.stripe.presentPayment(present)).rejects.toThrow(/busy with another payment/);
  });

  it("clears the reader with cancel_action", async () => {
    const { stripe, requests } = provider(() => ok({ id: "tmr_1" }));
    await stripe.cancelPresented("tmr_1");
    expect(requests[0]?.url).toBe("https://stripe.test/v1/terminal/readers/tmr_1/cancel_action");
    expect(requests[0]?.method).toBe("POST");
  });

  it("maps a card-present PaymentIntent's success, and ignores a web checkout's", () => {
    const intent = (types: string[]) => ({
      type: "payment_intent.succeeded",
      created: 1_800_000_000,
      data: {
        object: {
          id: "pi_1",
          amount: 450,
          amount_received: 450,
          currency: "aud",
          payment_method_types: types,
          metadata: { order_id: "ord_1" },
        },
      },
    });
    expect(mapStripeEvent(intent(["card_present"]), "evt_1")).toEqual({
      kind: "payment",
      provider: "stripe",
      eventId: "evt_1",
      orderId: "ord_1",
      checkoutRef: "pi_1",
      amount: 450,
      currency: "AUD",
      paymentRef: "pi_1",
      occurredAt: new Date(1_800_000_000 * 1000).toISOString(),
    });
    expect(mapStripeEvent(intent(["card"]), "evt_2")).toBeNull();
  });

  it("maps a reader's failed action as a reader event: declined or cancelled", () => {
    const failed = (code: string | null) => ({
      type: "terminal.reader.action_failed",
      created: 1_800_000_000,
      data: {
        object: {
          id: "tmr_1",
          action: {
            type: "process_payment_intent",
            status: "failed",
            failure_code: code,
            failure_message: "The card holder is buyer@customer.test",
            process_payment_intent: { payment_intent: "pi_1" },
          },
        },
      },
    });
    expect(mapStripeEvent(failed("card_declined"), "evt_3")).toEqual({
      kind: "reader",
      provider: "stripe",
      eventId: "evt_3",
      readerRef: "tmr_1",
      checkoutRef: "pi_1",
      outcome: "failed",
      failureCode: "card_declined",
      occurredAt: new Date(1_800_000_000 * 1000).toISOString(),
    });
    expect(mapStripeEvent(failed("customer_canceled"), "evt_4")).toMatchObject({
      outcome: "cancelled",
    });
    // The provider's message is never carried: it is free text.
    expect(JSON.stringify(mapStripeEvent(failed("card_declined"), "evt_5"))).not.toContain(
      "customer.test",
    );
  });
});
