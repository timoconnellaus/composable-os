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

const GYM = extId("gym");
const PLAN = `${GYM}.plan`;
const MEMBERSHIP = `${GYM}.membership`;
const PASSTYPE = `${GYM}.passtype`;
const PASS = `${GYM}.pass`;
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
          moves: [{ from: "active", to: "void", by: ["staff", "host"], final: true }],
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

    await deliver("invoice_payment_failed", read(id, { status: "past_due" }));
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
    expect(refused).toMatchObject({ code: "invalid_input", details: { rule: "holder" } });
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
        { ...base, state: "past_due", failing_since: "2026-11-20T00:00:00.000Z", cancel_at_period_end: 1 },
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
    expect(pass.values).toMatchObject({ person: buyer.principal.personId, uses: 10, status: "active" });
    const from = Date.parse(String(pass.values.from));
    const until = Date.parse(String(pass.values.until));
    expect(from).toBeGreaterThanOrEqual(before - 1000);
    // 30 local days: 30 days to the minute, or an hour either way across a change of clocks.
    expect(Math.abs(until - from - 30 * DAY)).toBeLessThanOrEqual(3_600_000);

    // A use spent, then the order refunded in full: void, and the use is still spent.
    const visit = await create(VISIT, { name: "Wed", person: buyer.principal.personId, holder: passId });
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
    intro = await create(PASSTYPE, { title: "Intro", price: 20, uses: 3, validDays: 7, intro: true });
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
    const issues = validateManifest(m).issues.map((i) => i.message).join("\n");
    expect(issues).toMatch(/needs a move from "active" to "paused"/);
    expect(issues).toMatch(/must be a final state/);
  });

  it("refuses onePerPerson on a plan, and on a field that is not a boolean", () => {
    const m = fixture(extId("bad"));
    const plan = m.objects.plan as NonNullable<(typeof m.objects)[string]>;
    (plan.sellable as { onePerPerson?: string }).onePerPerson = "trialDays";
    const issues = validateManifest(m).issues.map((i) => i.message).join("\n");
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

// `db` is the shared test database: referenced so the import is kept for helpers that need it.
void db;
