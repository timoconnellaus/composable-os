// Stage 32b, build steps 6 and 7 (ADRs 0530 to 0532): plan changes and pauses of a membership in
// the real host, with real D1, the real payments gatekeeper and its fake provider, and the
// Memberships dashboard against this file's own fixture, worked out by hand (criterion 16). Its
// own file, so the database holds only this fixture and every number is exact.
//
// What is checked (criterion 14): a member upgrades on the web: the gatekeeper's action is applied
// as the host's own call, the fake provider charges the rest of the period at once and its verified
// events give the member the new plan; a member downgrades: the provider shows the new price, the
// member keeps the plan paid for until the next period's verified read; staff pause a membership:
// the provider's paused read pauses it (no booking spends it), and ending the pause resumes it; and
// the dashboard's numbers.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  extensionDashboardId,
  type InvocationContext,
  memoryWidgetCache,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signatureHeader } from "../../../packages/gatekeeper-payments/src/signature.ts";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, newCustomer, refusal, run, unique } from "./helpers.ts";
import { filesByName, packFiles } from "./pack-files.ts";

const files: Record<string, Record<string, string>> = {
  programs: packFiles("programs"),
  memberships: packFiles("memberships"),
  bookings: filesByName(
    import.meta.glob<string>("../../../packs/memberships/test/fixtures/bookings/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
};
const OURS = new Set(Object.keys(files));

const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    { id: "programs", version: "0.1.0" },
    { id: "memberships", version: "0.1.0" },
    { id: "bookings", version: "0.0.1" },
  ],
  commitShipped: (id) =>
    OURS.has(id)
      ? host.commit({
          id,
          files: files[id] as Record<string, string>,
          message: `Shipped ${id}`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const FAKE_SECRET = "fake-payments-test-secret";
const RETURN = "https://gym.test/account";
const PLAN = "memberships.plan";
const MEMBERSHIP = "memberships.membership";
const CLASS = "bookings.class";
const BOOKING = "bookings.booking";
const DAY = 86_400_000;

let admin: ActingUser;
const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  integrations,
  extensionHost: shippedHost,
  ...extra,
});
const as = (principal: CustomerPrincipal) =>
  ({ principal, db, integrations, extensionHost: shippedHost }) as OutsideInvocationContext;

const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff(admin))).id;

const createMember = async (label: string) => (await newCustomer(staff(admin), label)).principal;

async function subscription(id: string) {
  return env.DB.prepare("SELECT * FROM core_subscription WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

async function membershipOf(subscriptionId: string): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    "SELECT record_id FROM core_subscription_grant WHERE subscription_id = ?",
  )
    .bind(subscriptionId)
    .first<{ record_id: string }>();
  if (!row) return null;
  return {
    id: row.record_id,
    ...(
      await run<{ values: Record<string, unknown> }>(
        "record.get",
        { object: MEMBERSHIP, id: row.record_id },
        staff(admin),
      )
    ).values,
  };
}

/** A member subscribed to `plan` and paid on the fake provider's page; its subscription, active. */
async function subscribed(label: string, plan: string) {
  const member = await createMember(label);
  const started = await run<{ subscriptionId: string; url: string }>(
    "subscription.start",
    { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
    as(member),
  );
  const paid = await runner.gatekeeperFetch(
    "payments",
    new Request(started.url, {
      method: "POST",
      body: new URLSearchParams({ outcome: "pay" }),
      redirect: "manual",
    }),
  );
  expect(paid.status).toBe(303);
  await vi.waitFor(
    async () => expect((await membershipOf(started.subscriptionId))?.status).toBe("active"),
    { timeout: 20_000 },
  );
  return { member, id: started.subscriptionId };
}

/** Posts a provider delivery to the gatekeeper's webhook, signed with the fake's secret. */
async function deliver(body: Record<string, unknown>) {
  const text = JSON.stringify(body);
  const signature = await signatureHeader(FAKE_SECRET, text, Math.floor(Date.now() / 1000));
  const answer = await runner.gatekeeperFetch(
    "payments",
    new Request("http://crm.test/gatekeeper/payments/in/fake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-fake-signature": signature },
      body: text,
    }),
  );
  expect(answer.status).toBe(200);
}

