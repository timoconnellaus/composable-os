// Stage 32a, build step 2, in the host (ADRs 0485 to 0487), against the payments gatekeeper's
// test double: the subscription record and its host moves from verified events (in any order,
// each once), the order per paid period with the provider's tax, a period's refund credited on
// its invoice, and the payer's own cancel, resume and portal. The gatekeeper's half (the fake
// provider's subscriptions and Stripe's requests) is packages/gatekeeper-payments.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  loadSubscriptionRow,
  memoryEventSink,
  type PaymentsEvent,
  type ProviderInvoice,
  type ProviderSubscription,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import {
  type Buyer,
  CURRENCY,
  createBuyer,
  outside,
  PUBLIC,
  refusal,
  run,
} from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const SCHOOL = extId("school");
/** A plan: every course, every month, with a trial. */
const PLAN = `${SCHOOL}.plan`;
/** Something bought once, not a plan. */
const BOOK = `${SCHOOL}.book`;
const RETURN = "https://shop.example.com/account";
const COURSE_CODE = "txcd_20060158";
const DAY = 86_400_000;

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime } = payments;
let admin: ActingUser;
let plan: string;
let book: string;

const staff = () => context(admin, { integrations: runtime, events });
const as = (buyer: Buyer) => outside(buyer.principal, { integrations: runtime, events });

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return ((await run("record.create", { object, values }, context(admin))) as { id: string }).id;
}

type Started = { subscriptionId: string; url: string; amount: number; trialDays: number | null };

async function subscribe(buyer: Buyer): Promise<Started> {
  return run<Started>(
    "subscription.start",
    { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
    as(buyer),
  );
}

let clock = Date.now();
/** A later moment each call: reads are ordered by when the gatekeeper made them. */
const later = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};

function read(id: string, overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  const start = new Date(Date.now()).toISOString();
  return {
    provider: "fake",
    ref: `fsub_${id}`,
    customerRef: `fcus_${id}`,
    subscriptionId: id,
    status: "trialing",
    amount: 2900,
    currency: CURRENCY,
    interval: "month",
    cancelAtPeriodEnd: false,
    cancelAt: null,
    trialEnd: new Date(Date.now() + 7 * DAY).toISOString(),
    currentPeriodStart: start,
    currentPeriodEnd: new Date(Date.now() + 7 * DAY).toISOString(),
    canceledAt: null,
    endedAt: null,
    endReason: null,
    observedAt: later(),
    ...overrides,
  };
}

function invoice(overrides: Partial<ProviderInvoice> = {}): ProviderInvoice {
  return {
    ref: `fin_${unique("i")}`,
    status: "paid",
    amountPaid: 2900,
    amountDue: 2900,
    currency: CURRENCY,
    paymentRef: `fpi_${unique("p")}`,
    periodStart: new Date(Date.now() + 7 * DAY).toISOString(),
    periodEnd: new Date(Date.now() + 37 * DAY).toISOString(),
    billingReason: "subscription_cycle",
    attemptCount: 1,
    nextAttemptAt: null,
    hostedUrl: null,
    ...overrides,
  };
}

/** Plays the gatekeeper delivering a verified subscription event. */
function deliver(
  trigger: Extract<PaymentsEvent, { kind: "subscription" }>["trigger"],
  subscription: ProviderSubscription,
  inv?: ProviderInvoice,
  eventId = `fevt_${unique("s")}`,
) {
  return payments.deliver({
    kind: "subscription",
    provider: "fake",
    eventId,
    trigger,
    subscription,
    ...(inv ? { invoice: inv } : {}),
    occurredAt: new Date().toISOString(),
  });
}

