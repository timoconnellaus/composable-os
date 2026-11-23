// Stage 44 step 3 (ADR 0644): enforcement. Nobody pays, starts a subscription or books without the
// agreements they need, on every path (acceptance criteria 1 to 3, 6 and 13 in the core suite):
// a signed-in customer, a guardian, staff (a person), the assistant and an MCP client, a guest,
// over invoke and over HTTP. A batch planned before anything that changes what is due (a publish
// with "agree again", an attach, a minor mark, a family link, the Trash, a merge, an erase) fails
// at commit; "agree again" is not retroactive; an object with nothing attached sells as before.
// The shipped packs' paths (Bookings, Memberships, Ticketing, Courses) are in
// apps/runner/test/agreements-enforcement.test.ts. All text is fixture text.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  type Actor,
  type CustomerPrincipal,
  createInvoker,
  createRegistry,
  defineOperation,
  type InvocationContext,
  memoryEventSink,
  onRecordMove,
  type ProviderSubscription,
  updateRecordAsHost,
} from "../src/index.ts";
import { fixtureOperations } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, setPreset, unique } from "./helpers.ts";
import { opRequest, outcomeOf, surfaceOver } from "./http-helpers.ts";
import {
  type Buyer,
  CURRENCY,
  createBuyer,
  orderRegistry,
  outside,
  PUBLIC,
  refusal,
} from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

/** Platform code making a host move, as a promotion from a waitlist does: never an operation. */
const hostMove = defineOperation({
  name: "fixture.hostMove",
  description: "Fixture: updates a record as the host.",
  input: z.object({
    object: z.string(),
    id: z.string(),
    values: z.record(z.string(), z.unknown()),
  }),
  output: z.object({ values: z.record(z.string(), z.unknown()) }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    await updateRecordAsHost(ctx, input.object, input.id, input.values);
    return { values: input.values };
  },
});
/** The core registry with the order fixtures, a tool's customer writes (fixture.myCreate). */
const registry = createRegistry([...orderRegistry.list(), ...fixtureOperations, hostMove]);
const invoker = createInvoker(registry);
const run = <T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: Parameters<typeof invoker.invokeByName>[2],
) => invoker.invokeByName(name, input, ctx) as Promise<T>;

const GYM = extId("agr");
const PLAN = `${GYM}.plan`;
const PASS = `${GYM}.pass`;
const TICKET = `${GYM}.ticket`;
const SLOT = `${GYM}.slot`;
const VISIT = `${GYM}.visit`;
const tag = Date.now().toString(36);
/** Buying a plan or a pass. */
const MEMBERSHIP = `pm${tag}`;
/** Before a visit (booked or waiting). */
const BOOKING = `pv${tag}`;
/** Buying a ticket: nothing attached until a test attaches it. */
const EVENT = `pe${tag}`;
const RETURN = "https://gym.example.com/account";
const DAY = 86_400_000;

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime } = payments;
let admin: ActingUser;
let plan: string;
let pass: string;
let ticket: string;
let slot: string;

const staff = (extra: Partial<InvocationContext> = {}) =>
  context(admin, { integrations: runtime, events, ...extra });
const as = (principal: CustomerPrincipal | { kind: "public" }) =>
  outside(principal, { integrations: runtime, events });

const body = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const QUESTIONS = [{ key: "q1", text: "Fixture question?", noteOnYes: false }];

interface Doc {
  id: string;
  versionId: string;
  kind: string;
}

async function publish(kind: "terms" | "waiver" | "health", points: string[]): Promise<Doc> {
  const { id } = await run<{ id: string }>(
    "agreement.create",
    { title: unique(`Fixture ${kind}`), kind },
    staff(),
  );
  const saved = await run<{ hash: string; rev: number }>(
    "agreement.draft.save",
    {
      id,
      body: body("Fixture text: not a real document."),
      tickLabel: "I have read this fixture",
      ...(kind === "health" ? { questions: QUESTIONS } : {}),
    },
    staff(),
  );
  const { version } = await run<{ version: { id: string } }>(
    "agreement.publish",
    { documentId: id, draftHash: saved.hash, draftRev: saved.rev, number: 1, change: "small" },
    staff(),
  );
  await run("agreement.attach", { documentId: id, points }, staff());
  return { id, versionId: version.id, kind };
}

/** A new version of `doc`: "agree again" (everyone asked again) or a small change. */
async function republish(doc: Doc, change: "small" | "agree_again"): Promise<string> {
  const saved = await run<{ hash: string; rev: number }>(
    "agreement.draft.save",
    { id: doc.id, body: body(unique("Fixture text, changed")) },
    staff(),
  );
  const got = await run<{ versions: unknown[] }>("agreement.get", { id: doc.id }, staff());
  const { version } = await run<{ version: { id: string } }>(
    "agreement.publish",
    {
      documentId: doc.id,
      draftHash: saved.hash,
      draftRev: saved.rev,
      number: got.versions.length + 1,
      change,
    },
    staff(),
  );
  doc.versionId = version.id;
  return version.id;
}

