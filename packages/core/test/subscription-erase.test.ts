// Issue #293 (ADR 0533): erasing a Person ends the subscriptions they are on as a member's own
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

/** The runtime, with the host's cancel answered by `cancel` instead (the rest as the double). */
function withCancel(
  cancel: (input: Parameters<NonNullable<IntegrationRuntime["callAsHost"]>>[0]) => Promise<unknown>,
): IntegrationRuntime {
  const inner = runtime.callAsHost as NonNullable<IntegrationRuntime["callAsHost"]>;
  return {
    ...runtime,
    async callAsHost(input) {
      if (input.method === "cancelSubscription") {
        const answer = await cancel(input);
        if (answer) return answer as Awaited<ReturnType<typeof inner>>;
      }
      return inner(input);
    },
  };
}

describe("the review of PR #354", () => {
  it("finding 1: the holder erased before the payer's checkout confirms: nothing is made, it is asked to end, staff told the payer is live", async () => {
    const payer = await createBuyer(admin, "livepayer");
    const child = await createBuyer(admin, "erasedchild");
    const { subscriptionId: id } = await run<{ subscriptionId: string }>(
      "subscription.start",
      {
        plan: { object: PLAN, id: plan },
        returnUrl: RETURN,
        email: payer.email,
        holderPersonId: child.principal.personId,
      },
      context(admin, { integrations: runtime, events }),
    );
    await erase(child.principal.personId);
    await deliver("checkout_completed", read(id));
    expect(await subscriptionRow(id)).toBeNull();
    expect(cancels(id).map((c) => c.request.when)).toEqual(["period_end"]);
    const told = (await notices(/confirmed for someone who was erased/)).filter((n) =>
      n.body.includes(`fsub_${id}`),
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.body).toContain("still a customer");
    expect(told[0]?.body).not.toContain(payer.email);
  });

  it("finding 2: staff cannot resume (or unpause) a subscription an erase ended", async () => {
    const { buyer, id } = await member("noresume");
    await erase(buyer.principal.personId);
    await deliver("updated", read(id, { cancelAtPeriodEnd: true }));
    const calls = gw.changes.length;
    await expect(
      run("subscription.resume", { id }, context(admin, { integrations: runtime, events })),
    ).rejects.toMatchObject({ code: "conflict" });
    const paused = await member("nounpause", { status: "paused" });
    await erase(paused.buyer.principal.personId);
    const after = gw.changes.length;
    await expect(
      run(
        "subscription.unpause",
        { id: paused.id },
        context(admin, { integrations: runtime, events }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(gw.changes.length).toBe(after);
    expect(gw.changes.slice(calls).some((c) => c.method === "resumeSubscription")).toBe(false);
  });

  it("finding 3: a checkout of theirs the provider confirms while the erase is asking is ended after the commit", async () => {
    const { buyer, id } = await member("racer");
    const { subscriptionId: second } = await run<{ subscriptionId: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
      as(buyer),
    );
    let landed = false;
    const racing = withCancel(async () => {
      if (!landed) {
        landed = true;
        await deliver("checkout_completed", read(second));
      }
      return null;
    });
    await erase(buyer.principal.personId, racing);
    expect(cancels(id)).toHaveLength(1);
    expect(await subscriptionRow(second)).toMatchObject({ payer_person_id: null, state: "active" });
    expect(cancels(second).map((c) => c.request.when)).toEqual(["period_end"]);
  });

  it("finding 4: a past due one, its period unpaid, ends at once so the card is not retried", async () => {
    const { buyer, id } = await member("pastdue", { status: "past_due" });
    const out = await erase(buyer.principal.personId);
    expect(out.subscriptionsEnding).toEqual({ atPeriodEnd: 0, now: 1, leftForStaff: 0 });
    expect(cancels(id).map((c) => c.request.when)).toEqual(["now"]);
  });

  it("finding 6: each notice says what was done", async () => {
    // A shared paused one ends at once: the shared notice does not say "at the period's end" only.
    const shared = await member("sharedpaused", { status: "paused" });
    const kid = await createBuyer(admin, "sharedkid");
    await env.DB.prepare("UPDATE core_subscription SET holder_person_id = ? WHERE id = ?")
      .bind(kid.principal.personId, shared.id)
      .run();
    await erase(shared.buyer.principal.personId);
    const sharedNotice = (await notices(/someone else is on/)).find((n) =>
      n.body.includes(shared.id),
    );
    expect(sharedNotice?.body).toContain("or at once when nothing of its period is paid");

    // A shared one that could not be asked is told only as left for staff.
    const unasked = await member("sharedunasked");
    const kid2 = await createBuyer(admin, "sharedkid2");
    await env.DB.prepare("UPDATE core_subscription SET holder_person_id = ? WHERE id = ?")
      .bind(kid2.principal.personId, unasked.id)
      .run();
    const failing = withCancel(async () => {
      throw new Error("the gatekeeper did not answer");
    });
    await erase(unasked.buyer.principal.personId, failing);
    expect((await notices(/someone else is on/)).some((n) => n.body.includes(unasked.id))).toBe(
      false,
    );
    expect((await notices(/could not be ended/)).some((n) => n.body.includes(unasked.id))).toBe(
      true,
    );

    // An erased checkout confirmed as incomplete is ended at once, and said so.
    const late = await createBuyer(admin, "lateincomplete");
    const { subscriptionId: lateId } = await run<{ subscriptionId: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
      as(late),
    );
    await erase(late.principal.personId);
    await deliver("checkout_completed", read(lateId, { status: "incomplete" }));
    expect(cancels(lateId).map((c) => c.request.when)).toEqual(["now"]);
    const lateNotice = (await notices(/confirmed for someone who was erased/)).find((n) =>
      n.body.includes(`fsub_${lateId}`),
    );
    expect(lateNotice?.body).toContain("end it at once");

    // One already ending at the provider is not asked, and the notice does not claim it was.
    const ending = await createBuyer(admin, "lateending");
    const { subscriptionId: endingId } = await run<{ subscriptionId: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
      as(ending),
    );
    await erase(ending.principal.personId);
    await deliver("checkout_completed", read(endingId, { cancelAtPeriodEnd: true }));
    expect(cancels(endingId)).toEqual([]);
    const endingNotice = (await notices(/confirmed for someone who was erased/)).find((n) =>
      n.body.includes(`fsub_${endingId}`),
    );
    expect(endingNotice?.body).toContain("already ends at the provider");
    expect(endingNotice?.body).not.toContain("was asked");
  });

  it("finding 8: a cancel waiting for an approval counts as left for staff, and they are told", async () => {
    const { buyer, id } = await member("pendingcancel");
    const waiting = withCancel(async (input) => {
      gw.changes.push({ method: input.method, request: input.args[0] as Record<string, unknown> });
      return {
        value: { status: "pending" },
        pending: [{ status: "pending_approval" }],
        applied: [],
      };
    });
    const out = await erase(buyer.principal.personId, waiting);
    expect(out.subscriptionsEnding).toEqual({ atPeriodEnd: 0, now: 0, leftForStaff: 1 });
    expect((await notices(/could not be ended/)).some((n) => n.body.includes(id))).toBe(true);
  });
});