const row = (id: string) => loadSubscriptionRow(db.query, id).catch(() => null);
async function subscriptionRow(id: string) {
  return env.DB.prepare("SELECT * FROM core_subscription WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}
async function periodOrders(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM core_order WHERE subscription_id = ? ORDER BY period_start",
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return results;
}
async function notices(title: RegExp) {
  const { results } = await env.DB.prepare(
    "SELECT title, body FROM core_notifications WHERE user_id = ? ORDER BY created_at",
  )
    .bind(admin.id)
    .all<{ title: string; body: string }>();
  return results.filter((r) => title.test(r.title));
}

/** A customer with a trialing subscription, as the provider's first event leaves it. */
async function trialing(): Promise<{ buyer: Buyer; id: string; sub: ProviderSubscription }> {
  const buyer = await createBuyer(admin, "member");
  const { subscriptionId: id } = await subscribe(buyer);
  const sub = read(id);
  await deliver("checkout_completed", sub);
  return { buyer, id, sub };
}

/** As trialing(), on a subscription opened while tax was on: its periods keep the provider's tax. */
async function taxedTrialing(): Promise<{ buyer: Buyer; id: string; sub: ProviderSubscription }> {
  await run("order.settings.update", { tax: true }, context(admin));
  try {
    return await trialing();
  } finally {
    await run("order.settings.update", { tax: false }, context(admin));
  }
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(
    manifest(SCHOOL, {
      objects: {
        plan: {
          label: "Plan",
          plural: "Plans",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price per month", currency: CURRENCY },
            trialDays: { type: "number", label: "Trial days" },
          },
          sellable: {
            price: "price",
            tax: { code: COURSE_CODE },
            recurring: { interval: "month", trialDays: "trialDays" },
          },
          public: { read: ["name", "price", "trialDays"] },
        },
        book: {
          label: "Book",
          plural: "Books",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
          },
          sellable: { price: "price" },
          public: { read: ["name", "price"] },
        },
      },
    }),
  );
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://shop.example.com"] },
    context(admin),
  );
  plan = await create(PLAN, { name: "Every course", price: 29, trialDays: 7 });
  book = await create(BOOK, { name: "Workbook", price: 15 });
  await payments.connect(admin.id);
});

beforeEach(() => {
  events = memoryEventSink();
});

describe("starting a subscription", () => {
  it("opens the provider's page priced from the plan, with its trial; nothing exists until the provider says", async () => {
    const buyer = await createBuyer(admin, "starter");
    const started = await subscribe(buyer);
    expect(started).toMatchObject({ amount: 2900, trialDays: 7 });
    expect(started.subscriptionId).toMatch(/^sbs_/);
    const sent = gw.subscriptions.at(-1);
    expect(sent).toMatchObject({
      subscriptionId: started.subscriptionId,
      amount: 2900,
      currency: CURRENCY,
      interval: "month",
      trialDays: 7,
      customerEmail: buyer.email,
      returnUrl: RETURN,
    });
    // Tax is off: nothing about tax is sent.
    expect(sent).not.toHaveProperty("tax");
    expect(await subscriptionRow(started.subscriptionId)).toBeNull();
    const checkout = await env.DB.prepare("SELECT * FROM core_subscription_checkout WHERE id = ?")
      .bind(started.subscriptionId)
      .first<Record<string, unknown>>();
    expect(checkout).toMatchObject({
      payer_person_id: buyer.principal.personId,
      holder_person_id: buyer.principal.personId,
      amount: 2900,
      plan_object: PLAN,
    });
  });

  it("refuses a return address off the list, something that is not a plan, and a plan on an order", async () => {
    const buyer = await createBuyer(admin, "refused");
    expect(
      (
        await refusal(
          run(
            "subscription.start",
            { plan: { object: PLAN, id: plan }, returnUrl: "https://evil.example/x" },
            as(buyer),
          ),
        )
      ).details,
    ).toMatchObject({ rule: "return_origin" });
    expect(
      (
        await refusal(
          run(
            "subscription.start",
            { plan: { object: BOOK, id: book }, returnUrl: RETURN },
            as(buyer),
          ),
        )
      ).message,
    ).toMatch(/not a plan/);
    expect(
      (await refusal(run("order.start", { lines: [{ object: PLAN, id: plan }] }, as(buyer))))
        .message,
    ).toMatch(/subscribe to it instead/);
  });

  it("starts for a guest by email, and sends the plan's tax code once a human admin turns tax on", async () => {
    await run("order.settings.update", { tax: true }, context(admin));
    try {
      const started = await run<Started>(
        "subscription.start",
        {
          plan: { object: PLAN, id: plan },
          returnUrl: RETURN,
          email: `${unique("g")}@buyers.example`,
        },
        outside(PUBLIC, { integrations: runtime, events }),
      );
      expect(gw.subscriptions.at(-1)).toMatchObject({
        subscriptionId: started.subscriptionId,
        tax: { behavior: "inclusive", taxCode: COURSE_CODE },
      });
    } finally {
      await run("order.settings.update", { tax: false }, context(admin));
    }
  });
});