const accept = (principal: CustomerPrincipal, doc: Doc, forPersonId?: string) =>
  run(
    "me.agreements.accept",
    {
      versionId: doc.versionId,
      typedName: "Fixture Name",
      ...(forPersonId ? { forPersonId } : {}),
      ...(doc.kind === "health" ? { answers: [{ key: "q1", yes: false }] } : {}),
    },
    as(principal),
  );

/** What a guest passes in the buying call for `docs`. */
const guestAgrees = (docs: Doc[]) =>
  docs.map((d) => ({
    versionId: d.versionId,
    typedName: "Fixture Visitor",
    ...(d.kind === "health" ? { answers: [{ key: "q1", yes: false }] } : {}),
  }));

const dueIds = (error: { details: Record<string, unknown> }) =>
  ((error.details.documents ?? []) as { documentId: string }[]).map((d) => d.documentId).sort();

const startOrder = (
  object: string,
  id: string,
  ctx: Parameters<typeof run>[2],
  extra: Record<string, unknown> = {},
) =>
  run<{ id: string; token: string | null; total: number }>(
    "order.start",
    { lines: [{ object, id, quantity: 1 }], ...extra },
    ctx,
  );

const subscribe = (ctx: Parameters<typeof run>[2], extra: Record<string, unknown> = {}) =>
  run<{ subscriptionId: string }>(
    "subscription.start",
    { plan: { object: PLAN, id: plan }, returnUrl: RETURN, ...extra },
    ctx,
  );

/** A visit made by a customer's tool (fixture.myCreate, as my.create) or by staff. */
const visit = (ctx: Parameters<typeof run>[2], values: Record<string, unknown>, my = true) =>
  run<{ id: string }>(
    my ? "fixture.myCreate" : "record.create",
    { object: VISIT, values: { slot, ...values } },
    ctx,
  );
const stateOf = async (id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object: VISIT, id }, staff()))
    .values.state;

const acceptances = async (where: string, value: string) =>
  (
    await env.DB.prepare(
      `SELECT id, person_id, by, order_id, subscription_checkout, email FROM core_agreement_acceptance WHERE ${where} = ? ORDER BY accepted_at, id`,
    )
      .bind(value)
      .all<Record<string, unknown>>()
  ).results;

let waiver: Doc;
let terms: Doc;
let health: Doc;

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
          agreements: { point: MEMBERSHIP, label: "Buying a membership" },
        },
        pass: {
          label: "Pass",
          plural: "Passes",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
          },
          sellable: { price: "price" },
          public: { read: ["name", "price"] },
          agreements: { point: MEMBERSHIP, label: "Buying a membership" },
        },
        ticket: {
          label: "Ticket",
          plural: "Tickets",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            price: { type: "currency", label: "Price", currency: CURRENCY },
          },
          sellable: { price: "price" },
          public: { read: ["name", "price"] },
          agreements: { point: EVENT, label: "Buying a ticket", suggests: ["waiver"] },
        },
        slot: {
          label: "Slot",
          plural: "Slots",
          titleField: "name",
          fields: { name: { type: "text", label: "Name", required: true } },
          public: { read: ["name"] },
        },
        visit: {
          label: "Visit",
          plural: "Visits",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title" },
            slot: { type: "relation", label: "Slot", to: `${GYM}.slot`, required: true },
            person: { type: "relation", label: "Person", to: "person" },
            madeBy: { type: "relation", label: "Made by", to: "person", readOnly: true },
            state: {
              type: "select",
              label: "State",
              options: [
                { value: "booked", label: "Booked" },
                { value: "waiting", label: "Waiting" },
                { value: "cancelled", label: "Cancelled" },
              ],
            },
          },
          states: {
            field: "state",
            initial: "booked",
            create: { in: { waiting: ["staff", "customer", "host"] } },
            moves: [
              { from: "waiting", to: "booked", by: ["staff", "customer", "host"] },
              { from: "booked", to: "cancelled", by: ["staff", "customer"], final: true },
              { from: "waiting", to: "cancelled", by: ["staff", "customer"], final: true },
            ],
          },
          customer: {
            field: "person",
            read: ["person", "slot", "state"],
            write: ["slot", "state"],
            createOnly: ["slot"],
            guardians: { write: true, madeBy: "madeBy" },
          },
          agreements: {
            point: BOOKING,
            label: "Before a visit",
            enter: ["booked", "waiting"],
            person: "person",
          },
        },
      },
    }),
  );
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://gym.example.com"] },
    staff(),
  );
  const create = async (object: string, values: Record<string, unknown>) =>
    (await run<{ id: string }>("record.create", { object, values }, staff())).id;
  plan = await create(PLAN, { name: "Monthly", price: 40 });
  pass = await create(PASS, { name: "Ten classes", price: 90 });
  ticket = await create(TICKET, { name: "Open day", price: 10 });
  slot = await create(SLOT, { name: "Morning" });
  await payments.connect(admin.id);
  // The criterion's fixture: a waiver and terms at buying a membership; the waiver and a health
  // form before a visit.
  waiver = await publish("waiver", [MEMBERSHIP, BOOKING]);
  terms = await publish("terms", [MEMBERSHIP]);
  health = await publish("health", [BOOKING]);
}, 120_000);