let three: string;
let unlimited: string;
let one: string;
let yoga: string;
const ann = { id: "", member: null as CustomerPrincipal | null };
const ben = { id: "", member: null as CustomerPrincipal | null };
const cat = { id: "", member: null as CustomerPrincipal | null };
let proration = 0;
let benRenewal = "";

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "memberships"]) {
    await run("extension.install", { id, shipped: true }, staff(admin));
  }
  await refreshSchemaRegistry(db.query);
  await run(
    "order.settings.update",
    { currency: "AUD", returnOrigins: ["https://gym.test"] },
    staff(admin),
  );
  await run("integration.setVendor", { vendor: "payments", enabled: true }, staff(admin));
  const payments = await run<{ connection: { id: string } }>(
    "connection.create",
    { vendor: "payments", scope: "org" },
    staff(admin),
  );
  await run(
    "connection.bindResource",
    { id: payments.connection.id, url: "payments://merchant/fake" },
    staff(admin),
  );
  const base = { per: "week", status: "on_sale" };
  three = await create(PLAN, {
    ...base,
    title: "Three a week",
    price: 30,
    uses: 3,
    pauseMinDays: 7,
    pauseMaxDays: 60,
  });
  unlimited = await create(PLAN, { ...base, title: "Unlimited", price: 70 });
  one = await create(PLAN, { ...base, title: "One a week", price: 15, uses: 1 });
  yoga = await create("programs.classtype", { name: "Yoga" });
});

afterAll(async () => {
  await setPreset("balanced");
});

describe("plan changes through the fake provider (decision 12)", () => {
  it("an upgrade is charged now, prorated, and the member holds the new plan from the provider's event", async () => {
    Object.assign(ann, await subscribed("ann", three));
    const asked = await run<{ kind: string }>(
      "subscription.change",
      { id: ann.id, planId: unlimited },
      as(ann.member as CustomerPrincipal),
    );
    expect(asked.kind).toBe("upgrade");
    await vi.waitFor(
      async () => expect(await membershipOf(ann.id)).toMatchObject({ plan: unlimited, uses: null }),
      { timeout: 20_000 },
    );
    expect(await subscription(ann.id)).toMatchObject({ plan_id: unlimited, amount: 7000 });
    const orders = await env.DB.prepare(
      "SELECT o.total, o.period_flag, l.title FROM core_order o JOIN core_order_line l ON l.order_id = o.id WHERE o.subscription_id = ? ORDER BY o.created_at",
    )
      .bind(ann.id)
      .all<{ total: number; period_flag: string | null; title: string }>();
    // The first period, then the rest of it at the difference: nearly a whole month was left.
    expect(orders.results).toHaveLength(2);
    expect(orders.results[0]).toMatchObject({ total: 3000, period_flag: null });
    proration = orders.results[1]?.total ?? 0;
    expect(proration).toBeGreaterThan(3990);
    expect(proration).toBeLessThanOrEqual(4000);
    expect(orders.results[1]).toMatchObject({ period_flag: null });
    expect(orders.results[1]?.title).toContain("upgrade from Three a week");
  });

  it("a downgrade keeps the plan paid for until the next period, then holds the new one", async () => {
    Object.assign(ben, await subscribed("ben", three));
    const member = ben.member as CustomerPrincipal;
    const asked = await run<{ kind: string; effectiveAt: string }>(
      "subscription.change",
      { id: ben.id, planId: one },
      as(member),
    );
    expect(asked.kind).toBe("downgrade");
    await vi.waitFor(
      async () =>
        expect(
          (
            await run<{ change: { state: string } | null }>(
              "subscription.get",
              { id: ben.id },
              as(member),
            )
          ).change?.state,
        ).toBe("waiting"),
      { timeout: 20_000 },
    );
    expect(await membershipOf(ben.id)).toMatchObject({ plan: three, uses: 3 });

    // A class next week spends one of three, while the plan paid for holds.
    const startsAt = new Date(Date.now() + 8 * DAY).toISOString();
    const klass = await create(CLASS, { name: "Morning yoga", classType: yoga, startsAt });
    const booking = await create(BOOKING, {
      name: unique("Booking"),
      person: member.personId,
      class: klass,
    });
    await run(
      "record.update",
      { object: BOOKING, id: booking, values: { state: "booked" } },
      staff(admin),
    );

    // The provider renews at the new price: the next period's verified read.
    const sub = (await subscription(ben.id)) as Record<string, unknown>;
    const periodStart = sub.current_period_end as string;
    const periodEnd = new Date(Date.parse(periodStart) + 30 * DAY).toISOString();
    benRenewal = unique("fin");
    await deliver({
      id: unique("fevt_renew"),
      type: "subscription.event",
      created: Math.floor(Date.now() / 1000),
      data: {
        trigger: "invoice_paid",
        subscription: {
          provider: "fake",
          ref: sub.provider_ref,
          customerRef: sub.customer_ref,
          subscriptionId: ben.id,
          status: "active",
          amount: 1500,
          currency: "AUD",
          interval: "month",
          cancelAtPeriodEnd: false,
          cancelAt: null,
          trialEnd: null,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          canceledAt: null,
          endedAt: null,
          endReason: null,
          observedAt: new Date().toISOString(),
        },
        invoice: {
          ref: benRenewal,
          status: "paid",
          amountPaid: 1500,
          amountDue: 1500,
          currency: "AUD",
          paymentRef: unique("fpi"),
          periodStart,
          periodEnd,
          billingReason: "subscription_cycle",
          attemptCount: 1,
          nextAttemptAt: null,
          hostedUrl: null,
        },
      },
    });
    await vi.waitFor(
      async () => expect(await membershipOf(ben.id)).toMatchObject({ plan: one, uses: 1 }),
      { timeout: 20_000 },
    );
    const renewal = await env.DB.prepare(
      "SELECT total, period_flag FROM core_order WHERE invoice_ref = ?",
    )
      .bind(benRenewal)
      .first();
    expect(renewal).toEqual({ total: 1500, period_flag: null });
  });
});

