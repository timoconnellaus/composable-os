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
  applyPendingPaymentEvents,
  applyStoredPaymentEvent,
  COOL_OFF_RELEASE_STEP,
  coolingOffWindow,
  memoryEventSink,
  newId,
  type PaymentsEvent,
  type ProviderInvoice,
  type ProviderSubscription,
  recordPaymentEvent,
  runCoolOffSweep,
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
          uses: { type: "number", label: "Uses" },
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
        customer: { field: "person", read: ["title", "status"], write: [] },
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
      // A class with places, and a visit to it that a membership pays for: Bookings' shape.
      klass: {
        label: "Class",
        plural: "Classes",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          startsAt: { type: "datetime", label: "Starts", required: true },
          places: { type: "number", label: "Places" },
        },
        capacity: { places: "places", show: "exact" },
      },
      visit: {
        label: "Visit",
        plural: "Visits",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          person: { type: "relation", label: "Person", to: "person" },
          klass: { type: "relation", label: "Class", to: `${id}.klass`, required: true },
          holder: { type: "text", label: "Paid by" },
          state: {
            type: "select",
            label: "State",
            options: ["booked", "attended", "cancelled", "cancelled_by_us"].map((value) => ({
              value,
              label: value,
            })),
          },
        },
        states: {
          field: "state",
          initial: "booked",
          moves: [
            { from: "booked", to: "attended", by: ["staff"] },
            { from: "booked", to: "cancelled", by: ["staff"], final: true },
            {
              from: ["booked", "attended"],
              to: "cancelled_by_us",
              by: ["host"],
              final: true,
            },
          ],
        },
        claims: { on: "klass", held: [], confirmed: ["booked", "attended"] },
        allowance: {
          spends: {
            person: "person",
            holder: "holder",
            spendIn: ["booked"],
            returnIn: ["cancelled", "cancelled_by_us"],
            at: "klass.startsAt",
            released: "cancelled_by_us",
          },
        },
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

/**
 * The provider's verified event, processed by the host at `clock` (by default a minute after
 * START, when the member joined): what is paid is paid then, for the cooling-off rule.
 */