beforeEach(() => {
  events = memoryEventSink();
});

/** A customer with nothing agreed, and one who has agreed to everything attached. */
async function fresh(label = "member"): Promise<Buyer> {
  return createBuyer(admin, label);
}
async function agreed(label = "agreed"): Promise<Buyer> {
  const buyer = await createBuyer(admin, label);
  for (const doc of [waiver, terms, health]) await accept(buyer.principal, doc);
  return buyer;
}

describe("no way round: a signed-in customer", () => {
  it("is refused a pass, a membership and a first visit (booked or waiting) until they agree", async () => {
    const buyer = await fresh();
    const order = await refusal(startOrder(PASS, pass, as(buyer.principal)));
    expect(order).toMatchObject({ code: "invalid_input", details: { rule: "agreements_due" } });
    expect(dueIds(order)).toEqual([waiver.id, terms.id].sort());
    // Only their own documents, each naming them.
    for (const d of order.details.documents as { personId: string }[]) {
      expect(d.personId).toBe(buyer.principal.personId);
    }
    const sub = await refusal(subscribe(as(buyer.principal)));
    expect(sub.details.rule).toBe("agreements_due");
    expect(gw.subscriptions.some((s) => s.customerEmail === buyer.email)).toBe(false);
    for (const state of ["booked", "waiting"]) {
      const booked = await refusal(visit(as(buyer.principal), { state }));
      expect(booked.details.rule).toBe("agreements_due");
      expect(dueIds(booked)).toEqual([waiver.id, health.id].sort());
    }
    // A customer cannot carry acceptances in the buying call: they agree first.
    const carried = await refusal(
      startOrder(PASS, pass, as(buyer.principal), { agreements: guestAgrees([waiver, terms]) }),
    );
    expect(carried.details).toMatchObject({ rule: "agreement_not_asked", field: "agreements" });

    await accept(buyer.principal, waiver);
    expect(dueIds(await refusal(startOrder(PASS, pass, as(buyer.principal))))).toEqual([terms.id]);
    await accept(buyer.principal, terms);
    const started = await startOrder(PASS, pass, as(buyer.principal));
    expect(started.id).toMatch(/^ord_/);
    expect((await subscribe(as(buyer.principal))).subscriptionId).toMatch(/^sbs_/);
    expect(dueIds(await refusal(visit(as(buyer.principal), {})))).toEqual([health.id]);
    await accept(buyer.principal, health);
    expect(await stateOf((await visit(as(buyer.principal), {})).id)).toBe("booked");
  });

  it("a waiter taking a free place themselves is asked; the host moving them in is not", async () => {
    const buyer = await agreed("waiter");
    const waiting = await visit(as(buyer.principal), { state: "waiting" });
    const second = await visit(as(buyer.principal), { state: "waiting" });
    await republish(waiver, "agree_again");
    const taken = await refusal(
      run(
        "fixture.myUpdate",
        { object: VISIT, id: waiting.id, values: { state: "booked" } },
        as(buyer.principal),
      ),
    );
    expect(taken.details.rule).toBe("agreements_due");
    expect(dueIds(taken)).toEqual([waiver.id]);
    // The host's own move (a promotion) is never asked: "agree again" is not retroactive.
    await run(
      "fixture.hostMove",
      { object: VISIT, id: second.id, values: { state: "booked" } },
      staff(),
    );
    const promoted = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: VISIT, id: second.id },
      staff(),
    );
    expect(promoted.values.state).toBe("booked");
    await accept(buyer.principal, waiver);
    await run(
      "fixture.myUpdate",
      { object: VISIT, id: waiting.id, values: { state: "booked" } },
      as(buyer.principal),
    );
  });
});