describe("a pause through the fake provider (decision 10)", () => {
  it("staff pause it within the plan's bounds; the provider's event pauses the membership", async () => {
    Object.assign(cat, await subscribed("cat", three));
    const member = cat.member as CustomerPrincipal;
    const until = new Date(Date.now() + 14 * DAY).toISOString();
    // A member cannot; too long for the plan is refused before the provider is asked.
    expect(
      (await refusal(run("subscription.pause", { id: cat.id, until, reason: "x" }, as(member))))
        .code,
    ).toBe("unknown_operation");
    const long = await refusal(
      run(
        "subscription.pause",
        { id: cat.id, until: new Date(Date.now() + 90 * DAY).toISOString(), reason: "Travel" },
        staff(admin),
      ),
    );
    expect(long.details).toMatchObject({ rule: "pause_length", max: 60 });
    await run("subscription.pause", { id: cat.id, until, reason: "Injury" }, staff(admin));
    await vi.waitFor(async () => expect((await membershipOf(cat.id))?.status).toBe("paused"), {
      timeout: 20_000,
    });
    expect((await subscription(cat.id))?.state).toBe("paused");
    // Nothing spends it while paused.
    const klass = await create(CLASS, {
      name: "Paused yoga",
      classType: yoga,
      startsAt: new Date(Date.now() + 2 * DAY).toISOString(),
    });
    const booking = await create(BOOKING, {
      name: unique("Booking"),
      person: member.personId,
      class: klass,
    });
    const refused = await refusal(
      run(
        "record.update",
        { object: BOOKING, id: booking, values: { state: "booked" } },
        staff(admin),
      ),
    );
    expect(JSON.stringify(refused)).toContain("allowance");
  });
});

