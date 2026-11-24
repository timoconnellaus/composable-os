// Stage 48 step 6 (ADR 0713, amending ADR 0402): deleting an account says first what it will do,
// then does it. Against real D1 and the payments gatekeeper's test double (acceptance criterion
// 10): a subscription they pay is set to end at its period's end at the provider, with nothing
// refunded or charged; an unpaid order is cancelled; bookings and tickets are counted for staff,
// never changed; admins are told what was left; a preview that changed meanwhile is a conflict.
// The statement count holds the confirm to D1's limits with the most it acts on.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_DELETE_MOST,
  type ActingUser,
  memoryEventSink,
  type ProviderSubscription,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, unique } from "./helpers.ts";
import {
  type Buyer,
  CURRENCY,
  createBuyer,
  createTicketType,
  installBoxOffice,
  orderRow,
  outside,
  refusal,
  run,
  TICKET_TYPE,
} from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const STUDIO = extId("acct");
const PLAN = `${STUDIO}.plan`;
const VISIT = `${STUDIO}.visit`;
const PASS = `${STUDIO}.pass`;
const RETURN = "https://shop.example.com/account";
const DAY = 86_400_000;

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime } = payments;
let admin: ActingUser;
let plan: string;
let ticket: string;
let depositTicket: string;

const as = (buyer: Buyer, extra: Parameters<typeof outside>[1] = {}) =>
  outside(buyer.principal, { integrations: runtime, events, ...extra });

interface Preview {
  deleted: false;
  subscriptions: { id: string; endsAt: string | null; ending: string }[];
  orders: { id: string; total: number; lines: string[] }[];
  leftForStaff: {
    records: { object: string; label: string; count: number }[];
    partPaidOrders: number;
    moreUnpaidOrders: number;
    subscriptions: { id: string; title: string; state: string; why: string }[];
    dependantsWithoutGuardian: number;
  };
  eraseDueAt: string;
  expect: string;
}

const preview = (buyer: Buyer) => run<Preview>("me.deleteAccount", {}, as(buyer));
const confirm = (buyer: Buyer, expect: string, extra: Parameters<typeof outside>[1] = {}) =>
  run<Record<string, unknown>>("me.deleteAccount", { confirm: true, expect }, as(buyer, extra));

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return ((await run("record.create", { object, values }, context(admin))) as { id: string }).id;
}

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
    currentPeriodEnd: new Date(Date.now() + 20 * DAY).toISOString(),
    canceledAt: null,
    endedAt: null,
    endReason: null,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function deliver(subscription: ProviderSubscription, trigger: "checkout_completed" | "updated") {
  return payments.deliver({
    kind: "subscription",
    provider: "fake",
    eventId: `fevt_${unique("s")}`,
    trigger,
    subscription,
    occurredAt: new Date().toISOString(),
  });
}

/** An active monthly subscription `buyer` pays, as the provider's first event leaves it. */
async function subscribed(buyer: Buyer): Promise<{ id: string; sub: ProviderSubscription }> {
  const { subscriptionId: id } = await run<{ subscriptionId: string }>(
    "subscription.start",
    { plan: { object: PLAN, id: plan }, returnUrl: RETURN },
    as(buyer),
  );
  const sub = read(id);
  await deliver(sub, "checkout_completed");
  return { id, sub };
}

const startOrder = (buyer: Buyer, lines: Record<string, unknown>[], extra = {}) =>
  run<{ id: string; state: string }>(
    "order.start",
    { lines: lines.map((line) => ({ object: TICKET_TYPE, ...line })), ...extra },
    as(buyer),
  );

async function noticesTo(user: string, personId: string) {
  const { results } = await env.DB.prepare(
    "SELECT title, body FROM core_notifications WHERE user_id = ? AND link LIKE ?",
  )
    .bind(user, `%${personId}%`)
    .all<{ title: string; body: string }>();
  return results;
}

/** A web session and an app session for `buyer`. */
async function signedIn(buyer: Buyer): Promise<void> {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + DAY).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_customer_session (id, customer_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(`ses_${unique("s")}`, buyer.principal.customerId, unique("token"), later, now, now),
    env.DB.prepare(
      "INSERT INTO core_device_session (id, audience, customer_id, device_name, access_hash, access_expires_at, refresh_hash, created_at, last_used_at) VALUES (?, 'customer', ?, 'Phone', ?, ?, ?, ?, ?)",
    ).bind(
      `dvs_${unique("d")}`,
      buyer.principal.customerId,
      unique("a"),
      later,
      unique("r"),
      now,
      now,
    ),
  ]);
  expect(await sessionsOf(buyer)).toEqual({ web: 1, device: 1 });
}