describe("the subscription record, moved only by verified events", () => {
  it("is made from the provider's first event, and read by its payer only", async () => {
    const { buyer, id } = await trialing();
    expect(await subscriptionRow(id)).toMatchObject({
      state: "trialing",
      payer_person_id: buyer.principal.personId,
      holder_person_id: buyer.principal.personId,
      provider_ref: `fsub_${id}`,
      customer_ref: `fcus_${id}`,
      amount: 2900,
    });
    const own = await run<{ state: string; planTitle: string; payerPersonId?: unknown }>(
      "subscription.get",
      { id },
      as(buyer),
    );
    expect(own).toMatchObject({ state: "trialing", planTitle: "Every course" });
    expect(own).not.toHaveProperty("payerPersonId");
    const other = await createBuyer(admin, "other");
    expect((await refusal(run("subscription.get", { id }, as(other)))).code).toBe("not_found");
    const listed = await run<{ items: { id: string }[] }>("subscription.list", {}, as(other));
    expect(listed.items.map((s) => s.id)).not.toContain(id);
    const mine = await run<{ items: { id: string }[] }>("subscription.list", {}, as(buyer));
    expect(mine.items.map((s) => s.id)).toEqual([id]);
  });

  it("changes nothing for a repeated event, and lets a later read win over an earlier one", async () => {
    const { id, sub } = await trialing();
    const newer = read(id, { status: "active", trialEnd: sub.trialEnd });
    const older = read(id, {
      status: "past_due",
      observedAt: new Date(Date.parse(newer.observedAt) - 500).toISOString(),
    });
    const first = await deliver("updated", newer, undefined, `fevt_${id}_a`);
    expect(first.result.outcome).toBe("applied");
    const again = await deliver("updated", newer, undefined, `fevt_${id}_a`);
    expect(again.result.outcome).toBe("duplicate");
    const stale = await deliver("updated", older);
    expect(stale.result.outcome).toBe("stale");
    expect((await subscriptionRow(id))?.state).toBe("active");
  });

  it("moves nothing for an event no checkout explains, or one not as agreed, and tells staff", async () => {
    const stranger = await deliver("updated", read("sbs_nobody", { subscriptionId: null }));
    expect(stranger.result.outcome).toBe("unknown_subscription");
    expect(await notices(/did not start/)).not.toHaveLength(0);

    const { id } = await trialing();
    // Not as agreed, and nothing in it that reduces what the member holds: nothing moves.
    const pricier = await deliver("updated", read(id, { amount: 1, status: "active" }));
    expect(pricier.result.outcome).toBe("terms_changed");
    expect((await subscriptionRow(id))?.state).toBe("trialing");
    // A provider subscription naming another of this host's ids is not this one.
    const other = await deliver("updated", read(id, { subscriptionId: "sbs_other" }));
    expect(other.result.outcome).toBe("subscription_mismatch");
    // A different provider subscription claiming this host's id is not it either.
    const impostor = await deliver("created", read(id, { ref: "fsub_impostor" }));
    expect(impostor.result.outcome).toBe("unknown_subscription");
  });

  it("cannot be moved by a person, an MCP client or a customer: no operation moves it", async () => {
    const { buyer, id } = await trialing();
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: "subscription", id, values: { state: "active" } },
            context(admin),
          ),
        )
      ).code,
    ).not.toBe("ok");
    // The one operation that applies an event is the host's own: anyone else is refused.
    for (const caller of [context(admin), context(admin, { actor: "mcp" }), as(buyer)]) {
      expect(["forbidden", "unknown_operation"]).toContain(
        (await refusal(run("order.applyPaymentEvent", { provider: "fake", eventId: "x" }, caller)))
          .code,
      );
    }
    expect((await subscriptionRow(id))?.state).toBe("trialing");
  });
});

