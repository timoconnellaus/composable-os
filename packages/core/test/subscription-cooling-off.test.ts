// Stage 44 step 7 (decision 11, ADR 0647): cooling off, in the host, with a fixture extension
// shaped like the Memberships pack (a plan with a cooling-off setting that grants a membership, a
// course-like plan without one) and the payments double playing the provider. Every figure is
// invented, in minor units.
//
// What is checked (criterion 12 and the step's own): with the setting at 14, a new member's
// `subscription.coolOff` on day 13 ends the subscription at the provider and, once the provider
// shows it ended, owes a full refund of each paid period, each waiting for a person with
// `orders:refund`; on day 15, with a continuation offer, or with the setting at 0, it is refused.
// The window is counted in the business's time zone to the end of the last local day, across a
// clock change, both sides of the closing instant; a plan change, a pause or a trial never moves
// it; the setting in force at the start is kept (the longer of it and the setting now); once per
// member; who may (the payer, a guardian paying, staff with subscriptions:manage; never an AI);
// a provider that fails or refuses leaves a state staff see and finish; retries do nothing twice;
// erase and merge; and the reads are a fixed number of statements.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { type ExtensionManifest, validateManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  coolingOffWindow,
  memoryEventSink,
  type PaymentsEvent,
  type ProviderInvoice,
  type ProviderSubscription,
  runRefundsDue,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import { type Buyer, CURRENCY, createBuyer, outside, refusal, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const GYM = extId("gymcool");
const PLAN = `${GYM}.plan`;
const MEMBERSHIP = `${GYM}.membership`;
const COURSE = `${GYM}.course`;
const RETURN = "https://gym.example.com/account";
const DAY = 86_400_000;
const RUNNING = ["trialing", "active", "past_due", "unpaid", "paused"] as const;
const ZONE = "Australia/Sydney";
// 10:00 on Monday 28 September 2026 in Sydney (AEST, +10). Clocks go forward on Sunday 4 October,
// inside a 14-day window, so its end (midnight after 12 October) is at +11: 13:00 UTC.
const START = "2026-09-28T00:00:00.000Z";
const ENDS_14 = "2026-10-12T13:00:00.000Z";
const at =
  (iso: string, ms = 0) =>
  () =>
    new Date(Date.parse(iso) + ms);
const day = (n: number) => at(START, n * DAY);

const grants = {
  object: "membership",
  set: {
    person: "subscription.holder",
    plan: "item",
    subscription: "subscription",
    title: "item.title",
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
} as const;

const status = () => ({
  type: "select" as const,
  label: "Status",
  options: [
    { value: "draft", label: "Draft" },
    { value: "on_sale", label: "On sale" },
  ],
});

function fixture(id: string): ExtensionManifest {
  return manifest(id, {
    settings: {
      coolingOffDays: {
        type: "number",
        label: "Cooling-off period (days)",
        default: 0,
        min: 0,
        max: 30,
        personApproves: true,
      },
    },
    objects: {
      plan: {
        label: "Plan",
        plural: "Plans",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          trialDays: { type: "number", label: "Trial days" },
          pauseMin: { type: "number", label: "Shortest pause" },
          pauseMax: { type: "number", label: "Longest pause" },
          status: status(),
        },
        public: { read: ["title", "price"], when: { field: "status", in: ["on_sale"] } },
        sellable: {
          price: "price",
          recurring: {
            interval: "month",
            trialDays: "trialDays",
            pause: { minDays: "pauseMin", maxDays: "pauseMax" },
            coolingOff: { setting: "coolingOffDays" },
            grants,
          },
        },
      },
      // A plan with no cooling off (a course's, say): its pack declares none.
      course: {
        label: "Course plan",
        plural: "Course plans",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          status: status(),
        },
        public: { read: ["title", "price"], when: { field: "status", in: ["on_sale"] } },
        sellable: { price: "price", recurring: { interval: "month" } },
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
        customer: { field: "person", read: ["title", "status"], write: [] },
      },
    },
  });
}

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { runtime, gw } = payments;
let admin: ActingUser;
let thirty: string;
let sixty: string;
let trialLong: string;
let trialShort: string;
let course: string;