describe("a member moving over (criterion 11)", () => {
  it("can read their offer, cannot take it until they agree, and can afterwards", async () => {
    const buyer = await fresh("moving");
    const freeUntil = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
    const { results } = await run<{ results: { offerId: string | null }[] }>(
      "subscription.offer.import",
      { plan: { object: PLAN, id: plan }, rows: [{ email: buyer.email, freeUntil }] },
      staff(),
    );
    const offerId = results[0]?.offerId as string;
    expect(offerId).toBeTruthy();
    const mine = await run<{ offers: { id: string }[] }>(
      "subscription.offer.mine",
      {},
      as(buyer.principal),
    );
    expect(mine.offers.map((o) => o.id)).toContain(offerId);
    const take = () => subscribe(as(buyer.principal), { offerId });
    const refused = await refusal(take());
    expect(refused.details.rule).toBe("agreements_due");
    expect(dueIds(refused)).toEqual([waiver.id, terms.id].sort());
    expect(gw.subscriptions.some((s) => s.customerEmail === buyer.email)).toBe(false);
    for (const doc of [waiver, terms]) await accept(buyer.principal, doc);
    expect((await take()).subscriptionId).toMatch(/^sbs_/);
  });
});

describe("no way round: a guardian", () => {
  it("books for a dependant only with a guardian's acceptance for the child", async () => {
    const parent = await agreed("parent");
    const child = (
      await run<{ id: string }>("person.create", { givenName: unique("Kid") }, staff())
    ).id;
    await run(
      "person.link.add",
      { guardianId: parent.principal.personId, dependantId: child },
      staff(),
    );
    const forChild = (extra: Record<string, unknown> = {}) =>
      run(
        "fixture.myCreate",
        { object: VISIT, values: { slot, ...extra }, forPersonId: child },
        as(parent.principal),
      );
    const refused = await refusal(forChild());
    expect(refused.details.rule).toBe("agreements_due");
    expect(dueIds(refused)).toEqual([waiver.id, health.id].sort());
    for (const d of refused.details.documents as { personId: string }[]) {
      expect(d.personId).toBe(child);
    }
    // The parent's own acceptances do not count for the child; the guardian's for the child do.
    await accept(parent.principal, waiver, child);
    await accept(parent.principal, health, child);
    const made = (await forChild()) as { id: string };
    const read = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: VISIT, id: made.id },
      staff(),
    );
    expect(read.values.person).toBe(child);
  });
});

describe("no way round: staff, the assistant and MCP", () => {
  it("staff (a person) are refused an order, a subscription and a visit for a Person, and cannot agree for them", async () => {
    const member = await fresh("desk");
    const order = await refusal(startOrder(PASS, pass, staff(), { email: member.email }));
    expect(order.details.rule).toBe("agreements_due");
    expect((order.details.documents as { personId: string }[])[0]?.personId).toBe(
      member.principal.personId,
    );
    expect((await refusal(subscribe(staff(), { email: member.email }))).details.rule).toBe(
      "agreements_due",
    );
    const booked = await refusal(visit(staff(), { person: member.principal.personId }, false));
    expect(booked.details.rule).toBe("agreements_due");
    // No bypass: staff carry no acceptances.
    const carried = await refusal(
      startOrder(PASS, pass, staff(), {
        email: member.email,
        agreements: guestAgrees([waiver, terms]),
      }),
    );
    expect(carried.details.rule).toBe("agreement_not_asked");
    // Giving an existing visit to someone with something due is a new visit for them.
    const ready = await agreed("ready");
    const theirs = await visit(staff(), { person: ready.principal.personId }, false);
    const moved = await refusal(
      run(
        "record.update",
        { object: VISIT, id: theirs.id, values: { person: member.principal.personId } },
        staff(),
      ),
    );
    expect(moved.details.rule).toBe("agreements_due");
  });

  const AI: { actor: Actor; origin: InvocationContext["origin"]; extra?: object }[] = [
    { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_enforce" } },
    {
      actor: "mcp",
      origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "cap_enforce" },
      extra: { grantedPermissions: ["records:read", "records:write"] },
    },
  ];
  for (const ai of AI) {
    it(`${ai.actor} acting for an admin is refused naming ids directly`, async () => {
      await setPreset("autonomous");
      try {
        const member = await fresh(`ai${ai.actor}`);
        const ctx = staff({ actor: ai.actor, origin: ai.origin, ...(ai.extra ?? {}) });
        const booked = await refusal(visit(ctx, { person: member.principal.personId }, false));
        expect(booked.details.rule).toBe("agreements_due");
        const order = await refusal(startOrder(PASS, pass, ctx, { email: member.email }));
        expect(order.details.rule).toBe("agreements_due");
      } finally {
        await setPreset("balanced");
      }
    });
  }
});