describe("an order per paid period", () => {
  it("writes a paid order for each paid invoice, once each, and none for the trial's", async () => {
    const { buyer, id, sub } = await trialing();
    const free = await deliver(
      "invoice_paid",
      sub,
      invoice({ amountPaid: 0, amountDue: 0, billingReason: "subscription_create" }),
    );
    expect(free.result.outcome).toBe("period_free");

    const first = invoice();
    const paid = await deliver("invoice_paid", read(id, { status: "active" }), first);
    expect(paid.result).toMatchObject({ outcome: "period_paid", state: "paid" });
    expect(paid.result.confirmation).not.toBeNull();
    // The same invoice reported again, by another event: no second order.
    const twice = await deliver("invoice_paid", read(id, { status: "active" }), first);
    expect(twice.result.outcome).toBe("period_duplicate");
    const second = invoice({
      periodStart: first.periodEnd,
      periodEnd: new Date(Date.parse(first.periodEnd as string) + 30 * DAY).toISOString(),
    });
    await deliver("invoice_paid", read(id, { status: "active" }), second);

    const orders = await periodOrders(id);
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      state: "paid",
      total: 2900,
      paid: 2900,
      person_id: buyer.principal.personId,
      invoice_ref: first.ref,
      period_start: first.periodStart,
      period_end: first.periodEnd,
      tax_amount: 0,
    });
    const order = await run<{
      lines: { object: string; recordId: string; title: string; total: number }[];
      subscriptionId?: string;
    }>("order.get", { id: orders[0]?.id }, as(buyer));
    expect(order.lines).toEqual([
      expect.objectContaining({ object: PLAN, recordId: plan, title: "Every course", total: 2900 }),
    ]);
    const payment = await env.DB.prepare("SELECT * FROM core_order_payment WHERE order_id = ?")
      .bind(orders[0]?.id)
      .first<Record<string, unknown>>();
    expect(payment).toMatchObject({
      outcome: "applied",
      payment_ref: first.paymentRef,
      invoice_ref: first.ref,
    });
    // A period's order also arrives while the read it came with is older than the record's.
    const late = invoice();
    const stale = read(id, {
      status: "past_due",
      observedAt: new Date(clock - 100_000).toISOString(),
    });
    expect((await deliver("invoice_paid", stale, late)).result.outcome).toBe("period_paid");
    expect((await subscriptionRow(id))?.state).toBe("active");
  });

  it("writes one order when two events report the same invoice paid at the same moment", async () => {
    const { id } = await trialing();
    const inv = invoice();
    const results = await Promise.all([
      deliver("invoice_paid", read(id, { status: "active" }), inv),
      deliver("invoice_paid", read(id, { status: "active" }), inv),
      deliver("updated", read(id, { status: "active" })),
    ]);
    expect(results.filter((r) => r.result.outcome === "period_paid")).toHaveLength(1);
    expect(await periodOrders(id)).toHaveLength(1);
    expect((await subscriptionRow(id))?.state).toBe("active");
  });

  it("keeps the provider's tax on a taxed subscription's period, and none on an untaxed one", async () => {
    await run("order.settings.update", { tax: true }, context(admin));
    let id: string;
    try {
      const buyer = await createBuyer(admin, "taxed");
      ({ subscriptionId: id } = await subscribe(buyer));
    } finally {
      await run("order.settings.update", { tax: false }, context(admin));
    }
    await deliver("checkout_completed", read(id));
    const taxed = invoice({ tax: { amount: 264, country: "AU" } });
    await deliver("invoice_paid", read(id, { status: "active" }), taxed);
    const [order] = await periodOrders(id);
    expect(order).toMatchObject({ tax_amount: 264, tax_country: "AU", total: 2900 });
    const line = await env.DB.prepare(
      "SELECT tax_amount, tax_code FROM core_order_line WHERE order_id = ?",
    )
      .bind(order?.id)
      .first();
    expect(line).toEqual({ tax_amount: 264, tax_code: COURSE_CODE });

    // Untaxed: a figure the provider sends anyway is not kept.
    const { id: plain } = await trialing();
    await deliver(
      "invoice_paid",
      read(plain, { status: "active" }),
      invoice({ tax: { amount: 264, country: "AU" } }),
    );
    expect((await periodOrders(plain))[0]).toMatchObject({ tax_amount: 0 });
  });

  it("records a period paid less or more than agreed as an order for what was paid, flagged, staff told once", async () => {
    const { id } = await trialing();
    // A coupon or the payer's balance at the provider: less was paid. The money is an order.
    const less = await deliver(
      "invoice_paid",
      read(id, { status: "active" }),
      invoice({ amountPaid: 100, amountDue: 100 }),
    );
    expect(less.result).toMatchObject({ outcome: "period_flagged", state: "paid" });
    const more = await deliver(
      "invoice_paid",
      read(id, { status: "active" }),
      invoice({ amountPaid: 3500, amountDue: 3500 }),
    );
    expect(more.result.outcome).toBe("period_flagged");
    const orders = await periodOrders(id);
    expect(orders.map((o) => [o.total, o.paid, o.period_flag, o.state])).toEqual([
      [100, 100, "paid_less", "paid"],
      [3500, 3500, "paid_more", "paid"],
    ]);
    // Once for the subscription, not once per period.
    const told = (await notices(/other than as agreed/)).filter((n) => n.body.includes(id));
    expect(told).toHaveLength(1);
    // Paid as agreed: no flag.
    await deliver("invoice_paid", read(id, { status: "active" }), invoice());
    expect((await periodOrders(id)).filter((o) => o.period_flag === null)).toHaveLength(1);
  });

  it("mirrors only what reduces what the member holds once the provider's terms are changed", async () => {
    const { id } = await trialing();
    await deliver("updated", read(id, { status: "active" }));
    const before = await subscriptionRow(id);
    // The price changed in the provider's dashboard, and the provider renewed it: the host does
    // not extend anything from those terms, and tells staff once.
    const later = new Date(Date.parse(String(before?.current_period_end)) + 30 * DAY).toISOString();
    const changed = await deliver(
      "updated",
      read(id, { status: "active", amount: 4900, currentPeriodEnd: later }),
    );
    expect(changed.result.outcome).toBe("terms_changed");
    expect((await subscriptionRow(id))?.current_period_end).toBe(before?.current_period_end);
    // Its renewal on those terms: the money is an order, flagged.
    const renewal = await deliver(
      "invoice_paid",
      read(id, { status: "active", amount: 4900 }),
      invoice({ amountPaid: 4900, amountDue: 4900 }),
    );
    expect(renewal.result.outcome).toBe("period_flagged");
    expect((await periodOrders(id)).at(-1)).toMatchObject({
      total: 4900,
      period_flag: "not_as_agreed",
    });
    // A failure and an end on those terms are still mirrored: access stops.
    await deliver("updated", read(id, { status: "past_due", amount: 4900 }));
    expect((await subscriptionRow(id))?.state).toBe("past_due");
    // Paid again on the changed terms: a failing one is not made active from them.
    await deliver("updated", read(id, { status: "active", amount: 4900 }));
    expect((await subscriptionRow(id))?.state).toBe("past_due");
    await deliver("updated", read(id, { status: "active", amount: 4900, cancelAtPeriodEnd: true }));
    expect(await subscriptionRow(id)).toMatchObject({ state: "past_due", cancel_at_period_end: 1 });
    await deliver(
      "deleted",
      read(id, { status: "canceled", amount: 4900, endReason: "cancellation_requested" }),
    );
    expect((await subscriptionRow(id))?.state).toBe("ended");
    const told = (await notices(/changed at the provider/)).filter((n) => n.body.includes(id));
    expect(told).toHaveLength(1);
  });

  it("makes no subscription from a first event not as agreed, but records a period paid on it", async () => {
    const buyer = await createBuyer(admin, "odd");
    const { subscriptionId: id } = await subscribe(buyer);
    const odd = read(id, { status: "active", amount: 1500 });
    const paid = await deliver("invoice_paid", odd, invoice({ amountPaid: 1500, amountDue: 1500 }));
    expect(paid.result.outcome).toBe("period_flagged");
    expect(await subscriptionRow(id)).toBeNull();
    const order = await env.DB.prepare(
      "SELECT total, period_flag, subscription_id, person_id FROM core_order WHERE id = ?",
    )
      .bind(paid.result.orderId)
      .first();
    expect(order).toEqual({
      total: 1500,
      period_flag: "not_as_agreed",
      subscription_id: null,
      person_id: buyer.principal.personId,
    });
  });

  it("refunds a period through approval, credited on its invoice, and leaves the subscription as it was", async () => {
    const { id } = await taxedTrialing();
    const inv = invoice({ tax: { amount: 264, country: "AU" } });
    await deliver("invoice_paid", read(id, { status: "active" }), inv);
    const [order] = await periodOrders(id);
    const asked = await run<{ refunds: { id: string; pendingActionId: string }[] }>(
      "order.refund",
      { id: order?.id, reason: "Half the month", amount: 1450 },
      staff(),
    );
    const refund = asked.refunds[0];
    const request = [...gw.refunds.values()].at(-1) as Record<string, unknown>;
    expect(request).toMatchObject({
      invoiceRef: inv.ref,
      paymentRef: inv.paymentRef,
      amount: 1450,
    });
    await run("approval.approve", { actionIds: [refund?.pendingActionId] }, staff());
    // The credit note's tax first, then the refund's confirmation: the tax waits, then lands.
    const note = await payments.deliver({
      kind: "refund",
      provider: "fake",
      eventId: `fevt_${unique("cn")}`,
      orderId: order?.id as string,
      refundId: refund?.id as string,
      refundRef: "fre_period_1",
      paymentRef: null,
      amount: 1450,
      currency: CURRENCY,
      occurredAt: new Date().toISOString(),
      tax: { amount: 132 },
      creditNote: true,
    });
    expect(note.result.outcome).toBe("credit_note_waiting");
    const confirmed = await payments.deliver({
      kind: "refund",
      provider: "fake",
      eventId: `fevt_${unique("rf")}`,
      orderId: order?.id as string,
      refundId: refund?.id as string,
      refundRef: "fre_period_1",
      paymentRef: inv.paymentRef,
      amount: 1450,
      currency: CURRENCY,
      occurredAt: new Date().toISOString(),
    });
    expect(confirmed.result.outcome).toBe("refunded");
    const after = await env.DB.prepare(
      "SELECT refunded, tax_refunded, state FROM core_order WHERE id = ?",
    )
      .bind(order?.id)
      .first();
    expect(after).toEqual({ refunded: 1450, tax_refunded: 132, state: "paid" });
    expect((await subscriptionRow(id))?.state).toBe("active");
  });

  it("takes a credit note's tax that arrives after the refund's confirmation", async () => {
    const { id } = await taxedTrialing();
    const inv = invoice({ tax: { amount: 264, country: "AU" } });
    await deliver("invoice_paid", read(id, { status: "active" }), inv);
    const [order] = await periodOrders(id);
    const asked = await run<{ refunds: { id: string; pendingActionId: string }[] }>(
      "order.refund",
      { id: order?.id, reason: "Whole month" },
      staff(),
    );
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
    const base = {
      kind: "refund" as const,
      provider: "fake" as const,
      orderId: order?.id as string,
      refundId: asked.refunds[0]?.id as string,
      refundRef: `fre_${unique("w")}`,
      amount: 2900,
      currency: CURRENCY,
      occurredAt: new Date().toISOString(),
    };
    await payments.deliver({ ...base, eventId: `fevt_${unique("a")}`, paymentRef: inv.paymentRef });
    const note = await payments.deliver({
      ...base,
      eventId: `fevt_${unique("b")}`,
      paymentRef: null,
      tax: { amount: 264 },
      creditNote: true,
    });
    expect(note.result.outcome).toBe("credit_note_tax");
    const after = await env.DB.prepare(
      "SELECT refunded, tax_refunded, state FROM core_order WHERE id = ?",
    )
      .bind(order?.id)
      .first();
    expect(after).toEqual({ refunded: 2900, tax_refunded: 264, state: "refunded" });
    // More tax than was paid is not taken.
    const again = await payments.deliver({
      ...base,
      eventId: `fevt_${unique("c")}`,
      paymentRef: null,
      tax: { amount: 999 },
      creditNote: true,
    });
    expect(again.result.outcome).toBe("duplicate");
  });
});

