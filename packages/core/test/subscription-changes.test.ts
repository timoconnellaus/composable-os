// Stage 32b, build step 6 (ADRs 0530, 0531): plan changes and pauses in the host, with a fixture
// extension shaped like the Memberships pack (a plan that grants a membership, a visit that
// spends) and the payments double playing the provider.
//
// What is checked (criterion 14): an upgrade is asked of the provider now, and the member holds the
// new plan (its uses) only from the verified read that shows the new price; its prorated charge is
// an order, not flagged; a declined charge leaves the plan; a downgrade is asked for the next
// period, the member keeps the plan paid for until a read shows the next period, then holds the new
// one; two changes asked at once ask the provider once; a pause is staff's only, within the plan's
// bounds, and the membership is paused (nothing spent) from the provider's read, resumed with it,
// the first period after it not flagged; a scheduled pause is withdrawn; nothing is asked of the
// provider for a refused call, an AI, or a dry run.
import { env } from "cloudflare:workers";
import { type ExtensionManifest, validateManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  createTestSimulation,
  memoryEventSink,
  type PaymentsEvent,
  type ProviderInvoice,
  type ProviderSubscription,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";
import { type Buyer, CURRENCY, createBuyer, outside, refusal, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const GYM = extId("gymchanges");
const PLAN = `${GYM}.plan`;
const MEMBERSHIP = `${GYM}.membership`;
const VISIT = `${GYM}.visit`;
const RETURN = "https://gym.example.com/account";
const DAY = 86_400_000;
const RUNNING = ["trialing", "active", "past_due", "unpaid", "paused"] as const;

function fixture(id: string): ExtensionManifest {
  return manifest(id, {
    objects: {
      plan: {
        label: "Plan",
        plural: "Plans",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          uses: { type: "number", label: "Uses" },
          pauseMin: { type: "number", label: "Shortest pause" },
          pauseMax: { type: "number", label: "Longest pause" },
          status: {
            type: "select",
            label: "Status",
            options: [
              { value: "draft", label: "Draft" },
              { value: "on_sale", label: "On sale" },
              { value: "retired", label: "Retired" },
            ],
          },
        },
        // On sale only while its status says so, as the Memberships pack's plans are.
        public: { read: ["title", "price", "uses"], when: { field: "status", in: ["on_sale"] } },
        sellable: {
          price: "price",
          recurring: {
            interval: "month",
            pause: { minDays: "pauseMin", maxDays: "pauseMax" },
            grants: {
              object: "membership",
              set: {
                person: "subscription.holder",
                plan: "item",
                subscription: "subscription",
                title: "item.title",
                uses: "item.uses",
              },
              from: "from",
              until: "until",
              states: {
                trialing: "trialing",
                active: "active",
                past_due: "past_due",
                unpaid: "unpaid",
                paused: "paused",
                ended: "ended",
              },
            },
          },
        },
      },
      membership: {
        label: "Membership",
        plural: "Memberships",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title", readOnly: true },
          person: { type: "relation", label: "Member", to: "person", readOnly: true },
          plan: { type: "relation", label: "Plan", to: `${id}.plan`, readOnly: true },
          subscription: { type: "text", label: "Subscription", readOnly: true },
          uses: { type: "number", label: "Uses", readOnly: true },
          from: { type: "datetime", label: "From", readOnly: true },
          until: { type: "datetime", label: "Until", readOnly: true },
          status: {
            type: "select",
            label: "Status",
            options: [...RUNNING, "ended"].map((value) => ({ value, label: value })),
          },
        },
        states: {
          field: "status",
          initial: "active",
          moves: [
            ...RUNNING.map((to) => ({
              from: RUNNING.filter((s) => s !== to),
              to,
              by: ["host" as const],
            })),
            { from: [...RUNNING], to: "ended", by: ["host" as const], final: true },
          ],
        },
        customer: { field: "person", read: ["title", "uses", "status"], write: [] },
        allowance: {
          holds: {
            person: "person",
            uses: "uses",
            per: "week",
            from: "from",
            until: "until",
            live: ["trialing", "active", "past_due"],
            emptyIsUnlimited: true,
            spendsOn: { object: "visit" },
          },
        },
      },
      visit: {
        label: "Visit",
        plural: "Visits",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          person: { type: "relation", label: "Person", to: "person" },
          holder: { type: "text", label: "Paid by" },
          state: {
            type: "select",
            label: "State",
            options: [
              { value: "open", label: "Open" },
              { value: "booked", label: "Booked" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "open",
          moves: [{ from: "open", to: "booked", by: ["staff"] }],
        },
        allowance: {
          spends: { person: "person", holder: "holder", spendIn: ["booked"], returnIn: [] },
        },
      },
    },
  });
}

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { runtime, gw } = payments;
let admin: ActingUser;
let three: string;
let unlimited: string;
let one: string;
let twin: string;
let draft: string;
let retired: string;

const staff = () => context(admin, { integrations: runtime, events });
const as = (buyer: Buyer) => outside(buyer.principal, { integrations: runtime, events });

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return ((await run("record.create", { object, values }, context(admin))) as { id: string }).id;
}

let clock = Date.now();
const later = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};

const PERIOD_START = new Date(Date.now() - 2 * DAY).toISOString();
const PERIOD_END = new Date(Date.now() + 28 * DAY).toISOString();