describe("guests (criterion 6)", () => {
  it("a visitor's pass needs the acceptances in the call; with them they are recorded with the order and no Person, and settle at payment", async () => {
    const email = `${unique("visitor")}@buyers.example`.toLowerCase();
    const without = await refusal(startOrder(PASS, pass, as(PUBLIC), { email }));
    expect(without.details.rule).toBe("agreements_due");
    expect(dueIds(without)).toEqual([waiver.id, terms.id].sort());
    // Nothing about any Person: the documents only.
    for (const d of without.details.documents as Record<string, unknown>[]) {
      expect(d).not.toHaveProperty("personId");
    }
    // Half of what is due, an unknown version, or one twice: refused.
    expect(
      dueIds(
        await refusal(
          startOrder(PASS, pass, as(PUBLIC), { email, agreements: guestAgrees([waiver]) }),
        ),
      ),
    ).toEqual([terms.id]);
    const twice = await refusal(
      startOrder(PASS, pass, as(PUBLIC), {
        email,
        agreements: guestAgrees([waiver, waiver, terms]),
      }),
    );
    expect(twice.details.rule).toBe("agreement_not_asked");
    const other = await refusal(
      startOrder(PASS, pass, as(PUBLIC), {
        email,
        agreements: guestAgrees([waiver, terms, health]),
      }),
    );
    expect(other.details.rule).toBe("agreement_not_asked");

    const started = await startOrder(PASS, pass, as(PUBLIC), {
      email,
      agreements: guestAgrees([waiver, terms]),
    });
    const rows = await acceptances("order_id", started.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ by: "guest", person_id: null, email });
    await run(
      "fixture.verifiedPayment",
      { eventId: unique("evt"), orderId: started.id, amount: started.total },
      staff(),
    );
    const order = await env.DB.prepare("SELECT person_id, state FROM core_order WHERE id = ?")
      .bind(started.id)
      .first<{ person_id: string; state: string }>();
    expect(order?.state).toBe("paid");
    for (const row of await acceptances("order_id", started.id)) {
      expect(row.person_id).toBe(order?.person_id);
    }
  });

  it("asks a member who has agreed the same as anyone, and deletes the acceptances of an order that expires unpaid", async () => {
    const member = await agreed("knowngu");
    const asked = await refusal(startOrder(PASS, pass, as(PUBLIC), { email: member.email }));
    const stranger = await refusal(
      startOrder(PASS, pass, as(PUBLIC), { email: `${unique("x")}@buyers.example` }),
    );
    expect(asked.details).toEqual(stranger.details);
    expect(asked.message).toBe(stranger.message);
    const started = await startOrder(PASS, pass, as(PUBLIC), {
      email: member.email,
      agreements: guestAgrees([waiver, terms]),
    });
    expect(await acceptances("order_id", started.id)).toHaveLength(2);
    await run(
      "order.expireDue",
      {},
      staff({ actor: "automation", clock: () => new Date(Date.now() + 2 * DAY) }),
    );
    expect(await acceptances("order_id", started.id)).toHaveLength(0);
  });

  it("a guest's subscription carries them with the checkout, settled to the holder when the provider confirms", async () => {
    const email = `${unique("subguest")}@buyers.example`.toLowerCase();
    expect((await refusal(subscribe(as(PUBLIC), { email }))).details.rule).toBe("agreements_due");
    const started = await subscribe(as(PUBLIC), {
      email,
      agreements: guestAgrees([waiver, terms]),
    });
    const rows = await acceptances("subscription_checkout", started.subscriptionId);
    expect(rows.map((r) => r.person_id)).toEqual([null, null]);
    const checkout = await env.DB.prepare(
      "SELECT holder_person_id, payer_person_id FROM core_subscription_checkout WHERE id = ?",
    )
      .bind(started.subscriptionId)
      .first<{ holder_person_id: string; payer_person_id: string }>();
    const read: ProviderSubscription = {
      provider: "fake",
      ref: `fsub_${started.subscriptionId}`,
      customerRef: `fcus_${started.subscriptionId}`,
      subscriptionId: started.subscriptionId,
      status: "active",
      amount: 4000,
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
      observedAt: new Date().toISOString(),
    };
    await payments.deliver({
      kind: "subscription",
      provider: "fake",
      eventId: unique("fevt"),
      trigger: "checkout_completed",
      subscription: read,
      occurredAt: new Date().toISOString(),
    });
    for (const row of await acceptances("subscription_checkout", started.subscriptionId)) {
      expect(row.person_id).toBe(checkout?.holder_person_id);
    }
  });
});