describe("failing and ending", () => {
  it("mirrors past due while the provider retries, tells staff once per invoice, and ends when it gives up", async () => {
    const { id } = await trialing();
    const failing = invoice({ status: "open", amountPaid: 0, paymentRef: null, attemptCount: 1 });
    await deliver("invoice_payment_failed", read(id, { status: "past_due" }), failing);
    const row1 = await subscriptionRow(id);
    expect(row1).toMatchObject({ state: "past_due" });
    expect(row1?.failing_since).not.toBeNull();
    await deliver("invoice_payment_failed", read(id, { status: "past_due" }), {
      ...failing,
      attemptCount: 2,
    });
    const told = (await notices(/payment failed/)).filter((n) => n.body.includes(id));
    expect(told).toHaveLength(1);

    await deliver("invoice_action_required", read(id, { status: "past_due" }), {
      ...failing,
      hostedUrl: "https://invoice.example/confirm",
    });
    expect((await subscriptionRow(id))?.action_url).toBe("https://invoice.example/confirm");

    await deliver(
      "deleted",
      read(id, {
        status: "canceled",
        endReason: "payment_failed",
        endedAt: new Date().toISOString(),
      }),
    );
    expect(await subscriptionRow(id)).toMatchObject({
      state: "ended",
      end_reason: "payment_failed",
      action_url: null,
    });
    expect((await notices(/payments failed/)).filter((n) => n.body.includes(id))).toHaveLength(1);
    // Ended is final: a read that says otherwise, even a later one, moves nothing.
    const after = await deliver("updated", read(id, { status: "active" }));
    expect(after.result.outcome).toBe("stale");
    expect((await subscriptionRow(id))?.state).toBe("ended");
  });

  it("tells staff at once of an invoice the provider cannot finalize", async () => {
    const { id } = await trialing();
    await deliver(
      "invoice_finalization_failed",
      read(id),
      invoice({ status: "draft", amountPaid: 0, paymentRef: null }),
    );
    expect((await notices(/cannot be collected/)).filter((n) => n.body.includes(id))).toHaveLength(
      1,
    );
  });
});