function read(id: string, overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    provider: "fake",
    ref: `fsub_${id}`,
    customerRef: `fcus_${id}`,
    subscriptionId: id,
    status: "active",
    amount: 3000,
    currency: CURRENCY,
    interval: "month",
    cancelAtPeriodEnd: false,
    cancelAt: null,
    trialEnd: null,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
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
    amountPaid: 3000,
    amountDue: 3000,
    currency: CURRENCY,
    paymentRef: `fpi_${unique("p")}`,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    billingReason: "subscription_cycle",
    attemptCount: 1,
    nextAttemptAt: null,
    hostedUrl: null,
    ...overrides,
  };
}

function deliver(
  trigger: Extract<PaymentsEvent, { kind: "subscription" }>["trigger"],
  subscription: ProviderSubscription,
  inv?: ProviderInvoice,
) {
  return payments.deliver({
    kind: "subscription",
    provider: "fake",
    eventId: `fevt_${unique("s")}`,
    trigger,
    subscription,
    ...(inv ? { invoice: inv } : {}),
    occurredAt: new Date().toISOString(),
  });
}

async function membershipOf(subscriptionId: string) {
  const row = await env.DB.prepare(
    "SELECT record_id FROM core_subscription_grant WHERE subscription_id = ?",
  )
    .bind(subscriptionId)
    .first<{ record_id: string }>();
  if (!row) return null;
  return (
    await run<{ id: string; values: Record<string, unknown> }>(
      "record.get",
      { object: MEMBERSHIP, id: row.record_id },
      staff(),
    )
  ).values;
}

async function subscription(id: string) {
  return run<{
    planId: string;
    planTitle: string;
    amount: number;
    state: string;
    change: Record<string, unknown> | null;
  }>("subscription.get", { id }, staff());
}

/** A running subscription to the 3-a-week plan, at 30.00, for a new member. */
async function member(label: string): Promise<{ buyer: Buyer; id: string }> {
  const buyer = await createBuyer(admin, label);
  const started = await run<{ subscriptionId: string }>(
    "subscription.start",
    { plan: { object: PLAN, id: three }, returnUrl: RETURN },
    as(buyer),
  );
  await deliver("checkout_completed", read(started.subscriptionId));
  return { buyer, id: started.subscriptionId };
}

/** Puts a subscription's open change past its life, as a day passing would. */
async function expire(subscriptionId: string) {
  await env.DB.prepare(
    "UPDATE core_subscription_change SET expires_at = ? WHERE subscription_id = ? AND state IN ('requested', 'waiting')",
  )
    .bind(new Date(Date.now() - 60_000).toISOString(), subscriptionId)
    .run();
}

async function changeRow(subscriptionId: string) {
  return env.DB.prepare(
    "SELECT * FROM core_subscription_change WHERE subscription_id = ? ORDER BY requested_at DESC LIMIT 1",
  )
    .bind(subscriptionId)
    .first<Record<string, unknown>>();
}

async function orderOf(invoiceRef: string) {
  return env.DB.prepare(
    "SELECT o.period_flag, o.total, l.title, l.record_id FROM core_order o JOIN core_order_line l ON l.order_id = o.id WHERE o.invoice_ref = ?",
  )
    .bind(invoiceRef)
    .first<Record<string, unknown>>();
}

