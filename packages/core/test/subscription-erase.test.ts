// Issue #293 (ADR 0649): erasing a Person ends the subscriptions they are on as a member's own
// deletion does (stage 48, decision 1): asked at the provider to end when the period paid for
// ends, nothing refunded, nothing more charged. Whoever started the erase, whichever of payer and
// holder they are, and one resumed since. A checkout the provider confirms after the erase is
// asked to end the same way. Against the payments gatekeeper's test double.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type IntegrationRuntime,
  memoryEventSink,
  type PaymentsEvent,
  type ProviderSubscription,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";
import { type Buyer, CURRENCY, createBuyer, outside, PUBLIC, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const GYM = extId("gym");
const PLAN = `${GYM}.plan`;
const RETURN = "https://shop.example.com/account";
const DAY = 86_400_000;

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime } = payments;
let admin: ActingUser;
let plan: string;

const as = (buyer: Buyer) => outside(buyer.principal, { integrations: runtime, events });

type EraseOut = {
  subscriptionsEnding: { atPeriodEnd: number; now: number; leftForStaff: number };
};
const erase = (personId: string, integrations: IntegrationRuntime = runtime) =>
  run<EraseOut>("person.erase", { id: personId }, context(admin, { integrations, events }));

let clock = Date.now();
const later = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};

function read(id: string, overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    provider: "fake",
    ref: `fsub_${id}`,
    customerRef: `fcus_${id}`,
    subscriptionId: id,
    status: "active",
    amount: 2900,
    currency: CURRENCY,
    interval: "month",
    cancelAtPeriodEnd: false,
    cancelAt: null,
    trialEnd: null,
    currentPeriodStart: new Date().toISOString(),
    currentPeriodEnd: new Date(Date.now() + 30 * DAY).toISOString(),
    canceledAt: null,
    endedAt: null,
    endReason: null,
    observedAt: later(),
    ...overrides,
  };
}

function deliver(
  trigger: Extract<PaymentsEvent, { kind: "subscription" }>["trigger"],
  subscription: ProviderSubscription,
) {
  return payments.deliver({
    kind: "subscription",
    provider: "fake",
    eventId: `fevt_${unique("s")}`,
    trigger,
    subscription,
    occurredAt: new Date().toISOString(),
  });
}