describe("the Memberships dashboard (criterion 16)", () => {
  it("matches the fixture worked out by hand", async () => {
    // One more: subscribed, then ended by staff at once.
    const eve = await subscribed("eve", three);
    await run("subscription.cancel", { id: eve.id, now: true, reason: "Moved away" }, staff(admin));
    await vi.waitFor(async () => expect((await subscription(eve.id))?.state).toBe("ended"), {
      timeout: 20_000,
    });

    const dashboardId = extensionDashboardId("memberships", "memberships");
    const dashboard = await run<{ widgets: { id: string }[] }>(
      "dashboard.get",
      { id: dashboardId },
      staff(admin),
    );
    const today = new Date();
    const from = new Date(today.getTime() - 40 * DAY).toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 40 * DAY).toISOString().slice(0, 10);
    const results: Record<string, unknown[]> = {};
    for (const { id } of dashboard.widgets) {
      const out = await run<{ rows: unknown[] }>(
        "widget.run",
        { dashboardId, widgetId: id, filters: { dates: { from, to } }, refresh: true },
        staff(admin, { widgetCache: memoryWidgetCache() }),
      );
      results[id] = out.rows;
    }
    // Ann (upgraded) and Ben (downgraded) are active; Cat is paused; Eve ended.
    expect(results.active).toEqual([{ value: 2 }]);
    expect(results.trialing).toEqual([{ value: 0 }]);
    expect(results.paused).toEqual([{ value: 1 }]);
    expect(results.failing).toEqual([{ value: 0 }]);
    expect(results.failing_members ?? results["failing-members"]).toEqual([]);
    expect(results["trials-ended"]).toEqual([{ value: 0 }]);
    expect(results["trials-paid"]).toEqual([{ value: 0 }]);
    // Four first periods at 30.00, Ann's upgrade, Ben's renewal at 15.00; no tax, no refunds.
    const revenue = (4 * 3000 + proration + 1500) / 100;
    expect(results.revenue).toEqual([{ value: revenue }]);
    const month = today.toISOString().slice(0, 7);
    const byMonth = results["revenue-by-month"] as { month: string; revenue: number }[];
    expect(byMonth.reduce((sum, r) => sum + r.revenue, 0)).toBeCloseTo(revenue, 2);
    expect(byMonth.map((r) => r.month)).toContain(month);
    expect(results["cancellations-by-month"]).toEqual([
      { month, reason: "Asked for", cancelled: 1 },
    ]);
    // Ben's one class next week; Cat's was refused.
    expect(results.uses).toEqual([{ value: 1 }]);
    expect((results["uses-by-week"] as { uses: number }[]).map((r) => r.uses)).toEqual([1]);
  });
});

describe("ending a pause", () => {
  it("staff end it early: the provider resumes it and charges a new period, and the membership runs again", async () => {
    await run("subscription.unpause", { id: cat.id, reason: "Back early" }, staff(admin));
    await vi.waitFor(async () => expect((await membershipOf(cat.id))?.status).toBe("active"), {
      timeout: 20_000,
    });
    expect((await subscription(cat.id))?.state).toBe("active");
    // A first period after the pause, if anything was owed on it, is not flagged.
    const flagged = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_order WHERE subscription_id = ? AND period_flag IS NOT NULL",
    )
      .bind(cat.id)
      .first<{ n: number }>();
    expect(flagged?.n).toBe(0);
  });
});

describe("the gatekeeper's typed refusal (second review)", () => {
  it("a refusal at the real gatekeeper reaches the host as refused, never by its wording", async () => {
    const dee = await subscribed("dee", three);
    const from = new Date(Date.now() + 3 * DAY).toISOString();
    await run(
      "subscription.pause",
      {
        id: dee.id,
        from,
        until: new Date(Date.parse(from) + 10 * DAY).toISOString(),
        reason: "Trip",
      },
      staff(admin),
    );
    // The host's row lapses (as a day passing would) while the provider still holds the pause.
    await env.DB.prepare(
      "UPDATE core_subscription_change SET expires_at = ? WHERE subscription_id = ? AND state = 'requested'",
    )
      .bind(new Date(Date.now() - 60_000).toISOString(), dee.id)
      .run();
    const refused = await refusal(
      run(
        "subscription.pause",
        { id: dee.id, until: new Date(Date.now() + 14 * DAY).toISOString(), reason: "Again" },
        staff(admin),
      ),
    );
    expect(refused.details).toMatchObject({ rule: "provider_refused" });
    const row = await env.DB.prepare(
      "SELECT state, call_outcome, call_error FROM core_subscription_change WHERE subscription_id = ? ORDER BY requested_at DESC LIMIT 1",
    )
      .bind(dee.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ state: "lapsed", call_outcome: "refused" });
    // The tag is read and removed: the words kept are the provider's.
    expect(String(row?.call_error)).not.toContain("[apply-outcome:");
  });
});