async function told(key: string): Promise<number> {
  return (
    (
      await env.DB.prepare("SELECT count(*) AS n FROM core_notifications WHERE dedupe_key = ?")
        .bind(key)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

const calls = (method: string, id: string) =>
  gw.changes.filter((c) => c.method === method && c.request.subscriptionId === id);

beforeAll(async () => {
  admin = await createUser("admin");
  const m = fixture(GYM);
  expect(validateManifest(m).issues).toEqual([]);
  await reconcile(m);
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://gym.example.com"] },
    context(admin),
  );
  const sale = { status: "on_sale" };
  three = await create(PLAN, {
    ...sale,
    title: "Three a week",
    price: 30,
    uses: 3,
    pauseMin: 7,
    pauseMax: 60,
  });
  unlimited = await create(PLAN, { ...sale, title: "Unlimited", price: 60 });
  one = await create(PLAN, { ...sale, title: "One a week", price: 15, uses: 1 });
  twin = await create(PLAN, { ...sale, title: "Three a week, mornings", price: 30, uses: 3 });
  draft = await create(PLAN, { status: "draft", title: "Coming soon", price: 90 });
  retired = await create(PLAN, { status: "retired", title: "Old unlimited", price: 50 });
  await payments.connect(admin.id);
});

beforeEach(() => {
  events = memoryEventSink();
});

describe("an upgrade (decision 12: at once, prorated)", () => {
  it("is asked of the provider now, and the member holds the new plan once the provider shows it", async () => {
    const { buyer, id } = await member("upgrader");
    const asked = await run<{ kind: string; changeId: string; effectiveAt: string | null }>(
      "subscription.change",
      { id, planId: unlimited },
      as(buyer),
    );
    expect(asked).toMatchObject({ kind: "upgrade", effectiveAt: null });
    expect(calls("changeSubscription", id).map((c) => c.request)).toEqual([
      expect.objectContaining({ when: "now", amount: 6000, changeId: asked.changeId }),
    ]);
    // Asked, not yet shown: the member keeps three a week.
    expect(await membershipOf(id)).toMatchObject({ uses: 3, plan: three });
    expect((await subscription(id)).change).toMatchObject({ kind: "upgrade", state: "requested" });

    // The provider's read at the new price, then its prorated charge.
    await deliver("updated", read(id, { amount: 6000 }));
    expect(await membershipOf(id)).toMatchObject({
      uses: null,
      plan: unlimited,
      title: "Unlimited",
    });
    const sub = await subscription(id);
    expect(sub).toMatchObject({
      planId: unlimited,
      planTitle: "Unlimited",
      amount: 6000,
      change: null,
    });
    const prorated = invoice({
      amountPaid: 2800,
      amountDue: 2800,
      billingReason: "subscription_update",
    });
    const paid = await deliver("invoice_paid", read(id, { amount: 6000 }), prorated);
    expect(paid.result.outcome).toBe("period_paid");
    const order = await env.DB.prepare(
      "SELECT o.period_flag, l.title, l.record_id FROM core_order o JOIN core_order_line l ON l.order_id = o.id WHERE o.invoice_ref = ?",
    )
      .bind(prorated.ref)
      .first();
    expect(order).toMatchObject({ period_flag: null, record_id: unlimited });
    expect(String(order?.title)).toContain("upgrade from Three a week");
    // No "changed at the provider" warning for a change the host asked for.
    const warned = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE dedupe_key = ?",
    )
      .bind(`subscription.terms_changed:fake:${id}`)
      .first<{ n: number }>();
    expect(warned?.n).toBe(0);
  });

  it("leaves the plan when its charge is declined, and is refused again until it lapses", async () => {
    const { buyer, id } = await member("declined");
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    const failed = await deliver(
      "invoice_payment_failed",
      read(id),
      invoice({
        status: "open",
        amountPaid: 0,
        amountDue: 2800,
        billingReason: "subscription_update",
      }),
    );
    expect(failed.result.outcome).toBe("upgrade_failed");
    expect(await membershipOf(id)).toMatchObject({ uses: 3, status: "active" });
    expect((await subscription(id)).state).toBe("active");
    const again = await refusal(run("subscription.change", { id, planId: unlimited }, as(buyer)));
    expect(again).toMatchObject({ code: "conflict", details: { rule: "change_open" } });
    // A day on, never shown by the provider: it lapsed, and a new change may be asked.
    await expire(id);
    expect((await subscription(id)).change).toMatchObject({ state: "lapsed" });
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    expect(calls("changeSubscription", id)).toHaveLength(2);
  });

  it("asks the provider once when two changes are asked at once", async () => {
    const { buyer, id } = await member("twice");
    const results = await Promise.allSettled([
      run("subscription.change", { id, planId: unlimited }, as(buyer)),
      run("subscription.change", { id, planId: unlimited }, as(buyer)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(calls("changeSubscription", id)).toHaveLength(1);
  });
});

describe("a downgrade (decision 12: at the next period)", () => {
  it("keeps the plan paid for until the period ends, then holds the new one", async () => {
    const { buyer, id } = await member("downgrader");
    const asked = await run<{ kind: string; effectiveAt: string }>(
      "subscription.change",
      { id, planId: one },
      as(buyer),
    );
    expect(asked).toMatchObject({ kind: "downgrade", effectiveAt: PERIOD_END });
    expect(calls("changeSubscription", id).at(-1)?.request).toMatchObject({
      when: "next_period",
      amount: 1500,
    });
    // The provider shows the new price at once; the member keeps three a week this period.
    await deliver("updated", read(id, { amount: 1500 }));
    expect(await membershipOf(id)).toMatchObject({ uses: 3, plan: three });
    expect((await subscription(id)).change).toMatchObject({
      state: "waiting",
      effectiveAt: PERIOD_END,
    });

    // The next period, charged the new price: the new plan, and its period an order as agreed.
    const next = new Date(Date.parse(PERIOD_END) + 30 * DAY).toISOString();
    const renewal = invoice({
      amountPaid: 1500,
      amountDue: 1500,
      periodStart: PERIOD_END,
      periodEnd: next,
    });
    const paid = await deliver(
      "invoice_paid",
      read(id, { amount: 1500, currentPeriodStart: PERIOD_END, currentPeriodEnd: next }),
      renewal,
    );
    expect(paid.result.outcome).toBe("period_paid");
    expect(await membershipOf(id)).toMatchObject({ uses: 1, plan: one, title: "One a week" });
    expect(await subscription(id)).toMatchObject({ planId: one, amount: 1500, change: null });
  });

  it("to a plan of the same price needs nothing of the provider", async () => {
    const { buyer, id } = await member("sameprice");
    const before = gw.changes.length;
    await run("subscription.change", { id, planId: twin }, as(buyer));
    expect(gw.changes.length).toBe(before);
    expect((await subscription(id)).change).toMatchObject({ kind: "downgrade", state: "waiting" });
  });
});

describe("who may change a plan", () => {
  it("refuses another's subscription, the same plan, and an AI", async () => {
    const { id } = await member("owner");
    const stranger = await createBuyer(admin, "stranger");
    expect(
      (await refusal(run("subscription.change", { id, planId: one }, as(stranger)))).code,
    ).toBe("not_found");
    expect(
      (await refusal(run("subscription.change", { id, planId: three }, staff()))).details,
    ).toMatchObject({ rule: "same_plan" });
    const ai = await refusal(
      run(
        "subscription.change",
        { id, planId: one },
        context(admin, { actor: "assistant", integrations: runtime, events }),
      ),
    );
    expect(ai.code).toBe("forbidden");
    expect(calls("changeSubscription", id)).toHaveLength(0);
  });

  it("asks nothing of the provider in a dry run", async () => {
    const { id } = await member("dryrun");
    const simulate = createTestSimulation();
    await run(
      "subscription.change",
      { id, planId: unlimited },
      context(admin, { integrations: runtime, events, simulate }),
    ).catch(() => null);
    await run(
      "subscription.pause",
      { id, until: new Date(Date.now() + 14 * DAY).toISOString(), reason: "Travel" },
      context(admin, { integrations: runtime, events, simulate }),
    ).catch(() => null);
    expect(calls("changeSubscription", id)).toHaveLength(0);
    expect(calls("pauseSubscription", id)).toHaveLength(0);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_subscription_change WHERE subscription_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe("a pause (decision 10: by staff, for a set time)", () => {
  it("is staff's, within the plan's bounds, and pauses the membership from the provider's read", async () => {
    const { buyer, id } = await member("pauser");
    const until = new Date(Date.now() + 21 * DAY).toISOString();
    // A customer cannot pause (staff only); too short or too long is refused.
    expect(
      (await refusal(run("subscription.pause", { id, until, reason: "x" }, as(buyer)))).code,
    ).toBe("unknown_operation");
    const short = await refusal(
      run(
        "subscription.pause",
        { id, until: new Date(Date.now() + 3 * DAY).toISOString(), reason: "x" },
        staff(),
      ),
    );
    expect(short.details).toMatchObject({ rule: "pause_length", min: 7, max: 60 });
    expect(
      (
        await refusal(
          run(
            "subscription.pause",
            { id, until: new Date(Date.now() + 90 * DAY).toISOString(), reason: "x" },
            staff(),
          ),
        )
      ).details,
    ).toMatchObject({ rule: "pause_length" });

    await run("subscription.pause", { id, until, reason: "Injury" }, staff());
    expect(calls("pauseSubscription", id).at(-1)?.request).toMatchObject({ from: null, until });
    // Asked: still active until the provider says it is paused.
    expect(await membershipOf(id)).toMatchObject({ status: "active" });
    await deliver(
      "paused",
      read(id, { status: "paused", currentPeriodEnd: new Date().toISOString() }),
    );
    expect(await membershipOf(id)).toMatchObject({ status: "paused" });
    expect((await subscription(id)).change).toMatchObject({
      kind: "pause",
      state: "applied",
      pauseUntil: until,
    });

    // Nothing is spent while it is paused.
    const visit = await create(VISIT, { name: "Monday", person: buyer.principal.personId });
    const refused = await refusal(
      run("record.update", { object: VISIT, id: visit, values: { state: "booked" } }, staff()),
    );
    expect(refused.details).toMatchObject({ rule: "allowance" });
    // No plan change while paused.
    expect(
      (await refusal(run("subscription.change", { id, planId: one }, as(buyer)))).details,
    ).toMatchObject({
      rule: "state",
    });

    // The provider resumes it on its date and charges the new period less the paused time.
    const next = new Date(Date.parse(until) + 30 * DAY).toISOString();
    await deliver("resumed", read(id, { currentPeriodStart: until, currentPeriodEnd: next }));
    const first = invoice({ amountPaid: 300, amountDue: 300, periodStart: until, periodEnd: next });
    const paid = await deliver(
      "invoice_paid",
      read(id, { currentPeriodStart: until, currentPeriodEnd: next }),
      first,
    );
    expect(paid.result.outcome).toBe("period_paid");
    expect(await membershipOf(id)).toMatchObject({ status: "active" });
    expect((await subscription(id)).change).toBeNull();
  });

  it("is refused when not active (on trial); one asked for later is withdrawn", async () => {
    const buyer = await createBuyer(admin, "nopause");
    const started = await run<{ subscriptionId: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: three }, returnUrl: RETURN },
      as(buyer),
    );
    const id = started.subscriptionId;
    await deliver("checkout_completed", read(id, { status: "trialing", trialEnd: PERIOD_END }));
    const until = new Date(Date.now() + 14 * DAY).toISOString();
    expect(
      (await refusal(run("subscription.pause", { id, until, reason: "x" }, staff()))).details,
    ).toMatchObject({
      rule: "state",
    });
    await deliver("updated", read(id));
    const from = new Date(Date.now() + 5 * DAY).toISOString();
    await run(
      "subscription.pause",
      { id, from, until: new Date(Date.parse(from) + 10 * DAY).toISOString(), reason: "Holiday" },
      staff(),
    );
    expect((await subscription(id)).change).toMatchObject({
      kind: "pause",
      state: "requested",
      pauseFrom: from,
    });
    await run("subscription.unpause", { id, reason: "Not going" }, staff());
    expect(calls("unpauseSubscription", id)).toHaveLength(1);
    expect((await subscription(id)).change).toBeNull();
  });
});

describe("the review of 32b: a change is trusted only while it is open", () => {
  it("a stale asked upgrade is closed: a later coupon renewal is flagged, a price edit is a change at the provider", async () => {
    const { buyer, id } = await member("stale");
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    await expire(id);
    // A month later a renewal paid less than the price (a coupon): flagged, never the upgrade's.
    const coupon = invoice({ amountPaid: 2500, amountDue: 2500 });
    await deliver("invoice_paid", read(id), coupon);
    expect(await orderOf(coupon.ref)).toMatchObject({ period_flag: "paid_less", record_id: three });
    expect((await changeRow(id))?.state).toBe("lapsed");
    // A price edited at the provider to the upgrade's: a change there, not the upgrade.
    await deliver("updated", read(id, { amount: 6000 }));
    expect(await membershipOf(id)).toMatchObject({ uses: 3, plan: three });
    expect((await subscription(id)).planId).toBe(three);
    expect(await told(`subscription.terms_changed:fake:${id}`)).toBe(1);
  });

  it("a proration is matched by its billing reason, also when it equals the old price", async () => {
    const { buyer, id } = await member("proration");
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    // 30.00 to 60.00 at the very start of the period: the proration is 30.00, the old price.
    const prorated = invoice({
      amountPaid: 3000,
      amountDue: 3000,
      billingReason: "subscription_update",
    });
    await deliver("invoice_paid", read(id, { amount: 6000 }), prorated);
    expect(await orderOf(prorated.ref)).toMatchObject({ period_flag: null, record_id: unlimited });
    // A renewal-sized invoice that is not an update is never taken as a proration.
    const { buyer: b2, id: id2 } = await member("notproration");
    await run("subscription.change", { id: id2, planId: unlimited }, as(b2));
    const cycle = invoice({ amountPaid: 2000, amountDue: 2000 });
    await deliver("invoice_paid", read(id2), cycle);
    expect(await orderOf(cycle.ref)).toMatchObject({ period_flag: "paid_less" });
  });

  it("an update's charge paid with no upgrade open tells staff each time", async () => {
    const { buyer, id } = await member("latepaid");
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    await expire(id);
    for (const _ of [1, 2]) {
      const late = invoice({
        amountPaid: 2800,
        amountDue: 2800,
        billingReason: "subscription_update",
      });
      await deliver("invoice_paid", read(id), late);
      expect(await told(`subscription.update_paid:fake:${late.ref}`)).toBe(1);
    }
  });

  it("an unknown outcome leaves an upgrade or a downgrade open, and verified reads decide", async () => {
    const up = await member("unknownup");
    gw.nextChange = "unknown";
    const asked = await run<{ asked: string }>(
      "subscription.change",
      { id: up.id, planId: unlimited },
      as(up.buyer),
    );
    expect(asked.asked).toBe("unknown");
    expect(await changeRow(up.id)).toMatchObject({ state: "requested", call_outcome: "unknown" });
    expect((await subscription(up.id)).change).toMatchObject({ callOutcome: "unknown" });
    await deliver("updated", read(up.id, { amount: 6000 }));
    expect(await membershipOf(up.id)).toMatchObject({ plan: unlimited });
    expect(await told(`subscription.terms_changed:fake:${up.id}`)).toBe(0);

    const down = await member("unknowndown");
    gw.nextChange = "throw";
    expect(
      (
        await run<{ asked: string }>(
          "subscription.change",
          { id: down.id, planId: one },
          as(down.buyer),
        )
      ).asked,
    ).toBe("unknown");
    await deliver("updated", read(down.id, { amount: 1500 }));
    expect(await changeRow(down.id)).toMatchObject({ state: "waiting", call_outcome: "unknown" });
    expect(await told(`subscription.terms_changed:fake:${down.id}`)).toBe(0);
  });

  it("a refusal closes the change and says so; a new one may be asked", async () => {
    const { buyer, id } = await member("refused");
    gw.nextChange = "refused";
    const refused = await refusal(run("subscription.change", { id, planId: unlimited }, as(buyer)));
    expect(refused).toMatchObject({ code: "conflict", details: { rule: "provider_refused" } });
    expect(await changeRow(id)).toMatchObject({ state: "lapsed", call_outcome: "refused" });
    const audited = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit WHERE operation = 'subscription.change.outcome' AND input LIKE ?",
    )
      .bind(`%${(await changeRow(id))?.id}%`)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
  });

  it("staff withdraw a stuck or waiting downgrade, put back at the provider; a price put back closes it", async () => {
    const { buyer, id } = await member("withdrawn");
    await run("subscription.change", { id, planId: one }, as(buyer));
    await deliver("updated", read(id, { amount: 1500 }));
    // Stuck: every other change is refused while it waits.
    expect(
      (
        await refusal(
          run(
            "subscription.pause",
            { id, until: new Date(Date.now() + 14 * DAY).toISOString(), reason: "x" },
            staff(),
          ),
        )
      ).details,
    ).toMatchObject({ rule: "change_open" });
    expect(
      (await refusal(run("subscription.change.withdraw", { id, reason: "x" }, as(buyer)))).code,
    ).toBe("unknown_operation");
    const out = await run<{ asked: string }>(
      "subscription.change.withdraw",
      { id, reason: "Changed mind" },
      staff(),
    );
    expect(out.asked).toBe("sent");
    expect(calls("changeSubscription", id).at(-1)?.request).toMatchObject({
      amount: 3000,
      when: "next_period",
    });
    expect((await changeRow(id))?.state).toBe("withdrawn");
    expect((await subscription(id)).change).toBeNull();
    await run("subscription.change", { id, planId: unlimited }, as(buyer));

    // A waiting downgrade whose price is put back at the provider is closed by the read.
    const other = await member("putback");
    await run("subscription.change", { id: other.id, planId: one }, as(other.buyer));
    await deliver("updated", read(other.id, { amount: 1500 }));
    await deliver("updated", read(other.id, { amount: 3000 }));
    expect((await changeRow(other.id))?.state).toBe("withdrawn");
  });

  it("without a renewal invoice, a downgrade keeps the plan to the end of the period the read shows, begun before it was asked", async () => {
    const { buyer, id } = await member("early");
    await run("subscription.change", { id, planId: one }, as(buyer));
    const start = new Date(Date.now() - 3_600_000).toISOString();
    const end = new Date(Date.now() + 20 * DAY).toISOString();
    await deliver(
      "updated",
      read(id, { amount: 1500, currentPeriodStart: start, currentPeriodEnd: end }),
    );
    expect(await changeRow(id)).toMatchObject({ state: "waiting", effective_at: end });
    expect(await membershipOf(id)).toMatchObject({ uses: 3, plan: three });
  });

  it("a change in a period the provider has renewed past is refused until the renewal arrives", async () => {
    const { buyer, id } = await member("renewing");
    await env.DB.prepare(
      "UPDATE core_subscription SET current_period_end = ?, version = version + 1 WHERE id = ?",
    )
      .bind(new Date(Date.now() - 60_000).toISOString(), id)
      .run();
    expect(
      (await refusal(run("subscription.change", { id, planId: one }, as(buyer)))).details,
    ).toMatchObject({ rule: "period_ended" });
  });

  it("a customer cannot choose a plan that is a draft or no longer sold; staff can", async () => {
    const { buyer, id } = await member("onsale");
    for (const planId of [draft, retired]) {
      const refused = await refusal(run("subscription.change", { id, planId }, as(buyer)));
      expect(["invalid_input", "not_found"]).toContain(refused.code);
    }
    expect(calls("changeSubscription", id)).toHaveLength(0);
    await run("subscription.change", { id, planId: draft }, staff());
    expect(calls("changeSubscription", id)).toHaveLength(1);
  });

  it("a free plan is refused before anything is written", async () => {
    const { id } = await member("free");
    const free = await create(PLAN, { status: "on_sale", title: "Free", price: 0 });
    const refused = await refusal(run("subscription.change", { id, planId: free }, staff()));
    expect(refused.code).toBe("invalid_input");
    expect(await changeRow(id)).toBeNull();
  });

  it("a change asked by the payer follows the holder's membership when they differ", async () => {
    const parent = await createBuyer(admin, "parent");
    const child = await run<{ id: string }>("person.create", { givenName: "Child" }, staff());
    const started = await run<{ subscriptionId: string }>(
      "subscription.start",
      {
        plan: { object: PLAN, id: three },
        returnUrl: RETURN,
        email: parent.email,
        holderPersonId: child.id,
      },
      staff(),
    );
    const id = started.subscriptionId;
    await deliver("checkout_completed", read(id));
    await run("subscription.change", { id, planId: unlimited }, as(parent));
    await deliver("updated", read(id, { amount: 6000 }));
    expect(await membershipOf(id)).toMatchObject({ person: child.id, plan: unlimited });
  });

  it("an upgrade's charge that needs the payer to confirm it shows the provider's page on the change", async () => {
    const { buyer, id } = await member("threeds");
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    const hosted = "https://fake-provider.invalid/invoice/confirm";
    const needed = await deliver(
      "invoice_action_required",
      read(id),
      invoice({
        status: "open",
        amountPaid: 0,
        amountDue: 2800,
        billingReason: "subscription_update",
        hostedUrl: hosted,
      }),
    );
    expect(needed.result.outcome).toBe("action_required");
    const mine = await run<{ change: { actionUrl: string | null } | null }>(
      "subscription.get",
      { id },
      as(buyer),
    );
    expect(mine.change?.actionUrl).toBe(hosted);
    await deliver("updated", read(id, { amount: 6000 }));
    expect((await changeRow(id))?.action_url).toBeNull();
  });

  it("a renewal failing while an upgrade is open is a failing renewal, and the upgrade stays open", async () => {
    const { buyer, id } = await member("failwhile");
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    const failed = await deliver(
      "invoice_payment_failed",
      read(id, { status: "past_due" }),
      invoice({ status: "open", amountPaid: 0, amountDue: 3000 }),
    );
    expect(failed.result.outcome).toBe("payment_failed");
    expect(await membershipOf(id)).toMatchObject({ status: "past_due", plan: three });
    expect((await changeRow(id))?.state).toBe("requested");
  });

  it("a half-finished pause or end of a pause shows, and is asked again", async () => {
    const { id } = await member("halfpause");
    gw.nextChange = "unknown";
    const paused = await run<{ asked: string }>(
      "subscription.pause",
      { id, until: new Date(Date.now() + 14 * DAY).toISOString(), reason: "Travel" },
      staff(),
    );
    expect(paused.asked).toBe("unknown");
    expect(await changeRow(id)).toMatchObject({ state: "requested", call_outcome: "unknown" });
    // The provider's read says it paused: applied.
    await deliver("paused", read(id, { status: "paused" }));
    expect((await changeRow(id))?.state).toBe("applied");
    // Ending it early: refused, then unknown, each shown on the subscription; asked again, sent.
    gw.nextChange = "refused";
    expect(
      (await refusal(run("subscription.unpause", { id, reason: "Back" }, staff()))).details,
    ).toMatchObject({
      rule: "provider_refused",
    });
    expect((await subscription(id)).change).toMatchObject({ kind: "pause", endOutcome: "refused" });
    gw.nextChange = "unknown";
    expect(
      (await run<{ asked: string }>("subscription.unpause", { id, reason: "Back" }, staff())).asked,
    ).toBe("unknown");
    expect((await subscription(id)).change).toMatchObject({ endOutcome: "unknown" });
    expect(
      (await run<{ asked: string }>("subscription.unpause", { id, reason: "Back" }, staff())).asked,
    ).toBe("sent");
    expect(calls("unpauseSubscription", id)).toHaveLength(3);
    // Still paused until the provider says otherwise: the host never claims it resumed.
    expect((await subscription(id)).state).toBe("paused");
  });

  it("a scheduled pause is withdrawn only once the gatekeeper says it was sent", async () => {
    const { id } = await member("withdrawpause");
    const from = new Date(Date.now() + 5 * DAY).toISOString();
    await run(
      "subscription.pause",
      { id, from, until: new Date(Date.parse(from) + 10 * DAY).toISOString(), reason: "Holiday" },
      staff(),
    );
    gw.nextChange = "unknown";
    await run("subscription.unpause", { id, reason: "Not going" }, staff());
    expect((await changeRow(id))?.state).toBe("requested");
    await run("subscription.unpause", { id, reason: "Not going" }, staff());
    expect((await changeRow(id))?.state).toBe("withdrawn");
  });
});

describe("the second review of 32b", () => {
  it("withdrawing a downgrade closes it only once the put-back is sent; until then it shows and is asked again", async () => {
    const { buyer, id } = await member("putbackunknown");
    await run("subscription.change", { id, planId: one }, as(buyer));
    await deliver("updated", read(id, { amount: 1500 }));
    gw.nextChange = "unknown";
    const first = await run<{ asked: string }>(
      "subscription.change.withdraw",
      { id, reason: "Changed mind" },
      staff(),
    );
    expect(first.asked).toBe("unknown");
    expect(await changeRow(id)).toMatchObject({ state: "waiting", end_outcome: "unknown" });
    expect((await subscription(id)).change).toMatchObject({
      state: "waiting",
      endOutcome: "unknown",
    });
    gw.nextChange = "refused";
    expect(
      (await refusal(run("subscription.change.withdraw", { id, reason: "Again" }, staff())))
        .details,
    ).toMatchObject({ rule: "provider_refused" });
    expect((await changeRow(id))?.state).toBe("waiting");
    const done = await run<{ asked: string }>(
      "subscription.change.withdraw",
      { id, reason: "Again" },
      staff(),
    );
    expect(done.asked).toBe("sent");
    expect(await changeRow(id)).toMatchObject({ state: "withdrawn", end_outcome: "sent" });
    expect(calls("changeSubscription", id).filter((c) => c.request.amount === 3000)).toHaveLength(
      3,
    );
  });

  it("withdrawing an upgrade voids its pending invoice first, and only then closes it", async () => {
    const { buyer, id } = await member("voidup");
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    gw.nextChange = "unknown";
    expect(
      (await run<{ asked: string }>("subscription.change.withdraw", { id, reason: "x" }, staff()))
        .asked,
    ).toBe("unknown");
    expect((await changeRow(id))?.state).toBe("requested");
    await run("subscription.change.withdraw", { id, reason: "x" }, staff());
    expect(calls("voidPendingUpdate", id)).toHaveLength(2);
    expect((await changeRow(id))?.state).toBe("withdrawn");
  });

  it("the audit says when a recorded outcome found the change moved on", async () => {
    const { buyer, id } = await member("movedon");
    gw.beforeAnswer = async () => {
      // The provider's verified read lands while the call is answered: applied first.
      await deliver("updated", read(id, { amount: 6000 }));
    };
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    const changeId = (await changeRow(id))?.id;
    expect((await changeRow(id))?.state).toBe("applied");
    const audit = await env.DB.prepare(
      "SELECT result FROM core_audit WHERE operation = 'subscription.change.outcome' AND input LIKE ?",
    )
      .bind(`%${changeId}%`)
      .first<{ result: string }>();
    expect(JSON.parse(audit?.result ?? "{}")).toMatchObject({ written: false });
  });

  it("a late upgrade event, paid before its life ran out, is followed as the upgrade", async () => {
    const { buyer, id } = await member("lateup");
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    await expire(id);
    const prorated = invoice({
      amountPaid: 2800,
      amountDue: 2800,
      billingReason: "subscription_update",
    });
    const paid = await deliver("invoice_paid", read(id, { amount: 6000 }), prorated);
    expect(paid.result.outcome).toBe("period_paid");
    expect(await membershipOf(id)).toMatchObject({ plan: unlimited });
    expect(await orderOf(prorated.ref)).toMatchObject({ period_flag: null, record_id: unlimited });
    expect(await told(`subscription.terms_changed:fake:${id}`)).toBe(0);
    // Without its invoice paid, a late read at the upgrade's price is never the upgrade.
    const other = await member("lateunpaid");
    await run("subscription.change", { id: other.id, planId: unlimited }, as(other.buyer));
    await expire(other.id);
    await deliver("updated", read(other.id, { amount: 6000 }));
    expect(await membershipOf(other.id)).toMatchObject({ plan: three });
    expect(await told(`subscription.terms_changed:fake:${other.id}`)).toBe(1);
  });

  it("a late downgrade read and a late paused read are followed as their change", async () => {
    const down = await member("latedown");
    await run("subscription.change", { id: down.id, planId: one }, as(down.buyer));
    await expire(down.id);
    await deliver("updated", read(down.id, { amount: 1500 }));
    expect((await changeRow(down.id))?.state).toBe("waiting");
    expect(await told(`subscription.terms_changed:fake:${down.id}`)).toBe(0);

    const p = await member("latepause");
    await run(
      "subscription.pause",
      { id: p.id, until: new Date(Date.now() + 14 * DAY).toISOString(), reason: "Travel" },
      staff(),
    );
    await expire(p.id);
    await deliver("paused", read(p.id, { status: "paused" }));
    expect((await changeRow(p.id))?.state).toBe("applied");
    // Too late (past the grace): lapsed, not followed.
    const old = await member("toolate");
    await run("subscription.change", { id: old.id, planId: one }, as(old.buyer));
    await env.DB.prepare(
      "UPDATE core_subscription_change SET expires_at = ? WHERE subscription_id = ?",
    )
      .bind(new Date(Date.now() - 4 * DAY).toISOString(), old.id)
      .run();
    await deliver("updated", read(old.id, { amount: 1500 }));
    expect((await changeRow(old.id))?.state).toBe("lapsed");
  });

  it("a downgrade's first period is decided by when its period began, not a discounted invoice's amount", async () => {
    const next = new Date(Date.parse(PERIOD_END) + 30 * DAY).toISOString();
    // Asked before the renewal, processed after it, renewed with a coupon: the new plan from it.
    const a = await member("billednew");
    await run("subscription.change", { id: a.id, planId: one }, as(a.buyer));
    const renewal = invoice({
      amountPaid: 1200,
      amountDue: 1200,
      periodStart: PERIOD_END,
      periodEnd: next,
    });
    await deliver(
      "invoice_paid",
      read(a.id, { amount: 1500, currentPeriodStart: PERIOD_END, currentPeriodEnd: next }),
      renewal,
    );
    expect(await membershipOf(a.id)).toMatchObject({ plan: one, uses: 1 });
    // The period began before the change was asked, its invoice discounted to the new price: the
    // old plan to that period's end.
    const b = await member("discountedold");
    const start = new Date(Date.now() - 3_600_000).toISOString();
    const end = new Date(Date.now() + 20 * DAY).toISOString();
    await run("subscription.change", { id: b.id, planId: one }, as(b.buyer));
    const discounted = invoice({
      amountPaid: 1500,
      amountDue: 1500,
      periodStart: start,
      periodEnd: end,
    });
    await deliver(
      "invoice_paid",
      read(b.id, { amount: 1500, currentPeriodStart: start, currentPeriodEnd: end }),
      discounted,
    );
    expect(await changeRow(b.id)).toMatchObject({ state: "waiting", effective_at: end });
    expect(await membershipOf(b.id)).toMatchObject({ plan: three });
  });

  it("a lapsed pause is not revived once a newer change was applied; an unasked pause tells staff", async () => {
    const { buyer, id } = await member("newerwins");
    await run(
      "subscription.pause",
      {
        id,
        from: new Date(Date.now() + 2 * DAY).toISOString(),
        until: new Date(Date.now() + 12 * DAY).toISOString(),
        reason: "x",
      },
      staff(),
    );
    await expire(id);
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    await deliver("updated", read(id, { amount: 6000 }));
    expect((await changeRow(id))?.state).toBe("applied");
    await deliver("paused", read(id, { amount: 6000, status: "paused" }));
    const pause = await env.DB.prepare(
      "SELECT state FROM core_subscription_change WHERE subscription_id = ? AND kind = 'pause'",
    )
      .bind(id)
      .first<{ state: string }>();
    expect(pause?.state).toBe("lapsed");
    const notices = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE substr(dedupe_key, 1, length(?1)) = ?1",
    )
      .bind(`subscription.paused_at_provider:fake:${id}:`)
      .first<{ n: number }>();
    expect(notices?.n).toBe(1);
  });

  it("withdrawing an upgrade with nothing left pending closes it", async () => {
    const { buyer, id } = await member("nothingpending");
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    // The gatekeeper finds nothing pending: done, nothing to undo.
    const out = await run<{ asked: string }>(
      "subscription.change.withdraw",
      { id, reason: "x" },
      staff(),
    );
    expect(out.asked).toBe("sent");
    expect((await changeRow(id))?.state).toBe("withdrawn");
  });

  it("a lost renewal event: the provider is read once and the change goes on from its period", async () => {
    const { buyer, id } = await member("lostrenewal");
    const ended = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(
      "UPDATE core_subscription SET current_period_end = ?, version = version + 1 WHERE id = ?",
    )
      .bind(ended, id)
      .run();
    const fresh = new Date(Date.now() + 29 * DAY).toISOString();
    gw.providerReads.set(
      `fsub_${id}`,
      read(id, { currentPeriodStart: ended, currentPeriodEnd: fresh }) as never,
    );
    const asked = await run<{ effectiveAt: string }>(
      "subscription.change",
      { id, planId: one },
      as(buyer),
    );
    expect(asked.effectiveAt).toBe(fresh);
    // The host's record is not moved by that read.
    expect(
      ((await subscription(id)) as unknown as { currentPeriodEnd: string }).currentPeriodEnd,
    ).toBe(ended);
  });

  it("a lapsed upgrade shows no page to pay", async () => {
    const { buyer, id } = await member("lapsedpage");
    await run("subscription.change", { id, planId: unlimited }, as(buyer));
    await deliver(
      "invoice_action_required",
      read(id),
      invoice({
        status: "open",
        amountPaid: 0,
        amountDue: 2800,
        billingReason: "subscription_update",
        hostedUrl: "https://fake-provider.invalid/x",
      }),
    );
    expect((await subscription(id)).change?.actionUrl).toBe("https://fake-provider.invalid/x");
    await expire(id);
    expect((await subscription(id)).change).toMatchObject({ state: "lapsed", actionUrl: null });
  });

  it("erasing the payer blanks the reasons on their subscription's changes", async () => {
    const { buyer, id } = await member("erased");
    await run(
      "subscription.change",
      { id, planId: one, reason: "Moving house, lower income" },
      as(buyer),
    );
    await run("person.erase", { id: buyer.principal.personId }, staff());
    const row = await env.DB.prepare(
      "SELECT reason FROM core_subscription_change WHERE subscription_id = ?",
    )
      .bind(id)
      .first<{ reason: string }>();
    expect(row?.reason).toBe("");
  });
});