const staff = (overrides: Parameters<typeof context>[1] = {}) =>
  context(admin, { integrations: runtime, events, ...overrides });
const as = (buyer: Buyer, clock?: () => Date) =>
  outside(buyer.principal, { integrations: runtime, events, ...(clock ? { clock } : {}) });

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return ((await run("record.create", { object, values }, context(admin))) as { id: string }).id;
}

async function setDays(days: number | null) {
  await run(
    "extensionSettings.update",
    { extension: GYM, values: { coolingOffDays: days } },
    context(admin),
  );
}

let observed = Date.now();
const later = () => {
  observed += 1000;
  return new Date(observed).toISOString();
};

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
    currentPeriodStart: START,
    // Ahead of the real clock: a plan change asks for a period still running.
    currentPeriodEnd: new Date(Date.now() + 30 * DAY).toISOString(),
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
    periodStart: START,
    periodEnd: new Date(Date.parse(START) + 30 * DAY).toISOString(),
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

/** The provider confirms the subscription (at START, the host's record backdated to it). */
async function confirm(id: string, overrides: Partial<ProviderSubscription> = {}, paid = 3000) {
  await deliver("checkout_completed", read(id, overrides));
  if (paid > 0) await deliver("invoice_paid", read(id, overrides), invoice({ amountPaid: paid }));
  await env.DB.prepare("UPDATE core_subscription SET created_at = ? WHERE id = ?")
    .bind(START, id)
    .run();
}

/** A new member subscribed to `plan` and confirmed by the provider, the first period paid. */
async function member(
  label: string,
  plan = thirty,
  options: { paid?: number; overrides?: Partial<ProviderSubscription> } = {},
): Promise<{ buyer: Buyer; id: string }> {
  const buyer = await createBuyer(admin, label);
  const started = await run<{ subscriptionId: string }>(
    "subscription.start",
    { plan: { object: plan === course ? COURSE : PLAN, id: plan }, returnUrl: RETURN },
    as(buyer),
  );
  await confirm(started.subscriptionId, options.overrides, options.paid ?? 3000);
  return { buyer, id: started.subscriptionId };
}

type Status = {
  subscriptionId: string;
  offered: boolean;
  why: string | null;
  days: number;
  until: string | null;
  endsAt: string | null;
  refund: number;
  coolOff: { state: string; asked: string | null; refunds: string | null; paid: number } | null;
};

async function statusOf(buyer: Buyer, id: string, clock: () => Date): Promise<Status> {
  const out = await run<{ items: Status[] }>(
    "subscription.coolingOff",
    { ids: [id] },
    as(buyer, clock),
  );
  return out.items[0] as Status;
}

const coolOff = (buyer: Buyer, id: string, clock: () => Date) =>
  run<{ id: string; state: string; asked: string | null; refund: number }>(
    "subscription.coolOff",
    { id },
    as(buyer, clock),
  );

const cancels = (id: string) =>
  gw.changes.filter((c) => c.method === "cancelSubscription" && c.request.subscriptionId === id);

/** The provider ends it now, as it does once asked (a verified read). */
const ended = (id: string, overrides: Partial<ProviderSubscription> = {}) =>
  deliver(
    "deleted",
    read(id, {
      status: "canceled",
      canceledAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      ...overrides,
    }),
  );

async function owed(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT d.state, d.entered, d.object_type, d.record_id, d.payment_ref, d.amount AS due_amount, o.id AS order_id, o.paid, o.refunded FROM core_sellable_refund_due d JOIN core_order o ON o.id = d.order_id WHERE o.subscription_id = ? ORDER BY o.paid DESC",
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return results;
}

async function subscriptionState(id: string) {
  return (
    await env.DB.prepare("SELECT state FROM core_subscription WHERE id = ?")
      .bind(id)
      .first<{ state: string }>()
  )?.state;
}

