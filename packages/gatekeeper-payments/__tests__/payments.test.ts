import { env, exports } from "cloudflare:workers";
import type {
  ActionDescription,
  ActionField,
} from "@composable-os/gatekeeper-interface/gatekeeper";
import { describe, expect, it, vi } from "vitest";
import { type FakeLedgerState, fakeLedger } from "../src/fake.js";
import { assertProviderAvailable, unavailableReason } from "../src/provider.js";
import { signatureHeader } from "../src/signature.js";
import type {
  PaymentsCheckout,
  PaymentsCheckoutInput,
  PaymentsEvent,
  PaymentsPayment,
  PaymentsRefundReceipt,
} from "../src/types.js";

// vitest.config.ts sets BASE_URL with a trailing slash, which the Worker strips.
const BASE = "https://crm.example.com/gatekeeper/payments";
const FAKE_SECRET = "fake-payments-dev-secret";
const STRIPE_SECRET = "whsec_test_0123456789abcdef";
const RETURN_URL = "https://shop.example.com/orders/return?o=1";

// The RPC stub types of entrypoints returned over RPC collapse; these are the shapes used here.
type Ui = {
  providers(): Promise<{ name: string; title: string; available: boolean }[]>;
  resourceUrl(provider: unknown): Promise<string>;
};
type Account = {
  describe(): Promise<{ displayName: string }>;
  getSupportedResources(): Promise<{ urlPattern: string; title: string; grantable?: boolean }[]>;
  getGatekeeperClassFor(url: string): Promise<unknown>;
  startResourceConfigurator(pattern: string): Promise<{ iframeHtml: string; ui: Ui }>;
};
const vendor = exports.GatekeeperVendor as unknown as {
  describe(): Promise<{
    displayName: string;
    autoProvisionsAccount?: boolean;
    providesAuth?: boolean;
  }>;
  createAccount(): Promise<Account>;
  connectAccount(callback: unknown): Promise<unknown>;
  getSupportedResources(): Promise<{ urlPattern: string; title: string; grantable?: boolean }[]>;
  getTypeScriptTypes(): Promise<string>;
};

let counter = 0;
function unique(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;
}

async function host(provider: "fake" | "stripe" = "fake") {
  const stub = env.TEST_HOST.getByName(unique("host"));
  await stub.open(provider);
  return stub;
}
type Host = Awaited<ReturnType<typeof host>>;

function checkoutInput(orderId: string, overrides: Partial<PaymentsCheckoutInput> = {}) {
  return {
    orderId,
    amount: 2500,
    currency: "aud",
    description: "Two tickets <to> the show",
    returnUrl: RETURN_URL,
    idempotencyKey: `checkout-${orderId}`,
    ...overrides,
  };
}

async function openCheckout(h: Host, orderId: string): Promise<PaymentsCheckout> {
  return (await h.call("createCheckout", [checkoutInput(orderId)])) as PaymentsCheckout;
}

function payPath(checkout: PaymentsCheckout): string {
  return new URL(checkout.url).pathname;
}

function submitPage(checkout: PaymentsCheckout, fields: Record<string, string>): Promise<Response> {
  return exports.default.fetch(
    new Request(checkout.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    }),
  );
}

async function eventsFor(h: Host, orderId: string): Promise<PaymentsEvent[]> {
  return (await h.recorded()).received.filter((event) => event.orderId === orderId);
}

async function ledger(): Promise<FakeLedgerState> {
  // Through the ledger's own binding: no route serves it (ADR 0458).
  return (await fakeLedger(env as never).state()) as FakeLedgerState;
}