describe("the race (criterion 2)", () => {
  let remove: (() => void) | null = null;
  afterEach(() => {
    remove?.();
    remove = null;
  });

  it("agree again published while an order, a visit and a subscription are being planned fails each batch; a retry is refused with the new version", async () => {
    const buyer = await agreed("racer");
    let armed = true;
    remove = onRecordMove("order", async () => {
      if (!armed) return;
      armed = false;
      await republish(terms, "agree_again");
    });
    const order = await refusal(startOrder(PASS, pass, as(buyer.principal)));
    expect(order).toMatchObject({ code: "conflict", details: { rule: "agreements_changed" } });
    const retry = await refusal(startOrder(PASS, pass, as(buyer.principal)));
    expect(retry.details.rule).toBe("agreements_due");
    expect((retry.details.documents as { versionId: string }[])[0]?.versionId).toBe(
      terms.versionId,
    );
    await accept(buyer.principal, terms);
    remove();

    armed = true;
    remove = onRecordMove(VISIT, async () => {
      if (!armed) return;
      armed = false;
      await republish(waiver, "agree_again");
    });
    const booked = await refusal(visit(as(buyer.principal), {}));
    expect(booked).toMatchObject({ code: "conflict", details: { rule: "agreements_changed" } });
    expect(dueIds(await refusal(visit(as(buyer.principal), {})))).toEqual([waiver.id]);
    await accept(buyer.principal, waiver);

    gw.beforeSubscribe = async () => {
      await republish(terms, "agree_again");
    };
    const sub = await refusal(subscribe(as(buyer.principal)));
    expect(sub).toMatchObject({ code: "conflict", details: { rule: "agreements_changed" } });
    expect(dueIds(await refusal(subscribe(as(buyer.principal))))).toEqual([terms.id]);
    await accept(buyer.principal, terms);
  });

  it("an attach between the read and the commit fails the batch too", async () => {
    const buyer = await agreed("attacher");
    const late = await publish("waiver", [EVENT]);
    await run("agreement.detach", { documentId: late.id, points: [EVENT] }, staff());
    remove = onRecordMove(VISIT, async () => {
      remove?.();
      remove = null;
      await run("agreement.attach", { documentId: late.id, points: [BOOKING] }, staff());
    });
    const booked = await refusal(visit(as(buyer.principal), {}));
    expect(booked.details.rule).toBe("agreements_changed");
    expect(dueIds(await refusal(visit(as(buyer.principal), {})))).toEqual([late.id]);
    await run("agreement.retire", { documentId: late.id }, staff());
  });

  // The counter also moves on a minor mark, a family link, the Trash, a merge and an erase
  // (migration 0851's triggers): each fails a booking and an order planned before it, by any
  // writer.
  const BUMPS: Record<string, (other: string) => Promise<unknown>> = {
    "a minor mark": (other) =>
      env.DB.prepare(
        "INSERT INTO core_agreement_minor (person_id, set_by, set_at) VALUES (?, 'usr_x', ?)",
      )
        .bind(other, new Date().toISOString())
        .run(),
    "a family link": async (other) => {
      const second = (
        await run<{ id: string }>("person.create", { givenName: unique("G") }, staff())
      ).id;
      return run("person.link.add", { guardianId: second, dependantId: other }, staff());
    },
    "the Trash": (other) => run("person.delete", { id: other }, staff()),
    "a merge": async (other) => {
      const survivor = (
        await run<{ id: string }>("person.create", { givenName: unique("S") }, staff())
      ).id;
      return run("person.merge", { survivorId: survivor, mergedId: other }, staff());
    },
    "an erase": (other) => run("person.erase", { id: other }, staff()),
  };
  for (const [what, bump] of Object.entries(BUMPS)) {
    it(`${what} committed between the read and the commit fails an order's and a visit's batch`, async () => {
      const buyer = await agreed("bumped");
      for (const target of ["order", VISIT] as const) {
        const other = (
          await run<{ id: string }>("person.create", { givenName: unique("Other") }, staff())
        ).id;
        remove = onRecordMove(target, async () => {
          remove?.();
          remove = null;
          await bump(other);
        });
        const call =
          target === "order"
            ? startOrder(PASS, pass, as(buyer.principal))
            : visit(as(buyer.principal), {});
        expect((await refusal(call)).details.rule).toBe("agreements_changed");
      }
      // Nothing changed for them: the retry goes through.
      await visit(as(buyer.principal), {});
    });
  }
});