async function membershipOf(id: string) {
  const row = await env.DB.prepare(
    "SELECT record_id FROM core_subscription_grant WHERE subscription_id = ?",
  )
    .bind(id)
    .first<{ record_id: string }>();
  if (!row) return null;
  return (
    await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: MEMBERSHIP, id: row.record_id },
      staff(),
    )
  ).values;
}

beforeAll(async () => {
  admin = await createUser("admin");
  const m = fixture(GYM);
  expect(validateManifest(m).issues).toEqual([]);
  await reconcile(m);
  // Installed, as the host keeps it: its manifest holds the setting (default 0, off).
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES (?, 'runtime', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
  )
    .bind(GYM, JSON.stringify(m), admin.id, now, now)
    .run();
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://gym.example.com"] },
    context(admin),
  );
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(ZONE))
    .run();
  const sale = { status: "on_sale" };
  thirty = await create(PLAN, { ...sale, title: "Three a week", price: 30, pauseMin: 7 });
  sixty = await create(PLAN, { ...sale, title: "Unlimited", price: 60 });
  trialLong = await create(PLAN, { ...sale, title: "Try a month", price: 30, trialDays: 30 });
  trialShort = await create(PLAN, { ...sale, title: "Try three days", price: 30, trialDays: 3 });
  course = await create(COURSE, { ...sale, title: "Every course", price: 30 });
  await payments.connect(admin.id);
  await setDays(14);
});

beforeEach(() => {
  events = memoryEventSink();
});

describe("the window (the business's days, its time zone, the end of the last day)", () => {
  it("is from the provider-confirmed start to the midnight after the last day, across a clock change", () => {
    expect(coolingOffWindow(START, 14, ZONE)).toEqual({ until: "2026-10-12", endsAt: ENDS_14 });
    // The same start in UTC: a day's end is a UTC midnight.
    expect(coolingOffWindow(START, 14, "UTC")).toEqual({
      until: "2026-10-12",
      endsAt: "2026-10-13T00:00:00.000Z",
    });
    // Clocks going back (Sydney, Sunday 5 April 2026): the end is still local midnight, at +10.
    expect(coolingOffWindow("2026-03-30T00:00:00.000Z", 14, ZONE)).toEqual({
      until: "2026-04-13",
      endsAt: "2026-04-13T14:00:00.000Z",
    });
    // A start late in the local evening counts its own local day as day 0.
    expect(coolingOffWindow("2026-09-28T13:30:00.000Z", 1, ZONE).until).toBe("2026-09-29");
  });

  it("is offered on day 13 and up to the last millisecond, refused at the closing instant and on day 15", async () => {
    const { buyer, id } = await member("window");
    const open = await statusOf(buyer, id, day(13));
    expect(open).toMatchObject({
      offered: true,
      why: null,
      days: 14,
      until: "2026-10-12",
      endsAt: ENDS_14,
      refund: 3000,
    });
    expect((await statusOf(buyer, id, at(ENDS_14, -1))).offered).toBe(true);
    const closed = await statusOf(buyer, id, at(ENDS_14));
    expect(closed).toMatchObject({ offered: false, why: "window_passed" });
    const late = await refusal(coolOff(buyer, id, at(ENDS_14)));
    expect(late.code).toBe("conflict");
    expect(late.details).toMatchObject({ rule: "cooling_off", reason: "window_passed" });
    expect((await refusal(coolOff(buyer, id, day(15)))).details).toMatchObject({
      reason: "window_passed",
    });
    expect(cancels(id)).toHaveLength(0);
    // The last millisecond is inside.
    expect(await coolOff(buyer, id, at(ENDS_14, -1))).toMatchObject({
      state: "asked",
      asked: "sent",
    });
  });
});

