// Stage 32a, build step 1 (ADR 0485, 0486): the gatekeeper's subscription checkout, events,
// cancel, resume and portal, through the fake provider end to end, and the Stripe provider's
// requests and reads against recorded shapes (no real Stripe).
import { env, exports } from "cloudflare:workers";
import type { ActionDescription } from "@composable-os/gatekeeper-interface/gatekeeper";
import { ActionApplyError, ActionOutcomeUnknownError } from "@composable-os/gatekeeper-kit/actions";
import { describe, expect, it, vi } from "vitest";
import { type FakeLedgerState, fakeLedger } from "../src/fake.js";
import { fakeEnabled, unavailableReason } from "../src/provider.js";
import { advanceFakeSubscription } from "../src/routes.js";
import { signatureHeader } from "../src/signature.js";
import {
  mapStripeEvent,
  STRIPE_BILLING_VERSION,
  StripeProvider,
  stripeInvoiceRead,
  stripeReadFor,
  stripeSubscriptionRead,
  verifyStripeWebhook,
} from "../src/stripe.js";
import type {
  PaymentsCheckout,
  PaymentsEvent,
  PaymentsPortal,
  PaymentsRefundReceipt,
  PaymentsSubscription,
  PaymentsSubscriptionChangeReceipt,
} from "../src/types.js";
import { parseSubscriptionCheckoutInput, validInstant } from "../src/validate.js";

const RETURN_URL = "https://shop.example.com/account/billing";

let counter = 0;
function unique(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;
}

async function host(asHost = false) {
  const stub = env.TEST_HOST.getByName(unique("host"));
  await stub.open("fake", asHost);
  await stub.bindAndEnable();
  return stub;
}
type Host = Awaited<ReturnType<typeof host>>;
type SubscriptionEvent = Extract<PaymentsEvent, { kind: "subscription" }>;

function subscriptionInput(subscriptionId: string, overrides: Record<string, unknown> = {}) {
  return {
    subscriptionId,
    amount: 2900,
    currency: "aud",
    interval: "month",
    description: "Every course, every month",
    returnUrl: RETURN_URL,
    customerEmail: "payer@customer.test",
    idempotencyKey: `sub-${subscriptionId}`,
    ...overrides,
  };
}

function submitPage(checkout: PaymentsCheckout, fields: Record<string, string>) {
  return exports.default.fetch(
    new Request(checkout.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    }),
  );
}

async function eventsFor(h: Host, subscriptionId: string): Promise<SubscriptionEvent[]> {
  return (await h.recorded()).received.filter(
    (e): e is SubscriptionEvent =>
      e.kind === "subscription" && e.subscription.subscriptionId === subscriptionId,
  );
}

async function ledgerSubscription(subscriptionId: string) {
  const state = (await fakeLedger(env as never).state()) as FakeLedgerState;
  const sub = state.subscriptions.find((s) => s.subscriptionId === subscriptionId);
  if (!sub) throw new Error("no fake subscription");
  return sub;
}

/** Opens a subscription checkout and submits its page; returns the provider's subscription. */
async function started(h: Host, id: string, overrides: Record<string, unknown> = {}, country = "") {
  const checkout = (await h.call("createSubscriptionCheckout", [
    subscriptionInput(id, overrides),
  ])) as PaymentsCheckout;
  const answer = await submitPage(checkout, { outcome: "pay", ...(country ? { country } : {}) });
  expect(answer.status).toBe(303);
  await vi.waitFor(async () => expect((await eventsFor(h, id)).length).toBeGreaterThanOrEqual(2));
  return ledgerSubscription(id);
}

describe("the fake provider's switch", () => {
  it("runs off localhost only with its own signing secret: the default one is public", () => {
    const on = { PAYMENTS_FAKE_PROVIDER: "true" } as const;
    const staging = { ...on, BASE_URL: "https://staging.example.com/gatekeeper/payments" };
    expect(fakeEnabled(staging as never)).toBe(false);
    expect(unavailableReason(staging as never, "fake")).toMatch(/FAKE_WEBHOOK_SECRET/);
    expect(fakeEnabled({ ...staging, FAKE_WEBHOOK_SECRET: "s3cret" } as never)).toBe(true);
    // The CRM's dev server and e2e: localhost, no secret needed.
    expect(
      fakeEnabled({ ...on, BASE_URL: "http://localhost:5173/gatekeeper/payments" } as never),
    ).toBe(true);
    expect(fakeEnabled(on as never)).toBe(true);
    expect(
      fakeEnabled({ PAYMENTS_FAKE_PROVIDER: "false", FAKE_WEBHOOK_SECRET: "s" } as never),
    ).toBe(false);
  });
});

