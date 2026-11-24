// Stage 32b step 6, in the host, with a fixture extension shaped like the Memberships pack: a plan
// whose subscription grants a membership (`sellable.recurring.grants`, ADR 0510), a pass type that
// grants a pass with an expiry (`grants.valid`, ADR 0511) and may be an intro offer, one per
// Person (`sellable.onePerPerson`, ADR 0512), a visit that spends; the payer and the holder
// (ADR 0487, stage 32b), and a tool only a person may call (`humanOnly`).
//
// What is checked: the membership is granted by the first verified event that reports the
// subscription running, in its batch, once; its state and its `until` follow every later read
// (past due for at most 30 days, set to end at the period's end, paused, ended and final); it is a
// holder the visit spends from, and nothing once it ended; staff start one paid by one Person and
// held by another, a customer cannot; a pass bought is valid from now for its days, a full refund
// voids it and the use spent stays spent; the intro offer is refused to a guest, held from the
// order's start, used when paid, released when it expires, refused a second time, one of two
// orders at once, and followed through a merge; a bad declaration is refused by the contract.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { type ExtensionManifest, validateManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  grantUntil,
  memoryEventSink,
  type PaymentsEvent,
  type ProviderSubscription,
  toolOperation,
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

/**
 * `db` over D1, noting each statement's bound values in `bound` (the local runtime enforces
 * neither 1,000 statements per invocation nor 100 bound values per statement).
 */