describe("cooling off on day 13 (criterion 12)", () => {
  it("ends it at the provider now, then owes each paid period in full, each waiting for a person with orders:refund", async () => {
    const { buyer, id } = await member("cooler");
    // A plan change inside the window: an upgrade, its prorated charge paid. It moves nothing.
    await run(
      "subscription.change",
      { id, planId: sixty },
      as(buyer, () => new Date()),
    );
    await deliver(
      "invoice_paid",
      read(id, { amount: 6000 }),
      invoice({ amountPaid: 1450, amountDue: 1450, billingReason: "subscription_update" }),
    );
    const before = await statusOf(buyer, id, day(13));
    expect(before).toMatchObject({ offered: true, refund: 4450, until: "2026-10-12" });

    const asked = await coolOff(buyer, id, day(13));
    expect(asked).toMatchObject({ id, state: "asked", asked: "sent", refund: 4450 });
    expect(cancels(id).map((c) => c.request.when)).toEqual(["now"]);
    // Nothing is owed until the provider shows it ended, and nothing has been refunded.
    expect(await owed(id)).toEqual([]);
    expect((await statusOf(buyer, id, day(13))).coolOff).toMatchObject({ state: "asked" });

    await ended(id, { amount: 6000 });
    expect(await subscriptionState(id)).toBe("ended");
    expect((await membershipOf(id))?.status).toBe("ended");
    // Every paid period, in full, whatever was used (decision 16).
    const rows = await owed(id);
    expect(rows.map((r) => [r.paid, r.state, r.entered, r.payment_ref, r.due_amount])).toEqual([
      [3000, "due", "cooled_off", null, null],
      [1450, "due", "cooled_off", null, null],
    ]);
    expect(rows.every((r) => r.object_type === "subscription" && r.record_id === id)).toBe(true);
    expect((await statusOf(buyer, id, day(14))).coolOff).toMatchObject({
      state: "ended",
      refunds: "waiting",
      paid: 4450,
    });

    // The minute cron asks the gatekeeper: each refund waits for a person, never applied alone.
    const appliedBefore = gw.applied.length;
    expect((await runRefundsDue(db, { integrations: runtime })).asked).toBe(2);
    expect(gw.applied.length).toBe(appliedBefore);
    const { results: waiting } = await env.DB.prepare(
      "SELECT id FROM core_pending_action WHERE action_kind = 'payments.refund' AND status = 'pending' AND input LIKE ?",
    )
      .bind(`%${id.slice(-6)}%`)
      .all<{ id: string }>()
      .then(async (r) =>
        r.results.length
          ? r
          : env.DB.prepare(
              "SELECT p.id FROM core_pending_action p WHERE p.action_kind = 'payments.refund' AND p.status = 'pending' AND EXISTS (SELECT 1 FROM core_order_refund r JOIN core_order o ON o.id = r.order_id WHERE r.pending_action_id = p.id AND o.subscription_id = ?)",
            )
              .bind(id)
              .all<{ id: string }>(),
      );
    expect(waiting).toHaveLength(2);
    // A person without orders:refund cannot approve; the assistant cannot either.
    const member2 = await createUser("member");
    expect(
      (
        await refusal(
          run(
            "approval.approve",
            { actionIds: waiting.map((w) => w.id) },
            context(member2, { integrations: runtime, events }),
          ),
        )
      ).code,
    ).toBe("forbidden");
    expect(
      (
        await refusal(
          run(
            "approval.approve",
            { actionIds: waiting.map((w) => w.id) },
            staff({ actor: "assistant" }),
          ),
        )
      ).code,
    ).toBe("forbidden");
    expect(gw.applied.length).toBe(appliedBefore);
    await run("approval.approve", { actionIds: waiting.map((w) => w.id) }, staff());
    expect(gw.applied.length).toBe(appliedBefore + 2);
    for (const action of gw.applied.slice(-2)) await payments.providerRefunds(action);
    const done = await statusOf(buyer, id, day(20));
    expect(done.coolOff).toMatchObject({ state: "ended", refunds: "refunded", paid: 4450 });
    expect((await runRefundsDue(db, { integrations: runtime })).lapsed).toBe(0);
  });

  it("owes a period the provider took as it ended too, and staff are told once", async () => {
    const { buyer, id } = await member("late-period");
    await coolOff(buyer, id, day(5));
    await ended(id);
    // A renewal the provider charged as it ended arrives after the end.
    await deliver(
      "invoice_paid",
      read(id, { status: "canceled", endedAt: new Date().toISOString() }),
      invoice({ amountPaid: 3000 }),
    );
    expect((await owed(id)).map((r) => r.paid)).toEqual([3000, 3000]);
    const told = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE dedupe_key = ?",
    )
      .bind(`subscription.cooled_off:${id}`)
      .first<{ n: number }>();
    expect(told?.n).toBeGreaterThan(0);
  });
});

