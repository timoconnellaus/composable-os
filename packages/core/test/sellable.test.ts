// Stage 27, build step 1: the `sellable` behaviour in the host (ADR 0435), against the box office
// fixture extension (test/fixtures/boxoffice) and the payments gatekeeper's test double. The
// acceptance criteria it covers for the host: 2 (buy two kinds, pay, the right tickets, each with
// its own code, granted in the paid batch), 3 (sale window, most per order and places refused,
// no order left), 5 (abandoned: expires, places return, nothing granted), 6 (a full refund voids
// what was granted and returns the places), 6a's host half (a deposit grants at the first
// payment; cancelling after the due date voids and returns the place), and the rules every
// behaviour keeps: they hold for every actor and in the approval queue's dry run.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fieldStorage, objectTableOf } from "../src/extensions/schema.ts";
import {
  type ActingUser,
  GRANT_CODE_LENGTH,
  loadOrderRow,
  memoryEventSink,
  PendingApprovalError,
} from "../src/index.ts";
import { extId, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, setPreset, unique } from "./helpers.ts";
import { CURRENCY, createBuyer, outside, PUBLIC, refusal, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";
import { boxOfficeManifest } from "./sellable-fixtures.ts";

const BOX = extId("box");
const EVENT = `${BOX}.event`;
const TICKET_TYPE = `${BOX}.tickettype`;
const TICKET = `${BOX}.ticket`;
const RETURN = "https://shop.example.com/thanks";
const DAY = 86_400_000;
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;

let events: ReturnType<typeof memoryEventSink>;
const payments = paymentsDouble(() => events);
const { gw, runtime, providerPays, providerRefunds } = payments;

let admin: ActingUser;
const staff = (extra: Record<string, unknown> = {}) =>
  context(admin, { integrations: runtime, events, ...extra });
const guest = (extra: Record<string, unknown> = {}) =>
  outside(PUBLIC, { integrations: runtime, events, ...extra });
const asMcp = () =>
  staff({
    actor: "mcp",
    origin: {
      surface: "mcp",
      clientId: "client-1",
      clientName: "Test client",
      sessionId: `box_${unique()}`,
    },
  });

interface OrderOut {
  id: string;
  state: string;
  total: number;
  paid: number;
  token?: string | null;
}

interface Ticket {
  id: string;
  values: Record<string, unknown>;
  createdAt: string | null;
}

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return (await run<{ id: string }>("record.create", { object, values }, context(admin))).id;
}

/** An event with `places`, and a ticket type of it. */
async function ticketType(values: Record<string, unknown> = {}, eventPlaces = 100) {
  const event = await create(EVENT, { name: unique("Camp"), places: eventPlaces });
  const id = await create(TICKET_TYPE, {
    name: unique("Ticket"),
    price: 50,
    places: 20,
    event,
    ...values,
  });
  return { event, id };
}

async function start(
  lines: { object?: string; id: string; quantity?: number }[],
  options: { pay?: "full" | "deposit"; email?: string; ctx?: Parameters<typeof run>[2] } = {},
) {
  return run<OrderOut>(
    "order.start",
    {
      lines: lines.map((l) => ({ object: TICKET_TYPE, ...l })),
      email: options.email ?? `${unique("guest")}@buyers.example`,
      pay: options.pay ?? "full",
    },
    options.ctx ?? guest(),
  );
}

async function checkout(order: OrderOut, amount?: number) {
  return run<{ url: string; amount: number }>(
    "order.checkout",
    { id: order.id, token: order.token, returnUrl: RETURN, ...(amount ? { amount } : {}) },
    guest(),
  );
}

async function pay(order: OrderOut, amount?: number) {
  await checkout(order, amount);
  return providerPays(order.id);
}

/** What an order granted, as staff read it. */
async function granted(orderId: string): Promise<Ticket[]> {
  const { results } = await env.DB.prepare(
    "SELECT record_id, code FROM core_order_grant WHERE order_id = ? ORDER BY record_id",
  )
    .bind(orderId)
    .all<{ record_id: string; code: string | null }>();
  return Promise.all(
    results.map((r) => run<Ticket>("record.get", { object: TICKET, id: r.record_id }, staff())),
  );
}