async function subscriptionRow(id: string) {
  return env.DB.prepare("SELECT * FROM core_subscription WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

async function notices(title: RegExp) {
  const { results } = await env.DB.prepare(
    "SELECT title, body, link FROM core_notifications WHERE user_id = ? ORDER BY created_at",
  )
    .bind(admin.id)
    .all<{ title: string; body: string; link: string | null }>();
  return results.filter((r) => title.test(r.title));
}

/** The cancel calls the host made for subscription `id`. */
const cancels = (id: string) =>
  gw.changes.filter((c) => c.method === "cancelSubscription" && c.request.subscriptionId === id);

/** A customer with an active subscription they pay for and hold. */
async function member(label: string, overrides: Partial<ProviderSubscription> = {}) {
  const buyer = await createBuyer(admin, label);
  const { subscriptionId: id } = await run<{ subscriptionId: string }>(
    "subscription.start",
    { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
    as(buyer),
  );
  await deliver("checkout_completed", read(id, overrides));
  return { buyer, id };
}

beforeAll(async () => {
  admin = await createUser("admin");
  await reconcile(
    manifest(GYM, {
      objects: {
        plan: {
          label: "Plan",
          plural: "Plans",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price per month", currency: CURRENCY },
          },
          sellable: { price: "price", recurring: { interval: "month" } },
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
  plan = (
    (await run(
      "record.create",
      { object: PLAN, values: { name: "Monthly", price: 29 } },
      context(admin),
    )) as {
      id: string;
    }
  ).id;
  await payments.connect(admin.id);
});

beforeEach(() => {
  events = memoryEventSink();
});

describe("erase ends a running subscription at the end of the period paid for (#293)", () => {
  it("staff erase a member who never deleted their account: asked to end at period end, nothing refunded", async () => {
    const { buyer, id } = await member("plain");
    const refunds = gw.refunds.size;
    const out = await erase(buyer.principal.personId);
    expect(out.subscriptionsEnding).toEqual({ atPeriodEnd: 1, now: 0, leftForStaff: 0 });
    expect(cancels(id)).toEqual([
      {
        method: "cancelSubscription",
        request: {
          subscriptionId: id,
          subscriptionRef: `fsub_${id}`,
          when: "period_end",
          reason: "Ended because a person on it was erased",
        },
      },
    ]);
    // Nothing refunded, nothing charged: no refund asked and no order made.
    expect(gw.refunds.size).toBe(refunds);
    // The record moves only when the provider says, and it still can: it names nobody now.
    expect(await subscriptionRow(id)).toMatchObject({
      payer_person_id: null,
      holder_person_id: null,
      cancel_at_period_end: 0,
      state: "active",
    });
    await deliver("updated", read(id, { cancelAtPeriodEnd: true }));
    expect(await subscriptionRow(id)).toMatchObject({ cancel_at_period_end: 1, state: "active" });
    await deliver("deleted", read(id, { status: "canceled", endReason: "cancellation_requested" }));
    expect((await subscriptionRow(id))?.state).toBe("ended");
  });

  it("one already ending is not asked again; one resumed since it was set to end is", async () => {
    const ending = await member("ending", { cancelAtPeriodEnd: true });
    let out = await erase(ending.buyer.principal.personId);
    expect(out.subscriptionsEnding).toEqual({ atPeriodEnd: 0, now: 0, leftForStaff: 0 });
    expect(cancels(ending.id)).toEqual([]);

    const resumed = await member("resumed", { cancelAtPeriodEnd: true });
    await deliver("updated", read(resumed.id));
    expect((await subscriptionRow(resumed.id))?.cancel_at_period_end).toBe(0);
    out = await erase(resumed.buyer.principal.personId);
    expect(out.subscriptionsEnding.atPeriodEnd).toBe(1);
    expect(cancels(resumed.id)).toHaveLength(1);
  });

  it("an end date set at the provider after the period's end is replaced by the period's end", async () => {
    const far = new Date(Date.now() + 200 * DAY).toISOString();
    const { buyer, id } = await member("fardate", { cancelAt: far });
    const out = await erase(buyer.principal.personId);
    expect(out.subscriptionsEnding.atPeriodEnd).toBe(1);
    expect(cancels(id).map((c) => c.request.when)).toEqual(["period_end"]);
  });

  it("a paused or unpaid one, whose paid period is over, ends at once; an ended one is left", async () => {
    const paused = await member("paused", { status: "paused" });
    const out = await erase(paused.buyer.principal.personId);
    expect(out.subscriptionsEnding).toEqual({ atPeriodEnd: 0, now: 1, leftForStaff: 0 });
    expect(cancels(paused.id).map((c) => c.request.when)).toEqual(["now"]);

    const unpaid = await member("unpaid", { status: "unpaid" });
    expect((await erase(unpaid.buyer.principal.personId)).subscriptionsEnding.now).toBe(1);

    const ended = await member("ended");
    await deliver("deleted", read(ended.id, { status: "canceled" }));
    expect((await erase(ended.buyer.principal.personId)).subscriptionsEnding).toEqual({
      atPeriodEnd: 0,
      now: 0,
      leftForStaff: 0,
    });
    expect(cancels(ended.id)).toEqual([]);
  });

  it("a subscription someone else is on ends too, as payer or as holder, and the admins are told", async () => {
    // The payer erased; the holder (a child) stays and keeps it until the period's end.
    const payerSide = await member("guardian");
    const child = await createBuyer(admin, "child");
    await env.DB.prepare("UPDATE core_subscription SET holder_person_id = ? WHERE id = ?")
      .bind(child.principal.personId, payerSide.id)
      .run();
    let out = await erase(payerSide.buyer.principal.personId);
    expect(out.subscriptionsEnding.atPeriodEnd).toBe(1);
    expect(cancels(payerSide.id).map((c) => c.request.when)).toEqual(["period_end"]);
    expect(await subscriptionRow(payerSide.id)).toMatchObject({
      holder_person_id: child.principal.personId,
      payer_person_id: null,
    });

    // The holder erased; the payer stays, and pays nothing more after the period's end.
    const holderSide = await member("payer");
    const held = await createBuyer(admin, "held");
    await env.DB.prepare("UPDATE core_subscription SET holder_person_id = ? WHERE id = ?")
      .bind(held.principal.personId, holderSide.id)
      .run();
    out = await erase(held.principal.personId);
    expect(out.subscriptionsEnding.atPeriodEnd).toBe(1);
    expect(cancels(holderSide.id)).toHaveLength(1);
    expect(await subscriptionRow(holderSide.id)).toMatchObject({
      payer_person_id: holderSide.buyer.principal.personId,
      holder_person_id: null,
    });

    const told = await notices(/someone else is on/);
    expect(told.map((n) => n.body).join("\n")).toContain(payerSide.id);
    expect(told.map((n) => n.body).join("\n")).toContain(holderSide.id);
    // Naming nobody: no erased person's address or id.
    for (const n of told) {
      expect(n.body).not.toContain(payerSide.buyer.email);
      expect(n.body).not.toContain(held.principal.personId);
    }
  });

  it("one the provider cannot be asked about is left for staff: the erase still happens and admins are told", async () => {
    const { buyer, id } = await member("unreachable");
    const failing: IntegrationRuntime = {
      ...runtime,
      async callAsHost(input) {
        if (input.method === "cancelSubscription") throw new Error("the gatekeeper did not answer");
        return (runtime.callAsHost as NonNullable<IntegrationRuntime["callAsHost"]>)(input);
      },
    };
    const out = await erase(buyer.principal.personId, failing);
    expect(out.subscriptionsEnding).toEqual({ atPeriodEnd: 0, now: 0, leftForStaff: 1 });
    expect(
      await env.DB.prepare("SELECT id FROM core_person WHERE id = ?")
        .bind(buyer.principal.personId)
        .first(),
    ).toBeNull();
    const told = await notices(/could not be ended/);
    expect(told.at(-1)?.body).toContain(id);
    expect(JSON.parse(told.at(-1)?.link ?? "{}")).toMatchObject({ object: "subscription", id });
    // Staff can still end it from its record.
    await run("subscription.cancel", { id }, context(admin, { integrations: runtime, events }));
    expect(cancels(id)).toHaveLength(1);
  });
});

describe("a checkout the provider confirms after the erase (#293)", () => {
  it("makes nothing, is asked to end at the period's end once, and staff are told nothing is refunded", async () => {
    const buyer = await createBuyer(admin, "late");
    const { subscriptionId: id } = await run<{ subscriptionId: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: plan }, returnUrl: RETURN, email: buyer.email },
      outside(PUBLIC, { integrations: runtime, events }),
    );
    await erase(buyer.principal.personId);
    await deliver("checkout_completed", read(id));
    expect(await subscriptionRow(id)).toBeNull();
    expect(cancels(id)).toEqual([
      {
        method: "cancelSubscription",
        request: {
          subscriptionId: id,
          subscriptionRef: `fsub_${id}`,
          when: "period_end",
          reason: "Ended because a person on it was erased",
        },
      },
    ]);
    const told = await notices(/confirmed for someone who was erased/);
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toContain("asked to end it when the period paid for ends");
    // The provider's next read shows it ending: nothing more is asked, nothing more is told.
    await deliver("updated", read(id, { cancelAtPeriodEnd: true }));
    expect(cancels(id)).toHaveLength(1);
    expect(await notices(/confirmed for someone who was erased/)).toHaveLength(1);
  });
});