describe("who it covers", () => {
  it("is refused with the setting at 0, for a plan with no cooling off, and for a member moving over", async () => {
    await setDays(0);
    try {
      const { buyer, id } = await member("off");
      expect(await statusOf(buyer, id, day(1))).toMatchObject({ offered: false, why: "off" });
      expect((await refusal(coolOff(buyer, id, day(1)))).details).toMatchObject({ reason: "off" });
    } finally {
      await setDays(14);
    }
    const { buyer, id } = await member("course", course);
    expect(await statusOf(buyer, id, day(1))).toMatchObject({ offered: false, why: "not_covered" });

    // A member moving over takes their continuation offer: never cooled off (decision 17).
    const mover = await createBuyer(admin, "mover");
    const freeUntil = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
    const imported = await run<{ results: { offerId: string | null }[] }>(
      "subscription.offer.import",
      { plan: { object: PLAN, id: thirty }, rows: [{ email: mover.email, freeUntil }] },
      staff(),
    );
    const offerId = imported.results[0]?.offerId as string;
    const taken = await run<{ subscriptionId: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: thirty }, returnUrl: RETURN, offerId },
      as(mover),
    );
    await confirm(taken.subscriptionId, { status: "trialing" }, 0);
    await deliver("invoice_paid", read(taken.subscriptionId), invoice({ amountPaid: 3000 }));
    expect(await statusOf(mover, taken.subscriptionId, day(1))).toMatchObject({
      offered: false,
      why: "continuation",
    });
    expect((await refusal(coolOff(mover, taken.subscriptionId, day(1)))).details).toMatchObject({
      reason: "continuation",
    });
  });

  it("keeps the days in force at the start: shortening never shortens, lengthening lengthens", async () => {
    const early = await member("early"); // started at 14
    await setDays(0);
    try {
      const shortened = await statusOf(early.buyer, early.id, day(13));
      expect(shortened).toMatchObject({ offered: true, days: 14, until: "2026-10-12" });
      const late = await member("late"); // started with none
      expect(await statusOf(late.buyer, late.id, day(13))).toMatchObject({ why: "off" });
      await setDays(30);
      // The longer of the two for each member.
      expect(await statusOf(late.buyer, late.id, day(29))).toMatchObject({
        offered: true,
        days: 30,
      });
      expect(await statusOf(early.buyer, early.id, day(29))).toMatchObject({
        offered: true,
        days: 30,
      });
      const row = await env.DB.prepare(
        "SELECT cooling_off_days AS d FROM core_subscription_checkout WHERE id = ?",
      )
        .bind(late.id)
        .first<{ d: number }>();
      expect(row?.d).toBe(0);
    } finally {
      await setDays(14);
    }
  });

  it("in a free trial longer than the window: nothing to refund, so the ordinary cancel ends it", async () => {
    const { buyer, id } = await member("trial", trialLong, {
      paid: 0,
      overrides: { status: "trialing", trialEnd: "2026-10-28T00:00:00.000Z" },
    });
    expect(await statusOf(buyer, id, day(3))).toMatchObject({
      offered: false,
      why: "nothing_paid",
      refund: 0,
    });
    expect((await refusal(coolOff(buyer, id, day(3)))).details).toMatchObject({
      reason: "nothing_paid",
    });
    // The ordinary cancel ends it with its trial, at no charge.
    await run("subscription.cancel", { id }, as(buyer));
    expect(cancels(id).map((c) => c.request.when)).toEqual(["period_end"]);
  });

  it("after a short trial, refunds the first charge made inside the window", async () => {
    const { buyer, id } = await member("short-trial", trialShort, {
      paid: 0,
      overrides: { status: "trialing", trialEnd: "2026-10-01T00:00:00.000Z" },
    });
    expect((await statusOf(buyer, id, day(1))).why).toBe("nothing_paid");
    await deliver("invoice_paid", read(id), invoice({ amountPaid: 3000 }));
    expect(await statusOf(buyer, id, day(4))).toMatchObject({ offered: true, refund: 3000 });
    await coolOff(buyer, id, day(4));
    await ended(id);
    expect((await owed(id)).map((r) => r.paid)).toEqual([3000]);
  });

  it("while paused inside the window: offered, and the pause never moves the window", async () => {
    const { buyer, id } = await member("paused");
    await deliver("paused", read(id, { status: "paused" }));
    expect(await statusOf(buyer, id, day(10))).toMatchObject({
      offered: true,
      until: "2026-10-12",
    });
    expect((await statusOf(buyer, id, day(15))).why).toBe("window_passed");
    await coolOff(buyer, id, day(10));
    await ended(id);
    expect((await owed(id)).map((r) => r.paid)).toEqual([3000]);
  });

  it("is once per member: a second membership is refused, and the database refuses it too", async () => {
    const first = await member("twice");
    await coolOff(first.buyer, first.id, day(2));
    await ended(first.id);
    const again = await run<{ subscriptionId: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: thirty }, returnUrl: RETURN },
      as(first.buyer),
    );
    await confirm(again.subscriptionId);
    expect(await statusOf(first.buyer, again.subscriptionId, day(3))).toMatchObject({
      offered: false,
      why: "used",
    });
    const refused = await refusal(coolOff(first.buyer, again.subscriptionId, day(3)));
    expect(refused.details).toMatchObject({ reason: "used" });
    // The words name nobody.
    expect(refused.message).not.toContain(first.buyer.email);
    const holder = first.buyer.principal.personId;
    await expect(
      env.DB.prepare(
        "INSERT INTO core_subscription_cool_off (subscription_id, holder_person_id, asked_by, days, window_ends_at, state, asked_at, updated_at) VALUES (?, ?, 'payer', 14, ?, 'asked', ?, ?)",
      )
        .bind(again.subscriptionId, holder, ENDS_14, START, START)
        .run(),
    ).rejects.toThrow(/core_cool_off_used/);
  });
});