function post(path: string, body: string, headers: Record<string, string>): Promise<Response> {
  return exports.default.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

const now = () => Math.floor(Date.now() / 1000);

function field(fields: ActionField[] | undefined, label: string): ActionField | undefined {
  return fields?.find((f) => f.label === label);
}

/** Opens a checkout and pays it on the fake page; returns the checkout and its payment ref. */
async function paidCheckout(
  h: Host,
  orderId: string,
): Promise<{ ref: string; paymentRef: string }> {
  const checkout = await openCheckout(h, orderId);
  expect((await submitPage(checkout, { outcome: "pay" })).status).toBe(303);
  const payment = (await h.call("getPayment", [checkout.ref])) as PaymentsPayment;
  if (!payment.paymentRef) throw new Error("not paid");
  return { ref: checkout.ref, paymentRef: payment.paymentRef };
}

describe("the vendor and account", () => {
  it("describes an auto-provisioned vendor with one grantable resource type", async () => {
    const description = await vendor.describe();
    expect(description).toMatchObject({
      displayName: "Payments",
      autoProvisionsAccount: true,
      providesAuth: false,
    });
    const resources = await vendor.getSupportedResources();
    expect(resources).toEqual([
      expect.objectContaining({
        urlPattern: "payments://merchant/:provider",
        title: "Payment account",
        grantable: true,
      }),
    ]);
    await expect(vendor.connectAccount({})).rejects.toThrow(/auto-provisioned/);
    const account = await vendor.createAccount();
    expect((await account.describe()).displayName).toBe("Payments");
    expect(await account.getSupportedResources()).toEqual(resources);
  });

  it("serves self-contained session types", async () => {
    const types = await vendor.getTypeScriptTypes();
    for (const name of [
      "PaymentsSession",
      "PaymentsEventHook",
      "PaymentsEvent",
      "PaymentsCheckoutInput",
      "PaymentsRefundInput",
      "PaymentsRefundReceipt",
      "PaymentsProviderName",
    ]) {
      expect(types).toContain(name);
    }
    expect(types).not.toMatch(/^import /m);
  });

  it("refuses URLs that are not payment account URLs", async () => {
    const account = await vendor.createAccount();
    for (const url of [
      "payments://merchant/paypal",
      "payments://merchant/stripe/x",
      "https://example.com",
    ]) {
      await expect(account.getGatekeeperClassFor(url)).rejects.toThrow(/payment account URL/);
    }
    await expect(account.startResourceConfigurator("https://other/*")).rejects.toThrow(
      /Unsupported/,
    );
  });

  it("refuses the fake provider when it is off, and Stripe without a secret key", () => {
    expect(() => assertProviderAvailable({ PAYMENTS_FAKE_PROVIDER: "false" }, "fake")).toThrow(
      /PAYMENTS_FAKE_PROVIDER=true/,
    );
    expect(() => assertProviderAvailable({ PAYMENTS_FAKE_PROVIDER: "false" }, "stripe")).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    expect(
      unavailableReason({ PAYMENTS_FAKE_PROVIDER: "false", STRIPE_SECRET_KEY: "sk_x" }, "stripe"),
    ).toBeUndefined();
    expect(unavailableReason({ PAYMENTS_FAKE_PROVIDER: "true" } as never, "fake")).toBeUndefined();
  });

  it("offers a configurator capability naming the providers this deployment has", async () => {
    const account = await vendor.createAccount();
    const { iframeHtml, ui } = await account.startResourceConfigurator(
      "payments://merchant/:provider",
    );
    expect(iframeHtml).toContain("Payment account");
    expect(await ui.providers()).toEqual([
      { name: "stripe", title: "Stripe", available: true },
      { name: "fake", title: "Fake provider (development)", available: true },
    ]);
    expect(await ui.resourceUrl("fake")).toBe("payments://merchant/fake");
    await expect(ui.resourceUrl("paypal")).rejects.toThrow(/provider/);
  });
});

describe("the facet and session", () => {
  it("describes the facet and has no auto-approvable actions", async () => {
    const stub = env.TEST_HOST.getByName(unique("describe"));
    expect(await stub.open("fake")).toEqual({
      url: "payments://merchant/fake",
      title: "Payments with Fake provider (development)",
      snippet: expect.stringContaining("refund"),
      suggestedBindingName: "PAYMENTS",
      tsType: "PaymentsSession",
      hookTsType: "PaymentsEventHook",
    });
    expect(await stub.autoApprovable()).toEqual([]);
    expect(await stub.types()).toContain("PaymentsSession");
    expect(await stub.call("provider", [])).toBe("fake");
  });

  it("opens a fake checkout after recording an observation, once per idempotency key", async () => {
    const h = await host();
    const orderId = unique("ord");
    const input = checkoutInput(orderId, { customerEmail: "buyer@customer.test" });
    const first = (await h.call("createCheckout", [input])) as PaymentsCheckout;
    expect(first).toEqual({
      provider: "fake",
      ref: expect.stringMatching(/^fcs_[A-Za-z0-9]+$/),
      url: `${BASE}/fake/pay/${first.ref}`,
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const expiresIn = Date.parse(first.expiresAt ?? "") - Date.now();
    expect(expiresIn).toBeGreaterThan(29 * 60 * 1000);
    expect(expiresIn).toBeLessThanOrEqual(30 * 60 * 1000);

    const again = (await h.call("createCheckout", [input])) as PaymentsCheckout;
    expect(again).toEqual(first);
    const other = (await h.call("createCheckout", [
      { ...input, idempotencyKey: `${input.idempotencyKey}-2` },
    ])) as PaymentsCheckout;
    expect(other.ref).not.toBe(first.ref);

    const { observations } = await h.recorded();
    const opened = observations.filter((o) => o.title.includes(orderId));
    expect(opened).toHaveLength(3);
    expect(opened[0]?.title).toBe(`Open a checkout of 25.00 AUD for order ${orderId}`);
    // The prefilled email is mentioned, never quoted.
    expect(JSON.stringify(opened)).not.toContain("buyer@customer.test");

    const payment = (await h.call("getPayment", [first.ref])) as PaymentsPayment;
    expect(payment).toEqual({
      provider: "fake",
      ref: first.ref,
      status: "open",
      orderId,
      amount: 2500,
      currency: "AUD",
      paymentRef: null,
    });
  });

  it("validates checkout and refund input", async () => {
    const h = await host();
    const good = checkoutInput(unique("ord"));
    const cases: [Record<string, unknown> | string, RegExp][] = [
      ["nope", /object/],
      [{ ...good, orderId: "has space" }, /orderId/],
      [{ ...good, amount: 0 }, /amount/],
      [{ ...good, amount: 1.5 }, /amount/],
      [{ ...good, amount: "2500" }, /amount/],
      [{ ...good, currency: "dollars" }, /currency/],
      [{ ...good, description: "" }, /description/],
      [{ ...good, description: "x".repeat(201) }, /description/],
      [{ ...good, returnUrl: "http://shop.example.com/" }, /returnUrl/],
      [{ ...good, returnUrl: "javascript:alert(1)" }, /returnUrl/],
      [{ ...good, returnUrl: "/relative" }, /returnUrl/],
      [{ ...good, customerEmail: "not an email" }, /customerEmail/],
      [{ ...good, idempotencyKey: "" }, /idempotencyKey/],
      [{ ...good, card: "4242424242424242" }, /Unrecognized key/],
    ];
    for (const [input, error] of cases) {
      await expect(h.call("createCheckout", [input])).rejects.toThrow(error);
    }
    // Local return URLs are fine for development.
    for (const returnUrl of ["http://localhost:5173/back", "http://127.0.0.1:8787/x"]) {
      await expect(
        h.call("createCheckout", [checkoutInput(unique("ord"), { returnUrl })]),
      ).resolves.toMatchObject({ provider: "fake" });
    }
    await expect(h.call("getPayment", ["../etc"])).rejects.toThrow(/ref/);
    await expect(
      h.call("refund", [
        { orderId: "o", paymentRef: "p", amount: 1, currency: "AUD", reason: "", refundId: "r" },
      ]),
    ).rejects.toThrow(/reason/);
  });
});

describe("the fake hosted page", () => {
  it("shows the order and amount with Pay and Cancel, self-contained", async () => {
    const h = await host();
    const checkout = await openCheckout(h, unique("ord"));
    const response = await exports.default.fetch(new Request(checkout.url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<title>Fake payment page</title>");
    expect(html).toContain("Two tickets &lt;to&gt; the show");
    expect(html).toContain("25.00 AUD");
    expect(html).toContain('name="outcome" value="pay"');
    expect(html).toContain('name="outcome" value="cancel"');
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//);
  });

  it("pays once: one payment event to the hook and a 303 back to the return URL", async () => {
    const h = await host();
    const bound = await h.bindAndEnable();
    expect(bound.title).toContain("Fake provider");
    const orderId = unique("ord");
    const checkout = await openCheckout(h, orderId);

    const paid = await submitPage(checkout, { outcome: "pay" });
    expect(paid.status).toBe(303);
    expect(paid.headers.get("location")).toBe(RETURN_URL);
    await vi.waitFor(async () => expect(await eventsFor(h, orderId)).toHaveLength(1));
    const [event] = await eventsFor(h, orderId);
    expect(event).toEqual({
      kind: "payment",
      provider: "fake",
      eventId: `fevt_pay_${checkout.ref}`,
      orderId,
      checkoutRef: checkout.ref,
      amount: 2500,
      currency: "AUD",
      paymentRef: expect.stringMatching(/^fpi_/),
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const { firingObservations } = await h.recorded();
    const observed = firingObservations.find((o) => o.description.includes(orderId));
    expect(observed?.title).toBe("Payment event payment");
    expect(observed?.description).toContain("25.00 AUD");

    // A second pay is a no-op: still redirected, nothing more delivered.
    const again = await submitPage(checkout, { outcome: "pay" });
    expect(again.status).toBe(303);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await eventsFor(h, orderId)).toHaveLength(1);

    const payment = (await h.call("getPayment", [checkout.ref])) as PaymentsPayment;
    expect(payment).toMatchObject({ status: "paid", paymentRef: event?.paymentRef });
  });

  it("cancels without paying", async () => {
    const h = await host();
    await h.bindAndEnable();
    const orderId = unique("ord");
    const checkout = await openCheckout(h, orderId);
    const cancelled = await submitPage(checkout, { outcome: "cancel" });
    expect(cancelled.status).toBe(303);
    expect(cancelled.headers.get("location")).toBe(RETURN_URL);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await eventsFor(h, orderId)).toHaveLength(0);
    expect(await h.call("getPayment", [checkout.ref])).toMatchObject({ status: "open" });
  });

  it("pays the checkout's own amount: an amount in the form is ignored (ADR 0458)", async () => {
    const h = await host();
    await h.bindAndEnable();
    const orderId = unique("ord");
    const checkout = await openCheckout(h, orderId);
    const opened = (await ledger()).checkouts.find((c) => c.ref === checkout.ref);
    expect((await submitPage(checkout, { outcome: "pay", amount: "100" })).status).toBe(303);
    await vi.waitFor(async () => expect(await eventsFor(h, orderId)).toHaveLength(1));
    expect((await eventsFor(h, orderId))[0]).toMatchObject({ amount: opened?.amount });
    expect(opened?.amount).not.toBe(100);
  });

  it("refuses a post from another site, and lets its own page's form back to the site", async () => {
    const h = await host();
    await h.bindAndEnable();
    const orderId = unique("ord");
    const checkout = await openCheckout(h, orderId);
    const page = await exports.default.fetch(new Request(checkout.url));
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`form-action 'self' ${new URL(RETURN_URL).origin};`);
    expect(csp).toContain("frame-ancestors 'none'");
    for (const headers of [
      { origin: "https://evil.test" } as Record<string, string>,
      { origin: "https://evil.test", "sec-fetch-site": "cross-site" },
      { origin: "null", "sec-fetch-site": "cross-site" },
      { origin: "null" },
      { "sec-fetch-site": "same-site" },
    ]) {
      const refused = await exports.default.fetch(
        new Request(checkout.url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams({ outcome: "pay" }),
          redirect: "manual",
        }),
      );
      expect(refused.status, JSON.stringify(headers)).toBe(403);
    }
    expect(await eventsFor(h, orderId)).toHaveLength(0);
    // Its own page's form, as a browser sends it.
    const own = await exports.default.fetch(
      new Request(checkout.url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: new URL(checkout.url).origin,
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({ outcome: "pay" }),
        redirect: "manual",
      }),
    );
    expect(own.status).toBe(303);
    expect(own.headers.get("location")).toBe(RETURN_URL);
  });

  it("serves no route that reads the ledger", async () => {
    const state = await exports.default.fetch(new Request(`${BASE}/fake/state`));
    expect(state.status).toBe(404);
  });

  it("answers 404 for an unknown ref and 400 for an unknown outcome", async () => {
    const h = await host();
    const unknown = await exports.default.fetch(new Request(`${BASE}/fake/pay/fcs_unknown`));
    expect(unknown.status).toBe(404);
    const unknownPost = await submitPage(
      {
        provider: "fake",
        ref: "fcs_unknown",
        url: `${BASE}/fake/pay/fcs_unknown`,
        expiresAt: null,
      },
      { outcome: "pay" },
    );
    expect(unknownPost.status).toBe(404);
    const checkout = await openCheckout(h, unique("ord"));
    expect((await submitPage(checkout, { outcome: "steal" })).status).toBe(400);
    expect(payPath(checkout)).toBe(`/gatekeeper/payments/fake/pay/${checkout.ref}`);
  });
});

describe("inbound webhooks", () => {
  it("answers 401 to a bad or missing signature and delivers nothing", async () => {
    const h = await host();
    await h.bindAndEnable();
    const orderId = unique("ord");
    const body = JSON.stringify({
      id: unique("fevt"),
      type: "payment.succeeded",
      created: now(),
      data: { orderId, checkoutRef: "fcs_x", amount: 1, currency: "AUD", paymentRef: null },
    });
    const good = await signatureHeader(FAKE_SECRET, body, now());
    const wrongSecret = await signatureHeader("not-the-secret", body, now());
    const stale = await signatureHeader(FAKE_SECRET, body, now() - 10 * 60);
    const attempts: [string, Record<string, string>, string][] = [
      ["missing", {}, body],
      ["wrong secret", { "X-Fake-Signature": wrongSecret }, body],
      ["stale", { "X-Fake-Signature": stale }, body],
      ["tampered", { "X-Fake-Signature": good }, body.replace('"amount":1', '"amount":2')],
      ["garbage", { "X-Fake-Signature": "t=1,v1=zz" }, body],
    ];
    for (const [label, headers, sent] of attempts) {
      const response = await post("/in/fake", sent, headers);
      expect(response.status, label).toBe(401);
      expect(((await response.json()) as { ok: boolean }).ok, label).toBe(false);
    }

    const stripeBody = JSON.stringify({ id: unique("evt"), type: "refund.updated", data: {} });
    const stripeAttempts: Record<string, string>[] = [
      {},
      { "Stripe-Signature": await signatureHeader("whsec_wrong", stripeBody, now()) },
    ];
    for (const headers of stripeAttempts) {
      expect((await post("/in/stripe", stripeBody, headers)).status).toBe(401);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await eventsFor(h, orderId)).toHaveLength(0);
  });

  it("acknowledges a replayed delivery as a duplicate and delivers it once", async () => {
    const h = await host();
    await h.bindAndEnable();
    const orderId = unique("ord");
    const body = JSON.stringify({
      id: unique("fevt"),
      type: "payment.succeeded",
      created: now(),
      data: {
        orderId,
        checkoutRef: "fcs_replay",
        amount: 700,
        currency: "nzd",
        paymentRef: "fpi_r",
      },
    });
    const headers = { "X-Fake-Signature": await signatureHeader(FAKE_SECRET, body, now()) };
    const first = await post("/in/fake", body, headers);
    const second = await post("/in/fake", body, headers);
    expect(await first.json()).toEqual({ ok: true });
    expect(await second.json()).toEqual({ ok: true, duplicate: true });
    await vi.waitFor(async () => expect(await eventsFor(h, orderId)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await eventsFor(h, orderId)).toEqual([
      expect.objectContaining({ amount: 700, currency: "NZD", paymentRef: "fpi_r" }),
    ]);
  });

  it("answers 413 to an oversized body and 405 to a GET", async () => {
    const big = JSON.stringify({ blob: "x".repeat(300 * 1024) });
    expect((await post("/in/stripe", big, { "Stripe-Signature": "t=1,v1=00" })).status).toBe(413);
    expect((await exports.default.fetch(new Request(`${BASE}/in/fake`))).status).toBe(405);
    expect((await exports.default.fetch(new Request(`${BASE}/elsewhere`))).status).toBe(404);
    expect(
      (await exports.default.fetch(new Request("https://crm.example.com/other/in/stripe"))).status,
    ).toBe(404);
  });

  describe("Stripe events", () => {
    async function sendStripe(event: Record<string, unknown>, timestamp = now()) {
      const body = JSON.stringify(event);
      return post("/in/stripe", body, {
        "Stripe-Signature": await signatureHeader(STRIPE_SECRET, body, timestamp),
      });
    }

    it("maps a paid checkout.session.completed and a succeeded refund, and ignores the rest", async () => {
      const h = await host("stripe");
      await h.bindAndEnable();
      const orderId = unique("ord");
      const created = now();
      const paid = await sendStripe({
        id: unique("evt"),
        type: "checkout.session.completed",
        created,
        data: {
          object: {
            id: "cs_test_paid",
            payment_status: "paid",
            client_reference_id: orderId,
            amount_total: 4200,
            currency: "aud",
            payment_intent: "pi_123",
            customer_details: { email: "buyer@customer.test" },
          },
        },
      });
      expect(await paid.json()).toEqual({ ok: true });

      const unpaid = await sendStripe({
        id: unique("evt"),
        type: "checkout.session.completed",
        created,
        data: {
          object: {
            id: "cs_test_unpaid",
            payment_status: "unpaid",
            client_reference_id: orderId,
            amount_total: 4200,
            currency: "aud",
          },
        },
      });
      expect(await unpaid.json()).toEqual({ ok: true, ignored: true });

      const refundEventId = unique("evt");
      const refunded = await sendStripe({
        id: refundEventId,
        type: "refund.updated",
        created,
        data: {
          object: {
            id: "re_1",
            status: "succeeded",
            amount: 1000,
            currency: "aud",
            payment_intent: { id: "pi_123" },
            metadata: { order_id: orderId, cos_refund_id: "rf_1" },
          },
        },
      });
      expect(await refunded.json()).toEqual({ ok: true });

      const ignored = await sendStripe({
        id: unique("evt"),
        type: "customer.created",
        created,
        data: { object: { id: "cus_1" } },
      });
      expect(await ignored.json()).toEqual({ ok: true, ignored: true });

      const stale = await sendStripe(
        { id: unique("evt"), type: "refund.created", data: {} },
        now() - 10 * 60,
      );
      expect(stale.status).toBe(401);

      await vi.waitFor(async () => expect(await eventsFor(h, orderId)).toHaveLength(2));
      const events = await eventsFor(h, orderId);
      const occurredAt = new Date(created * 1000).toISOString();
      expect(events).toContainEqual({
        kind: "payment",
        provider: "stripe",
        eventId: expect.stringMatching(/^evt_/),
        orderId,
        checkoutRef: "cs_test_paid",
        amount: 4200,
        currency: "AUD",
        paymentRef: "pi_123",
        occurredAt,
      });
      expect(events).toContainEqual({
        kind: "refund",
        provider: "stripe",
        eventId: refundEventId,
        orderId,
        refundId: "rf_1",
        refundRef: "re_1",
        paymentRef: "pi_123",
        amount: 1000,
        currency: "AUD",
        occurredAt,
      });
      expect(JSON.stringify(events)).not.toContain("buyer@customer.test");
    });
  });
});

describe("refunds", () => {
  it("submits a payments.refund action with the described fields and sends nothing until applied", async () => {
    const h = await host();
    await h.bindAndEnable();
    const orderId = unique("ord");
    const { paymentRef } = await paidCheckout(h, orderId);
    const refundId = unique("rf");
    const input = {
      orderId,
      paymentRef,
      amount: 2500,
      currency: "aud",
      reason: "Customer could not attend.\nAsked by phone.",
      refundId,
    };
    const receipt = (await h.call("refund", [input])) as PaymentsRefundReceipt;
    expect(receipt).toEqual({ status: "pending", id: 1 });

    // The tuple type does not survive the RPC stub's typing.
    const submissions = (await h.recorded()).submissions as [number, ActionDescription][];
    const [, description] = submissions.find(([, d]) => d.title.includes(orderId)) ?? [];
    expect(description).toMatchObject({
      title: `Refund 25.00 AUD on order ${orderId}`,
      descriptionIsComplete: true,
      implementsRevert: false,
      autoApprovable: false,
      actionKind: { tag: "payments.refund", label: "Refund a payment" },
    });
    const fields = description?.fields;
    expect(field(fields, "Provider")).toEqual({
      label: "Provider",
      kind: "inline",
      value: "Fake provider (development)",
    });
    expect(field(fields, "Order")).toEqual({ label: "Order", kind: "inline", value: orderId });
    expect(field(fields, "Payment")).toEqual({
      label: "Payment",
      kind: "inline",
      value: paymentRef,
    });
    expect(field(fields, "Amount")).toEqual({
      label: "Amount",
      kind: "inline",
      value: "25.00 AUD (2500 minor units)",
    });
    expect(field(fields, "Reason")).toEqual({ label: "Reason", kind: "text", value: input.reason });
    expect(field(fields, "Refund id")).toEqual({
      label: "Refund id",
      kind: "inline",
      value: refundId,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await ledger()).refunds.filter((r) => r.paymentRef === paymentRef)).toEqual([]);
    expect((await eventsFor(h, orderId)).filter((e) => e.kind === "refund")).toEqual([]);

    await h.apply(receipt.id);
    await h.apply(receipt.id);
    const refunds = (await ledger()).refunds.filter((r) => r.paymentRef === paymentRef);
    expect(refunds).toEqual([
      expect.objectContaining({ amount: 2500, currency: "AUD", orderId, refundId }),
    ]);
    await vi.waitFor(async () =>
      expect((await eventsFor(h, orderId)).filter((e) => e.kind === "refund")).toHaveLength(1),
    );
    const refundEvent = (await eventsFor(h, orderId)).find((e) => e.kind === "refund");
    expect(refundEvent).toEqual({
      kind: "refund",
      provider: "fake",
      eventId: `fevt_refund_${refunds[0]?.refundRef}`,
      orderId,
      refundId,
      refundRef: refunds[0]?.refundRef,
      paymentRef,
      amount: 2500,
      currency: "AUD",
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    await expect(h.revert(receipt.id)).rejects.toThrow(/cannot be taken back/);
  });

  it("sends nothing for a rejected refund", async () => {
    const h = await host();
    const orderId = unique("ord");
    const { paymentRef } = await paidCheckout(h, orderId);
    const receipt = (await h.call("refund", [
      {
        orderId,
        paymentRef,
        amount: 100,
        currency: "AUD",
        reason: "Duplicate",
        refundId: unique("rf"),
      },
    ])) as PaymentsRefundReceipt;
    await h.reject(receipt.id);
    await expect(h.apply(receipt.id)).rejects.toThrow(/Unknown pending action/);
    expect((await ledger()).refunds.filter((r) => r.paymentRef === paymentRef)).toEqual([]);
  });

  it("fails to apply a refund of more than was paid, in total", async () => {
    const h = await host();
    const orderId = unique("ord");
    const { paymentRef } = await paidCheckout(h, orderId);
    const refund = async (amount: number) =>
      (
        (await h.call("refund", [
          {
            orderId,
            paymentRef,
            amount,
            currency: "AUD",
            reason: "Partial",
            refundId: unique("rf"),
          },
        ])) as PaymentsRefundReceipt
      ).id;
    const first = await refund(2000);
    const tooMuch = await refund(600);
    await h.apply(first);
    await expect(h.apply(tooMuch)).rejects.toThrow(/refused the refund, so nothing was refunded/);
    // Terminal: a second attempt gets the same answer without another provider call.
    await expect(h.apply(tooMuch)).rejects.toThrow(/refused the refund/);
    const rest = await refund(500);
    await h.apply(rest);
    expect(
      (await ledger()).refunds.filter((r) => r.paymentRef === paymentRef).map((r) => r.amount),
    ).toEqual(expect.arrayContaining([2000, 500]));
    expect((await ledger()).refunds.filter((r) => r.paymentRef === paymentRef)).toHaveLength(2);
  });

  it("refuses an unknown payment or a different currency when applied", async () => {
    const h = await host();
    const orderId = unique("ord");
    const { paymentRef } = await paidCheckout(h, orderId);
    const unknown = (await h.call("refund", [
      {
        orderId,
        paymentRef: "fpi_nope",
        amount: 1,
        currency: "AUD",
        reason: "x",
        refundId: unique("rf"),
      },
    ])) as PaymentsRefundReceipt;
    await expect(h.apply(unknown.id)).rejects.toThrow(/no paid payment/);
    const currency = (await h.call("refund", [
      { orderId, paymentRef, amount: 1, currency: "USD", reason: "x", refundId: unique("rf") },
    ])) as PaymentsRefundReceipt;
    await expect(h.apply(currency.id)).rejects.toThrow(/AUD/);
  });
});

describe("card data", () => {
  it("never stores or delivers anything that looks like a card number", async () => {
    const h = await host();
    await h.bindAndEnable();
    const orderId = unique("ord");
    const checkout = await openCheckout(h, orderId);
    // Even a card number posted to the page is never read.
    const response = await submitPage(checkout, {
      outcome: "pay",
      card: "4242424242424242",
      cvc: "123",
    });
    expect(response.status).toBe(303);
    await vi.waitFor(async () => expect(await eventsFor(h, orderId)).toHaveLength(1));
    const { paymentRef } = (await h.call("getPayment", [checkout.ref])) as PaymentsPayment;
    const receipt = (await h.call("refund", [
      {
        orderId,
        paymentRef,
        amount: 2500,
        currency: "AUD",
        reason: "Test",
        refundId: unique("rf"),
      },
    ])) as PaymentsRefundReceipt;
    await h.apply(receipt.id);
    await vi.waitFor(async () => expect(await eventsFor(h, orderId)).toHaveLength(2));

    const cardLike = /\d{13,19}/;
    expect(JSON.stringify(await ledger())).not.toMatch(cardLike);
    expect(JSON.stringify(await eventsFor(h, orderId))).not.toMatch(cardLike);
    const recent = await env.PAYMENTS_EVENTS.get(env.PAYMENTS_EVENTS.idFromName("fake")).listEvents(
      100,
    );
    expect(JSON.stringify(recent)).not.toMatch(cardLike);
  });
});