describe("agree again is not retroactive (criterion 3)", () => {
  it("keeps visits booked and a subscription renewing; the next visit and purchase ask; a small change asks nobody", async () => {
    const buyer = await agreed("kept");
    const kept = await visit(as(buyer.principal), {});
    const started = await subscribe(as(buyer.principal));
    await republish(waiver, "small");
    // A small change asks nobody.
    await visit(as(buyer.principal), { state: "waiting" });
    await republish(waiver, "agree_again");
    const read = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: VISIT, id: kept.id },
      staff(),
    );
    expect(read.values.state).toBe("booked");
    // Cancelling is not entering: allowed.
    await run(
      "fixture.myUpdate",
      { object: VISIT, id: kept.id, values: { state: "cancelled" } },
      as(buyer.principal),
    );
    // The provider's events for the running subscription are the host's: nothing asks.
    await payments.deliver({
      kind: "subscription",
      provider: "fake",
      eventId: unique("fevt"),
      trigger: "checkout_completed",
      subscription: {
        provider: "fake",
        ref: `fsub_${started.subscriptionId}`,
        customerRef: `fcus_${started.subscriptionId}`,
        subscriptionId: started.subscriptionId,
        status: "active",
        amount: 4000,
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
        observedAt: new Date().toISOString(),
      },
      occurredAt: new Date().toISOString(),
    });
    const sub = await env.DB.prepare("SELECT state FROM core_subscription WHERE id = ?")
      .bind(started.subscriptionId)
      .first<{ state: string }>();
    expect(sub?.state).toBe("active");
    expect(dueIds(await refusal(visit(as(buyer.principal), {})))).toEqual([waiver.id]);
    expect(dueIds(await refusal(startOrder(PASS, pass, as(buyer.principal))))).toEqual([waiver.id]);
    await accept(buyer.principal, waiver);
  });
});

describe("with nothing attached a sale is as before (criterion 13)", () => {
  it("a ticket sells to a guest with no acceptances, and needs the waiver once one is attached", async () => {
    const email = `${unique("tix")}@buyers.example`.toLowerCase();
    expect((await startOrder(TICKET, ticket, as(PUBLIC), { email })).id).toMatch(/^ord_/);
    const stray = await refusal(
      startOrder(TICKET, ticket, as(PUBLIC), { email, agreements: guestAgrees([waiver]) }),
    );
    expect(stray.details.rule).toBe("agreement_not_asked");
    await run("agreement.attach", { documentId: waiver.id, points: [EVENT] }, staff());
    try {
      expect(dueIds(await refusal(startOrder(TICKET, ticket, as(PUBLIC), { email })))).toEqual([
        waiver.id,
      ]);
      const started = await startOrder(TICKET, ticket, as(PUBLIC), {
        email,
        agreements: guestAgrees([waiver]),
      });
      expect(await acceptances("order_id", started.id)).toHaveLength(1);
    } finally {
      await run("agreement.detach", { documentId: waiver.id, points: [EVENT] }, staff());
    }
  });
});