describe("who may", () => {
  it("the payer, a guardian paying for a child, staff with subscriptions:manage: never an AI, never someone else", async () => {
    // A parent pays for a child's membership (staff start it naming the holder).
    const parent = await createBuyer(admin, "parent");
    const child = await createBuyer(admin, "child");
    const started = await run<{ subscriptionId: string }>(
      "subscription.start",
      {
        plan: { object: PLAN, id: thirty },
        returnUrl: RETURN,
        email: parent.email,
        holderPersonId: child.principal.personId,
      },
      staff(),
    );
    const id = started.subscriptionId;
    await confirm(id);
    // The child holds it but does not pay: not theirs to end, and not found (names nobody).
    expect((await refusal(statusOf(child, id, day(1)))).code).toBe("not_found");
    expect((await refusal(coolOff(child, id, day(1)))).code).toBe("not_found");
    // Another member: not found either.
    const stranger = await createBuyer(admin, "stranger");
    expect((await refusal(coolOff(stranger, id, day(1)))).code).toBe("not_found");
    // Staff's assistant: refused, not queued.
    const viaAi = await refusal(
      run("subscription.coolOff", { id }, staff({ actor: "assistant", clock: day(1) })),
    );
    expect(viaAi.code).toBe("forbidden");
    const pending = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_pending_action WHERE operation = 'subscription.coolOff'",
    ).first<{ n: number }>();
    expect(pending?.n ?? 0).toBe(0);
    // A person on the staff without subscriptions:manage: refused.
    const plain = await createUser("member");
    expect(
      (
        await refusal(
          run(
            "subscription.coolOff",
            { id },
            context(plain, { integrations: runtime, events, clock: day(1) }),
          ),
        )
      ).code,
    ).toBe("forbidden");
    expect(cancels(id)).toHaveLength(0);
    // The parent, who pays: yes. The child's membership ends.
    expect(await coolOff(parent, id, day(1))).toMatchObject({ state: "asked", asked: "sent" });
    await ended(id);
    expect((await membershipOf(id))?.status).toBe("ended");
    expect((await owed(id)).map((r) => r.paid)).toEqual([3000]);
  });

  it("staff end a guest's for them", async () => {
    const email = `${unique("guest")}@buyers.example`.toLowerCase();
    const started = await run<{ subscriptionId: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: thirty }, returnUrl: RETURN, email },
      outside({ kind: "public" }, { integrations: runtime, events }),
    );
    const id = started.subscriptionId;
    await confirm(id);
    const out = await run<{ state: string; asked: string }>(
      "subscription.coolOff",
      { id },
      staff({ clock: day(6) }),
    );
    expect(out).toMatchObject({ state: "asked", asked: "sent" });
    const row = await env.DB.prepare(
      "SELECT asked_by, asked_by_user FROM core_subscription_cool_off WHERE subscription_id = ?",
    )
      .bind(id)
      .first<Record<string, unknown>>();
    expect(row).toEqual({ asked_by: "staff", asked_by_user: admin.id });
  });

  it("the setting is a person's: the assistant's change waits for one", async () => {
    expect(
      (
        await refusal(
          run(
            "extensionSettings.update",
            { extension: GYM, values: { coolingOffDays: 30 } },
            context(admin, { actor: "assistant" }),
          ),
        )
      ).code,
    ).toBe("pending_approval");
    // Out of its bounds: refused.
    expect(
      (
        await refusal(
          run(
            "extensionSettings.update",
            { extension: GYM, values: { coolingOffDays: 31 } },
            context(admin),
          ),
        )
      ).code,
    ).toBe("invalid_input");
  });
});