describe("the fake provider's subscriptions", () => {
  it("opens the page after an observation, takes the card and starts a trial", async () => {
    const h = await host();
    const id = unique("sbs");
    const checkout = (await h.call("createSubscriptionCheckout", [
      subscriptionInput(id, { trialDays: 7 }),
    ])) as PaymentsCheckout;
    expect(checkout.url).toMatch(/\/fake\/pay\/fcs_/);
    const { observations } = await h.recorded();
    const observed = observations.find((o) => o.description.includes(id));
    expect(observed?.description).toContain("29.00 AUD every month");
    expect(observed?.description).toContain("The first period is free");

    const page = await exports.default.fetch(new Request(checkout.url));
    const html = await page.text();
    expect(html).toContain("every month");
    expect(html).toContain("Nothing is charged until 7 days from now");

    expect((await submitPage(checkout, { outcome: "pay" })).status).toBe(303);
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(2));
    const [completed, firstInvoice] = await eventsFor(h, id);
    expect(completed?.trigger).toBe("checkout_completed");
    expect(completed?.subscription).toMatchObject({
      status: "trialing",
      amount: 2900,
      currency: "AUD",
      interval: "month",
      cancelAtPeriodEnd: false,
      subscriptionId: id,
    });
    expect(completed?.subscription.customerRef).toMatch(/^fcus_/);
    // Stripe makes a zero invoice for a trial; it pays nothing.
    expect(firstInvoice?.trigger).toBe("invoice_paid");
    expect(firstInvoice?.invoice).toMatchObject({
      amountPaid: 0,
      billingReason: "subscription_create",
    });
    // Each read is later than the one before it.
    expect(
      (firstInvoice?.subscription.observedAt ?? "") >= (completed?.subscription.observedAt ?? ""),
    ).toBe(true);
  });

  it("says whether a subscription checkout's page is open or completed, after an observation", async () => {
    const h = await host();
    const id = unique("sbs");
    const checkout = (await h.call("createSubscriptionCheckout", [
      subscriptionInput(id, { trialDays: 7 }),
    ])) as PaymentsCheckout;
    expect(Date.parse(String(checkout.expiresAt))).toBeGreaterThan(Date.now());
    expect(await h.call("getSubscriptionCheckout", [checkout.ref])).toEqual({
      ref: checkout.ref,
      status: "open",
    });
    expect((await submitPage(checkout, { outcome: "pay" })).status).toBe(303);
    expect(await h.call("getSubscriptionCheckout", [checkout.ref])).toMatchObject({
      status: "complete",
    });
    const { observations } = await h.recorded();
    expect(observations.some((o) => o.description.includes(checkout.ref))).toBe(true);
    await expect(h.call("getSubscriptionCheckout", ["fcs_unknown"])).rejects.toThrow();
  });

  it("charges each period on its own schedule, with the tax inside the price", async () => {
    const h = await host();
    const id = unique("sbs");
    const sub = await started(
      h,
      id,
      { tax: { behavior: "inclusive", taxCode: "txcd_20060158" } },
      "AU",
    );
    let events = await eventsFor(h, id);
    // No trial: the first period is paid on the page, tax inside it (the fake's AU rate, 10%).
    expect(events[1]?.invoice).toMatchObject({
      amountPaid: 2900,
      tax: { amount: 264, country: "AU" },
    });
    expect(events[1]?.invoice?.paymentRef).toMatch(/^fpi_/);

    await advanceFakeSubscription(env as never, sub.ref, "renew");
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(4));
    events = await eventsFor(h, id);
    const renewal = events[3];
    expect(renewal?.trigger).toBe("invoice_paid");
    expect(renewal?.invoice).toMatchObject({
      amountPaid: 2900,
      billingReason: "subscription_cycle",
    });
    expect(renewal?.invoice?.periodStart).toBe(events[1]?.invoice?.periodEnd);
    expect(renewal?.subscription.currentPeriodStart).toBe(renewal?.invoice?.periodStart);
  });

  it("fails a renewal, retries, and ends when the retries run out", async () => {
    const h = await host();
    const id = unique("sbs");
    const sub = await started(h, id);
    await advanceFakeSubscription(env as never, sub.ref, "fail");
    await advanceFakeSubscription(env as never, sub.ref, "retry_fail");
    await advanceFakeSubscription(env as never, sub.ref, "give_up");
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(6));
    const events = (await eventsFor(h, id)).slice(2);
    expect(events.map((e) => e.trigger)).toEqual([
      "updated",
      "invoice_payment_failed",
      "invoice_payment_failed",
      "deleted",
    ]);
    expect(events[0]?.subscription.status).toBe("past_due");
    expect(events[2]?.invoice?.attemptCount).toBe(2);
    expect(events[3]?.subscription).toMatchObject({
      status: "canceled",
      endReason: "payment_failed",
    });
  });

  it("asks the payer to confirm a renewal (3D Secure) on the provider's page", async () => {
    const h = await host();
    const id = unique("sbs");
    const sub = await started(h, id);
    await advanceFakeSubscription(env as never, sub.ref, "action_required");
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(4));
    const event = (await eventsFor(h, id))[3];
    expect(event?.trigger).toBe("invoice_action_required");
    expect(event?.invoice?.hostedUrl).toMatch(/^https:\/\//);
  });

  it("cancels and resumes only as approved actions, and the provider's event says so", async () => {
    const h = await host();
    const id = unique("sbs");
    const sub = await started(h, id);
    const cancel = (await h.call("cancelSubscription", [
      { subscriptionId: id, subscriptionRef: sub.ref, when: "period_end", reason: "Moving away" },
    ])) as PaymentsSubscriptionChangeReceipt;
    expect(cancel.status).toBe("pending");
    const { submissions } = await h.recorded();
    const submitted = submissions.find(([action]) => action === cancel.id)?.[1] as
      | ActionDescription
      | undefined;
    expect(submitted?.actionKind).toEqual({
      tag: "payments.subscription.cancel",
      label: "Cancel a subscription",
    });
    expect(submitted?.autoApprovable).toBe(false);
    // Nothing is sent until it is applied.
    expect((await ledgerSubscription(id)).cancelAtPeriodEnd).toBe(false);

    await h.apply(cancel.id);
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(3));
    expect((await eventsFor(h, id))[2]?.subscription.cancelAtPeriodEnd).toBe(true);

    const resume = (await h.call("resumeSubscription", [
      { subscriptionId: id, subscriptionRef: sub.ref },
    ])) as PaymentsSubscriptionChangeReceipt;
    await h.apply(resume.id);
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(4));
    expect((await eventsFor(h, id))[3]?.subscription.cancelAtPeriodEnd).toBe(false);

    // Ending now: the provider's subscription is canceled at once.
    const now = (await h.call("cancelSubscription", [
      { subscriptionId: id, subscriptionRef: sub.ref, when: "now", reason: "Staff ended it" },
    ])) as PaymentsSubscriptionChangeReceipt;
    await h.apply(now.id);
    await vi.waitFor(async () => expect(await eventsFor(h, id)).toHaveLength(5));
    expect((await eventsFor(h, id))[4]).toMatchObject({
      trigger: "deleted",
      subscription: { status: "canceled", endReason: "cancellation_requested" },
    });
    const read = (await h.call("getSubscription", [sub.ref])) as PaymentsSubscription;
    expect(read.status).toBe("canceled");
  });

  it("refunds a period on its invoice, saying the tax it gave back", async () => {
    const h = await host();
    const id = unique("sbs");
    await started(h, id, { tax: { behavior: "inclusive", taxCode: "txcd_20060158" } }, "AU");
    const invoice = (await eventsFor(h, id))[1]?.invoice;
    if (!invoice?.paymentRef) throw new Error("no paid invoice");
    const receipt = (await h.call("refund", [
      {
        orderId: "ord_period_1",
        paymentRef: invoice.paymentRef,
        amount: 1450,
        currency: "AUD",
        reason: "Half the month",
        refundId: unique("rfd"),
        invoiceRef: invoice.ref,
      },
    ])) as PaymentsRefundReceipt;
    await h.apply(receipt.id);
    await vi.waitFor(async () => {
      const refunds = (await h.recorded()).received.filter(
        (e) => e.kind === "refund" && e.paymentRef === invoice.paymentRef,
      );
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ amount: 1450, tax: { amount: 132 } });
    });
  });

  it("opens the portal only for the host's own call, after an observation", async () => {
    // A session any other caller holds (Code Mode, an extension's tool, MCP): refused.
    const other = await host();
    await expect(
      other.call("openPortal", [{ customerRef: "fcus_abc", returnUrl: RETURN_URL }]),
    ).rejects.toThrow(/only by the host/);
    const h = await host(true);
    const portal = (await h.call("openPortal", [
      { customerRef: "fcus_abc", returnUrl: RETURN_URL },
    ])) as PaymentsPortal;
    expect(portal.url).toMatch(/\/fake\/portal\/fcus_abc$/);
    const page = await exports.default.fetch(new Request(portal.url));
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(await page.text()).toContain("Nothing can be cancelled or changed");
    const { observations } = await h.recorded();
    expect(observations.some((o) => o.title === "Open the customer portal")).toBe(true);
  });

  it("gives a customer a new email only for the host's own call, once applied (stage 48)", async () => {
    const other = await host();
    const input = { customerRef: "fcus_none", email: "new@gym.test", changeId: "ech_1" };
    await expect(other.call("updateCustomerEmail", [input])).rejects.toThrow(/only by the host/);
    const h = await host(true);
    const id = unique("sbs");
    const checkout = (await h.call("createSubscriptionCheckout", [
      subscriptionInput(id),
    ])) as PaymentsCheckout;
    await exports.default.fetch(
      new Request(checkout.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ outcome: "pay" }).toString(),
        redirect: "manual",
      }),
    );
    const state = async () => (await fakeLedger(env as never).state()) as FakeLedgerState;
    const sub = (await state()).subscriptions.find((s) => s.subscriptionId === id);
    if (!sub) throw new Error("no fake subscription");
    const receipt = (await h.call("updateCustomerEmail", [
      { ...input, customerRef: sub.customerRef },
    ])) as { status: string; id: number };
    // Submitted as its own kind, never auto-approvable; nothing reaches the provider until applied.
    const { submissions } = await h.recorded();
    const action = submissions.at(-1)?.[1] as ActionDescription | undefined;
    expect(action?.actionKind?.tag).toBe("payments.customer.email");
    expect(action?.autoApprovable).toBe(false);
    expect((await state()).customerEmails[sub.customerRef]).toBeUndefined();
    await h.apply(receipt.id);
    expect((await state()).customerEmails[sub.customerRef]).toBe("new@gym.test");
    // A customer the provider does not have is refused, and malformed input before anything.
    const unknown = (await h.call("updateCustomerEmail", [input])) as { id: number };
    await expect(h.apply(unknown.id)).rejects.toThrow(/nothing changed/);
    await expect(
      h.call("updateCustomerEmail", [{ ...input, email: "not an address" }]),
    ).rejects.toThrow();
    await expect(h.call("updateCustomerEmail", [{ ...input, changeId: "x" }])).rejects.toThrow();
  });

  it("refuses malformed subscription input", async () => {
    const h = await host();
    const id = unique("sbs");
    const refused = async (overrides: Record<string, unknown>) =>
      expect(
        h.call("createSubscriptionCheckout", [subscriptionInput(id, overrides)]),
      ).rejects.toThrow();
    await refused({ interval: "day" });
    await refused({ amount: 0 });
    await refused({ trialDays: 7, trialEnd: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    // Stripe Checkout's trial_end must be at least 48 hours ahead.
    await refused({ trialEnd: new Date(Date.now() + 3_600_000).toISOString() });
    await refused({ price: 1 });
    await refused({ tax: { behavior: "exclusive", taxCode: "txcd_20060158" } });
    await expect(
      h.call("cancelSubscription", [
        { subscriptionId: id, subscriptionRef: "sub_1", when: "later", reason: "x" },
      ]),
    ).rejects.toThrow();
    await expect(
      h.call("openPortal", [{ customerRef: "cus_1", returnUrl: "http://evil.test" }]),
    ).rejects.toThrow();
    const ok = parseSubscriptionCheckoutInput(
      subscriptionInput(id, { trialEnd: "2031-01-01T00:00:00+10:00" }),
      Date.parse("2030-12-01T00:00:00Z"),
    );
    expect(ok.trialEnd).toBe("2030-12-31T14:00:00.000Z");
  });
});