// Stage 44 step 5: what the blocks read. A visitor reads the words of what a refusal named
// (agreement.guestVersions); a member is told where the copy goes.
describe("what the agreement blocks read", () => {
  it("a visitor reads the versions a refusal named, and nothing a guest is not asked", async () => {
    const email = `${unique("words")}@buyers.example`.toLowerCase();
    const refused = await refusal(startOrder(PASS, pass, as(PUBLIC), { email }));
    const named = (refused.details.documents as { versionId: string }[]).map((d) => d.versionId);
    const read = await run<{ versions: { id: string; title: string; tickLabel: string }[] }>(
      "agreement.guestVersions",
      { versionIds: [...named, "agv_01NOSUCHVERSION0000000000"] },
      as(PUBLIC),
    );
    expect(read.versions.map((v) => v.id).sort()).toEqual([...named].sort());
    expect(read.versions[0]?.tickLabel).toBe("I have read this fixture");
    // A document only for children (a guardian's consent) is never a guest's to read.
    const { id } = await run<{ id: string }>(
      "agreement.create",
      { title: unique("Fixture consent"), kind: "guardian" },
      staff(),
    );
    const saved = await run<{ hash: string; rev: number }>(
      "agreement.draft.save",
      {
        id,
        body: body("Fixture text: not a real document."),
        tickLabel: "I have read this fixture",
        forWhom: "dependants",
      },
      staff(),
    );
    const { version } = await run<{ version: { id: string } }>(
      "agreement.publish",
      { documentId: id, draftHash: saved.hash, draftRev: saved.rev, number: 1, change: "small" },
      staff(),
    );
    // A version scheduled for later is not what a guest is asked: left out.
    const terms2 = await run<{ hash: string; rev: number }>(
      "agreement.draft.save",
      { id: terms.id, body: body(unique("Fixture text, later")) },
      staff(),
    );
    const termsDoc = await run<{ versions: unknown[] }>("agreement.get", { id: terms.id }, staff());
    const later = await run<{ version: { id: string } }>(
      "agreement.publish",
      {
        documentId: terms.id,
        draftHash: terms2.hash,
        draftRev: terms2.rev,
        number: termsDoc.versions.length + 1,
        change: "small",
        effectiveFrom: new Date(Date.now() + 30 * DAY).toISOString(),
      },
      staff(),
    );
    expect(
      (
        await run<{ versions: { id: string }[] }>(
          "agreement.guestVersions",
          { versionIds: [later.version.id, terms.versionId] },
          as(PUBLIC),
        )
      ).versions.map((v) => v.id),
    ).toEqual([terms.versionId]);
    // Not attached anywhere yet, then attached: a guest reads neither.
    expect(
      (
        await run<{ versions: unknown[] }>(
          "agreement.guestVersions",
          { versionIds: [version.id] },
          as(PUBLIC),
        )
      ).versions,
    ).toEqual([]);
    await run("agreement.attach", { documentId: id, points: [EVENT] }, staff());
    try {
      expect(
        (
          await run<{ versions: unknown[] }>(
            "agreement.guestVersions",
            { versionIds: [version.id] },
            as(PUBLIC),
          )
        ).versions,
      ).toEqual([]);
    } finally {
      await run("agreement.retire", { documentId: id }, staff());
    }
  });

  it("tells a member where the copy goes, and names none for a repeat that records nothing", async () => {
    const buyer = await fresh("copyto");
    const first = await run<{ copyTo: string | null }>(
      "me.agreements.accept",
      { versionId: waiver.versionId, typedName: "Fixture Name" },
      as(buyer.principal),
    );
    expect(first.copyTo).toBe(buyer.email);
    const again = await run<{ copyTo: string | null }>(
      "me.agreements.accept",
      { versionId: waiver.versionId, typedName: "Fixture Name" },
      as(buyer.principal),
    );
    expect(again.copyTo).toBe(null);
  });
});

describe("over HTTP", () => {
  it("refuses a guest's order and a customer's visit with agreements_due, and takes a guest's acceptances", async () => {
    const surface = surfaceOver(registry, as(PUBLIC));
    const send = async (name: string, input: unknown, ctx: Parameters<typeof opRequest>[2]) =>
      outcomeOf((await surface.handle(opRequest(name, input, ctx))) as Response);
    const email = `${unique("http")}@buyers.example`.toLowerCase();
    const lines = [{ object: PASS, id: pass, quantity: 1 }];
    const guest = await send("order.start", { lines, email }, null);
    expect(guest).toMatchObject({ ok: false, error: { details: { rule: "agreements_due" } } });
    const paid = await send(
      "order.start",
      { lines, email, agreements: guestAgrees([waiver, terms]) },
      null,
    );
    expect(paid.ok).toBe(true);
    const buyer = await fresh("httpc");
    const booked = await send(
      "fixture.myCreate",
      { object: VISIT, values: { slot } },
      as(buyer.principal),
    );
    expect(booked).toMatchObject({ ok: false, error: { details: { rule: "agreements_due" } } });
  });
});

// Last: it drops the unique index on live addresses, as an old import could have left two People
// with one address (as orders.test.ts does).
describe("an address several People share", () => {
  it("refuses staff and a guest until staff say whose it is", async () => {
    const email = `${unique("shared")}@buyers.example`.toLowerCase();
    await run("person.create", { givenName: "One", emails: [{ email }] }, staff());
    const second = await run<{ id: string }>(
      "person.create",
      { givenName: "Two", emails: [{ email: `${unique("two")}@buyers.example` }] },
      staff(),
    );
    await env.DB.prepare("DROP INDEX IF EXISTS core_person_emails_live_email_uq").run();
    await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE person_id = ?")
      .bind(email, second.id)
      .run();
    const order = await refusal(startOrder(PASS, pass, staff(), { email }));
    expect(order.details.rule).toBe("agreements_due");
    // A guest with the acceptances: the order waits for staff, and its acceptances with it.
    const started = await startOrder(PASS, pass, as(PUBLIC), {
      email,
      agreements: guestAgrees([waiver, terms]),
    });
    await run(
      "fixture.verifiedPayment",
      { eventId: unique("evt"), orderId: started.id, amount: started.total },
      staff(),
    );
    expect((await acceptances("order_id", started.id)).map((r) => r.person_id)).toEqual([
      null,
      null,
    ]);
    await run("order.setPerson", { id: started.id, personId: second.id }, staff());
    expect((await acceptances("order_id", started.id)).map((r) => r.person_id)).toEqual([
      second.id,
      second.id,
    ]);
  });
});