describe("the payment provider", () => {
  it("lost answer: asked, staff told, the member not told it ended; asked again it is sent once", async () => {
    const { buyer, id } = await member("lost");
    gw.nextCancel = "throw";
    expect(await coolOff(buyer, id, day(3))).toMatchObject({ state: "asked", asked: "unknown" });
    expect((await statusOf(buyer, id, day(3))).coolOff).toMatchObject({
      state: "asked",
      asked: "unknown",
    });
    expect(await subscriptionState(id)).toBe("active");
    const key = `subscription.cool_off:unknown:${id}:`;
    const told = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE substr(dedupe_key, 1, ?) = ?",
    )
      .bind(key.length, key)
      .first<{ n: number }>();
    expect(told?.n).toBeGreaterThan(0);
    // Asked again (after the window, even: it was asked inside it): sent.
    expect(await coolOff(buyer, id, day(20))).toMatchObject({ asked: "sent" });
    // Asked a third time: nothing more is asked of the provider.
    expect(await coolOff(buyer, id, day(20))).toMatchObject({ asked: "sent" });
    expect(cancels(id)).toHaveLength(2);
    await ended(id);
    expect((await coolOff(buyer, id, day(21))).state).toBe("ended");
    expect(cancels(id)).toHaveLength(2);
    expect((await owed(id)).map((r) => r.paid)).toEqual([3000]);
  });

  it("refused: nothing ended, nothing owed, staff told, asked again; refused as already ended, it counts", async () => {
    const { buyer, id } = await member("refused");
    gw.nextCancel = "refused";
    const refused = await refusal(coolOff(buyer, id, day(3)));
    expect(refused.details).toMatchObject({ rule: "provider_refused" });
    expect((await statusOf(buyer, id, day(3))).coolOff).toMatchObject({ state: "refused" });
    // A later end of another kind owes nothing for a refused cooling off.
    expect(await owed(id)).toEqual([]);
    // Asked again and taken.
    expect(await coolOff(buyer, id, day(4))).toMatchObject({ asked: "sent" });

    // Refused because the provider already ended it (a race): read, and counted as sent.
    const other = await member("raced");
    gw.nextCancel = "refused";
    gw.providerReads.set(`fsub_${other.id}`, {
      ...read(other.id, { status: "canceled" }),
    });
    expect(await coolOff(other.buyer, other.id, day(3))).toMatchObject({ asked: "sent" });
    await ended(other.id);
    expect((await owed(other.id)).map((r) => r.paid)).toEqual([3000]);
  });

  it("two asks at once ask the provider once", async () => {
    const { buyer, id } = await member("race");
    const both = await Promise.allSettled([coolOff(buyer, id, day(3)), coolOff(buyer, id, day(3))]);
    expect(both.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(cancels(id)).toHaveLength(1);
  });
});