function countingDb(d1: D1Database, bound: number[]) {
  const counted = new Proxy(d1, {
    get(target, key) {
      if (key === "prepare") {
        return (query: string) =>
          new Proxy(target.prepare(query), {
            get(inner, name) {
              if (name === "bind") {
                return (...values: unknown[]) => {
                  bound.push(values.length);
                  return inner.bind(...values);
                };
              }
              const value = Reflect.get(inner, name);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return createCrmDb(counted);
}

const GYM = extId("gym");
const PLAN = `${GYM}.plan`;
const MEMBERSHIP = `${GYM}.membership`;
const PASSTYPE = `${GYM}.passtype`;
const PASS = `${GYM}.pass`;
const VISIT = `${GYM}.visit`;
const RETURN = "https://gym.example.com/account";
const DAY = 86_400_000;

const RUNNING = ["trialing", "active", "past_due", "unpaid", "paused"] as const;

/** A Person's journey signals (stage 53), by name. */
async function signalsOf(personId: string) {
  const { results } = await env.DB.prepare(
    "SELECT signal, object_type, record_id, standing, bulk FROM core_person_signal WHERE person_id = ? ORDER BY signal",
  )
    .bind(personId)
    .all<{
      signal: string;
      object_type: string;
      record_id: string;
      standing: string;
      bulk: number;
    }>();
  return Object.fromEntries(results.map((r) => [r.signal.slice(GYM.length + 1), r]));
}

function fixture(id: string): ExtensionManifest {
  return manifest(id, {
    // The Memberships pack's journey signals, as it declares them (stage 53, ADR 0802).
    journeySignals: {
      started: { label: "Membership started", object: "membership" },
      joined: {
        label: "Joined after a trial",
        object: "membership",
        enters: ["active"],
        from: ["trialing"],
        created: false,
      },
      ended: { label: "Membership ended", object: "membership", enters: ["ended"] },
      trialEnded: {
        label: "Trial ended without joining",
        object: "membership",
        enters: ["past_due", "unpaid", "paused", "ended"],
        from: ["trialing"],
        created: false,
      },
      passStarted: { label: "Pass started", object: "pass" },
    },
    objects: {
      plan: {
        label: "Plan",
        plural: "Plans",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          uses: { type: "number", label: "Uses" },
          per: {
            type: "select",
            label: "Per",
            options: [
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
            ],
          },
          trialDays: { type: "number", label: "Trial days" },
        },
        public: { read: ["title", "price", "uses", "per", "trialDays"] },
        sellable: {
          price: "price",
          recurring: {
            interval: "month",
            trialDays: "trialDays",
            grants: {
              object: "membership",
              set: {
                person: "subscription.holder",
                payer: "subscription.payer",
                plan: "item",
                subscription: "subscription",
                title: "item.title",
                uses: "item.uses",
                per: "item.per",
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
          payer: { type: "relation", label: "Payer", to: "person", readOnly: true },
          plan: { type: "relation", label: "Plan", to: `${id}.plan`, readOnly: true },
          subscription: { type: "text", label: "Subscription", readOnly: true },
          uses: { type: "number", label: "Uses", readOnly: true },
          per: {
            type: "select",
            label: "Per",
            readOnly: true,
            options: [
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
            ],
          },
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
        customer: { field: "person", read: ["title", "uses", "per", "until", "status"], write: [] },
        allowance: {
          holds: {
            person: "person",
            uses: "uses",
            per: { field: "per" },
            from: "from",
            until: "until",
            live: ["trialing", "active", "past_due"],
            emptyIsUnlimited: true,
            spendsOn: { object: "visit" },
          },
        },
      },
      passtype: {
        label: "Pass type",
        plural: "Pass types",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title", required: true },
          price: { type: "currency", label: "Price", currency: CURRENCY },
          uses: { type: "number", label: "Uses", required: true },
          validDays: { type: "number", label: "Valid for" },
          intro: { type: "boolean", label: "Intro offer" },
        },
        public: { read: ["title", "price", "uses", "validDays", "intro"] },
        sellable: {
          price: "price",
          grants: {
            object: "pass",
            set: { person: "order.person", passtype: "item", uses: "item.uses", order: "order" },
            void: "void",
            valid: { from: "from", until: "until", days: "item.validDays" },
          },
          onePerPerson: "intro",
        },
      },
      pass: {
        label: "Pass",
        plural: "Passes",
        titleField: "order",
        fields: {
          person: { type: "relation", label: "Member", to: "person", readOnly: true },
          passtype: { type: "relation", label: "Type", to: `${id}.passtype`, readOnly: true },
          order: { type: "text", label: "Order", readOnly: true },
          uses: { type: "number", label: "Uses", readOnly: true },
          from: { type: "datetime", label: "From", readOnly: true },
          until: { type: "datetime", label: "Until", readOnly: true },
          status: {
            type: "select",
            label: "Status",
            options: [
              { value: "active", label: "Active" },
              { value: "void", label: "Void" },
            ],
          },
        },
        states: {
          field: "status",
          initial: "active",
          moves: [{ from: "active", to: "void", by: ["host"], final: true }],
        },
        customer: { field: "person", read: ["uses", "until", "status"], write: [] },
        allowance: {
          holds: {
            person: "person",
            uses: "uses",
            per: "total",
            from: "from",
            until: "until",
            live: ["active"],
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
              { value: "cancelled", label: "Cancelled" },
            ],
          },
        },
        states: {
          field: "state",
          initial: "open",
          moves: [
            { from: "open", to: "booked", by: ["staff"] },
            { from: "booked", to: "cancelled", by: ["staff"], final: true },
          ],
        },
        allowance: {
          spends: {
            person: "person",
            holder: "holder",
            spendIn: ["booked"],
            returnIn: ["cancelled"],
          },
        },
      },
    },
  });
}

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { runtime, providerPays, providerRefunds, gw } = payments;
let admin: ActingUser;
let plan: string;

const staff = () => context(admin, { integrations: runtime, events });
const as = (buyer: Buyer) => outside(buyer.principal, { integrations: runtime, events });
const guest = () => outside(PUBLIC, { integrations: runtime, events });

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return ((await run("record.create", { object, values }, context(admin))) as { id: string }).id;
}

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
    amount: 4500,
    currency: CURRENCY,
    interval: "month",
    cancelAtPeriodEnd: false,
    cancelAt: null,
    trialEnd: null,
    currentPeriodStart: new Date(Date.now()).toISOString(),
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

/** The record a subscription granted, and the row that says so. */
async function grantOf(subscriptionId: string) {
  const row = await env.DB.prepare(
    "SELECT object_type, record_id FROM core_subscription_grant WHERE subscription_id = ?",
  )
    .bind(subscriptionId)
    .first<{ object_type: string; record_id: string }>();
  if (!row) return null;
  const record = await run<{ id: string; values: Record<string, unknown> }>(
    "record.get",
    { object: row.object_type, id: row.record_id },
    staff(),
  );
  return { ...row, values: record.values };
}

async function subscribe(buyer: Buyer): Promise<string> {
  const started = await run<{ subscriptionId: string }>(
    "subscription.start",
    { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
    as(buyer),
  );
  return started.subscriptionId;
}

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
  plan = await create(PLAN, { title: "Three a week", price: 45, uses: 3, per: "week" });
  await payments.connect(admin.id);
});

beforeEach(() => {
  events = memoryEventSink();
});

describe("a subscription's grant follows it (recurring.grants, ADR 0510)", () => {
  it("is granted by the first event that reports it running, once, with the plan's terms", async () => {
    const buyer = await createBuyer(admin, "member");
    const id = await subscribe(buyer);
    // Waiting for its first payment: nothing granted yet.
    await deliver("checkout_completed", read(id, { status: "incomplete" }));
    expect(await grantOf(id)).toBeNull();
    const running = read(id, { status: "active" });
    await deliver("updated", running);
    const granted = await grantOf(id);
    expect(granted?.object_type).toBe(MEMBERSHIP);
    expect(granted?.values).toMatchObject({
      person: buyer.principal.personId,
      payer: buyer.principal.personId,
      plan,
      subscription: id,
      title: "Three a week",
      uses: 3,
      per: "week",
      status: "active",
      until: null,
    });
    // The same read again, and a later one with nothing new: still one grant.
    await deliver("updated", { ...running, observedAt: later() });
    const { results } = await env.DB.prepare(
      "SELECT * FROM core_subscription_grant WHERE subscription_id = ?",
    )
      .bind(id)
      .all();
    expect(results).toHaveLength(1);
    // Its member reads it as their own.
    const mine = await run<{ items: { id: string }[] }>(
      "my.list",
      { object: MEMBERSHIP },
      as(buyer),
    );
    expect(mine.items.map((i) => i.id)).toEqual([granted?.record_id]);
  });

  it("moves with it: past due for 30 days at most, paused and back, set to end, ended and final", async () => {
    const buyer = await createBuyer(admin, "mover");
    const id = await subscribe(buyer);
    await deliver("checkout_completed", read(id, { status: "trialing", trialEnd: later() }));
    expect((await grantOf(id))?.values.status).toBe("trialing");
    // The membership starting is its member's journey signal; nobody has joined yet.
    expect(Object.keys(await signalsOf(buyer.principal.personId))).toEqual(["started"]);

    await deliver("invoice_payment_failed", read(id, { status: "past_due" }));
    // A trial that fails its first payment ended without joining.
    expect(Object.keys(await signalsOf(buyer.principal.personId))).toEqual([
      "started",
      "trialEnded",
    ]);
    const failing = await grantOf(id);
    expect(failing?.values.status).toBe("past_due");
    const sub = await env.DB.prepare("SELECT failing_since FROM core_subscription WHERE id = ?")
      .bind(id)
      .first<{ failing_since: string }>();
    expect(failing?.values.until).toBe(
      new Date(Date.parse(sub?.failing_since ?? "") + 30 * DAY).toISOString(),
    );

    // Paid again: running, with no end.
    await deliver("updated", read(id, { status: "active" }));
    expect((await grantOf(id))?.values).toMatchObject({ status: "active", until: null });

    await deliver("paused", read(id, { status: "paused" }));
    expect((await grantOf(id))?.values.status).toBe("paused");
    await deliver("resumed", read(id, { status: "active" }));
    expect((await grantOf(id))?.values.status).toBe("active");

    // Set to end at the period's end: it stops then, and not a minute after.
    const periodEnd = new Date(Date.now() + 12 * DAY).toISOString();
    await deliver(
      "updated",
      read(id, { status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd }),
    );
    expect((await grantOf(id))?.values).toMatchObject({ status: "active", until: periodEnd });

    const endedAt = later();
    await deliver("deleted", read(id, { status: "canceled", endedAt }));
    const ended = await grantOf(id);
    expect(ended?.values).toMatchObject({ status: "ended", until: endedAt });
    // Paid again after failing, and back from a pause: neither is joining. Ended is.
    expect(Object.keys(await signalsOf(buyer.principal.personId))).toEqual([
      "ended",
      "started",
      "trialEnded",
    ]);
  });

  it("a trial that becomes paid is the member joining (AC 2), written by the host in its batch", async () => {
    const buyer = await createBuyer(admin, "joiner");
    const id = await subscribe(buyer);
    await deliver("checkout_completed", read(id, { status: "trialing", trialEnd: later() }));
    await deliver("updated", read(id, { status: "active" }));
    expect((await grantOf(id))?.values.status).toBe("active");
    const signals = await signalsOf(buyer.principal.personId);
    expect(Object.keys(signals)).toEqual(["joined", "started"]);
    expect(signals.joined).toMatchObject({
      object_type: MEMBERSHIP,
      record_id: (await grantOf(id))?.record_id,
      standing: "host",
      bulk: 0,
    });
  });

  it("is a holder its member spends from while it runs, and not once it has ended", async () => {
    const buyer = await createBuyer(admin, "spender");
    const id = await subscribe(buyer);
    await deliver("checkout_completed", read(id, { status: "active" }));
    const membership = await grantOf(id);
    const visit = await create(VISIT, { name: "Monday", person: buyer.principal.personId });
    await run("record.update", { object: VISIT, id: visit, values: { state: "booked" } }, staff());
    const after = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: VISIT, id: visit },
      staff(),
    );
    expect(after.values.holder).toBe(membership?.record_id);
    const left = await run<{ period: { used: number; left: number } }>(
      "allowance.get",
      { object: MEMBERSHIP, id: membership?.record_id },
      as(buyer),
    );
    expect(left.period).toMatchObject({ used: 1, left: 2 });

    await deliver("deleted", read(id, { status: "canceled", endedAt: later() }));
    const next = await create(VISIT, { name: "Tuesday", person: buyer.principal.personId });
    const refused = await refusal(
      run("record.update", { object: VISIT, id: next, values: { state: "booked" } }, staff()),
    );
    expect(refused.details).toMatchObject({ rule: "allowance" });
  });

  it("staff start one paid by one Person and held by another; a customer cannot name a holder", async () => {
    const parent = await createBuyer(admin, "parent");
    const child = await run<{ id: string }>("person.create", { givenName: "Child" }, staff());
    const started = await run<{ subscriptionId: string }>(
      "subscription.start",
      {
        plan: { object: PLAN, id: plan },
        returnUrl: RETURN,
        email: parent.email,
        holderPersonId: child.id,
      },
      staff(),
    );
    const checkout = await env.DB.prepare(
      "SELECT payer_person_id, holder_person_id FROM core_subscription_checkout WHERE id = ?",
    )
      .bind(started.subscriptionId)
      .first();
    expect(checkout).toEqual({
      payer_person_id: parent.principal.personId,
      holder_person_id: child.id,
    });
    await deliver("checkout_completed", read(started.subscriptionId, { status: "active" }));
    expect((await grantOf(started.subscriptionId))?.values).toMatchObject({
      person: child.id,
      payer: parent.principal.personId,
    });
    // The parent pays and reads the subscription; the membership is the child's, not theirs.
    const theirs = await run<{ items: unknown[] }>("my.list", { object: MEMBERSHIP }, as(parent));
    expect(theirs.items).toEqual([]);

    const refused = await refusal(
      run(
        "subscription.start",
        { plan: { object: PLAN, id: plan }, returnUrl: RETURN, holderPersonId: child.id },
        as(parent),
      ),
    );
    expect(refused).toMatchObject({ code: "invalid_input", details: { rule: "staff_input" } });
    expect(gw.subscriptions.at(-1)?.subscriptionId).toBe(started.subscriptionId);
  });

  it("works out when it stops from the host's record", () => {
    const base = {
      state: "active",
      ended_at: null,
      cancel_at_period_end: 0,
      current_period_end: "2026-12-01T00:00:00.000Z",
      cancel_at: null,
      failing_since: null,
    } as unknown as Parameters<typeof grantUntil>[0];
    const now = "2026-11-24T00:00:00.000Z";
    expect(grantUntil(base, now)).toBeNull();
    expect(grantUntil({ ...base, cancel_at_period_end: 1 }, now)).toBe("2026-12-01T00:00:00.000Z");
    expect(
      grantUntil(
        {
          ...base,
          state: "past_due",
          failing_since: "2026-11-20T00:00:00.000Z",
          cancel_at_period_end: 1,
        },
        now,
      ),
    ).toBe("2026-12-01T00:00:00.000Z");
    expect(
      grantUntil({ ...base, state: "past_due", failing_since: "2026-11-20T00:00:00.000Z" }, now),
    ).toBe("2026-12-20T00:00:00.000Z");
    expect(grantUntil({ ...base, state: "ended" }, now)).toBe(now);
  });
});

describe("passes: valid for their days, voided by a full refund (grants.valid, ADR 0511)", () => {
  it("grants a pass valid from now for the type's days; a full refund voids it and spent uses stay", async () => {
    const type = await create(PASSTYPE, { title: "Ten", price: 200, uses: 10, validDays: 30 });
    const buyer = await createBuyer(admin, "packer");
    const order = await run<{ id: string }>(
      "order.start",
      { lines: [{ object: PASSTYPE, id: type, quantity: 1 }], pay: "full" },
      as(buyer),
    );
    await run("order.checkout", { id: order.id, returnUrl: RETURN }, as(buyer));
    const before = Date.now();
    await providerPays(order.id);
    const { results } = await env.DB.prepare(
      "SELECT record_id FROM core_order_grant WHERE order_id = ?",
    )
      .bind(order.id)
      .all<{ record_id: string }>();
    expect(results).toHaveLength(1);
    const passId = results[0]?.record_id as string;
    const pass = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: PASS, id: passId },
      staff(),
    );
    expect(pass.values).toMatchObject({
      person: buyer.principal.personId,
      uses: 10,
      status: "active",
    });
    const from = Date.parse(String(pass.values.from));
    const until = Date.parse(String(pass.values.until));
    expect(from).toBeGreaterThanOrEqual(before - 1000);
    // 30 local days: 30 days to the minute, or an hour either way across a change of clocks.
    expect(Math.abs(until - from - 30 * DAY)).toBeLessThanOrEqual(3_600_000);

    // A use spent, then the order refunded in full: void, and the use is still spent.
    const visit = await create(VISIT, {
      name: "Wed",
      person: buyer.principal.personId,
      holder: passId,
    });
    await run("record.update", { object: VISIT, id: visit, values: { state: "booked" } }, staff());
    const asked = await run<{ refunds: { pendingActionId: string }[] }>(
      "order.refund",
      { id: order.id, reason: "Moved away" },
      staff(),
    );
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
    await providerRefunds(gw.action);
    const voided = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: PASS, id: passId },
      staff(),
    );
    expect(voided.values.status).toBe("void");
    const uses = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_allowance_use WHERE record_id = ? AND returned_at IS NULL",
    )
      .bind(passId)
      .first<{ n: number }>();
    expect(uses?.n).toBe(1);
  });
});