function deliver(
  trigger: Extract<PaymentsEvent, { kind: "subscription" }>["trigger"],
  subscription: ProviderSubscription,
  inv?: ProviderInvoice,
  clock: () => Date = at(START, 60_000),
) {
  return payments.deliver(
    {
      kind: "subscription",
      provider: "fake",
      eventId: `fevt_${unique("s")}`,
      trigger,
      subscription,
      ...(inv ? { invoice: inv } : {}),
      occurredAt: clock().toISOString(),
    },
    clock,
  );
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
/**
 * The provider ends it (a verified read), by default a minute after the cooling off's last ask
 * (the provider ends it at once when asked), else now.
 */
async function ended(id: string, overrides: Partial<ProviderSubscription> = {}) {
  const asked = await env.DB.prepare(
    "SELECT last_asked_at FROM core_subscription_cool_off WHERE subscription_id = ?",
  )
    .bind(id)
    .first<{ last_asked_at: string }>();
  const when =
    overrides.endedAt ??
    (asked
      ? new Date(Date.parse(asked.last_asked_at) + 60_000).toISOString()
      : new Date().toISOString());
  return deliver(
    "deleted",
    read(id, { status: "canceled", canceledAt: when, endedAt: when, ...overrides }),
    undefined,
    at(when),
  );
}

/** A renewal paid for the period starting `n` months (of 30 days) after START. */
const renew = (id: string, n: number, amount = 3000) =>
  deliver(
    "invoice_paid",
    read(id),
    invoice({
      amountPaid: amount,
      amountDue: amount,
      periodStart: new Date(Date.parse(START) + n * 30 * DAY).toISOString(),
      periodEnd: new Date(Date.parse(START) + (n + 1) * 30 * DAY).toISOString(),
    }),
    // Paid on the day its period starts.
    at(START, n * 30 * DAY),
  );

async function coolOffRow(id: string) {
  return env.DB.prepare("SELECT * FROM core_subscription_cool_off WHERE subscription_id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

async function noticeCount(prefix: string) {
  return (
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM core_notifications WHERE substr(dedupe_key, 1, ?) = ?",
      )
        .bind(prefix.length, prefix)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

const sweep = (clock: () => Date) =>
  run<{ resolved: number; asked: number; told: number; unread: number }>(
    "subscription.coolOffSweep",
    {},
    context(admin, {
      actor: "automation",
      origin: { surface: "system", automationId: "system.orders" },
      integrations: runtime,
      events,
      clock,
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

  it("a payment reported after the end, paid after it, adds nothing; staff are told once", async () => {
    const { buyer, id } = await member("late-period");
    await coolOff(buyer, id, day(5));
    await ended(id);
    // An invoice the provider reports after the window, paid then (rule C owes only what was paid
    // in the window, or after the ask and on or before the end).
    await deliver(
      "invoice_paid",
      read(id, { status: "canceled", endedAt: at(START, 5 * DAY + 60_000)().toISOString() }),
      invoice({ amountPaid: 1234, amountDue: 1234 }),
      at(START, 20 * DAY),
    );
    expect((await owed(id)).map((r) => r.paid)).toEqual([3000]);
    expect(await noticeCount(`subscription.cool_off:cooled_off:${id}`)).toBeGreaterThan(0);
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

  it("keeps the days in force at the start, for good: a later change applies only to later starts", async () => {
    const early = await member("early"); // started at 14
    await setDays(0);
    try {
      const shortened = await statusOf(early.buyer, early.id, day(13));
      expect(shortened).toMatchObject({ offered: true, days: 14, until: "2026-10-12" });
      const late = await member("late"); // started with none
      expect(await statusOf(late.buyer, late.id, day(13))).toMatchObject({ why: "off" });
      await setDays(30);
      // A raise reopens nobody's window: each keeps the days it started with.
      expect(await statusOf(late.buyer, late.id, day(10))).toMatchObject({
        offered: false,
        why: "off",
        days: 0,
      });
      expect(await statusOf(early.buyer, early.id, day(20))).toMatchObject({
        offered: false,
        why: "window_passed",
        days: 14,
      });
      // A member who starts after the raise has 30.
      const later = await member("later");
      expect(await statusOf(later.buyer, later.id, day(29))).toMatchObject({
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
    // The database holds it too: a second row moved into `ended` for the same holder.
    const holder = first.buyer.principal.personId;
    await env.DB.prepare(
      "INSERT INTO core_subscription_cool_off (subscription_id, holder_person_id, asked_by, days, window_ends_at, state, asked_at, deadline_at, last_asked_at, updated_at) VALUES (?, ?, 'payer', 14, ?, 'asked', ?, ?, ?, ?)",
    )
      .bind(again.subscriptionId, holder, ENDS_14, START, START, START, START)
      .run();
    await expect(
      env.DB.prepare("UPDATE core_subscription_cool_off SET state = 'ended' WHERE subscription_id = ?")
        .bind(again.subscriptionId)
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

// ---- ADR 0647's rule (the coordinator's decision of 2026-11-24): one rule, every case ------------
// The window here ends at ENDS_14 (day 14.54). An ask on day 3 has its deadline on day 10; one on
// day 13, on day 20.

const DEADLINE_MS = 7 * DAY;
const VISIT = () => `${GYM}.visit`;
const KLASS = () => `${GYM}.klass`;
const visitState = async (visitId: string) =>
  (
    await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: VISIT(), id: visitId },
      context(admin),
    )
  ).values.state;
const hoursAhead = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
/** A payment of `amount` the provider takes at `when` (an invoice for a period starting then). */
const paidAt = (id: string, when: () => Date, amount: number) =>
  deliver(
    "invoice_paid",
    read(id),
    invoice({ amountPaid: amount, amountDue: amount, periodStart: when().toISOString() }),
    when,
  );
const sumOf = (rows: Record<string, unknown>[]) => rows.reduce((a, r) => a + Number(r.paid), 0);
const tick = (clock: () => Date) => runCoolOffSweep(db, { integrations: runtime, clock });
const staffStatus = async (id: string, clock: () => Date) =>
  (
    await run<{ items: (Status & { coolOff: Record<string, unknown> | null })[] }>(
      "subscription.coolingOff",
      { ids: [id] },
      staff({ clock }),
    )
  ).items[0];

describe("rule A: a valid ask is made inside the window, and fixes its deadline", () => {
  it("staff cannot start one after the window; asking again moves neither the ask nor the deadline", async () => {
    const late = await member("a-late");
    expect(
      (await refusal(run("subscription.coolOff", { id: late.id }, staff({ clock: day(20) }))))
        .details,
    ).toMatchObject({ reason: "window_passed" });
    const { buyer, id } = await member("a-fixed");
    gw.nextCancel = "refused";
    await refusal(coolOff(buyer, id, day(3)));
    const first = await coolOffRow(id);
    expect(first?.deadline_at).toBe(at(START, 3 * DAY + DEADLINE_MS)().toISOString());
    gw.nextCancel = "refused";
    await refusal(coolOff(buyer, id, day(5)));
    const second = await coolOffRow(id);
    expect([second?.asked_at, second?.deadline_at, second?.ask_count]).toEqual([
      first?.asked_at,
      first?.deadline_at,
      2,
    ]);
    // Staff ask again after the window and before the deadline; not after it.
    const lateAsk = await member("a-staff");
    gw.nextCancel = "refused";
    await refusal(coolOff(lateAsk.buyer, lateAsk.id, day(13)));
    gw.nextCancel = "refused";
    expect(
      (await refusal(run("subscription.coolOff", { id: lateAsk.id }, staff({ clock: day(18) }))))
        .details,
    ).toMatchObject({ rule: "provider_refused" });
    expect(
      (await refusal(run("subscription.coolOff", { id: lateAsk.id }, staff({ clock: day(21) }))))
        .details,
    ).toMatchObject({ reason: "deadline_passed" });
  });
});

describe("rule B: while open and before its deadline, any end is the cooling off's", () => {
  it("an end for failed payments, while the ask waits at the gatekeeper, is the cooling off's; rule C owes the window's and those after the ask", async () => {
    const { buyer, id } = await member("b-any");
    gw.nextCancel = "pending";
    expect(await coolOff(buyer, id, day(13))).toMatchObject({ asked: "pending" });
    await paidAt(id, day(12), 500); // in the window, before the ask
    await paidAt(id, day(17), 1500); // after the window, after the ask, before the end
    expect((await statusOf(buyer, id, day(17.5))).refund).toBe(5000);
    await ended(id, { endedAt: day(18)().toISOString(), endReason: "payment_failed" });
    expect((await coolOffRow(id))?.state).toBe("ended");
    expect(sumOf(await owed(id))).toBe(5000);
    // Paid after the end: neither owed nor in the figure shown.
    await paidAt(id, day(19), 700);
    expect(sumOf(await owed(id))).toBe(5000);
    expect((await statusOf(buyer, id, day(19))).coolOff).toMatchObject({ state: "ended", paid: 5000 });
  });

  it("the bounds: an end the tolerance before the ask is; one a second earlier is not; one after the deadline is not", async () => {
    const tolerance = 5 * 60_000;
    const just = await member("b-tol");
    gw.nextCancel = "throw";
    await coolOff(just.buyer, just.id, day(3));
    await ended(just.id, { endedAt: at(day(3)().toISOString(), -tolerance + 1000)().toISOString() });
    expect((await coolOffRow(just.id))?.state).toBe("ended");
    const before = await member("b-before");
    gw.nextCancel = "throw";
    await coolOff(before.buyer, before.id, day(3));
    await ended(before.id, {
      endedAt: at(day(3)().toISOString(), -tolerance - 1000)().toISOString(),
    });
    expect(await coolOffRow(before.id)).toMatchObject({ state: "lapsed", lapsed_because: "end_time" });
    expect(await owed(before.id)).toEqual([]);
    const after = await member("b-after");
    gw.nextCancel = "pending";
    await coolOff(after.buyer, after.id, day(3));
    for (let n = 1; n <= 5; n += 1) await renew(after.id, n);
    await ended(after.id, {
      endedAt: at(START, 150 * DAY)().toISOString(),
      endReason: "cancellation_requested",
    });
    expect(await coolOffRow(after.id)).toMatchObject({ state: "lapsed", lapsed_because: "end_time" });
    expect(await owed(after.id)).toEqual([]);
  });

  it("a lost answer the provider took: the late end, before a later ask, is the cooling off's", async () => {
    const { buyer, id } = await member("b-lost");
    gw.nextCancel = "throw";
    await coolOff(buyer, id, day(3));
    gw.providerReads.set(`fsub_${id}`, { ...read(id, { status: "canceled" }) });
    expect(await coolOff(buyer, id, at(START, 3 * DAY + 10 * 60_000))).toMatchObject({
      asked: "sent",
    });
    expect(cancels(id)).toHaveLength(1);
    await ended(id, { endedAt: at(START, 3 * DAY + 30_000)().toISOString() });
    expect((await coolOffRow(id))?.state).toBe("ended");
    expect(sumOf(await owed(id))).toBe(3000);
  });
});

describe("rule C: what is owed, one formula, and the figure shown is the same", () => {
  it("a payment inside the window for a later period, an order staff partly refunded: exact amounts", async () => {
    const { buyer, id } = await member("c-figure");
    await paidAt(id, day(5), 1000);
    const order = await env.DB.prepare(
      "SELECT id FROM core_order WHERE subscription_id = ? AND paid = 3000",
    )
      .bind(id)
      .first<{ id: string }>();
    const asked = await run<{ refunds: { pendingActionId: string | null }[] }>(
      "order.refund",
      { id: order?.id, amount: 1000, reason: "A class we cancelled" },
      staff(),
    );
    await run("approval.approve", { actionIds: asked.refunds.map((r) => r.pendingActionId) }, staff());
    await payments.providerRefunds(gw.action);
    expect((await statusOf(buyer, id, day(6))).refund).toBe(3000);
    expect(await coolOff(buyer, id, day(6))).toMatchObject({ refund: 3000 });
    await ended(id);
    expect((await owed(id)).map((r) => [r.paid, r.refunded])).toEqual([
      [3000, 1000],
      [1000, 0],
    ]);
    await runRefundsDue(db, { integrations: runtime });
    const asks = [...gw.refunds.values()].filter((r) => r.orderId === order?.id).map((r) => r.amount);
    expect(asks).toEqual([1000, 2000]);
  });
});

describe("rule D: at its deadline an open one lapses, and the ordinary cancel works again", () => {
  it("the sweep lapses it, rejects its waiting cancel, tells admins once; a later end stays lapsed", async () => {
    const { buyer, id } = await member("d-deadline");
    gw.nextCancel = "pending";
    await coolOff(buyer, id, day(3));
    const row = await coolOffRow(id);
    expect(row?.pending_action_id).toMatch(/^pac_/);
    // Open: the ordinary cancel waits.
    expect((await refusal(run("subscription.cancel", { id }, as(buyer, day(5))))).details).toMatchObject({
      rule: "cooling_off_open",
    });
    gw.providerReads.set(`fsub_${id}`, { ...read(id) });
    await tick(at(START, 3 * DAY + DEADLINE_MS + 60_000));
    expect(await coolOffRow(id)).toMatchObject({ state: "lapsed", lapsed_because: "deadline" });
    const action = await env.DB.prepare("SELECT status FROM core_pending_action WHERE id = ?")
      .bind(row?.pending_action_id)
      .first<{ status: string }>();
    expect(action?.status).toBe("rejected");
    expect(await noticeCount(`subscription.cool_off:lapsed:${id}`)).toBeGreaterThan(0);
    // The ordinary cancel and staff's end-now work again.
    await run("subscription.cancel", { id }, as(buyer, day(11)));
    await run("subscription.cancel", { id, now: true, reason: "Asked" }, staff({ clock: day(11) }));
    await ended(id, { endedAt: day(11)().toISOString() });
    expect((await coolOffRow(id))?.state).toBe("lapsed");
    expect(await owed(id)).toEqual([]);
  });

  it("ended at the provider before the deadline but not yet heard: not lapsed; its event is the cooling off's", async () => {
    const { buyer, id } = await member("d-late-event");
    gw.nextCancel = "throw";
    await coolOff(buyer, id, day(3));
    gw.providerReads.set(`fsub_${id}`, { ...read(id, { status: "canceled" }) });
    await tick(at(START, 3 * DAY + DEADLINE_MS + 60_000));
    expect((await coolOffRow(id))?.state).toBe("asked");
    await ended(id, { endedAt: day(9)().toISOString() });
    expect((await coolOffRow(id))?.state).toBe("ended");
  });

  it("its waiting cancel turned down by a person: it lapses at once", async () => {
    const { buyer, id } = await member("d-action");
    gw.nextCancel = "pending";
    await coolOff(buyer, id, day(3));
    const actionId = (await coolOffRow(id))?.pending_action_id as string;
    await run("approval.reject", { actionIds: [actionId], reason: "Not now" }, staff());
    gw.providerReads.set(`fsub_${id}`, { ...read(id) });
    await tick(day(4));
    expect(await coolOffRow(id)).toMatchObject({ state: "lapsed", lapsed_because: "action" });
  });
});

describe("rule E: staff finish a lapsed one", () => {
  it("it ends the membership, owes the window's payments only, releases the bookings, sends the summary; later events add nothing", async () => {
    const { buyer, id } = await member("e-finish");
    const k = await create(KLASS(), { name: "Ahead", startsAt: hoursAhead(72), places: 5 });
    const v = await create(VISIT(), {
      name: "Booked",
      person: buyer.principal.personId,
      klass: k,
      state: "booked",
    });
    gw.nextCancel = "pending";
    await coolOff(buyer, id, day(3));
    await paidAt(id, day(20), 2000); // after the window: never owed by a finish
    gw.providerReads.set(`fsub_${id}`, { ...read(id) });
    await tick(at(START, 3 * DAY + DEADLINE_MS + 60_000));
    expect((await coolOffRow(id))?.state).toBe("lapsed");
    // The member's exit: the ordinary cancel; staff's: finish it.
    expect((await staffStatus(id, day(21)))?.coolOff).toMatchObject({ askAgain: true });
    expect(await run("subscription.coolOff", { id }, staff({ clock: day(21) }))).toMatchObject({
      state: "ended",
      refund: 3000,
    });
    expect(cancels(id).at(-1)?.request).toMatchObject({ when: "now", askKey: "cool-off-finish" });
    expect(await coolOffRow(id)).toMatchObject({ state: "ended", finished: 1, release_left: 1 });
    expect(sumOf(await owed(id))).toBe(3000);
    await tick(day(21.01));
    expect(await visitState(v)).toBe("cancelled_by_us");
    // Its end arrives, then a payment the provider reports later: nothing more is owed.
    await ended(id, { endedAt: day(21.02)().toISOString() });
    await paidAt(id, day(21.5), 1234);
    expect(sumOf(await owed(id))).toBe(3000);
  });
});

describe("rule F: once per member, and nothing here fails an end", () => {
  it("two memberships: A asked and refused, B cooled off; A then ends inside its deadline: the end is recorded, A lapses as not counted", async () => {
    const a = await member("f-two");
    const second = await run<{ subscriptionId: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: sixty }, returnUrl: RETURN },
      as(a.buyer),
    );
    await confirm(second.subscriptionId, { amount: 6000 }, 6000);
    const b = second.subscriptionId;
    gw.nextCancel = "refused";
    await refusal(coolOff(a.buyer, a.id, day(2)));
    expect(await coolOff(a.buyer, b, day(3))).toMatchObject({ asked: "sent" });
    await ended(b, { endedAt: at(START, 3 * DAY + 60_000)().toISOString() });
    expect((await coolOffRow(b))?.state).toBe("ended");
    await ended(a.id, { endedAt: day(5)().toISOString(), endReason: "payment_failed" });
    expect(await subscriptionState(a.id)).toBe("ended");
    expect((await membershipOf(a.id))?.status).toBe("ended");
    expect(await coolOffRow(a.id)).toMatchObject({ state: "lapsed", lapsed_because: "used" });
    expect(await owed(a.id)).toEqual([]);
    expect(await noticeCount(`subscription.cool_off:used:${a.id}`)).toBeGreaterThan(0);
    const unapplied = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_payment_event WHERE applied_at IS NULL",
    ).first<{ n: number }>();
    expect(unapplied?.n ?? 0).toBe(0);
    // Finishing the lapsed A is refused: B counted.
    expect(
      (await refusal(run("subscription.coolOff", { id: a.id }, staff({ clock: day(6) })))).details,
    ).toMatchObject({ reason: "used" });
  });

  it("a lapsed one does not count: the member cools off another; finished, it counts", async () => {
    const a = await member("f-lapsed");
    gw.nextCancel = "pending";
    await coolOff(a.buyer, a.id, day(3));
    gw.providerReads.set(`fsub_${a.id}`, { ...read(a.id) });
    await tick(at(START, 3 * DAY + DEADLINE_MS + 60_000));
    expect((await coolOffRow(a.id))?.state).toBe("lapsed");
    await run("subscription.coolOff", { id: a.id }, staff({ clock: day(11) }));
    const next = await run<{ subscriptionId: string }>(
      "subscription.start",
      { plan: { object: PLAN, id: thirty }, returnUrl: RETURN },
      as(a.buyer),
    );
    await confirm(next.subscriptionId);
    expect((await refusal(coolOff(a.buyer, next.subscriptionId, day(4)))).details).toMatchObject({
      reason: "used",
    });
  });
});

describe("rule G: every state has an exit", () => {
  it("open after the window: the member waits (no ask, no cancel) until the deadline, then cancels as usual", async () => {
    const { buyer, id } = await member("g-wait");
    gw.nextCancel = "throw";
    await coolOff(buyer, id, day(13));
    gw.providerReads.set(`fsub_${id}`, { ...read(id) });
    expect((await refusal(coolOff(buyer, id, day(16)))).details).toMatchObject({
      reason: "window_passed",
    });
    expect((await refusal(run("subscription.cancel", { id }, as(buyer, day(16))))).details).toMatchObject({
      rule: "cooling_off_open",
    });
    const status = await statusOf(buyer, id, day(16));
    expect(status.coolOff).toMatchObject({ open: true, askAgain: false });
    await tick(at(START, 13 * DAY + DEADLINE_MS + 60_000));
    expect((await coolOffRow(id))?.state).toBe("lapsed");
    await run("subscription.cancel", { id }, as(buyer, day(21)));
    expect(cancels(id).at(-1)?.request).toMatchObject({ when: "period_end" });
  });

  it("open inside the window after a refusal: the member asks again, a new request", async () => {
    const { buyer, id } = await member("g-again");
    gw.nextCancel = "refused";
    await refusal(coolOff(buyer, id, day(3)));
    expect((await statusOf(buyer, id, day(3))).coolOff).toMatchObject({ askAgain: true, open: true });
    expect(await coolOff(buyer, id, day(4))).toMatchObject({ asked: "sent" });
    expect(cancels(id).map((c) => c.request.askKey)).toEqual(["cool-off-1", "cool-off-2"]);
  });
});

describe("the third review's probes, as tests with exact amounts", () => {
  for (const [label, how, reason] of [
    ["P1", "pending", "cancellation_requested"],
    ["P1b", "pending", null],
    ["P1c", "retryable", "cancellation_requested"],
  ] as const) {
    it(`${label}: asked on day 3 (${how}), five renewals, an end on day 150: owes nothing; the cancel works after the deadline`, async () => {
      const { buyer, id } = await member(`p1-${label}`);
      gw.nextCancel = how;
      await coolOff(buyer, id, day(3));
      expect((await refusal(run("subscription.cancel", { id }, as(buyer, day(5))))).details).toMatchObject({
        rule: "cooling_off_open",
      });
      for (let n = 1; n <= 5; n += 1) await renew(id, n);
      gw.providerReads.set(`fsub_${id}`, { ...read(id) });
      await tick(day(11));
      expect((await coolOffRow(id))?.state).toBe("lapsed");
      await run("subscription.cancel", { id }, as(buyer, day(12)));
      await ended(id, { endedAt: at(START, 150 * DAY)().toISOString(), endReason: reason });
      expect((await coolOffRow(id))?.state).toBe("lapsed");
      expect(sumOf(await owed(id))).toBe(0);
    });
  }

  it("P2: refused on day 2; an end for failed payments on day 8 is the cooling off's (3000), one on day 13 is not (0)", async () => {
    const inside = await member("p2-in");
    gw.nextCancel = "refused";
    await refusal(coolOff(inside.buyer, inside.id, day(2)));
    await ended(inside.id, { endedAt: day(8)().toISOString(), endReason: "payment_failed" });
    expect((await coolOffRow(inside.id))?.state).toBe("ended");
    expect(sumOf(await owed(inside.id))).toBe(3000);
    const after = await member("p2-after");
    gw.nextCancel = "refused";
    await refusal(coolOff(after.buyer, after.id, day(2)));
    await ended(after.id, { endedAt: day(13)().toISOString(), endReason: "payment_failed" });
    expect(await coolOffRow(after.id)).toMatchObject({ state: "lapsed", lapsed_because: "end_time" });
    expect(sumOf(await owed(after.id))).toBe(0);
  });

  it("P3/P7: a finished one's summary is due once its releases are done; a payment after the window adds nothing (3000)", async () => {
    const { buyer, id } = await member("p3");
    gw.nextCancel = "pending";
    await coolOff(buyer, id, day(3));
    gw.providerReads.set(`fsub_${id}`, { ...read(id) });
    await tick(day(11));
    await run("subscription.coolOff", { id }, staff({ clock: day(12) }));
    expect(await coolOffRow(id)).toMatchObject({
      state: "ended",
      finished: 1,
      mail_state: "due",
      release_left: 1,
      owed_from: null,
    });
    await paidAt(id, day(30), 3000);
    await ended(id, { endedAt: day(30)().toISOString() });
    expect(sumOf(await owed(id))).toBe(3000);
  });
});

describe("the provider and the sweep", () => {
  it("a crash between the commit and the call: the sweep reads the provider and asks again, once, with the same ask's key", async () => {
    const { buyer, id } = await member("crash");
    const asked = day(3)().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_subscription_cool_off (subscription_id, holder_person_id, asked_by, days, window_ends_at, state, asked_at, deadline_at, last_asked_at, updated_at) VALUES (?, ?, 'payer', 14, ?, 'asked', ?, ?, ?, ?)",
    )
      .bind(id, buyer.principal.personId, ENDS_14, asked, at(asked, DEADLINE_MS)().toISOString(), asked, asked)
      .run();
    expect((await statusOf(buyer, id, day(3))).coolOff).toMatchObject({
      asked: null,
      staffTold: false,
      askAgain: true,
      open: true,
    });
    expect(await sweep(at(asked, 60_000))).toMatchObject({ asked: 0 });
    gw.providerReads.set(`fsub_${id}`, { ...read(id) });
    expect(await sweep(at(asked, 10 * 60_000))).toMatchObject({ asked: 1 });
    expect(await sweep(at(asked, 11 * 60_000))).toMatchObject({ asked: 0 });
    expect(cancels(id).map((c) => c.request.askKey)).toEqual(["cool-off-1"]);
  });

  it("a retryable failure is pending, never refused; two asks again at once share one key", async () => {
    const r = await member("retryable");
    gw.nextCancel = "retryable";
    expect(await coolOff(r.buyer, r.id, day(3))).toMatchObject({ asked: "pending" });
    const { buyer, id } = await member("p5");
    gw.nextCancel = "refused";
    await refusal(coolOff(buyer, id, day(2)));
    gw.nextCancel = "refused";
    await Promise.allSettled([coolOff(buyer, id, day(3)), coolOff(buyer, id, day(3))]);
    const keys = cancels(id).map((c) => c.request.askKey);
    expect(new Set(keys.slice(1))).toEqual(new Set(["cool-off-2"]));
  });

  it("the ordinary cancel is refused while open; INSERT OR REPLACE is refused; an idle minute writes no audit row", async () => {
    const { buyer, id } = await member("misc");
    await coolOff(buyer, id, day(2));
    await ended(id);
    await expect(
      env.DB.prepare(
        "INSERT OR REPLACE INTO core_subscription_cool_off (subscription_id, holder_person_id, asked_by, days, window_ends_at, state, asked_at, deadline_at, last_asked_at, updated_at) VALUES (?, ?, 'payer', 14, ?, 'asked', 'x', 'x', 'x', 'x')",
      )
        .bind(id, buyer.principal.personId, ENDS_14)
        .run(),
    ).rejects.toThrow(/core_cool_off_exists/);
    const count = async () =>
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM core_audit WHERE operation IN ('subscription.coolOffSweep', 'subscription.coolOffRelease')",
        ).first<{ n: number }>()
      )?.n ?? 0;
    await env.DB.prepare(
      "UPDATE core_subscription_cool_off SET mail_state = NULL, release_left = 0",
    ).run();
    await env.DB.prepare(
      "UPDATE core_subscription_cool_off SET state = 'lapsed', lapsed_because = 'deadline' WHERE state = 'asked'",
    ).run();
    const before = await count();
    expect(await tick(at(START, 400 * DAY))).toMatchObject({ releases: 0 });
    expect(await count()).toBe(before);
  });
});

describe("bookings ahead and the summary email", () => {
  const mailChannel = async () => {
    const connection = newId("connection");
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'email-send', 'org', ?, 'Mail', 'active', ?, ?, ?)",
    )
      .bind(
        connection,
        admin.id,
        JSON.stringify([
          {
            key: "k1",
            url: "email-send://sender/crm%40example.com",
            pattern: "email-send://sender/:address",
            title: "Mail",
            tsType: "X",
            bindingName: "X",
          },
        ]),
        now,
        now,
      )
      .run();
    await run("notification.updateDeliverySettings", { email: connection }, staff());
  };
  const summaries = (email: string) =>
    gw.emails.filter((e) => e.to.includes(email) && e.subject.includes("cooling-off"));

  it("released by the step after the end (never its batch), ordered, until none is left; others kept; one email", async () => {
    await mailChannel();
    try {
      const { buyer, id } = await member("release");
      const person = buyer.principal.personId;
      // Another membership of theirs pays for one; one class has started; one is ticked.
      const second = await run<{ subscriptionId: string }>(
        "subscription.start",
        { plan: { object: PLAN, id: sixty }, returnUrl: RETURN },
        as(buyer),
      );
      await confirm(second.subscriptionId, { amount: 6000 }, 6000);
      const otherGrant = await env.DB.prepare(
        "SELECT record_id FROM core_subscription_grant WHERE subscription_id = ?",
      )
        .bind(second.subscriptionId)
        .first<{ record_id: string }>();
      const cooledGrant = await env.DB.prepare(
        "SELECT record_id FROM core_subscription_grant WHERE subscription_id = ?",
      )
        .bind(id)
        .first<{ record_id: string }>();
      const ids: string[] = [];
      for (let i = 0; i < 61; i += 1) {
        const k = await create(KLASS(), { name: `K${i}`, startsAt: hoursAhead(48 + i), places: 5 });
        ids.push(
          await create(VISIT(), {
            name: `V${i}`,
            person,
            klass: k,
            holder: cooledGrant?.record_id,
            state: "booked",
          }),
        );
      }
      const later = await create(KLASS(), { name: "Other", startsAt: hoursAhead(30), places: 5 });
      const byOther = await create(VISIT(), {
        name: "Other",
        person,
        klass: later,
        holder: otherGrant?.record_id,
        state: "booked",
      });
      const ticked = await create(VISIT(), {
        name: "Ticked",
        person,
        klass: later,
        holder: cooledGrant?.record_id,
        state: "booked",
      });
      await run(
        "record.update",
        { object: VISIT(), id: ticked, values: { state: "attended" } },
        context(admin),
      );
      await coolOff(buyer, id, day(2));
      await ended(id);
      const released = async () =>
        (await Promise.all(ids.map(visitState))).filter((s) => s === "cancelled_by_us").length;
      // The end's batch released nothing (rule F): the steps do.
      expect(await released()).toBe(0);
      expect(summaries(buyer.email)).toHaveLength(0);
      await tick(day(2.01));
      expect(await released()).toBe(30);
      // The earliest first.
      expect(await visitState(ids[0] as string)).toBe("cancelled_by_us");
      expect(await visitState(ids[60] as string)).toBe("booked");
      await tick(day(2.02));
      await tick(day(2.03));
      expect(await released()).toBe(61);
      // A step that finds only what cannot be released ends (the ticked one keeps its use).
      expect(await coolOffRow(id)).toMatchObject({ release_left: 0, released_count: 61 });
      expect(await visitState(byOther)).toBe("booked");
      expect(await visitState(ticked)).toBe("attended");
      // Two minutes at once: the claim before the send lets one of them send it.
      await Promise.all([tick(day(2.04)), tick(day(2.04))]);
      expect(summaries(buyer.email)).toHaveLength(1);
      expect(summaries(buyer.email)[0]?.text).toContain("61 bookings for classes ahead");
      expect(await coolOffRow(id)).toMatchObject({ mail_state: "sent" });
      await tick(day(2.05));
      expect(summaries(buyer.email)).toHaveLength(1);
    } finally {
      await run("notification.updateDeliverySettings", { email: null }, staff());
    }
  });

  it("the email: claimed before it is sent; one stuck after its claim is tried once more with its key; one that cannot go is failed and told", async () => {
    await mailChannel();
    try {
      const { buyer, id } = await member("mail-stuck");
      await coolOff(buyer, id, day(2));
      await ended(id);
      // A crash after the claim: left `sending`.
      await env.DB.prepare(
        "UPDATE core_subscription_cool_off SET mail_state = 'sending', mail_claimed_at = ?, mail_tries = 1 WHERE subscription_id = ?",
      )
        .bind(day(2.01)().toISOString(), id)
        .run();
      await tick(day(2.01)); // the release step: nothing ahead
      await tick(day(2.012)); // too soon
      expect(summaries(buyer.email)).toHaveLength(0);
      await tick(at(day(2.01)().toISOString(), 11 * 60_000));
      expect(summaries(buyer.email)).toHaveLength(1);
      expect(await coolOffRow(id)).toMatchObject({ mail_state: "sent", mail_tries: 2 });
      // Stuck again after its second try: failed, and admins told.
      await env.DB.prepare(
        "UPDATE core_subscription_cool_off SET mail_state = 'sending', mail_claimed_at = ? WHERE subscription_id = ?",
      )
        .bind(day(2.1)().toISOString(), id)
        .run();
      await tick(at(day(2.1)().toISOString(), 11 * 60_000));
      expect(await coolOffRow(id)).toMatchObject({ mail_state: "failed" });
      expect(await noticeCount(`subscription.cool_off:mail:${id}`)).toBeGreaterThan(0);
    } finally {
      await run("notification.updateDeliverySettings", { email: null }, staff());
    }
  });

  it("the email: one held for approval is pending, not sent; one whose send throws is tried once more with the same key", async () => {
    await mailChannel();
    try {
      const held = await member("mail-held");
      await coolOff(held.buyer, held.id, day(2));
      await ended(held.id);
      gw.nextEmail = "pending";
      await tick(day(2.01));
      expect(await coolOffRow(held.id)).toMatchObject({ mail_state: "pending" });
      await tick(day(2.5));
      expect(summaries(held.buyer.email)).toHaveLength(0);
      const thrown = await member("mail-throw");
      await coolOff(thrown.buyer, thrown.id, day(2));
      await ended(thrown.id);
      gw.nextEmail = "throw";
      await tick(day(2.01));
      expect(await coolOffRow(thrown.id)).toMatchObject({ mail_state: "sending", mail_tries: 1 });
      await tick(at(day(2.01)().toISOString(), 11 * 60_000));
      const sent = summaries(thrown.buyer.email);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.idempotencyKey).toMatch(/^cool-off-summary:/);
      expect(await coolOffRow(thrown.id)).toMatchObject({ mail_state: "sent", mail_tries: 2 });
    } finally {
      await run("notification.updateDeliverySettings", { email: null }, staff());
    }
  });

  it("a batch that fails is applied again: the end and the refunds owed are recorded; payment events failing tell admins once and keep being tried", async () => {
    const { buyer, id } = await member("failing");
    await coolOff(buyer, id, day(2));
    await env.DB.prepare(
      "CREATE TRIGGER zz_fail_end BEFORE UPDATE OF state ON core_subscription WHEN NEW.state = 'ended' BEGIN SELECT RAISE(ABORT, 'zz_fail_end'); END",
    ).run();
    await ended(id).catch(() => undefined);
    expect(await subscriptionState(id)).not.toBe("ended");
    for (let i = 0; i < 6; i += 1) {
      await applyPendingPaymentEvents({ crm: db, integrations: runtime, clock: day(2 + i * 0.001) });
    }
    expect(
      await noticeCount("payment-event.failing:"),
    ).toBeGreaterThan(0);
    const stuck = await env.DB.prepare(
      "SELECT attempts FROM core_payment_event WHERE applied_at IS NULL ORDER BY attempts DESC LIMIT 1",
    ).first<{ attempts: number }>();
    // Five tries in a row, then it backs off (an hour from its arrival).
    expect(stuck?.attempts).toBe(5);
    await env.DB.prepare("DROP TRIGGER zz_fail_end").run();
    await applyPendingPaymentEvents({ crm: db, integrations: runtime, clock: day(30) });
    expect(await subscriptionState(id)).toBe("ended");
    expect((await coolOffRow(id))?.state).toBe("ended");
    expect(sumOf(await owed(id))).toBe(3000);
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
    const coolOffQueries = queries;
    // The event that ends it: every paid period owed in one statement, whatever their number.
    const endAt = new Date(Date.parse(day(3)().toISOString()) + 60_000).toISOString();
    const key = await recordPaymentEvent(
      db,
      {
        kind: "subscription",
        provider: "fake",
        eventId: `fevt_${unique("s")}`,
        trigger: "deleted",
        subscription: read(many.id, { status: "canceled", endedAt: endAt, canceledAt: endAt }),
        occurredAt: new Date().toISOString(),
      },
      payments.connectionId(),
      new Date().toISOString(),
    );
    queries = 0;
    await applyStoredPaymentEvent(
      {
        crm: counted,
        integrations: runtime,
        events,
        appOrigin: "https://crm.example.com",
        clock: at(endAt),
      },
      key as NonNullable<typeof key>,
    );
    const endQueries = queries;
    expect((await owed(many.id)).length).toBe(13);
    expect(endQueries).toBeLessThan(80);
    // Reported in the PR: the statements each costs.
    console.log("cooling off statements", {
      status: one,
      coolOff: coolOffQueries,
      end: endQueries,
    });
  });

  it("releasing bookings ahead stays under the limit at the most it releases in one batch", async () => {
    let queries = 0;
    const metered = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(stmt, {
                get(s, p) {
                  if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
                  if (p === "all" || p === "run" || p === "first" || p === "raw") queries += 1;
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
    /** The statements the provider's end costs for a cooled-off member with `n` bookings ahead. */
    const endWith = async (n: number) => {
      const { buyer, id } = await member(`release-${n}`);
      for (let i = 0; i < n; i += 1) {
        const klass = await create(`${GYM}.klass`, {
          name: `Ahead ${i}`,
          startsAt: new Date(Date.now() + (3 + i) * DAY).toISOString(),
          places: 5,
        });
        await create(`${GYM}.visit`, {
          name: `Booked ${i}`,
          person: buyer.principal.personId,
          klass,
          state: "booked",
        });
      }
      await coolOff(buyer, id, day(2));
      const endAt = new Date(Date.parse(day(2)().toISOString()) + 60_000).toISOString();
      const key = await recordPaymentEvent(
        db,
        {
          kind: "subscription",
          provider: "fake",
          eventId: `fevt_${unique("s")}`,
          trigger: "deleted",
          subscription: read(id, { status: "canceled", endedAt: endAt, canceledAt: endAt }),
          occurredAt: new Date().toISOString(),
        },
        payments.connectionId(),
        new Date().toISOString(),
      );
      queries = 0;
      await applyStoredPaymentEvent(
        {
          crm: counted,
          integrations: runtime,
          events,
          appOrigin: "https://crm.example.com",
          clock: at(endAt),
        },
        key as NonNullable<typeof key>,
      );
      const end = queries;
      // The release step the minute cron runs next (its own batch), and the sweep after it.
      queries = 0;
      await runCoolOffSweep(counted, { integrations: runtime, clock: at(endAt, 60_000) });
      return { end, step: queries };
    };
    const none = await endWith(0);
    const three = await endWith(3);
    const each = Math.ceil((three.step - none.step) / 3);
    console.log("cooling off release statements", { none, three, each });
    // The end's batch releases nothing, whatever is booked ahead (rule F).
    expect(three.end).toBe(none.end);
    expect(none.step + each * COOL_OFF_RELEASE_STEP).toBeLessThan(1000);
  });
});