describe("erase and merge", () => {
  it("an erased payer's refunds are still owed; nobody is made un-erasable or un-mergeable", async () => {
    const { buyer, id } = await member("erased");
    await coolOff(buyer, id, day(2));
    await ended(id);
    await run("person.erase", { id: buyer.principal.personId }, staff());
    const row = await env.DB.prepare(
      "SELECT holder_person_id FROM core_subscription_cool_off WHERE subscription_id = ?",
    )
      .bind(id)
      .first<{ holder_person_id: string | null }>();
    expect(row?.holder_person_id).toBeNull();
    expect((await owed(id)).map((r) => [r.paid, r.state])).toEqual([[3000, "due"]]);

    // Two people who each cooled off merge: the survivor holds both, and the merge goes through.
    const a = await member("merge-a");
    const b = await member("merge-b");
    await coolOff(a.buyer, a.id, day(2));
    await coolOff(b.buyer, b.id, day(2));
    await run("customer.disable", { id: b.buyer.principal.customerId }, staff());
    await run(
      "person.merge",
      { survivorId: a.buyer.principal.personId, mergedId: b.buyer.principal.personId },
      staff(),
    );
    const { results } = await env.DB.prepare(
      "SELECT holder_person_id AS h FROM core_subscription_cool_off WHERE subscription_id IN (?, ?)",
    )
      .bind(a.id, b.id)
      .all<{ h: string }>();
    expect(results.map((r) => r.h)).toEqual([
      a.buyer.principal.personId,
      a.buyer.principal.personId,
    ]);
  });
});

describe("cost (D1's 1,000 statements per invocation)", () => {
  it("asking and cooling off are a fixed handful of statements, whatever has been paid", async () => {
    let queries = 0;
    const metered = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(stmt, {
                get(s, p) {
                  if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
                  if (p === "all" || p === "run" || p === "first" || p === "raw") {
                    queries += 1;
                  }
                  const value = Reflect.get(s, p);
                  return typeof value === "function" ? value.bind(s) : value;
                },
              });
            return wrap(target.prepare(query));
          };
        }
        if (prop === "batch") {
          return (statements: D1PreparedStatement[]) => {
            queries += statements.length;
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const counted = createCrmDb(metered);
    const subs: { buyer: Buyer; id: string }[] = [];
    for (let i = 0; i < 3; i += 1) subs.push(await member(`cost-${i}`));
    // One with many paid periods (renewals the provider reported).
    const many = subs[0] as { buyer: Buyer; id: string };
    for (let i = 0; i < 12; i += 1) {
      await deliver("invoice_paid", read(many.id), invoice({ amountPaid: 100 + i }));
    }
    const ask = async (s: { buyer: Buyer; id: string }) => {
      queries = 0;
      await run(
        "subscription.coolingOff",
        { ids: [s.id] },
        { ...as(s.buyer, day(3)), db: counted },
      );
      return queries;
    };
    const one = await ask(subs[1] as { buyer: Buyer; id: string });
    expect(await ask(many)).toBe(one);
    expect(one).toBeLessThan(30);
    queries = 0;
    await run("subscription.coolOff", { id: many.id }, { ...as(many.buyer, day(3)), db: counted });
    expect(queries).toBeLessThan(40);
    // The event that ends it owes every paid period in one statement.
    queries = 0;
    await payments.deliver({
      kind: "subscription",
      provider: "fake",
      eventId: `fevt_${unique("s")}`,
      trigger: "deleted",
      subscription: read(many.id, { status: "canceled", endedAt: new Date().toISOString() }),
      occurredAt: new Date().toISOString(),
    });
    expect((await owed(many.id)).length).toBe(13);
  });
});