// --- Stripe, against recorded shapes ----------------------------------------------------------

type Recorded = { url: string; method: string; headers: Headers; form: URLSearchParams };
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function stripe(answer: (r: Recorded) => Response) {
  const requests: Recorded[] = [];
  const store = new Map<string, string>();
  const provider = new StripeProvider({
    secretKey: "sk_test_key",
    webhookSecret: "whsec_x",
    apiBase: "https://stripe.test",
    account: "",
    store: { get: (k) => store.get(k), put: (k, v) => void store.set(k, v) },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const recorded: Recorded = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        form: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      };
      requests.push(recorded);
      return answer(recorded);
    }) as typeof fetch,
  });
  return { provider, requests };
}

/** A Subscription as API version 2026-11-18.endive shapes it (docs.stripe.com/api/subscriptions/object). */
const SUBSCRIPTION = {
  id: "sub_1",
  object: "subscription",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: false,
  cancel_at: null,
  canceled_at: null,
  ended_at: null,
  trial_end: 1_900_000_000,
  cancellation_details: { reason: null, feedback: null, comment: null },
  metadata: { cos_subscription: "sbs_1" },
  items: {
    data: [
      {
        current_period_start: 1_900_000_000,
        current_period_end: 1_902_592_000,
        price: { unit_amount: 2900, currency: "aud", recurring: { interval: "month" } },
      },
    ],
  },
};