describe("the payer's own cancel, resume and portal", () => {
  it("asks the provider to end it at the period's end, and shows it once the provider says", async () => {
    const { buyer, id, sub } = await trialing();
    await run("subscription.cancel", { id, reason: "Taking a break" }, as(buyer));
    expect(gw.changes.at(-1)).toEqual({
      method: "cancelSubscription",
      request: {
        subscriptionId: id,
        subscriptionRef: sub.ref,
        when: "period_end",
        reason: "Taking a break",
      },
    });
    // Nothing moved yet: only the provider's event moves it.
    expect((await subscriptionRow(id))?.cancel_at_period_end).toBe(0);
    await deliver(
      "updated",
      read(id, { cancelAtPeriodEnd: true, canceledAt: new Date().toISOString() }),
    );
    expect((await subscriptionRow(id))?.cancel_at_period_end).toBe(1);
    expect((await refusal(run("subscription.cancel", { id }, as(buyer)))).code).toBe("conflict");

    await run("subscription.resume", { id }, as(buyer));
    expect(gw.changes.at(-1)).toMatchObject({
      method: "resumeSubscription",
      request: { subscriptionId: id },
    });
    await deliver("updated", read(id));
    expect((await subscriptionRow(id))?.cancel_at_period_end).toBe(0);
  });

  it("refuses another customer's subscription, an ended one, and an AI caller", async () => {
    const { id } = await trialing();
    const other = await createBuyer(admin, "nosy");
    const calls = gw.changes.length;
    expect((await refusal(run("subscription.cancel", { id }, as(other)))).code).toBe("not_found");
    expect((await refusal(run("subscription.resume", { id }, as(other)))).code).toBe("not_found");
    expect(
      (
        await refusal(
          run(
            "subscription.cancel",
            { id },
            context(admin, { integrations: runtime, actor: "mcp" }),
          ),
        )
      ).code,
    ).toBe("forbidden");
    expect(gw.changes.length).toBe(calls);
    await deliver("deleted", read(id, { status: "canceled", endReason: "cancellation_requested" }));
    expect((await refusal(run("subscription.cancel", { id }, staff()))).code).toBe("conflict");
  });

  it("opens the portal for the signed-in payer's own provider customer only", async () => {
    const { buyer, id } = await trialing();
    const portal = await run<{ url: string }>(
      "subscription.portal",
      { returnUrl: RETURN },
      as(buyer),
    );
    expect(portal.url).toBe("https://billing.example/portal");
    expect(gw.changes.at(-1)).toEqual({
      method: "openPortal",
      request: { customerRef: `fcus_${id}`, returnUrl: RETURN },
    });
    const stranger = await createBuyer(admin, "noplan");
    expect(
      (await refusal(run("subscription.portal", { returnUrl: RETURN }, as(stranger)))).code,
    ).toBe("not_found");
    expect(
      (await refusal(run("subscription.portal", { returnUrl: RETURN }, staff()))).code,
    ).not.toBe("ok");
  });

  it("reuses a provider customer only for a caller who proved who they are", async () => {
    const { buyer, id } = await trialing();
    // A guest typing the subscriber's address gets a new provider customer, never theirs.
    await run(
      "subscription.start",
      { plan: { object: PLAN, id: plan }, returnUrl: RETURN, email: buyer.email },
      outside(PUBLIC, { integrations: runtime, events }),
    );
    const guestSent = gw.subscriptions.at(-1);
    expect(guestSent).not.toHaveProperty("customerRef");
    expect(guestSent?.customerEmail).toBe(buyer.email);
    // The subscriber signed in reuses their own; so does staff starting one for them.
    await subscribe(buyer);
    expect(gw.subscriptions.at(-1)).toMatchObject({
      customerRef: `fcus_${id}`,
      customerEmail: buyer.email,
    });
    await run(
      "subscription.start",
      { plan: { object: PLAN, id: plan }, returnUrl: RETURN, email: buyer.email },
      staff(),
    );
    expect(gw.subscriptions.at(-1)).toMatchObject({ customerRef: `fcus_${id}` });
  });

  it("opens the newest provider customer's portal when a payer has two (ADR 0487)", async () => {
    const { buyer, id: first } = await trialing();
    // A second subscription the provider gave its own customer (started as a guest, say).
    const { subscriptionId: second } = await subscribe(buyer);
    await deliver("checkout_completed", read(second, { customerRef: `fcus_second_${first}` }));
    await run("subscription.portal", { returnUrl: RETURN }, as(buyer));
    expect(gw.changes.at(-1)?.request).toMatchObject({ customerRef: `fcus_second_${first}` });
  });

  it("lets staff end or keep going someone else's only with subscriptions:manage", async () => {
    const { id } = await trialing();
    const member = await createUser("member");
    const asMember = context(member, { integrations: runtime, events });
    expect((await refusal(run("subscription.cancel", { id }, asMember))).code).toBe("forbidden");
    expect((await refusal(run("subscription.resume", { id }, asMember))).code).toBe("forbidden");
    // Granted one by one, as orders:refund is.
    await run(
      "user.setPermissions",
      { id: member.id, permissions: ["subscriptions:manage"] },
      context(admin),
    );
    await run("subscription.cancel", { id, reason: "Asked by phone" }, asMember);
    expect(gw.changes.at(-1)).toMatchObject({ method: "cancelSubscription" });
  });

  it("refuses to resume an end date set at the provider, saying so", async () => {
    const { buyer, id } = await trialing();
    const date = new Date(Date.now() + 20 * DAY).toISOString();
    await deliver("updated", read(id, { cancelAt: date }));
    expect((await subscriptionRow(id))?.cancel_at).toBe(date);
    const calls = gw.changes.length;
    const refused = await refusal(run("subscription.resume", { id }, as(buyer)));
    expect(refused).toMatchObject({ code: "conflict", details: { rule: "provider_end_date" } });
    expect(refused.message).toMatch(/provider's dashboard/);
    expect(gw.changes.length).toBe(calls);
    expect((await refusal(run("subscription.cancel", { id }, as(buyer)))).code).toBe("conflict");
  });
});

describe("the payer's confirm-your-payment link", () => {
  it("is kept only from a current read of an open invoice, and cleared once active", async () => {
    const { id } = await trialing();
    const owing = invoice({
      status: "open",
      amountPaid: 0,
      paymentRef: null,
      hostedUrl: "https://invoice.example/a",
    });
    // A stale read: nothing kept.
    const stale = read(id, {
      status: "past_due",
      observedAt: new Date(clock - 500_000).toISOString(),
    });
    await deliver("invoice_action_required", stale, owing);
    expect((await subscriptionRow(id))?.action_url).toBeNull();
    // An invoice no longer open: nothing kept.
    await deliver("invoice_action_required", read(id, { status: "past_due" }), {
      ...owing,
      status: "paid",
    });
    expect((await subscriptionRow(id))?.action_url).toBeNull();
    await deliver("invoice_action_required", read(id, { status: "past_due" }), owing);
    expect((await subscriptionRow(id))?.action_url).toBe("https://invoice.example/a");
    await deliver("updated", read(id, { status: "active" }));
    expect((await subscriptionRow(id))?.action_url).toBeNull();
  });
});

it("keeps the payer and the holder apart in the record, the same Person in 32a (ADR 0487)", async () => {
  const { buyer, id } = await trialing();
  const sub = await row(id);
  expect(sub?.payer_person_id).toBe(buyer.principal.personId);
  expect(sub?.holder_person_id).toBe(buyer.principal.personId);
});