async function counter(object: string, record: string) {
  return env.DB.prepare(
    "SELECT places, held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(object, record)
    .first<{ places: number | null; held: number; taken: number }>();
}

async function ordersFor(email: string) {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM core_order WHERE email = ?")
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const state = async (id: string) => (await loadOrderRow(db.query, id)).state;

async function refundInFull(orderId: string) {
  const asked = await run<{ refunds: { pendingActionId: string }[] }>(
    "order.refund",
    { id: orderId, reason: "Cannot come" },
    staff(),
  );
  await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
  return providerRefunds(gw.action);
}

beforeAll(async () => {
  admin = await createUser("admin");
  const m = boxOfficeManifest(BOX);
  // The fixture passes the contract check, sellable and all.
  expect(validateManifest(m).issues).toEqual([]);
  await reconcile(m);
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://shop.example.com"], minPartPayment: 1000 },
    context(admin),
  );
  await payments.connect(admin.id);
});

beforeEach(async () => {
  events = memoryEventSink();
  await setPreset("balanced");
});

// --- Criterion 2 -------------------------------------------------------------------------------

describe("buying two kinds (criterion 2)", () => {
  it("grants one ticket per place, each with its own code, in the batch that marked it paid", async () => {
    const { event, id: general } = await ticketType({ name: "General" });
    const vip = await create(TICKET_TYPE, { name: "VIP", price: 120, places: 5, event });
    const buyer = await createBuyer(admin, "two-kinds");
    const order = await start(
      [
        { id: general, quantity: 2 },
        { id: vip, quantity: 1 },
      ],
      { email: buyer.email },
    );
    expect(order.total).toBe(2 * 5000 + 12000);
    // Started, not paid: nothing granted.
    expect(await granted(order.id)).toEqual([]);

    const { event: paid, result } = await pay(order);
    expect(result.outcome).toBe("applied");
    const row = await loadOrderRow(db.query, order.id);
    expect(row.state).toBe("paid");

    const tickets = await granted(order.id);
    expect(tickets).toHaveLength(3);
    const byType = (id: string) => tickets.filter((t) => t.values.ticketType === id);
    expect(byType(general)).toHaveLength(2);
    expect(byType(vip)).toHaveLength(1);
    for (const ticket of tickets) {
      expect(ticket.values).toMatchObject({
        state: "valid",
        event,
        holder: buyer.principal.personId,
        email: buyer.email,
        orderId: order.id,
      });
      expect(String(ticket.values.code)).toMatch(new RegExp(`^[0-9A-Z]{${GRANT_CODE_LENGTH}}$`));
      // Written in the paid batch: the same moment as the payment.
      expect(ticket.createdAt).toBe(row.paid_at);
    }
    expect(byType(vip)[0]?.values.name).toMatch(/^VIP/);
    expect(new Set(tickets.map((t) => t.values.code)).size).toBe(3);

    // The same payment delivered again grants nothing more.
    const again = await payments.deliver({ ...paid, eventId: paid.eventId });
    expect(again.result.outcome).toBe("duplicate");
    expect(await granted(order.id)).toHaveLength(3);
    // The places are taken.
    expect(await counter(TICKET_TYPE, general)).toMatchObject({ held: 0, taken: 2 });
    expect(await counter(EVENT, event)).toMatchObject({ held: 0, taken: 3 });
  });

  it("a ticket that cannot be granted fails the payment's batch: not paid, nothing granted", async () => {
    // A trigger refuses one ticket's insert, as any failing statement in the batch would. Were
    // granting outside the paid batch, the order would be paid with no tickets.
    const table = objectTableOf(TICKET) as string;
    const { id } = await ticketType({ name: "Refuse me" });
    await env.DB.prepare(
      `CREATE TRIGGER IF NOT EXISTS test_refuse_ticket BEFORE INSERT ON ${table} WHEN NEW.${fieldStorage(TICKET, "name")?.column} LIKE 'Refuse me%' BEGIN SELECT RAISE(ABORT, 'test refused'); END`,
    ).run();
    try {
      const order = await start([{ id, quantity: 2 }]);
      await checkout(order);
      await expect(providerPays(order.id)).rejects.toThrow();
      expect(await state(order.id)).toBe("pending");
      expect(await granted(order.id)).toEqual([]);
      const applied = await env.DB.prepare(
        "SELECT count(*) AS n FROM core_order_payment WHERE order_id = ?",
      )
        .bind(order.id)
        .first<{ n: number }>();
      expect(applied?.n).toBe(0);
      expect(await counter(TICKET_TYPE, id)).toMatchObject({ held: 2, taken: 0 });
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS test_refuse_ticket").run();
    }
  });
});

describe("granted in the paid batch (criterion 2, both ways)", () => {
  it("a payment whose own row cannot be written grants nothing", async () => {
    // The other direction: granting before the paid batch, in a batch of its own, would leave
    // tickets for an order that is not paid.
    const { id } = await ticketType();
    const order = await start([{ id }]);
    await checkout(order);
    await env.DB.prepare(
      `CREATE TRIGGER IF NOT EXISTS test_refuse_payment BEFORE INSERT ON core_order_payment WHEN NEW.order_id = '${order.id}' BEGIN SELECT RAISE(ABORT, 'test refused'); END`,
    ).run();
    try {
      await expect(providerPays(order.id)).rejects.toThrow();
      expect(await state(order.id)).toBe("pending");
      expect(await granted(order.id)).toEqual([]);
      const tickets = await env.DB.prepare(
        `SELECT count(*) AS n FROM ${objectTableOf(TICKET)} WHERE ${fieldStorage(TICKET, "orderId")?.column} = ?`,
      )
        .bind(order.id)
        .first<{ n: number }>();
      expect(tickets?.n).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS test_refuse_payment").run();
    }
    // Once the payment can be written, it grants.
    await providerPays(order.id);
    expect(await granted(order.id)).toHaveLength(1);
  });
});

// --- Criterion 3 -------------------------------------------------------------------------------

describe("the host's rules (criterion 3)", () => {
  const later = new Date(Date.now() + 10 * DAY).toISOString();
  const earlier = new Date(Date.now() - 10 * DAY).toISOString();

  it("a line outside the sale window is refused with the rule, and no order exists", async () => {
    const { id: notYet } = await ticketType({ onSaleFrom: later });
    const { id: over } = await ticketType({ onSaleFrom: earlier, onSaleUntil: earlier });
    const { id: open } = await ticketType({ onSaleFrom: earlier, onSaleUntil: later });
    for (const [id, message] of [
      [notYet, /not on sale yet/],
      [over, /no longer on sale/],
    ] as const) {
      const email = `${unique("window")}@buyers.example`;
      const refused = await refusal(start([{ id }], { email }));
      expect(refused.code).toBe("invalid_input");
      expect(refused.message).toMatch(message);
      expect(refused.details).toMatchObject({ rule: "sale_window", line: 0 });
      expect(await ordersFor(email)).toBe(0);
    }
    expect((await start([{ id: open }])).state).toBe("pending");
  });

  it("more than the most per order is refused with the numbers, and no order exists", async () => {
    const { id } = await ticketType({ maxPerOrder: 2 });
    const email = `${unique("max")}@buyers.example`;
    const refused = await refusal(start([{ id, quantity: 3 }], { email }));
    expect(refused.details).toEqual({ rule: "max_per_order", line: 0, max: 2, asked: 3 });
    expect(await ordersFor(email)).toBe(0);
    expect(await counter(TICKET_TYPE, id)).toMatchObject({ held: 0 });
    expect((await start([{ id, quantity: 2 }])).state).toBe("pending");
  });

  it("more places than remain are refused, and no order exists", async () => {
    const { id, event } = await ticketType({ places: 3 }, 2);
    const email = `${unique("full")}@buyers.example`;
    const refused = await refusal(start([{ id, quantity: 3 }], { email }));
    expect(refused.details).toEqual({ rule: "capacity" });
    expect(await ordersFor(email)).toBe(0);
    expect(await counter(EVENT, event)).toMatchObject({ held: 0 });
  });

  it("every actor is held to them: staff, customers, the public and MCP clients", async () => {
    const { id } = await ticketType({ onSaleFrom: later, maxPerOrder: 1 });
    const buyer = await createBuyer(admin, "actor");
    const callers = [
      () => start([{ id }], { ctx: guest() }),
      () => run("order.start", { lines: [{ object: TICKET_TYPE, id }] }, outside(buyer.principal)),
      () => start([{ id }], { ctx: staff() }),
      () => start([{ id }], { ctx: asMcp() }),
    ];
    for (const call of callers) {
      expect((await refusal(call())).details).toMatchObject({ rule: "sale_window" });
    }
  });

  it("the approval queue's dry run reports the refusal and queues nothing", async () => {
    await setPreset("cautious");
    const { id: closed } = await ticketType({ onSaleUntil: earlier });
    const before = await env.DB.prepare("SELECT count(*) AS n FROM core_pending_action").first<{
      n: number;
    }>();
    expect((await refusal(start([{ id: closed }], { ctx: asMcp() }))).details).toMatchObject({
      rule: "sale_window",
    });
    const { id: limited } = await ticketType({ maxPerOrder: 1 });
    expect(
      (await refusal(start([{ id: limited, quantity: 2 }], { ctx: asMcp() }))).details,
    ).toMatchObject({ rule: "max_per_order" });
    const after = await env.DB.prepare("SELECT count(*) AS n FROM core_pending_action").first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
  });
});

// --- Criterion 5 -------------------------------------------------------------------------------

describe("abandoned (criterion 5)", () => {
  it("an unpaid order expires, its places return, and nothing was granted", async () => {
    const { id, event } = await ticketType();
    const order = await start([{ id, quantity: 2 }]);
    await checkout(order);
    expect(await counter(EVENT, event)).toMatchObject({ held: 2 });
    const swept = await run<{ expired: string[] }>(
      "order.expireDue",
      {},
      staff({ actor: "automation", clock: () => new Date(Date.now() + 16 * 60_000) }),
    );
    expect(swept.expired).toContain(order.id);
    expect(await state(order.id)).toBe("expired");
    expect(await counter(TICKET_TYPE, id)).toMatchObject({ held: 0, taken: 0 });
    expect(await counter(EVENT, event)).toMatchObject({ held: 0, taken: 0 });
    expect(await granted(order.id)).toEqual([]);
  });

  it("a late payment staff honour grants then", async () => {
    const { id } = await ticketType();
    const order = await start([{ id }]);
    await checkout(order);
    await run(
      "order.expireDue",
      {},
      staff({ actor: "automation", clock: () => new Date(Date.now() + 16 * 60_000) }),
    );
    const { result } = await providerPays(order.id);
    expect(result.outcome).toBe("late");
    expect(await granted(order.id)).toEqual([]);
    await run("order.honourLate", { id: order.id }, staff());
    expect(await state(order.id)).toBe("paid");
    expect(await granted(order.id)).toHaveLength(1);
  });
});

// --- Criterion 6 -------------------------------------------------------------------------------

describe("refunded (criterion 6)", () => {
  it("a full refund voids what was granted, used or not, and returns the places", async () => {
    const { id, event } = await ticketType();
    const order = await start([{ id, quantity: 2 }]);
    await pay(order);
    const [first] = await granted(order.id);
    // One ticket was used at the door.
    await run(
      "record.update",
      { object: TICKET, id: first?.id, values: { state: "used" } },
      staff(),
    );
    await refundInFull(order.id);
    expect(await state(order.id)).toBe("refunded");
    expect((await granted(order.id)).map((t) => t.values.state)).toEqual(["void", "void"]);
    expect(await counter(TICKET_TYPE, id)).toMatchObject({ held: 0, taken: 0 });
    expect(await counter(EVENT, event)).toMatchObject({ held: 0, taken: 0 });
  });

  it("a part refund voids nothing", async () => {
    const { id } = await ticketType();
    const order = await start([{ id, quantity: 2 }]);
    await pay(order);
    const asked = await run<{ refunds: { pendingActionId: string }[] }>(
      "order.refund",
      { id: order.id, amount: 1000, reason: "A goodwill refund" },
      staff(),
    );
    await run("approval.approve", { actionIds: [asked.refunds[0]?.pendingActionId] }, staff());
    await providerRefunds(gw.action);
    expect(await state(order.id)).toBe("paid");
    expect((await granted(order.id)).map((t) => t.values.state)).toEqual(["valid", "valid"]);
  });
});

// --- Criterion 6a, the host's half -------------------------------------------------------------

describe("paying by deposit (criterion 6a, the host's half)", () => {
  const deposit = { price: 1000, depositAmount: 200, balanceDue: NEXT_YEAR };

  it("the ticket is granted at the first payment, and paying the rest grants nothing more", async () => {
    const { id } = await ticketType(deposit);
    const order = await start([{ id }], { pay: "deposit" });
    await pay(order);
    const row = await loadOrderRow(db.query, order.id);
    expect(row).toMatchObject({ state: "part_paid", paid: 20000, total: 100000 });
    const tickets = await granted(order.id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.createdAt).toBe(row.updated_at);
    // The rest, in two parts.
    await checkout(order, 30000);
    await providerPays(order.id);
    expect(await state(order.id)).toBe("part_paid");
    await checkout(order);
    await providerPays(order.id);
    expect(await state(order.id)).toBe("paid");
    expect(await granted(order.id)).toHaveLength(1);
  });

  it("cancelled by staff after the due date: the ticket is void and the place returns", async () => {
    const { id, event } = await ticketType(deposit);
    const order = await start([{ id }], { pay: "deposit" });
    await pay(order);
    expect(await counter(EVENT, event)).toMatchObject({ taken: 1 });
    const pastDue = () => new Date(Date.parse(`${NEXT_YEAR}T12:00:00Z`) + 2 * DAY);
    const overdue = await run<{ items: { id: string }[] }>(
      "order.overdue",
      {},
      staff({ clock: pastDue }),
    );
    expect(overdue.items.map((o) => o.id)).toContain(order.id);
    await run("order.cancel", { id: order.id }, staff({ clock: pastDue }));
    expect(await state(order.id)).toBe("cancelled");
    expect((await granted(order.id)).map((t) => t.values.state)).toEqual(["void"]);
    expect(await counter(TICKET_TYPE, id)).toMatchObject({ held: 0, taken: 0 });
    expect(await counter(EVENT, event)).toMatchObject({ held: 0, taken: 0 });
  });

  it("a cancel the approval queue holds voids nothing in its dry run, and voids when approved", async () => {
    await setPreset("cautious");
    const { id } = await ticketType(deposit);
    const order = await start([{ id }], { pay: "deposit" });
    await pay(order);
    const queued = await run("order.cancel", { id: order.id }, asMcp()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(queued).toBeInstanceOf(PendingApprovalError);
    expect(await state(order.id)).toBe("part_paid");
    expect((await granted(order.id)).map((t) => t.values.state)).toEqual(["valid"]);
    await run(
      "approval.approve",
      { actionIds: [(queued as PendingApprovalError).pending.actionId] },
      staff(),
    );
    expect(await state(order.id)).toBe("cancelled");
    expect((await granted(order.id)).map((t) => t.values.state)).toEqual(["void"]);
  });
});

// --- What only the host may do -------------------------------------------------------------------

describe("granted records", () => {
  it("their code is the host's: nobody can set or change it", async () => {
    const { id } = await ticketType();
    const order = await start([{ id }]);
    await pay(order);
    const [ticket] = await granted(order.id);
    const refused = await refusal(
      run("record.update", { object: TICKET, id: ticket?.id, values: { code: "MINE" } }, staff()),
    );
    expect(refused.code).toBe("invalid_input");
    expect(refused.details).toMatchObject({ field: "code" });
  });

  it("an object that declares no sellable cannot be bought", async () => {
    const event = await create(EVENT, { name: unique("Not for sale"), places: 10 });
    const refused = await refusal(start([{ object: EVENT, id: event }]));
    expect(refused.details).toMatchObject({ rule: "not_for_sale" });
  });
});