/** An Invoice as 2026-11-18.endive shapes it, read with `expand[]=payments`. */
const INVOICE = {
  id: "in_1",
  object: "invoice",
  status: "paid",
  amount_paid: 2900,
  amount_due: 2900,
  currency: "aud",
  billing_reason: "subscription_cycle",
  attempt_count: 1,
  next_payment_attempt: null,
  hosted_invoice_url: "https://invoice.stripe.test/i/1",
  automatic_tax: { enabled: true },
  total_taxes: [{ amount: 264, tax_behavior: "inclusive" }],
  customer_address: { country: "AU" },
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
  payments: {
    data: [
      {
        status: "paid",
        is_default: true,
        payment: { type: "payment_intent", payment_intent: "pi_1" },
      },
    ],
  },
  lines: { data: [{ period: { start: 1_900_000_000, end: 1_902_592_000 } }] },
  period_start: 1_899_000_000,
  period_end: 1_899_000_000,
};

describe("the Stripe provider's subscriptions", () => {
  it("opens Checkout in subscription mode with the documented fields and the pinned version", async () => {
    const { provider, requests } = stripe(() =>
      ok({ id: "cs_1", url: "https://checkout.stripe.test/c/1" }),
    );
    await provider.createSubscriptionCheckout({
      subscriptionId: "sbs_1",
      amount: 2900,
      currency: "AUD",
      interval: "month",
      description: "Every course",
      returnUrl: RETURN_URL,
      customerEmail: "payer@customer.test",
      trialDays: 7,
      idempotencyKey: "k1",
      tax: { behavior: "inclusive", taxCode: "txcd_20060158" },
    });
    const [request] = requests;
    expect(request?.url).toBe("https://stripe.test/v1/checkout/sessions");
    expect(request?.headers.get("stripe-version")).toBe(STRIPE_BILLING_VERSION);
    expect(request?.headers.get("idempotency-key")).toBe("k1");
    const form = Object.fromEntries(request?.form ?? []);
    expect(form).toMatchObject({
      mode: "subscription",
      "line_items[0][price_data][currency]": "aud",
      "line_items[0][price_data][unit_amount]": "2900",
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][price_data][tax_behavior]": "inclusive",
      "line_items[0][price_data][product_data][tax_code]": "txcd_20060158",
      "automatic_tax[enabled]": "true",
      billing_address_collection: "required",
      payment_method_collection: "always",
      "subscription_data[metadata][cos_subscription]": "sbs_1",
      "subscription_data[billing_mode][type]": "flexible",
      "subscription_data[trial_period_days]": "7",
      "subscription_data[trial_settings][end_behavior][missing_payment_method]": "cancel",
      customer_email: "payer@customer.test",
    });
    expect(form).not.toHaveProperty("client_reference_id");
  });

  it("reads a Checkout Session's status, and refuses one it cannot read", async () => {
    const answers = [{ status: "expired" }, { status: "complete" }, { status: "weird" }];
    const { provider, requests } = stripe(() => ok(answers.shift() ?? {}));
    expect(await provider.getSubscriptionCheckout("cs_1")).toBe("expired");
    expect(requests[0]?.url).toBe("https://stripe.test/v1/checkout/sessions/cs_1");
    expect(requests[0]?.headers.get("stripe-version")).toBe(STRIPE_BILLING_VERSION);
    expect(await provider.getSubscriptionCheckout("cs_2")).toBe("complete");
    await expect(provider.getSubscriptionCheckout("cs_3")).rejects.toThrow(/status/);
  });

  it("hands the host only a readable expiry", () => {
    expect(validInstant("2026-11-22T10:00:00Z")).toBe("2026-11-22T10:00:00.000Z");
    expect(validInstant("not a moment")).toBeNull();
    expect(validInstant(1_700_000_000)).toBeNull();
    expect(validInstant(null)).toBeNull();
  });

  it("sends nothing about tax or trials when none is asked, and a continuation as trial_end", async () => {
    const { provider, requests } = stripe(() =>
      ok({ id: "cs_1", url: "https://checkout.stripe.test/c/1" }),
    );
    const trialEnd = new Date(Date.now() + 10 * 86_400_000);
    trialEnd.setUTCMilliseconds(0);
    await provider.createSubscriptionCheckout({
      subscriptionId: "sbs_2",
      amount: 2900,
      currency: "AUD",
      interval: "month",
      description: "Every course",
      returnUrl: RETURN_URL,
      customerRef: "cus_9",
      trialEnd: trialEnd.toISOString(),
      idempotencyKey: "k2",
    });
    const keys = [...(requests[0]?.form.keys() ?? [])];
    expect(keys.some((k) => k.includes("tax"))).toBe(false);
    expect(keys).not.toContain("subscription_data[trial_period_days]");
    expect(requests[0]?.form.get("subscription_data[trial_end]")).toBe(
      String(trialEnd.getTime() / 1000),
    );
    expect(requests[0]?.form.get("customer")).toBe("cus_9");
    expect(requests[0]?.form.has("customer_email")).toBe(false);
  });

  it("reads a subscription's period from its items and an invoice's payment and tax", () => {
    expect(stripeSubscriptionRead(SUBSCRIPTION, "2030-01-01T00:00:00.000Z")).toEqual({
      provider: "stripe",
      ref: "sub_1",
      customerRef: "cus_1",
      subscriptionId: "sbs_1",
      status: "active",
      amount: 2900,
      currency: "AUD",
      interval: "month",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      trialEnd: new Date(1_900_000_000_000).toISOString(),
      currentPeriodStart: new Date(1_900_000_000_000).toISOString(),
      currentPeriodEnd: new Date(1_902_592_000_000).toISOString(),
      canceledAt: null,
      endedAt: null,
      endReason: null,
      observedAt: "2030-01-01T00:00:00.000Z",
    });
    // A `cancel_at` date (the dashboard's) is reported apart from cancel_at_period_end: the
    // host's resume, which sets cancel_at_period_end=false, cannot undo it.
    expect(
      stripeSubscriptionRead({ ...SUBSCRIPTION, cancel_at: 1_902_592_000 }, "x"),
    ).toMatchObject({
      cancelAtPeriodEnd: false,
      cancelAt: new Date(1_902_592_000_000).toISOString(),
    });
    expect(
      stripeSubscriptionRead(
        { ...SUBSCRIPTION, cancel_at_period_end: true, cancel_at: 1_902_592_000 },
        "x",
      ),
    ).toMatchObject({ cancelAtPeriodEnd: true, cancelAt: null });
    expect(stripeSubscriptionRead({ ...SUBSCRIPTION, status: "weird" }, "x")).toBeNull();
    expect(stripeInvoiceRead(INVOICE)).toMatchObject({
      ref: "in_1",
      amountPaid: 2900,
      paymentRef: "pi_1",
      // The service period is the line's, not the invoice's period_start/end.
      periodStart: new Date(1_900_000_000_000).toISOString(),
      billingReason: "subscription_cycle",
      tax: { amount: 264, country: "AU" },
    });
    const untaxed = stripeInvoiceRead({ ...INVOICE, automatic_tax: { enabled: false } });
    expect(untaxed).not.toHaveProperty("tax");
  });

  it("asks for a current read for each subscription event, taking only ids from the payload", () => {
    const ev = (type: string, object: Record<string, unknown>) => ({
      id: "evt_1",
      type,
      created: 1_900_000_000,
      data: { object },
    });
    expect(
      stripeReadFor(
        ev("checkout.session.completed", { mode: "subscription", subscription: "sub_1" }),
      ),
    ).toMatchObject({
      trigger: "checkout_completed",
      subscriptionRef: "sub_1",
      invoiceRef: null,
    });
    expect(
      stripeReadFor(ev("customer.subscription.updated", { id: "sub_1", status: "past_due" }))
        ?.trigger,
    ).toBe("updated");
    expect(stripeReadFor(ev("invoice.paid", INVOICE))).toMatchObject({
      trigger: "invoice_paid",
      subscriptionRef: "sub_1",
      invoiceRef: "in_1",
    });
    // An endpoint on an older version puts the subscription at the top.
    expect(
      stripeReadFor(ev("invoice.payment_failed", { id: "in_2", subscription: "sub_1" }))?.trigger,
    ).toBe("invoice_payment_failed");
    // A one-off invoice, invoice.payment_succeeded (invoice.paid says it) and anything else: no read.
    expect(stripeReadFor(ev("invoice.paid", { id: "in_3", parent: null }))).toBeNull();
    expect(stripeReadFor(ev("invoice.payment_succeeded", INVOICE))).toBeNull();
    expect(stripeReadFor(ev("customer.created", { id: "cus_1" }))).toBeNull();
    // A subscription's checkout is never read as an order's payment.
    expect(
      mapStripeEvent(
        ev("checkout.session.completed", {
          mode: "subscription",
          payment_status: "paid",
          client_reference_id: "ord_1",
          id: "cs_1",
          amount_total: 2900,
          currency: "aud",
        }),
        "evt_1",
      ),
    ).toBeNull();
  });

  it("verifies the signature before anything, then reads the subscription and invoice now", async () => {
    const body = JSON.stringify({
      id: "evt_9",
      type: "invoice.paid",
      created: 1_900_000_000,
      data: { object: INVOICE },
    });
    const bytes = new TextEncoder().encode(body);
    const bad = await verifyStripeWebhook(
      "whsec_x",
      { "stripe-signature": "t=1,v1=00" },
      bytes,
      Math.floor(Date.now() / 1000),
    );
    expect(bad.ok).toBe(false);
    const header = await signatureHeader("whsec_x", body, Math.floor(Date.now() / 1000));
    const good = await verifyStripeWebhook(
      "whsec_x",
      { "stripe-signature": header },
      bytes,
      Math.floor(Date.now() / 1000),
    );
    if (!good.ok) throw new Error("not verified");
    expect(good.events).toEqual([]);
    expect(good.reads).toHaveLength(1);

    const { provider, requests } = stripe((r) =>
      ok(r.url.includes("/v1/invoices/") ? INVOICE : SUBSCRIPTION),
    );
    const outcome = await provider.readSubscriptionEvent("evt_9", good.reads?.[0] as never);
    const event = "event" in outcome ? outcome.event : null;
    expect(requests.map((r) => r.url)).toEqual([
      "https://stripe.test/v1/subscriptions/sub_1",
      "https://stripe.test/v1/invoices/in_1?expand[]=payments",
    ]);
    expect(requests.every((r) => r.headers.get("stripe-version") === STRIPE_BILLING_VERSION)).toBe(
      true,
    );
    expect(event).toMatchObject({
      kind: "subscription",
      eventId: "evt_9",
      trigger: "invoice_paid",
      subscription: { ref: "sub_1", subscriptionId: "sbs_1", status: "active" },
      invoice: { ref: "in_1", paymentRef: "pi_1", tax: { amount: 264 } },
    });
  });

  it("refunds a period, then credits its invoice linked to that refund", async () => {
    const { provider, requests } = stripe((r) =>
      ok(r.url.endsWith("/v1/refunds") ? { id: "re_1", status: "succeeded" } : { id: "cn_1" }),
    );
    await provider.refund({
      orderId: "ord_1",
      paymentRef: "pi_1",
      amount: 1450,
      currency: "AUD",
      reason: "Half the month",
      refundId: "rfd_1",
      invoiceRef: "in_1",
    });
    expect(requests.map((r) => r.url)).toEqual([
      "https://stripe.test/v1/refunds",
      "https://stripe.test/v1/credit_notes",
    ]);
    expect(requests[0]?.form.get("metadata[cos_refund_id]")).toBe("rfd_1");
    expect(Object.fromEntries(requests[1]?.form ?? [])).toMatchObject({
      invoice: "in_1",
      amount: "1450",
      "refunds[0][refund]": "re_1",
      "refunds[0][amount_refunded]": "1450",
      "metadata[cos_refund_id]": "rfd_1",
    });
    expect(requests[1]?.headers.get("idempotency-key")).toBe("rfd_1-credit-note");

    // A credit note Stripe will not make after the refund went through: neither "nothing
    // happened" nor "unknown", but a plain (retriable) error saying the credit note is owed; the
    // next apply sends only the credit note, never a second refund.
    let creditNoteAnswers = 0;
    const failing = stripe((r) => {
      if (r.url.endsWith("/v1/refunds")) return ok({ id: "re_2", status: "succeeded" });
      creditNoteAnswers += 1;
      return creditNoteAnswers === 1 ? new Response("{}", { status: 500 }) : ok({ id: "cn_2" });
    });
    const input = {
      orderId: "ord_1",
      paymentRef: "pi_1",
      amount: 100,
      currency: "AUD",
      reason: "x",
      refundId: "rfd_2",
      invoiceRef: "in_1",
    };
    const first = await failing.provider.refund(input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(Error);
    expect(first).not.toBeInstanceOf(ActionOutcomeUnknownError);
    expect(first).not.toBeInstanceOf(ActionApplyError);
    expect(String((first as Error).message)).toMatch(/refund went through; its credit note/);
    expect(await failing.provider.refund(input)).toEqual({ refundRef: "re_2", status: "pending" });
    expect(failing.requests.map((r) => r.url)).toEqual([
      "https://stripe.test/v1/refunds",
      "https://stripe.test/v1/credit_notes",
      "https://stripe.test/v1/credit_notes",
    ]);
    expect(failing.requests[2]?.form.get("refunds[0][refund]")).toBe("re_2");
  });

  it("starts with a new provider customer when the payer's earlier one is gone", async () => {
    const { provider, requests } = stripe((r) =>
      r.form.get("customer") === "cus_gone"
        ? new Response(
            JSON.stringify({
              error: { type: "invalid_request_error", code: "resource_missing", param: "customer" },
            }),
            { status: 400 },
          )
        : ok({ id: "cs_2", url: "https://checkout.stripe.test/c/2" }),
    );
    const checkout = await provider.createSubscriptionCheckout({
      subscriptionId: "sbs_3",
      amount: 2900,
      currency: "AUD",
      interval: "month",
      description: "Every course",
      returnUrl: RETURN_URL,
      customerRef: "cus_gone",
      customerEmail: "payer@customer.test",
      idempotencyKey: "k3",
    });
    expect(checkout.ref).toBe("cs_2");
    expect(requests.map((r) => [r.form.get("customer"), r.form.get("customer_email")])).toEqual([
      ["cus_gone", null],
      [null, "payer@customer.test"],
    ]);
    expect(requests[1]?.headers.get("idempotency-key")).toBe("k3:new-customer");
    // Any other refusal is not retried.
    const refusing = stripe(() => new Response("{}", { status: 400 }));
    await expect(
      refusing.provider.createSubscriptionCheckout({
        subscriptionId: "sbs_4",
        amount: 2900,
        currency: "AUD",
        interval: "month",
        description: "Every course",
        returnUrl: RETURN_URL,
        customerRef: "cus_x",
        customerEmail: "payer@customer.test",
        idempotencyKey: "k4",
      }),
    ).rejects.toThrow();
    expect(refusing.requests).toHaveLength(1);
  });

  it("ignores, never retries, a subscription it did not start or cannot read", async () => {
    const read = {
      trigger: "updated" as const,
      subscriptionRef: "sub_1",
      invoiceRef: null,
      occurredAt: new Date().toISOString(),
    };
    const foreign = stripe(() => ok({ ...SUBSCRIPTION, metadata: {} }));
    expect(await foreign.provider.readSubscriptionEvent("evt_f", read)).toEqual({
      ignored: "foreign",
    });
    const tiered = stripe(() =>
      ok({
        ...SUBSCRIPTION,
        items: {
          data: [
            { price: { unit_amount: null, currency: "aud", recurring: { interval: "month" } } },
          ],
        },
      }),
    );
    expect(await tiered.provider.readSubscriptionEvent("evt_t", read)).toEqual({
      ignored: "unreadable",
    });
    // A read that failed is retried: it throws, and the route answers 500.
    const down = stripe(() => new Response("{}", { status: 503 }));
    await expect(down.provider.readSubscriptionEvent("evt_d", read)).rejects.toThrow();
  });

  it("answers a foreign subscription's event 200, counted, and a failed read 500", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const deliver = async (id: string) => {
        const body = JSON.stringify({
          id,
          type: "customer.subscription.updated",
          created: Math.floor(Date.now() / 1000),
          data: { object: { id: "sub_foreign", metadata: { cos_subscription: "sbs_forged" } } },
        });
        const header = await signatureHeader(
          "whsec_test_0123456789abcdef",
          body,
          Math.floor(Date.now() / 1000),
        );
        return exports.default.fetch(
          new Request("https://crm.example.com/gatekeeper/payments/in/stripe", {
            method: "POST",
            headers: { "content-type": "application/json", "stripe-signature": header },
            body,
          }),
        );
      };
      // The payload claims to be ours; the read says it is not: ignored.
      fetchSpy.mockResolvedValueOnce(ok({ ...SUBSCRIPTION, id: "sub_foreign", metadata: {} }));
      const ignored = await deliver(unique("evt_foreign"));
      expect(ignored.status).toBe(200);
      expect(await ignored.json()).toMatchObject({ ok: true, ignored: true });
      fetchSpy.mockRejectedValueOnce(new Error("network"));
      expect((await deliver(unique("evt_down"))).status).toBe(500);
      const status = await env.PAYMENTS_EVENTS.get(
        env.PAYMENTS_EVENTS.idFromName("stripe"),
      ).status();
      expect(status.ignored?.foreign).toBeGreaterThanOrEqual(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("maps a credit note to the tax its refund gave back, confirming nothing", () => {
    const event = mapStripeEvent(
      {
        id: "evt_cn",
        type: "credit_note.created",
        created: 1_900_000_000,
        data: {
          object: {
            id: "cn_1",
            currency: "aud",
            amount: 1450,
            total_taxes: [{ amount: 132 }],
            refunds: [{ refund: "re_1", amount_refunded: 1450, type: "refund" }],
            metadata: { order_id: "ord_1", cos_refund_id: "rfd_1" },
          },
        },
      },
      "evt_cn",
    );
    expect(event).toMatchObject({
      kind: "refund",
      refundRef: "re_1",
      refundId: "rfd_1",
      amount: 1450,
      tax: { amount: 132 },
      creditNote: true,
    });
    // No tax rows: the tax is not said (unknown), never a precise zero.
    const silent = mapStripeEvent(
      {
        id: "evt_cn2",
        type: "credit_note.created",
        created: 1_900_000_000,
        data: {
          object: {
            id: "cn_2",
            currency: "aud",
            total_taxes: [],
            refunds: [{ refund: "re_2", amount_refunded: 1450 }],
            metadata: { cos_refund_id: "rfd_2" },
          },
        },
      },
      "evt_cn2",
    );
    expect(silent).toMatchObject({ kind: "refund", creditNote: true });
    expect(silent).not.toHaveProperty("tax");
  });

  it("gives a customer a new email, once per address change (stage 48)", async () => {
    const { provider, requests } = stripe(() => ok({ id: "cus_1", email: "new@gym.test" }));
    await provider.updateCustomerEmail({
      customerRef: "cus_1",
      email: "new@gym.test",
      changeId: "ech_1",
    });
    expect(requests.map((r) => [r.method, r.url, r.form.get("email")])).toEqual([
      ["POST", "https://stripe.test/v1/customers/cus_1", "new@gym.test"],
    ]);
    expect(requests[0]?.headers.get("idempotency-key")).toBe("cos-email-ech_1-cus_1");
  });

  it("cancels at period end, now, resumes, and makes the portal's configuration once", async () => {
    const { provider, requests } = stripe((r) =>
      ok(
        r.url.includes("billing_portal/configurations")
          ? { id: "bpc_1" }
          : r.url.includes("billing_portal/sessions")
            ? { url: "https://billing.stripe.test/p/1" }
            : SUBSCRIPTION,
      ),
    );
    await provider.cancelSubscription({
      subscriptionId: "sbs_1",
      subscriptionRef: "sub_1",
      when: "period_end",
      reason: "Moving",
    });
    await provider.cancelSubscription({
      subscriptionId: "sbs_1",
      subscriptionRef: "sub_1",
      when: "now",
      reason: "Staff",
    });
    await provider.resumeSubscription({ subscriptionId: "sbs_1", subscriptionRef: "sub_1" });
    expect(requests.map((r) => [r.method, r.url, r.form.get("cancel_at_period_end")])).toEqual([
      ["POST", "https://stripe.test/v1/subscriptions/sub_1", "true"],
      ["DELETE", "https://stripe.test/v1/subscriptions/sub_1", null],
      ["POST", "https://stripe.test/v1/subscriptions/sub_1", "false"],
    ]);
    requests.length = 0;
    expect(await provider.openPortal({ customerRef: "cus_1", returnUrl: RETURN_URL })).toEqual({
      url: "https://billing.stripe.test/p/1",
    });
    await provider.openPortal({ customerRef: "cus_1", returnUrl: RETURN_URL });
    expect(requests.map((r) => r.url)).toEqual([
      "https://stripe.test/v1/billing_portal/configurations",
      "https://stripe.test/v1/billing_portal/sessions",
      "https://stripe.test/v1/billing_portal/sessions",
    ]);
    expect(Object.fromEntries(requests[0]?.form ?? [])).toMatchObject({
      "features[payment_method_update][enabled]": "true",
      "features[invoice_history][enabled]": "true",
      "features[subscription_cancel][enabled]": "false",
      "features[subscription_update][enabled]": "false",
      "features[subscription_pause][enabled]": "false",
    });
    expect(Object.fromEntries(requests[1]?.form ?? [])).toMatchObject({
      customer: "cus_1",
      return_url: RETURN_URL,
      configuration: "bpc_1",
    });

    const refusing = stripe(() => new Response("{}", { status: 400 }));
    await expect(
      refusing.provider.cancelSubscription({
        subscriptionId: "sbs_1",
        subscriptionRef: "sub_1",
        when: "now",
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(ActionApplyError);
  });
});