describe("an intro offer: one per Person (onePerPerson, ADR 0512)", () => {
  let intro: string;
  let otherIntro: string;
  beforeAll(async () => {
    intro = await create(PASSTYPE, {
      title: "Intro",
      price: 20,
      uses: 3,
      validDays: 7,
      intro: true,
    });
    otherIntro = await create(PASSTYPE, { title: "Intro 2", price: 25, uses: 2, intro: true });
  });
  const startFor = (ctx: Parameters<typeof run>[2], id: string, email?: string) =>
    run<{ id: string }>(
      "order.start",
      {
        lines: [{ object: PASSTYPE, id, quantity: 1 }],
        pay: "full",
        ...(email ? { email } : {}),
      },
      ctx,
    );
  async function onceRows(personId: string) {
    const { results } = await env.DB.prepare(
      "SELECT state, order_id FROM core_sellable_once WHERE person_id = ? ORDER BY created_at",
    )
      .bind(personId)
      .all<{ state: string; order_id: string }>();
    return results;
  }

  it("is refused to a guest who typed an address, whoever's it is", async () => {
    const someone = await createBuyer(admin, "typed");
    for (const email of [someone.email, `${unique("new")}@gym.example`]) {
      const refused = await refusal(startFor(guest(), intro, email));
      expect(refused).toMatchObject({
        code: "invalid_input",
        details: { rule: "once_per_person", reason: "sign_in" },
      });
    }
    expect(await onceRows(someone.principal.personId)).toEqual([]);
  });

  it("is held from the order's start, used when paid, and refused a second time on any intro type", async () => {
    const buyer = await createBuyer(admin, "intro");
    const order = await startFor(as(buyer), intro);
    expect((await onceRows(buyer.principal.personId)).map((r) => r.state)).toEqual(["held"]);
    // Waiting to be paid: a second is refused.
    expect(await refusal(startFor(as(buyer), otherIntro))).toMatchObject({
      details: { rule: "once_per_person", reason: "held" },
    });
    await run("order.checkout", { id: order.id, returnUrl: RETURN }, as(buyer));
    await providerPays(order.id);
    expect((await onceRows(buyer.principal.personId)).map((r) => r.state)).toEqual(["used"]);
    for (const id of [intro, otherIntro]) {
      expect(await refusal(startFor(as(buyer), id))).toMatchObject({
        details: { rule: "once_per_person", reason: "used" },
      });
    }
    // Staff buying it for them are refused the same way.
    expect(await refusal(startFor(staff(), intro, buyer.email))).toMatchObject({
      details: { rule: "once_per_person", reason: "used" },
    });
  });

  it("is given back when the unpaid order expires, so they can buy it again", async () => {
    const buyer = await createBuyer(admin, "lapse");
    const order = await startFor(as(buyer), intro);
    await run("fixture.moveOrderAs", { id: order.id, to: "expired", by: "host" }, staff());
    expect((await onceRows(buyer.principal.personId)).map((r) => r.state)).toEqual(["released"]);
    await startFor(as(buyer), intro);
    expect((await onceRows(buyer.principal.personId)).map((r) => r.state)).toEqual([
      "released",
      "held",
    ]);
  });

  it("gives one of two orders started at once, and holds one only on one line of one", async () => {
    const buyer = await createBuyer(admin, "race");
    const results = await Promise.allSettled([
      startFor(as(buyer), intro),
      startFor(as(buyer), otherIntro),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((failed.reason as { details?: unknown }).details).toMatchObject({
      rule: "once_per_person",
    });
    const { results: orders } = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_order WHERE person_id = ?",
    )
      .bind(buyer.principal.personId)
      .all<{ n: number }>();
    expect(orders[0]?.n).toBe(1);
    expect(await onceRows(buyer.principal.personId)).toHaveLength(1);

    const two = await createBuyer(admin, "two");
    expect(
      await refusal(
        run(
          "order.start",
          { lines: [{ object: PASSTYPE, id: intro, quantity: 2 }], pay: "full" },
          as(two),
        ),
      ),
    ).toMatchObject({ details: { rule: "once_per_person", reason: "one" } });
  });

  it("follows a merge: the survivor has had theirs", async () => {
    const merged = await createBuyer(admin, "merged");
    const survivor = await createBuyer(admin, "survivor");
    const order = await startFor(as(merged), intro);
    await run("order.checkout", { id: order.id, returnUrl: RETURN }, as(merged));
    await providerPays(order.id);
    await run("customer.disable", { id: merged.principal.customerId }, staff());
    await run(
      "person.merge",
      { survivorId: survivor.principal.personId, mergedId: merged.principal.personId },
      staff(),
    );
    expect(await refusal(startFor(as(survivor), intro))).toMatchObject({
      details: { rule: "once_per_person", reason: "used" },
    });
  });

  it("counts a+1@ and a+2@ as one person (#225, ADR 0692); a.b@ and ab@ stay two", async () => {
    const tag = unique("fold").toLowerCase();
    const one = await createBuyer(admin, "fold1", `${tag}+1@gym.example`);
    const two = await createBuyer(admin, "fold2", `${tag}+2@gym.example`);
    const bare = await createBuyer(admin, "fold0", `${tag}@gym.example`);
    const order = await startFor(as(one), intro);
    // Waiting to be paid on +1: +2 and the bare address are refused, on any intro type.
    for (const buyer of [two, bare]) {
      expect(await refusal(startFor(as(buyer), otherIntro))).toMatchObject({
        details: { rule: "once_per_person", reason: "held" },
      });
    }
    await run("order.checkout", { id: order.id, returnUrl: RETURN }, as(one));
    await providerPays(order.id);
    expect(await refusal(startFor(as(two), intro))).toMatchObject({
      details: { rule: "once_per_person", reason: "used" },
    });
    // Staff buying it for +2 are refused the same way.
    expect(await refusal(startFor(staff(), intro, two.email))).toMatchObject({
      details: { rule: "once_per_person", reason: "used" },
    });
    expect(await onceRows(two.principal.personId)).toEqual([]);

    // Dots are not folded: a.b@ and ab@ each buy their own.
    const dotted = await createBuyer(admin, "dot", `a.b.${tag}@gym.example`);
    const dotless = await createBuyer(admin, "nodot", `ab${tag}@gym.example`);
    await startFor(as(dotted), intro);
    await startFor(as(dotless), intro);
    expect((await onceRows(dotless.principal.personId)).map((r) => r.state)).toEqual(["held"]);
  });

  it("gives one of two orders started at once by a+1@ and a+2@: the database refuses the other", async () => {
    const tag = unique("foldrace").toLowerCase();
    const one = await createBuyer(admin, "race1", `${tag}+1@gym.example`);
    const two = await createBuyer(admin, "race2", `${tag}+2@gym.example`);
    const results = await Promise.allSettled([
      startFor(as(one), intro),
      startFor(as(two), otherIntro),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((failed.reason as { details?: unknown }).details).toMatchObject({
      rule: "once_per_person",
      reason: "held",
    });
    const rows = [
      ...(await onceRows(one.principal.personId)),
      ...(await onceRows(two.principal.personId)),
    ];
    expect(rows).toHaveLength(1);
    // The backstop itself: a hold written straight to the table for +2 is refused.
    const winner = rows[0] as { order_id: string };
    const loser = (await onceRows(one.principal.personId)).length ? two : one;
    await expect(
      env.DB.prepare(
        "INSERT INTO core_sellable_once (id, person_id, object_type, record_id, order_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'held', ?, ?)",
      )
        .bind(unique("so"), loser.principal.personId, PASSTYPE, intro, winner.order_id, "t", "t")
        .run(),
    ).rejects.toThrow(/core_sellable_once_folded/);
  });

  it("keeps every check to a few bound values however many People share the folded address", async () => {
    const tag = unique("foldmany").toLowerCase();
    const now = new Date().toISOString();
    // 150 People who are one person: more than D1's 100 bound values, were each named.
    const people = Array.from({ length: 150 }, (_, i) => `per_${tag}_${i}`);
    await env.DB.batch(
      people.flatMap((id, i) => [
        env.DB.prepare(
          "INSERT INTO core_person (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ).bind(id, `Many ${i}`, now, now),
        env.DB.prepare(
          "INSERT INTO core_person_emails (id, person_id, email, is_primary, position, created_at) VALUES (?, ?, ?, 1, 0, ?)",
        ).bind(`eml_${id}`, id, `${tag}+${i}@gym.example`, now),
      ]),
    );
    const buyer = await createBuyer(admin, "many", `${tag}@gym.example`);
    const bound: number[] = [];
    const counted = countingDb(env.DB, bound);
    const order = await startFor(outside(buyer.principal, { db: counted, events }), intro);
    expect(bound.length).toBeLessThan(1000);
    expect(Math.max(...bound)).toBeLessThan(100);
    expect((await onceRows(buyer.principal.personId)).map((r) => r.state)).toEqual(["held"]);
    // And one of the 150 is refused while it waits.
    const other = await createBuyer(admin, "many2", `${tag}+x@gym.example`);
    bound.length = 0;
    expect(
      await refusal(startFor(outside(other.principal, { db: counted, events }), intro)),
    ).toMatchObject({ details: { rule: "once_per_person", reason: "held" } });
    expect(Math.max(...bound)).toBeLessThan(100);
    expect(order.id).toBeTruthy();
  });

  it("lets through a pass given by hand to a+2@ after a+1@ had theirs (a person's override)", async () => {
    const tag = unique("foldhand").toLowerCase();
    const one = await createBuyer(admin, "hand1", `${tag}+1@gym.example`);
    const two = await createBuyer(admin, "hand2", `${tag}+2@gym.example`);
    const order = await startFor(as(one), intro);
    await run("order.checkout", { id: order.id, returnUrl: RETURN }, as(one));
    await providerPays(order.id);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_sellable_once (id, person_id, object_type, record_id, order_id, state, source, given_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 'used', 'by_hand', ?, ?, ?)",
    )
      .bind(unique("so"), two.principal.personId, PASSTYPE, intro, admin.id, now, now)
      .run();
    expect((await onceRows(two.principal.personId)).map((r) => r.state)).toEqual(["used"]);
  });
});

describe("the declarations' checks", () => {
  it("refuses a granted object that cannot follow its subscription", () => {
    const m = fixture(extId("bad"));
    const membership = m.objects.membership as NonNullable<(typeof m.objects)[string]>;
    // No move into paused from active, and an ended state that is not final.
    membership.states = {
      field: "status",
      initial: "active",
      moves: [{ from: "active", to: "ended", by: ["host"] }],
    };
    const issues = validateManifest(m)
      .issues.map((i) => i.message)
      .join("\n");
    expect(issues).toMatch(/needs a move from "active" to "paused"/);
    expect(issues).toMatch(/must be a final state/);
  });

  it("refuses onePerPerson on a plan, and on a field that is not a boolean", () => {
    const m = fixture(extId("bad"));
    const plan = m.objects.plan as NonNullable<(typeof m.objects)[string]>;
    (plan.sellable as { onePerPerson?: string }).onePerPerson = "trialDays";
    const issues = validateManifest(m)
      .issues.map((i) => i.message)
      .join("\n");
    expect(issues).toMatch(/onePerPerson is for things bought once/);
    expect(issues).toMatch(/must be a boolean field/);
  });

  it("a tool only a person may call is an operation only a human actor reaches", () => {
    const tool = {
      description: "Gives a pass by hand, for a person on the staff only.",
      risk: "write" as const,
      humanOnly: true as const,
      inputSchema: z.toJSONSchema(z.object({})) as never,
      outputSchema: z.toJSONSchema(z.object({})) as never,
    };
    const op = toolOperation(fixture(extId("tool")), "givePass", tool, "shipped");
    expect(op.actors).toEqual(["human"]);
  });
});

// --- The independent review of step 6 (ADR 0513) -------------------------------------------------

/** A running membership: its subscription, its record id, its member. */
async function runningMembership(label: string) {
  const buyer = await createBuyer(admin, label);
  const id = await subscribe(buyer);
  await deliver("checkout_completed", read(id, { status: "active" }));
  const granted = await grantOf(id);
  return { buyer, id, record: granted?.record_id as string };
}

/** A pass bought and paid, of a fresh pass type. */
async function boughtPass(buyer: Buyer, values: Record<string, unknown> = {}) {
  const type = await create(PASSTYPE, { title: unique("Pack"), price: 50, uses: 5, ...values });
  const order = await run<{ id: string }>(
    "order.start",
    { lines: [{ object: PASSTYPE, id: type, quantity: 1 }], pay: "full" },
    as(buyer),
  );
  await run("order.checkout", { id: order.id, returnUrl: RETURN }, as(buyer));
  await providerPays(order.id);
  const row = await env.DB.prepare("SELECT record_id FROM core_order_grant WHERE order_id = ?")
    .bind(order.id)
    .first<{ record_id: string }>();
  return { type, order: order.id, pass: row?.record_id as string };
}

async function stateOf(object: string, id: string) {
  const table = object === PASS ? `x_${GYM}_pass` : `x_${GYM}_membership`;
  return env.DB.prepare(`SELECT status, deleted_at FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ status: string; deleted_at: string | null }>();
}

describe("a granted holder and the Trash (review 1)", () => {
  it("a running membership cannot go to the Trash; an ended one can, and comes back ended", async () => {
    const { id, record } = await runningMembership("trash");
    const refused = await refusal(
      run("record.delete", { object: MEMBERSHIP, id: record }, staff()),
    );
    expect(refused.details).toMatchObject({ rule: "allowance", reason: "holder_live" });
    await deliver("deleted", read(id, { status: "canceled", endedAt: later() }));
    await run("record.delete", { object: MEMBERSHIP, id: record }, staff());
    await run("record.restore", { object: MEMBERSHIP, id: record }, staff());
    expect((await stateOf(MEMBERSHIP, record))?.status).toBe("ended");
  });

  it("one put in the Trash while it ran (before this rule) is not restored once its grant moved on", async () => {
    const { id, record } = await runningMembership("trashed-early");
    // As data from before the rule: in the Trash while active.
    await env.DB.prepare(`UPDATE x_${GYM}_membership SET deleted_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), record)
      .run();
    await deliver("deleted", read(id, { status: "canceled", endedAt: later() }));
    const refused = await refusal(
      run("record.restore", { object: MEMBERSHIP, id: record }, staff()),
    );
    expect(refused.details).toMatchObject({ reason: "holder_granted" });
    expect((await stateOf(MEMBERSHIP, record))?.deleted_at).not.toBeNull();
  });

  it("an active pass cannot go to the Trash; a pass trashed before the rule is not restored live after its refund", async () => {
    const buyer = await createBuyer(admin, "passtrash");
    const { order, pass } = await boughtPass(buyer);
    expect(
      (await refusal(run("record.delete", { object: PASS, id: pass }, staff()))).details,
    ).toMatchObject({ reason: "holder_live" });
    await env.DB.prepare(`UPDATE x_${GYM}_pass SET deleted_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), pass)
      .run();
    const asked = await run<{ refunds: { pendingActionId: string }[] }>(
      "order.refund",
      { id: order, reason: "Moved away" },
      staff(),
    );
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
    await providerRefunds(gw.action);
    expect(
      (await refusal(run("record.restore", { object: PASS, id: pass }, staff()))).details,
    ).toMatchObject({ reason: "holder_granted" });
  });
});

describe("only the host (or a person's tool) voids a pass (review 2)", () => {
  it("staff cannot void a pass through the generic record operations, as a person or over MCP", async () => {
    const buyer = await createBuyer(admin, "novoid");
    const { pass } = await boughtPass(buyer);
    for (const ctx of [
      staff(),
      context(admin, {
        integrations: runtime,
        events,
        actor: "mcp",
        origin: { surface: "mcp", clientId: "c", clientName: "C", sessionId: unique("s") },
      }),
    ]) {
      const refused = await refusal(
        run("record.update", { object: PASS, id: pass, values: { status: "void" } }, ctx),
      );
      expect(refused.code).toBe("invalid_input");
    }
    expect((await stateOf(PASS, pass))?.status).toBe("active");
  });
});

describe("a merge and the intro offer (review 3)", () => {
  let intro: string;
  beforeAll(async () => {
    intro = await create(PASSTYPE, { title: "Intro M", price: 20, uses: 3, intro: true });
  });
  const startIntro = (buyer: Buyer) =>
    run<{ id: string }>(
      "order.start",
      { lines: [{ object: PASSTYPE, id: intro, quantity: 1 }], pay: "full" },
      as(buyer),
    );
  async function merge(survivor: Buyer, merged: Buyer) {
    await run("customer.disable", { id: merged.principal.customerId }, staff());
    await run(
      "person.merge",
      { survivorId: survivor.principal.personId, mergedId: merged.principal.personId },
      staff(),
    );
  }
  async function onceStates(personId: string) {
    const { results } = await env.DB.prepare(
      "SELECT state FROM core_sellable_once WHERE person_id = ? AND object_type = ? ORDER BY state",
    )
      .bind(personId, PASSTYPE)
      .all<{ state: string }>();
    return results.map((r) => r.state);
  }
  async function passesOf(orderId: string) {
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_order_grant WHERE order_id = ?",
    )
      .bind(orderId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("survivor used, merged held: the merged order, paid later, grants nothing and staff are told", async () => {
    const survivor = await createBuyer(admin, "m-su");
    const merged = await createBuyer(admin, "m-mh");
    const first = await startIntro(survivor);
    await run("order.checkout", { id: first.id, returnUrl: RETURN }, as(survivor));
    await providerPays(first.id);
    const pending = await startIntro(merged);
    await run("order.checkout", { id: pending.id, returnUrl: RETURN }, as(merged));
    await merge(survivor, merged);
    expect(await onceStates(survivor.principal.personId)).toEqual(["released", "used"]);
    await providerPays(pending.id);
    expect(await passesOf(pending.id)).toBe(0);
    const told = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE title = ? AND body LIKE ?",
    )
      .bind("A one-per-person purchase granted nothing", `%${pending.id}%`)
      .first<{ n: number }>();
    expect(told?.n).toBeGreaterThan(0);
  });

  it("survivor held, merged used: the survivor ends with the used one, and its own pending order grants nothing", async () => {
    const survivor = await createBuyer(admin, "m-sh");
    const merged = await createBuyer(admin, "m-mu");
    const had = await startIntro(merged);
    await run("order.checkout", { id: had.id, returnUrl: RETURN }, as(merged));
    await providerPays(had.id);
    const pending = await startIntro(survivor);
    await run("order.checkout", { id: pending.id, returnUrl: RETURN }, as(survivor));
    await merge(survivor, merged);
    expect(await onceStates(survivor.principal.personId)).toEqual(["released", "used"]);
    await providerPays(pending.id);
    expect(await passesOf(pending.id)).toBe(0);
  });

  it("both held: one hold is kept", async () => {
    const survivor = await createBuyer(admin, "m-hh1");
    const merged = await createBuyer(admin, "m-hh2");
    await startIntro(survivor);
    await startIntro(merged);
    await merge(survivor, merged);
    expect(await onceStates(survivor.principal.personId)).toEqual(["held", "released"]);
  });

  it("a late payment for an intro offer had since is refused with words saying so", async () => {
    const buyer = await createBuyer(admin, "m-late");
    const late = await startIntro(buyer);
    await run("order.checkout", { id: late.id, returnUrl: RETURN }, as(buyer));
    await run("fixture.moveOrderAs", { id: late.id, to: "expired", by: "host" }, staff());
    const second = await startIntro(buyer);
    await run("order.checkout", { id: second.id, returnUrl: RETURN }, as(buyer));
    await providerPays(second.id);
    await providerPays(late.id);
    const refused = await refusal(run("order.honourLate", { id: late.id }, staff()));
    expect(refused.details).toMatchObject({ rule: "once_per_person", reason: "had_since" });
    expect(refused.message).toMatch(/Refund the payment/);
  });
});

describe("a granted holder's terms (review 4)", () => {
  it("the contract refuses a granted holder whose terms are writable, or that staff move into a live state", () => {
    const m = fixture(extId("bad"));
    const pass = m.objects.pass as NonNullable<(typeof m.objects)[string]>;
    pass.fields.uses = { type: "number", label: "Uses" };
    (pass.states as { moves: unknown[] }).moves = [
      { from: "active", to: "void", by: ["host"], final: true },
      { from: "void", to: "active", by: ["staff"] },
    ];
    const issues = validateManifest(m)
      .issues.map((i) => i.message)
      .join("\n");
    expect(issues).toMatch(/"uses" is one of its terms, so it must be readOnly/);
    expect(issues).toMatch(/only the host moves it into "active"/);
  });

  it("the extension's own code writes a holder's terms only from a tool only a person with a permission calls", async () => {
    const buyer = await createBuyer(admin, "ownterms");
    const { pass } = await boughtPass(buyer);
    const own = (tool?: { name: string; humanOnly: boolean; permission: string | null }) =>
      context(admin, {
        actor: "extension",
        origin: { surface: "extension", extensionId: GYM },
        extension: {
          id: GYM,
          permissions: { read: [], write: [], operations: [], modules: [] },
          ...(tool ? { tool } : {}),
        },
      } as never);
    for (const ctx of [own(), own({ name: "anyTool", humanOnly: false, permission: null })]) {
      const refused = await refusal(
        run("record.update", { object: PASS, id: pass, values: { uses: 99 } }, ctx),
      );
      expect(refused.code).toBe("invalid_input");
    }
    await run(
      "record.update",
      { object: PASS, id: pass, values: { uses: 4 } },
      own({ name: "givePass", humanOnly: true, permission: `${GYM}:passes` }),
    );
  });
});

describe("dropping what a plan grants (review 7)", () => {
  it("is refused while a subscription still running holds one, naming it", async () => {
    const { id } = await runningMembership("drop");
    const m = fixture(GYM);
    const p = m.objects.plan as NonNullable<(typeof m.objects)[string]>;
    const sellable = p.sellable as { recurring: { grants?: unknown } };
    delete sellable.recurring.grants;
    const { plan: planOf } = await import("./extension-helpers.ts");
    const planned = await planOf(m);
    const issue = planned.issues.find((i) => i.code === "grants_conflict");
    expect(issue?.message).toContain(id);
  });
});

describe("staff-only input (review 9)", () => {
  it("a customer cannot pass holderPersonId, and their contract does not offer it", async () => {
    const buyer = await createBuyer(admin, "staffinput");
    const refused = await refusal(
      run(
        "subscription.start",
        { plan: { object: PLAN, id: plan }, returnUrl: RETURN, holderPersonId: "per_x" },
        as(buyer),
      ),
    );
    expect(refused.details).toMatchObject({ rule: "staff_input" });
    const { buildContract, contractFor, coreRegistry } = await import("../src/index.ts");
    const contract = buildContract(coreRegistry.list());
    const props = (audience: "staff" | "customer" | "public") =>
      Object.keys(
        (contractFor(contract, audience).operations.find((o) => o.name === "subscription.start")
          ?.input.properties as Record<string, unknown>) ?? {},
      );
    expect(props("staff")).toContain("holderPersonId");
    expect(props("customer")).not.toContain("holderPersonId");
    expect(props("public")).not.toContain("holderPersonId");
  });
});

describe("events and refunds (review 10, 11)", () => {
  it("the same read again changes nothing on the membership (no write when its until is the same moment)", async () => {
    const buyer = await createBuyer(admin, "same");
    const id = await subscribe(buyer);
    const end = new Date(Date.now() + 12 * DAY);
    end.setUTCMilliseconds(0);
    const ending = read(id, {
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: end.toISOString().replace(".000Z", "Z"),
    });
    await deliver("checkout_completed", ending);
    const record = (await grantOf(id))?.record_id as string;
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit_log WHERE record_id = ?",
    )
      .bind(record)
      .first<{ n: number }>()
      .catch(() => null);
    const history = async () =>
      (
        await env.DB.prepare(`SELECT updated_at FROM x_${GYM}_membership WHERE id = ?`)
          .bind(record)
          .first<{ updated_at: string }>()
      )?.updated_at;
    const was = await history();
    await deliver("updated", { ...ending, observedAt: later() });
    expect(await history()).toBe(was);
    void before;
  });

  it("refunding a paid period in full tells staff the membership keeps running", async () => {
    const { id } = await runningMembership("refundperiod");
    const sub = await env.DB.prepare("SELECT * FROM core_subscription WHERE id = ?")
      .bind(id)
      .first<Record<string, string>>();
    await payments.deliver({
      kind: "subscription",
      provider: "fake",
      eventId: `fevt_${unique("p")}`,
      trigger: "invoice_paid",
      subscription: read(id, { status: "active" }),
      invoice: {
        ref: `fin_${unique("i")}`,
        status: "paid",
        amountPaid: 4500,
        amountDue: 4500,
        currency: CURRENCY,
        paymentRef: `fpi_${unique("p")}`,
        periodStart: sub?.current_period_start ?? new Date().toISOString(),
        periodEnd: sub?.current_period_end ?? new Date().toISOString(),
        billingReason: "subscription_cycle",
        attemptCount: 1,
        nextAttemptAt: null,
        hostedUrl: null,
      },
      occurredAt: new Date().toISOString(),
    });
    const order = await env.DB.prepare("SELECT id FROM core_order WHERE subscription_id = ?")
      .bind(id)
      .first<{ id: string }>();
    const asked = await run<{ refunds: { pendingActionId: string }[] }>(
      "order.refund",
      { id: order?.id, reason: "Goodwill" },
      staff(),
    );
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
    await providerRefunds(gw.action);
    const told = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE title = ? AND body LIKE ?",
    )
      .bind("A refunded period's membership keeps running", `%${id}%`)
      .first<{ n: number }>();
    expect(told?.n).toBeGreaterThan(0);
  });
});

// `db` is the shared test database: referenced so the import is kept for helpers that need it.
void db;