async function sessionsOf(buyer: Buyer): Promise<{ web: number; device: number }> {
  const count = async (table: string) =>
    Number(
      (
        await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE customer_id = ?`)
          .bind(buyer.principal.customerId)
          .first<{ n: number }>()
      )?.n,
    );
  return { web: await count("core_customer_session"), device: await count("core_device_session") };
}

/** A member with a subscription, an unpaid order, a part-paid one, two open visits, a past
 * one, and a pass. */
async function busyMember() {
  const buyer = await createBuyer(admin, "member");
  const { id: subscription, sub } = await subscribed(buyer);
  const unpaid = await startOrder(buyer, [{ id: ticket, quantity: 2 }]);
  const deposit = await startOrder(buyer, [{ id: depositTicket, deposit: 1 }], {
    pay: "deposit",
    deposit: 1,
  });
  await run(
    "fixture.verifiedPayment",
    { orderId: deposit.id, amount: 10_000, eventId: unique("evt") },
    context(admin, { actor: "automation" }),
  );
  const person = buyer.principal.personId;
  for (const state of ["booked", "booked", "attended"]) {
    await create(VISIT, { name: unique("Visit"), person, state });
  }
  await create(PASS, { name: unique("Pass"), holder: person });
  return { buyer, subscription, sub, unpaid, deposit };
}

beforeAll(async () => {
  admin = await createUser("admin");
  await installBoxOffice(admin);
  await reconcile(
    manifest(STUDIO, {
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
        visit: {
          label: "Visit",
          plural: "Visits",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            person: { type: "relation", label: "Person", to: "person" },
            state: {
              type: "select",
              label: "State",
              options: [
                { value: "booked", label: "Booked" },
                { value: "attended", label: "Attended" },
                { value: "cancelled", label: "Cancelled" },
              ],
            },
          },
          states: {
            field: "state",
            initial: "booked",
            moves: [
              { from: "booked", to: "attended", by: ["staff"], final: true },
              { from: "booked", to: "cancelled", by: ["staff", "customer"], final: true },
            ],
          },
          customer: { field: "person", read: ["name", "state"], write: [] },
        },
        pass: {
          label: "Pass",
          plural: "Passes",
          titleField: "name",
          fields: {
            name: { type: "text", label: "Name", required: true },
            holder: { type: "relation", label: "Holder", to: "person" },
          },
          customer: { field: "holder", read: ["name"], write: [] },
        },
      },
    }),
  );
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://shop.example.com"] },
    context(admin),
  );
  plan = await create(PLAN, { name: "Monthly", price: 29 });
  ticket = await createTicketType(admin, { name: "Drop-in", price: 20 });
  depositTicket = await createTicketType(admin, {
    name: "Camp",
    price: 400,
    depositAmount: 100,
    balanceDue: `${new Date().getUTCFullYear() + 1}-06-30`,
  });
  await payments.connect(admin.id);
});

beforeEach(() => {
  events = memoryEventSink();
});

describe("the preview (criterion 10)", () => {
  it("says what will end, what is cancelled and what stays for staff, and changes nothing", async () => {
    const { buyer, subscription, sub, unpaid } = await busyMember();
    const calls = gw.changes.length;
    const seen = await preview(buyer);
    expect(seen).toMatchObject({
      deleted: false,
      subscriptions: [
        {
          id: subscription,
          title: "Monthly",
          amount: 2900,
          currency: CURRENCY,
          interval: "month",
          endsAt: sub.currentPeriodEnd,
          ending: "period_end",
        },
      ],
      orders: [{ id: unpaid.id, total: 4000, currency: CURRENCY, lines: ["Drop-in"] }],
      leftForStaff: {
        // The attended visit is finished: only open records stay for staff to decide.
        records: [
          { object: PASS, label: "Pass", count: 1 },
          { object: VISIT, label: "Visits", count: 2 },
        ],
        partPaidOrders: 1,
        moreUnpaidOrders: 0,
        subscriptions: [],
        dependantsWithoutGuardian: 0,
      },
    });
    expect(seen.expect).toMatch(/^[0-9a-f]{32}$/);
    // Asking is read-only: nothing at the provider, nothing in D1.
    expect(gw.changes.length).toBe(calls);
    expect((await orderRow(unpaid.id)).state).toBe("pending");
    const account = await env.DB.prepare("SELECT status FROM core_customer WHERE id = ?")
      .bind(buyer.principal.customerId)
      .first<{ status: string }>();
    expect(account?.status).toBe("active");
    const requests = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_erase_request WHERE person_id = ?",
    )
      .bind(buyer.principal.personId)
      .first<{ n: number }>();
    expect(Number(requests?.n)).toBe(0);
  });

  it("shows only the caller's own: another member's subscription, orders and visits never", async () => {
    const { buyer } = await busyMember();
    const other = await createBuyer(admin, "quiet");
    expect(await preview(other)).toMatchObject({
      subscriptions: [],
      orders: [],
      leftForStaff: { records: [], partPaidOrders: 0 },
    });
    expect((await preview(buyer)).subscriptions).toHaveLength(1);
  });

  it("does not end a subscription someone else pays for them", async () => {
    const payer = await createBuyer(admin, "payer");
    const { id } = await subscribed(payer);
    const holder = await createBuyer(admin, "holder");
    await env.DB.prepare("UPDATE core_subscription SET holder_person_id = ? WHERE id = ?")
      .bind(holder.principal.personId, id)
      .run();
    expect((await preview(holder)).subscriptions).toEqual([]);
    expect((await preview(payer)).subscriptions.map((s) => s.id)).toEqual([id]);
  });
});

describe("confirming (criterion 10)", () => {
  it("ends the subscription at the period's end, cancels the order, disables and tells admins", async () => {
    const { buyer, subscription, sub, unpaid, deposit } = await busyMember();
    await signedIn(buyer);
    const seen = await preview(buyer);
    const calls = gw.changes.length;
    const done = await confirm(buyer, seen.expect);
    expect(done).toMatchObject({
      deleted: true,
      disabled: true,
      subscriptionsEnding: 1,
      ordersCancelled: 1,
    });
    // Due as the preview said, give or take the moments between the two calls.
    const due = (done.eraseRequest as { dueAt: string }).dueAt;
    expect(Math.abs(Date.parse(due) - Date.parse(seen.eraseDueAt))).toBeLessThan(60_000);
    // One call to the provider: end at the period's end. No refund, no charge, nothing else.
    expect(gw.changes.slice(calls)).toEqual([
      {
        method: "cancelSubscription",
        request: {
          subscriptionId: subscription,
          subscriptionRef: sub.ref,
          when: "period_end",
          reason: "The payer deleted their account",
        },
      },
    ]);
    expect(gw.refunds.size).toBe(0);
    expect(await orderRow(unpaid.id)).toMatchObject({ state: "cancelled" });
    // A part-paid order is staff's: left as it was.
    expect(await orderRow(deposit.id)).toMatchObject({ state: "part_paid" });
    const account = await env.DB.prepare("SELECT status FROM core_customer WHERE id = ?")
      .bind(buyer.principal.customerId)
      .first<{ status: string }>();
    expect(account?.status).toBe("disabled");
    // Every session ends, web and app, and the erase request is open with the due date given.
    expect(await sessionsOf(buyer)).toEqual({ web: 0, device: 0 });
    const request = await env.DB.prepare(
      "SELECT status, customer_id, due_at FROM core_erase_request WHERE person_id = ?",
    )
      .bind(buyer.principal.personId)
      .first();
    expect(request).toEqual({
      status: "open",
      customer_id: buyer.principal.customerId,
      due_at: due,
    });
    const [notice] = await noticesTo(admin.id, buyer.principal.personId);
    expect(notice?.title).toBe("A customer asked to be erased");
    expect(notice?.body).toContain(
      "Left for you to decide at erase: 1 pass, 2 visits, 1 part-paid order.",
    );
    expect(notice?.body).toContain(
      "1 subscription they pay ends when the period paid for ends; nothing was refunded.",
    );
    expect(notice?.body).toContain("1 unpaid order cancelled.");
    // The record shows the end once the provider's event says so, as for any cancel.
    await deliver(read(subscription, { cancelAtPeriodEnd: true }), "updated");
    const row = await env.DB.prepare(
      "SELECT state, cancel_at_period_end FROM core_subscription WHERE id = ?",
    )
      .bind(subscription)
      .first();
    expect(row).toMatchObject({ state: "active", cancel_at_period_end: 1 });
  });

  it("is refused when the preview changed meanwhile, and without the preview's expect", async () => {
    const { buyer, unpaid } = await busyMember();
    const seen = await preview(buyer);
    expect((await refusal(run("me.deleteAccount", { confirm: true }, as(buyer)))).code).toBe(
      "invalid_input",
    );
    await startOrder(buyer, [{ id: ticket }]);
    const calls = gw.changes.length;
    expect(await refusal(confirm(buyer, seen.expect))).toMatchObject({
      code: "conflict",
      details: { rule: "preview_changed" },
    });
    expect(gw.changes.length).toBe(calls);
    expect((await orderRow(unpaid.id)).state).toBe("pending");
    // Looked at again, it goes through.
    expect(await confirm(buyer, (await preview(buyer)).expect)).toMatchObject({
      ordersCancelled: 2,
    });
  });

  it("asks nothing more of a subscription they already set to end", async () => {
    const buyer = await createBuyer(admin, "ending");
    const { id } = await subscribed(buyer);
    await deliver(read(id, { cancelAtPeriodEnd: true }), "updated");
    const seen = await preview(buyer);
    expect(seen.subscriptions).toMatchObject([{ id, ending: "already" }]);
    const calls = gw.changes.length;
    await confirm(buyer, seen.expect);
    expect(gw.changes.length).toBe(calls);
  });

  it("leaves a subscription with a later end date at the provider to staff, and says it may charge", async () => {
    // Review of PR #375: an end date set at the provider after the period paid for keeps
    // charging until then, and cancelAtPeriodEnd refuses it; deleting must not call it ending.
    const buyer = await createBuyer(admin, "dated");
    const { id } = await subscribed(buyer);
    const later = new Date(Date.now() + 300 * DAY).toISOString();
    await deliver(read(id, { cancelAt: later }), "updated");
    const seen = await preview(buyer);
    expect(seen.subscriptions).toEqual([]);
    expect(seen.leftForStaff.subscriptions).toEqual([
      { id, title: "Monthly", state: "active", why: "end_date_later" },
    ]);
    const calls = gw.changes.length;
    await confirm(buyer, seen.expect);
    expect(gw.changes.length).toBe(calls);
    const [notice] = await noticesTo(admin.id, buyer.principal.personId);
    expect(notice?.body).toContain("1 subscription they pay was not ended and may still charge");
    expect(notice?.body).not.toContain("ends when the period paid for ends");
  });

  it("an end date set before the period ends is already ending: nothing more is asked", async () => {
    const buyer = await createBuyer(admin, "early");
    const { id, sub } = await subscribed(buyer);
    const soon = new Date(Date.parse(sub.currentPeriodEnd as string) - DAY).toISOString();
    await deliver(read(id, { cancelAt: soon }), "updated");
    const seen = await preview(buyer);
    expect(seen.subscriptions).toMatchObject([{ id, ending: "already", endsAt: soon }]);
    expect(seen.leftForStaff.subscriptions).toEqual([]);
  });

  it("a subscription under a cooling off ends with it: deleting asks the provider nothing", async () => {
    // Review of PR #375: the cooling off's rule (ADR 0647) is the host's, on every path.
    const buyer = await createBuyer(admin, "cooling");
    const { id } = await subscribed(buyer);
    const now = new Date().toISOString();
    const deadline = new Date(Date.now() + DAY).toISOString();
    await env.DB.prepare(
      `INSERT INTO core_subscription_cool_off (subscription_id, holder_person_id, asked_by, days, window_ends_at, state, call_outcome, asked_at, deadline_at, last_asked_at, updated_at)
       VALUES (?, ?, 'payer', 14, ?, 'asked', 'pending', ?, ?, ?, ?)`,
    )
      .bind(id, buyer.principal.personId, deadline, now, deadline, now, now)
      .run();
    const seen = await preview(buyer);
    expect(seen.subscriptions).toMatchObject([{ id, ending: "cooling_off", endsAt: null }]);
    const calls = gw.changes.length;
    // The host's own cancel refuses it too, whoever calls it.
    expect(await refusal(run("subscription.cancel", { id }, as(buyer)))).toMatchObject({
      code: "conflict",
      details: { rule: "cooling_off_open" },
    });
    await confirm(buyer, seen.expect);
    expect(gw.changes.length).toBe(calls);
    const [notice] = await noticesTo(admin.id, buyer.principal.personId);
    expect(notice?.body).toContain("1 subscription ends with the cooling off under way");
  });

  it("does not count a membership its subscription granted as left for staff", async () => {
    // Review of PR #375: the record follows the subscription deleting ends.
    const buyer = await createBuyer(admin, "granted");
    const { id } = await subscribed(buyer);
    const visit = await create(VISIT, { name: unique("Visit"), person: buyer.principal.personId });
    await create(VISIT, { name: unique("Visit"), person: buyer.principal.personId });
    await env.DB.prepare(
      "INSERT INTO core_subscription_grant (subscription_id, object_type, record_id, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(id, VISIT, visit, new Date().toISOString())
      .run();
    expect((await preview(buyer)).leftForStaff.records).toEqual([
      { object: VISIT, label: "Visit", count: 1 },
    ]);
  });

  it("leaves the account as it was when the provider refuses", async () => {
    const { buyer, unpaid } = await busyMember();
    const seen = await preview(buyer);
    const failing = {
      ...runtime,
      callAsHost: async () => {
        throw new Error("provider down");
      },
    } as typeof runtime;
    await expect(confirm(buyer, seen.expect, { integrations: failing })).rejects.toThrow();
    expect((await orderRow(unpaid.id)).state).toBe("pending");
    const account = await env.DB.prepare("SELECT status FROM core_customer WHERE id = ?")
      .bind(buyer.principal.customerId)
      .first<{ status: string }>();
    expect(account?.status).toBe("active");
  });
});

// --- Statements ---------------------------------------------------------------------------------

/** What one call ran on D1: each statement's bound variables. */
let ran: number[] = [];
const counted = new Proxy(env.DB, {
  get(target, key) {
    if (key === "prepare") {
      return (query: string) => {
        const statement = target.prepare(query);
        return new Proxy(statement, {
          get(inner, name) {
            if (name === "bind") {
              return (...values: unknown[]) => {
                ran.push(values.length);
                return inner.bind(...values);
              };
            }
            const value = Reflect.get(inner, name);
            if (typeof value === "function") {
              if (name === "all" || name === "first" || name === "run" || name === "raw") {
                ran.push(0);
              }
              return value.bind(inner);
            }
            return value;
          },
        });
      };
    }
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const countedDb = createCrmDb(counted);

describe("statements (D1's limits)", () => {
  it("the preview reads a fixed number, and the confirm with the most it acts on stays in bounds", async () => {
    const few = await createBuyer(admin, "few");
    await startOrder(few, [{ id: ticket }]);
    ran = [];
    await run("me.deleteAccount", {}, as(few, { db: countedDb }));
    const fewReads = ran.length;

    const many = await createBuyer(admin, "many");
    for (let n = 0; n < ACCOUNT_DELETE_MOST + 2; n += 1) await startOrder(many, [{ id: ticket }]);
    for (let n = 0; n < ACCOUNT_DELETE_MOST + 2; n += 1) await subscribed(many);
    for (let n = 0; n < 5; n += 1) {
      await create(VISIT, { name: unique("Visit"), person: many.principal.personId });
    }
    ran = [];
    const seen = await run<Preview>("me.deleteAccount", {}, as(many, { db: countedDb }));
    // As many statements for twenty-two orders, twenty-two subscriptions and five visits as for
    // one order: one more, the read of their cooling offs, when there are subscriptions at all.
    expect(ran.length).toBe(fewReads + 1);
    expect(seen.orders).toHaveLength(ACCOUNT_DELETE_MOST);
    expect(seen.leftForStaff.moreUnpaidOrders).toBe(2);
    expect(seen.subscriptions).toHaveLength(ACCOUNT_DELETE_MOST);
    expect(seen.leftForStaff.subscriptions.map((s) => s.why)).toEqual(["more", "more"]);

    ran = [];
    const calls = gw.changes.length;
    await confirm(many, seen.expect, { db: countedDb });
    expect(gw.changes.length - calls).toBe(ACCOUNT_DELETE_MOST);
    console.log(
      `STATEMENTS preview=${fewReads + 1} confirm=${ran.length} maxBound=${Math.max(...ran)}`,
    );
    expect(ran.length).toBeLessThan(1000);
    expect(Math.max(...ran)).toBeLessThanOrEqual(100);
  });
});
