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
        },
        public: { read: ["title", "price", "uses"] },
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
  three = await create(PLAN, {
    title: "Three a week",
    price: 30,
    uses: 3,
    pauseMin: 7,
    pauseMax: 60,
  });
  unlimited = await create(PLAN, { title: "Unlimited", price: 60 });
  one = await create(PLAN, { title: "One a week", price: 15, uses: 1 });
  twin = await create(PLAN, { title: "Three a week, mornings", price: 30, uses: 3 });
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
    await env.DB.prepare(
      "UPDATE core_subscription_change SET requested_at = ? WHERE subscription_id = ?",
    )
      .bind(new Date(Date.now() - 25 * 3_600_000).toISOString(), id)
      .run();
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
  it("refuses another's subscription, a plan of another interval or the same plan, and an AI", async () => {
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
