// Stage 27, build steps 2 and 3: the Ticketing pack (packs/ticketing) in the real host. Its
// source is installed the way a product that lists the pack installs it (a shipped extension,
// committed to the workspace and run in the sandbox), with real D1, the real payments gatekeeper
// and its fake provider, and the fake email provider's outbox.
//
// Acceptance criteria: 1 (a product without the pack has none of it; with it, its objects), 2
// (buy two ticket types, pay, the right number of valid tickets with distinct codes, one email),
// 3 (sale window, most per order, places), 4 (never oversold, through orderStart, inside an event
// pool), 5 (abandoned), 6 (refund), 6a (deposit), 6b (the door role over the whole registry), 7
// (check-in) and 8 (isolation). Criterion 9 (public reads) needs a host rule that does not exist
// yet: see the stage's build notes.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type AnyOperation,
  type CustomerPrincipal,
  coreRegistry,
  type ExtensionHost,
  getObject,
  type InvocationContext,
  invokeByName,
  loadExtensionOperations,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listedPacks } from "../src/extensions/shipped-list.ts";
import { fakeProviderStub } from "../src/integrations/fake.ts";
import { blobStore, integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const files = Object.fromEntries(
  Object.entries(
    // The pack's extension files, as a release carries them (not its config or tests).
    import.meta.glob<string>(["../../../packs/ticketing/*.ts", "!**/vitest.config.ts"], {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([path, text]) => [path.split("/").pop() as string, text]),
);

/** The extension host of a deployment whose product lists Ticketing. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [...(await host.shipped()), { id: "ticketing", version: "0.1.0" }],
  commitShipped: (id) =>
    id === "ticketing"
      ? host.commit({
          id,
          files,
          message: "Shipped ticketing 0.1.0",
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const RETURN = "https://gym.test/thanks";
const EVENT = "ticketing.event";
const TICKET_TYPE = "ticketing.tickettype";
const TICKET = "ticketing.ticket";
const DAY = 86_400_000;
const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;

let admin: ActingUser;
let door: ActingUser;
let outbox: string;

const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  integrations,
  blobs: blobStore(env),
  extensionHost: shippedHost,
  ...extra,
});
const guest: OutsideInvocationContext = {
  principal: { kind: "public" },
  db,
  integrations,
  extensionHost: shippedHost,
};
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  integrations,
  extensionHost: shippedHost,
});

function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
): Promise<T> {
  return invokeByName(name, input, ctx) as Promise<T>;
}

/** What a call was refused with: its code and the host's details (unwrapped from a tool's). */
async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; details?: Record<string, unknown> };
    const inner = (e.details?.details ?? e.details) as Record<string, unknown> | undefined;
    return { code: e.code, inner: e.details?.code, details: inner };
  }
  throw new Error("expected a refusal");
}

interface Order {
  id: string;
  state: string;
  total: number;
  paid: number;
  balance: number;
  deposit: number | null;
  balanceDueAt: string | null;
  token: string | null;
  lines: { ticketTypeId: string; quantity: number }[];
}

async function createRecord(object: string, values: Record<string, unknown>): Promise<string> {
  return (await run<{ id: string }>("record.create", { object, values }, staff(admin))).id;
}

/** An event on sale with `places`, and ticket types of it. */
async function eventWith(
  types: Record<string, unknown>[],
  places: number | null = 100,
): Promise<{ event: string; types: string[] }> {
  const event = await createRecord(EVENT, { name: unique("Gains"), places });
  await run(
    "record.update",
    { object: EVENT, id: event, values: { status: "on_sale" } },
    staff(admin),
  );
  const ids: string[] = [];
  for (const values of types) {
    ids.push(
      await createRecord(TICKET_TYPE, { event, name: unique("Type"), price: 45, ...values }),
    );
  }
  return { event, types: ids };
}

const buyerEmail = () => `${unique("buyer")}@buyers.test`.toLowerCase();

async function checkoutAndPay(order: Order, ctx: OutsideInvocationContext, amount?: number) {
  const checkout = await run<{ url: string; amount: number }>(
    "order.checkout",
    {
      id: order.id,
      ...(order.token ? { token: order.token } : {}),
      returnUrl: RETURN,
      ...(amount ? { amount } : {}),
    },
    ctx,
  );
  const paid = await runner.gatekeeperFetch(
    "payments",
    new Request(checkout.url, {
      method: "POST",
      body: new URLSearchParams({ outcome: "pay" }),
      redirect: "manual",
    }),
  );
  expect(paid.status).toBe(303);
  return checkout;
}

async function orderState(id: string): Promise<{ state: string; paid: number; balance: number }> {
  return run("order.get", { id }, staff(admin));
}

async function waitForState(id: string, state: string) {
  await vi.waitFor(async () => expect((await orderState(id)).state).toBe(state), {
    timeout: 20_000,
  });
}

/** The tickets an order granted, as staff read them. */
async function ticketsOf(orderId: string) {
  const page = await run<{ items: { id: string; values: Record<string, unknown> }[] }>(
    "record.list",
    { object: TICKET, filter: { field: "order", op: "eq", value: orderId }, limit: 100 },
    staff(admin),
  );
  return page.items;
}

async function counter(object: string, id: string) {
  return env.DB.prepare(
    "SELECT held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(object, id)
    .first<{ held: number; taken: number }>();
}

async function createCustomer(
  label: string,
): Promise<{ principal: CustomerPrincipal; email: string }> {
  const tag = unique(label).toLowerCase();
  const email = `${tag}@buyers.test`;
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: `Given-${tag}`, emails: [{ email }] },
    staff(admin),
  );
  const customerId = `cus_${tag}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(customerId, person.id, email, now, now)
    .run();
  return { principal: { kind: "customer", customerId, personId: person.id }, email };
}

async function createStaff(role: "member" | "viewer", name: string): Promise<ActingUser> {
  const id = `usr_${unique("staff")}`;
  const email = `${unique("staff")}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 1, ?, ?, ?)",
  )
    .bind(id, name, email, now, now, role)
    .run();
  return { id, email, name, role };
}

/** The fake provider's consent page and handoff, for the org (as customer-mail.test.ts). */
async function connectFakeMail(address: string): Promise<string> {
  const created = await run<{
    connection: { id: string };
    connect: { url: string; nonce: string };
  }>("connection.create", { vendor: "fake", scope: "org", sharingLevel: "full" }, staff(admin));
  const url = `http://crm.test${created.connect.url}`;
  await runner.gatekeeperFetch("fake", new Request(url));
  const done = await runner.gatekeeperFetch(
    "fake",
    new Request(url, { method: "POST", body: new URLSearchParams({ address }) }),
  );
  const ticket = /var ticket = "([^"]+)"/.exec(await done.text())?.[1] ?? "";
  await run(
    "connection.completeConnect",
    { connectionId: created.connection.id, ticket, nonce: created.connect.nonce },
    staff(admin),
  );
  await run(
    "connection.bindResource",
    { id: created.connection.id, url: `fake://outbox/${encodeURIComponent(address)}` },
    staff(admin),
  );
  return created.connection.id;
}

async function emailsTo(address: string) {
  return (await fakeProviderStub(env, outbox).sent()).filter((m) => m.to.includes(address));
}

// --- Criterion 1: a product turns it on ----------------------------------------------------------

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");

  // This runner is built for the CRM, whose product does not list Ticketing: its release has no
  // ticketing pack, and the host has none of its objects or tools.
  expect(listedPacks("*").map((p) => p.id)).not.toContain("ticketing");
  await refreshSchemaRegistry(db.query);
  expect(getObject(EVENT)).toBeUndefined();
  expect(await refusal(run("x.ticketing.checkIn", { code: "x" }, staff(admin)))).toMatchObject({
    code: "unknown_operation",
  });

  // A deployment of a product that lists it installs it as shipped.
  await run("extension.install", { id: "ticketing", shipped: true }, staff(admin));
  await refreshSchemaRegistry(db.query);
  expect(getObject(EVENT)?.label).toBe("Event");
  expect(getObject(TICKET_TYPE)?.sellable).toBeDefined();
  expect(getObject(TICKET)?.customer?.field).toBe("holder");

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
  // The buyer's confirmation goes through the email channel (Settings → Notification delivery).
  await run("integration.setVendor", { vendor: "fake", enabled: true }, staff(admin));
  outbox = `${unique("box-office")}@example.com`;
  const mail = await connectFakeMail(outbox);
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('notification_delivery', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify({ email: mail }), new Date().toISOString())
    .run();

  // A coach with the door role (6b): given by a human admin.
  door = await createStaff("member", "Coach Kim");
  await run("user.setPackRole", { id: door.id, role: "ticketing.door" }, staff(admin));
}, 120_000);

afterAll(() => setPreset("balanced"));

describe("the pack in a product (criterion 1)", () => {
  it("is installed as shipped with its objects, tools and role", async () => {
    const row = await env.DB.prepare("SELECT source, status FROM core_extensions WHERE id = ?")
      .bind("ticketing")
      .first();
    expect(row).toEqual({ source: "shipped", status: "active" });
    const roles = await run<{ items: { name: string; permissions: string[]; read: string[] }[] }>(
      "user.packRoles",
      {},
      staff(admin),
    );
    expect(roles.items).toEqual([
      {
        name: "ticketing.door",
        label: "Door",
        description: expect.any(String),
        permissions: ["ticketing:checkin"],
        read: [EVENT, TICKET_TYPE, TICKET],
      },
    ]);
  });
});

// --- Criterion 2: buy ----------------------------------------------------------------------------

describe("buying (criterion 2)", () => {
  it("a guest buys two ticket types, pays, and has the right valid tickets with their own codes", async () => {
    const { types } = await eventWith([{ price: 45 }, { price: 120 }]);
    const email = buyerEmail();
    const order = await run<Order>(
      "x.ticketing.orderStart",
      {
        lines: [
          { ticketTypeId: types[0], quantity: 2 },
          { ticketTypeId: types[1], quantity: 1 },
        ],
        email,
      },
      guest,
    );
    // Priced by the host from the ticket types: 2 × 45 + 120, in cents.
    expect(order).toMatchObject({ state: "pending", total: 21000, paid: 0 });
    expect(order.token).toEqual(expect.any(String));
    expect(await ticketsOf(order.id)).toEqual([]);

    await checkoutAndPay(order, guest);
    await waitForState(order.id, "paid");
    const tickets = await ticketsOf(order.id);
    expect(tickets).toHaveLength(3);
    expect(tickets.every((t) => t.values.state === "valid")).toBe(true);
    expect(new Set(tickets.map((t) => t.values.code)).size).toBe(3);
    expect(tickets.filter((t) => t.values.tickettype === types[0])).toHaveLength(2);
    // Every ticket is the buyer's Person, matched or created from the email.
    const holders = new Set(tickets.map((t) => t.values.holder));
    expect(holders.size).toBe(1);
    // Granted in the batch that marked the order paid (ADR 0435): the grants and the move to
    // paid carry the one timestamp the batch was written with.
    const paidAt = await env.DB.prepare(
      "SELECT entered_at FROM core_transition_history WHERE object_type = 'order' AND record_id = ? AND position_id = 'paid'",
    )
      .bind(order.id)
      .first<{ entered_at: string }>();
    const grants = await env.DB.prepare(
      "SELECT DISTINCT created_at FROM core_order_grant WHERE order_id = ?",
    )
      .bind(order.id)
      .all<{ created_at: string }>();
    expect(grants.results).toEqual([{ created_at: paidAt?.entered_at }]);
    // The buyer got one email.
    await vi.waitFor(async () => expect(await emailsTo(email)).toHaveLength(1), {
      timeout: 15_000,
    });
  });
});

// --- Criterion 3: the host's rules ---------------------------------------------------------------

describe("the host's rules (criterion 3)", () => {
  async function noOrderFor(email: string) {
    const row = await env.DB.prepare("SELECT count(*) AS n FROM core_order WHERE email = ?")
      .bind(email)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  }

  it("refuses a line outside the sale window, with details, and leaves no order", async () => {
    const from = new Date(Date.now() + 7 * DAY).toISOString();
    const { types } = await eventWith([{ onSaleFrom: from }]);
    const email = buyerEmail();
    const refused = await refusal(
      run("x.ticketing.orderStart", { lines: [{ ticketTypeId: types[0] }], email }, guest),
    );
    expect(refused).toMatchObject({ code: "extension_error", inner: "invalid_input" });
    expect(refused.details).toMatchObject({ rule: "sale_window", line: 0, from });
    await noOrderFor(email);
  });

  it("refuses more than the most per order", async () => {
    const { types } = await eventWith([{ maxPerOrder: 2 }]);
    const email = buyerEmail();
    const refused = await refusal(
      run(
        "x.ticketing.orderStart",
        { lines: [{ ticketTypeId: types[0], quantity: 3 }], email },
        guest,
      ),
    );
    expect(refused.details).toMatchObject({ rule: "max_per_order", max: 2, asked: 3 });
    await noOrderFor(email);
  });

  it("refuses more places than remain, in the ticket type or its event", async () => {
    const { types } = await eventWith([{ places: 1 }, { places: 50 }], 3);
    const email = buyerEmail();
    const overType = await refusal(
      run(
        "x.ticketing.orderStart",
        { lines: [{ ticketTypeId: types[0], quantity: 2 }], email },
        guest,
      ),
    );
    // A guest is told only that there are not enough places (ADR 0429): never the numbers.
    expect(overType.details).toEqual({ rule: "capacity" });
    const overEvent = await refusal(
      run(
        "x.ticketing.orderStart",
        { lines: [{ ticketTypeId: types[1], quantity: 4 }], email },
        guest,
      ),
    );
    expect(overEvent.details).toEqual({ rule: "capacity" });
    // A deployment's staff see the numbers: the event's pool is what refused.
    const asStaff = await refusal(
      run(
        "order.start",
        { lines: [{ object: TICKET_TYPE, id: types[1], quantity: 4 }], email },
        staff(admin),
      ),
    );
    expect(asStaff.details).toMatchObject({ rule: "capacity", object: EVENT, available: 3 });
    await noOrderFor(email);
  });
});

// --- Criterion 4: never oversold -----------------------------------------------------------------

describe("never oversold (criterion 4)", () => {
  it("500 guests at once for 100 places in an event pool: exactly 100 orders", async () => {
    // The ticket type has more places than its event: the event's pool is what runs out.
    const { event, types } = await eventWith([{ places: 400 }], 100);
    const outcomes = await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        run<Order>(
          "x.ticketing.orderStart",
          { lines: [{ ticketTypeId: types[0] }], email: `rush${i}.${unique("r")}@buyers.test` },
          guest,
        ).then(
          (order) => ({ ok: true as const, order }),
          (error: { details?: { code?: string; details?: { rule?: string } } }) => ({
            ok: false as const,
            code: error.details?.code,
            rule: error.details?.details?.rule,
          }),
        ),
      ),
    );
    const won = outcomes.filter((o) => o.ok);
    const lost = outcomes.filter((o) => !o.ok);
    expect(won).toHaveLength(100);
    expect(lost).toHaveLength(400);
    expect(lost.every((o) => o.code === "invalid_input" && o.rule === "capacity")).toBe(true);
    expect(await counter(EVENT, event)).toEqual({ held: 100, taken: 0 });
    expect(await counter(TICKET_TYPE, types[0] as string)).toEqual({ held: 100, taken: 0 });
  }, 300_000);
});

// --- Criterion 5: abandoned ----------------------------------------------------------------------

describe("abandoned (criterion 5)", () => {
  it("an unpaid order expires, its places return, and no ticket was granted", async () => {
    const { event, types } = await eventWith([{}]);
    const order = await run<Order>(
      "x.ticketing.orderStart",
      { lines: [{ ticketTypeId: types[0], quantity: 2 }], email: buyerEmail() },
      guest,
    );
    expect(await counter(EVENT, event)).toEqual({ held: 2, taken: 0 });
    // The minute cron's sweep, in its batches, until this order's turn (the rush above left
    // pending orders too).
    const expired: string[] = [];
    for (let batch = 0; batch < 20 && !expired.includes(order.id); batch += 1) {
      const swept = await run<{ expired: string[] }>(
        "order.expireDue",
        {},
        staff(admin, { actor: "automation", clock: () => new Date(Date.now() + 16 * 60_000) }),
      );
      if (!swept.expired.length) break;
      expired.push(...swept.expired);
    }
    expect(expired).toContain(order.id);
    expect((await orderState(order.id)).state).toBe("expired");
    expect(await counter(EVENT, event)).toEqual({ held: 0, taken: 0 });
    expect(await ticketsOf(order.id)).toEqual([]);
  });
});

// --- Criterion 6: refund -------------------------------------------------------------------------

describe("refund (criterion 6)", () => {
  it("a full refund voids the order's tickets and returns the places", async () => {
    const { event, types } = await eventWith([{}]);
    const order = await run<Order>(
      "x.ticketing.orderStart",
      { lines: [{ ticketTypeId: types[0], quantity: 2 }], email: buyerEmail() },
      guest,
    );
    await checkoutAndPay(order, guest);
    await waitForState(order.id, "paid");
    expect(await counter(EVENT, event)).toEqual({ held: 0, taken: 2 });
    const asked = await run<{ refunds: { pendingActionId: string | null }[] }>(
      "order.refund",
      { id: order.id, reason: "The camp moved" },
      staff(admin),
    );
    const actionId = asked.refunds[0]?.pendingActionId as string;
    await run("approval.approve", { actionIds: [actionId] }, staff(admin));
    await waitForState(order.id, "refunded");
    const tickets = await ticketsOf(order.id);
    expect(tickets.map((t) => t.values.state)).toEqual(["void", "void"]);
    expect(await counter(EVENT, event)).toEqual({ held: 0, taken: 0 });
    expect(await counter(TICKET_TYPE, types[0] as string)).toEqual({ held: 0, taken: 0 });
  });
});

// --- Criterion 6a: deposit -----------------------------------------------------------------------

describe("paying by deposit (criterion 6a)", () => {
  const deposit = { price: 1000, depositAmount: 200, balanceDue: NEXT_YEAR };

  it("grants at the first payment, shows the balance, checks in owing, and pays off in two parts", async () => {
    const { types } = await eventWith([deposit]);
    const buyer = await createCustomer("deposit");
    const order = await run<Order>(
      "x.ticketing.orderStart",
      { lines: [{ ticketTypeId: types[0] }], pay: "deposit" },
      as(buyer.principal),
    );
    expect(order).toMatchObject({ total: 100000, deposit: 20000, balance: 100000 });
    expect(order.balanceDueAt).toContain(NEXT_YEAR);
    await checkoutAndPay(order, as(buyer.principal));
    await waitForState(order.id, "part_paid");
    const [ticket] = await ticketsOf(order.id);
    expect(ticket?.values).toMatchObject({ state: "valid", holder: buyer.principal.personId });
    const now = await run<Order>("order.get", { id: order.id }, as(buyer.principal));
    expect(now).toMatchObject({ state: "part_paid", paid: 20000, balance: 80000 });
    expect(now.balanceDueAt).toContain(NEXT_YEAR);

    // At the door with the balance still owing: let in, and told how much.
    const scan = await run<{ accepted: boolean; balanceOwing: unknown; message: string }>(
      "x.ticketing.checkIn",
      { code: ticket?.values.code },
      staff(door),
    );
    expect(scan.accepted).toBe(true);
    expect(scan.balanceOwing).toEqual({
      amount: 80000,
      currency: "AUD",
      dueAt: expect.stringContaining(NEXT_YEAR),
    });

    // The rest in two parts.
    await checkoutAndPay(now, as(buyer.principal), 30000);
    await vi.waitFor(async () => expect((await orderState(order.id)).paid).toBe(50000), {
      timeout: 20_000,
    });
    expect((await orderState(order.id)).state).toBe("part_paid");
    await checkoutAndPay(now, as(buyer.principal), 50000);
    await waitForState(order.id, "paid");
    // Paying the rest granted nothing more.
    expect(await ticketsOf(order.id)).toHaveLength(1);
  });

  it("cancelled by staff after the due date: the ticket is void and the place returns", async () => {
    const { event, types } = await eventWith([deposit]);
    const buyer = await createCustomer("lapsed");
    const order = await run<Order>(
      "x.ticketing.orderStart",
      { lines: [{ ticketTypeId: types[0] }], pay: "deposit" },
      as(buyer.principal),
    );
    await checkoutAndPay(order, as(buyer.principal));
    await waitForState(order.id, "part_paid");
    expect(await counter(EVENT, event)).toEqual({ held: 0, taken: 1 });
    const pastDue = () => new Date(Date.parse(`${NEXT_YEAR}T00:00:00Z`) + 3 * DAY);
    await run("order.cancel", { id: order.id }, staff(admin, { clock: pastDue }));
    expect((await orderState(order.id)).state).toBe("cancelled");
    expect((await ticketsOf(order.id)).map((t) => t.values.state)).toEqual(["void"]);
    expect(await counter(EVENT, event)).toEqual({ held: 0, taken: 0 });
  });
});

// --- Criterion 7: check-in -----------------------------------------------------------------------

/** A paid order's tickets, bought by a guest. */
async function paidTickets(quantity = 1) {
  const { types, event } = await eventWith([{}]);
  const order = await run<Order>(
    "x.ticketing.orderStart",
    { lines: [{ ticketTypeId: types[0], quantity }], email: buyerEmail() },
    guest,
  );
  await checkoutAndPay(order, guest);
  await waitForState(order.id, "paid");
  return { order, event, tickets: await ticketsOf(order.id) };
}

interface Scan {
  result: string;
  accepted: boolean;
  message: string;
  ticket: { usedAt: string | null; usedBy: { id: string; name: string | null } | null } | null;
}

describe("check-in (criterion 7)", () => {
  it("a valid code is accepted once; a second scan says who used it and when", async () => {
    const { tickets } = await paidTickets();
    const code = tickets[0]?.values.code as string;
    const first = await run<Scan>("x.ticketing.checkIn", { code }, staff(door));
    expect(first).toMatchObject({ result: "accepted", accepted: true });
    expect(first.ticket?.usedBy).toEqual({ id: door.id, name: "Coach Kim" });
    const second = await run<Scan>(
      "x.ticketing.checkIn",
      { code: code.toLowerCase() },
      staff(admin),
    );
    expect(second).toMatchObject({ result: "already_used", accepted: false });
    expect(second.ticket?.usedBy).toEqual({ id: door.id, name: "Coach Kim" });
    expect(second.ticket?.usedAt).toBe(first.ticket?.usedAt);
    expect(second.message).toContain("Coach Kim");
    expect(second.message).toContain(first.ticket?.usedAt as string);
  });

  it("a void ticket and an unknown code are refused with different, clear reasons", async () => {
    const { tickets } = await paidTickets();
    const id = tickets[0]?.id as string;
    await run("record.update", { object: TICKET, id, values: { state: "void" } }, staff(admin));
    const voided = await run<Scan>(
      "x.ticketing.checkIn",
      { code: tickets[0]?.values.code },
      staff(door),
    );
    const unknown = await run<Scan>(
      "x.ticketing.checkIn",
      { code: "ZZZZZZZZZZZZZZZZZZZZZZZZZZ" },
      staff(door),
    );
    expect(voided).toMatchObject({ result: "void", accepted: false });
    expect(unknown).toMatchObject({ result: "unknown", accepted: false, ticket: null });
    expect(voided.message).not.toBe(unknown.message);
  });

  it("two scanners scanning the same code at once accept it once", async () => {
    const { tickets } = await paidTickets();
    const code = tickets[0]?.values.code as string;
    const scanners = [door, admin, door, admin, door, admin];
    const scans = await Promise.all(
      scanners.map((user) => run<Scan>("x.ticketing.checkIn", { code }, staff(user))),
    );
    expect(scans.filter((s) => s.accepted)).toHaveLength(1);
    const winner = scans.find((s) => s.accepted);
    for (const scan of scans.filter((s) => !s.accepted)) {
      expect(scan.result).toBe("already_used");
      expect(scan.ticket?.usedBy).toEqual(winner?.ticket?.usedBy);
    }
    // One move into `used` in the ticket's history.
    const moves = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_transition_history WHERE object_type = ? AND record_id = ? AND position_id = 'used'",
    )
      .bind(TICKET, tickets[0]?.id)
      .first<{ n: number }>();
    expect(moves?.n).toBe(1);
  }, 60_000);

  it("a check-in can be undone, and then accepted again", async () => {
    const { tickets } = await paidTickets();
    const code = tickets[0]?.values.code as string;
    const id = tickets[0]?.id as string;
    expect((await run<Scan>("x.ticketing.checkIn", { code }, staff(door))).accepted).toBe(true);
    const undone = await run<{ undone: boolean }>(
      "x.ticketing.undoCheckIn",
      { ticketId: id },
      staff(door),
    );
    expect(undone.undone).toBe(true);
    expect((await run<Scan>("x.ticketing.checkIn", { code }, staff(door))).accepted).toBe(true);
  });
});

// --- Criterion 8: isolation ----------------------------------------------------------------------

describe("isolation (criterion 8)", () => {
  it("a customer never sees another's ticket or code, and guessing codes finds nothing", async () => {
    const { types } = await eventWith([{}]);
    const a = await createCustomer("a");
    const b = await createCustomer("b");
    const bought: Record<string, Order> = {};
    for (const [label, who] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const order = await run<Order>(
        "x.ticketing.orderStart",
        { lines: [{ ticketTypeId: types[0], quantity: 2 }] },
        as(who.principal),
      );
      await checkoutAndPay(order, as(who.principal));
      await waitForState(order.id, "paid");
      bought[label] = order;
    }
    const bTickets = await ticketsOf(bought.b?.id as string);
    type Mine = { items: { id: string; code: string | null; event: string | null }[] };
    const mine = await run<Mine>("x.ticketing.myTickets", {}, as(a.principal));
    const aTickets = await ticketsOf(bought.a?.id as string);
    expect(mine.items.map((t) => t.id).sort()).toEqual(aTickets.map((t) => t.id).sort());
    // What a holder reads of a ticket: its event, type, code and state, nothing else.
    const one = await run<{ values: Record<string, unknown> }>(
      "my.get",
      { object: TICKET, id: aTickets[0]?.id },
      as(a.principal),
    );
    expect(Object.keys(one.values).sort()).toEqual(["code", "event", "state", "tickettype"]);
    // B's ticket and B's code are not there for A.
    expect(
      await refusal(run("my.get", { object: TICKET, id: bTickets[0]?.id }, as(a.principal))),
    ).toMatchObject({
      code: "not_found",
    });
    const guessed = await run<Mine>(
      "x.ticketing.myTickets",
      { code: bTickets[0]?.values.code as string },
      as(a.principal),
    );
    expect(guessed.items).toEqual([]);
    for (let i = 0; i < 20; i += 1) {
      const code = Array.from(
        { length: 26 },
        () => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)],
      ).join("");
      expect((await run<Mine>("x.ticketing.myTickets", { code }, as(a.principal))).items).toEqual(
        [],
      );
    }
    // And no ticket is anyone's but the customer's: the public has no tickets at all.
    expect(await refusal(run("x.ticketing.myTickets", {}, guest))).toMatchObject({
      code: "unknown_operation",
    });
  });
});

// --- Criterion 6b: the door role -----------------------------------------------------------------

describe("the door role (criterion 6b, ADR 0436)", () => {
  /** Operations a door-only account may call: the pack's two check-in tools and two reads. */
  const DOOR_MAY = new Set([
    "x.ticketing.checkIn",
    "x.ticketing.undoCheckIn",
    "record.get",
    "record.list",
  ]);

  it("can check in and list an event's tickets", async () => {
    const { event, tickets } = await paidTickets(2);
    const list = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: TICKET, filter: { field: "event", op: "eq", value: event } },
      staff(door),
    );
    expect(list.items.map((t) => t.id).sort()).toEqual(tickets.map((t) => t.id).sort());
    await run("record.get", { object: EVENT, id: event }, staff(door));
    await run("record.list", { object: TICKET_TYPE }, staff(door));
    const scan = await run<Scan>(
      "x.ticketing.checkIn",
      { code: tickets[0]?.values.code },
      staff(door),
    );
    expect(scan.accepted).toBe(true);
  });

  it("is refused every other operation in the registry, before its input is read", async () => {
    const all: AnyOperation[] = [
      ...coreRegistry.list(),
      ...(await loadExtensionOperations(db.query)),
    ];
    expect(all.some((op) => op.name === "x.ticketing.checkIn")).toBe(true);
    const leaked: string[] = [];
    for (const op of all) {
      if (DOOR_MAY.has(op.name)) continue;
      const outcome = await refusal(run(op.name, {}, staff(door))).catch(() => ({
        code: "ran",
      }));
      // A staff-facing operation answers `forbidden`; one open to customers or the public only
      // does not exist for staff at all.
      if (outcome.code !== "forbidden" && outcome.code !== "unknown_operation") {
        leaked.push(`${op.name}: ${outcome.code}`);
      }
    }
    expect(leaked).toEqual([]);
    // The reads it may make are on its three objects only.
    for (const object of ["person", "organisation", "task", "deals.deal", "order"]) {
      for (const name of ["record.get", "record.list"]) {
        expect(
          await refusal(run(name, { object, id: "rec_x" }, staff(door))),
          `${name} ${object}`,
        ).toMatchObject({ code: "forbidden" });
      }
    }
    // The sales summary is staff work the door does not do.
    expect(
      await refusal(run("x.ticketing.salesSummary", { eventId: "x" }, staff(door))),
    ).toMatchObject({ code: "forbidden" });
  }, 120_000);

  it("holds for every way an account is built: the account's column is what the pipeline reads", async () => {
    // An adapter that builds the user from the row (MCP, the assistant, run-as) and never heard
    // of pack roles still gets a door-only account: its `role` is viewer, and the role is read
    // on every call.
    const row = await env.DB.prepare("SELECT role, pack_role FROM core_user WHERE id = ?")
      .bind(door.id)
      .first();
    expect(row).toEqual({ role: "viewer", pack_role: "ticketing.door" });
    const asMember = { ...door, role: "member" as const };
    expect(await refusal(run("person.list", {}, staff(asMember)))).toMatchObject({
      code: "forbidden",
    });
    expect(
      await refusal(
        run("person.list", {}, staff(door, { actor: "mcp", origin: { surface: "mcp" } })),
      ),
    ).toMatchObject({ code: "forbidden" });
  });

  it("is given and taken away by a human admin only, and audited", async () => {
    const coach = await createStaff("viewer", "Coach Lee");
    const member = await createStaff("member", "Plain member");
    // Not by an AI or an MCP client, and not by someone who is not an admin.
    expect(
      await refusal(
        run(
          "user.setPackRole",
          { id: coach.id, role: "ticketing.door" },
          staff(admin, { actor: "mcp", origin: { surface: "mcp" } }),
        ),
      ),
    ).toMatchObject({ code: "forbidden" });
    expect(
      await refusal(
        run("user.setPackRole", { id: coach.id, role: "ticketing.door" }, staff(member)),
      ),
    ).toMatchObject({ code: "forbidden" });
    // Not a role no pack declares, and not to an admin.
    expect(
      await refusal(
        run("user.setPackRole", { id: coach.id, role: "ticketing.boss" }, staff(admin)),
      ),
    ).toMatchObject({ code: "invalid_input" });
    const otherAdmin = await createAdmin();
    expect(
      await refusal(
        run("user.setPackRole", { id: otherAdmin.id, role: "ticketing.door" }, staff(admin)),
      ),
    ).toMatchObject({ code: "conflict" });

    await run("user.setPackRole", { id: coach.id, role: "ticketing.door" }, staff(admin));
    expect(await refusal(run("person.list", {}, staff(coach)))).toMatchObject({
      code: "forbidden",
    });
    // While it is held their role cannot be changed past it.
    expect(
      await refusal(run("user.updateRole", { id: coach.id, role: "admin" }, staff(admin))),
    ).toMatchObject({ code: "conflict" });
    const users = await run<{ items: { id: string; packRole: string | null }[] }>(
      "user.list",
      { filter: { field: "id", op: "eq", value: coach.id } },
      staff(admin),
    );
    expect(users.items[0]?.packRole).toBe("ticketing.door");

    await run("user.setPackRole", { id: coach.id, role: null }, staff(admin));
    await run("person.list", {}, staff(coach));
    const audit = await env.DB.prepare(
      "SELECT a.outcome, c.diff FROM core_audit a JOIN core_audit_changes c ON c.audit_id = a.id WHERE a.operation = 'user.setPackRole' AND c.record_id = ? ORDER BY a.at, a.id",
    )
      .bind(coach.id)
      .all<{ outcome: string; diff: string }>();
    expect(audit.results.map((r) => [r.outcome, JSON.parse(r.diff).packRole])).toEqual([
      ["ok", { before: null, after: "ticketing.door" }],
      ["ok", { before: "ticketing.door", after: null }],
    ]);
    // A refusal of the door account is audited too.
    const refused = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit WHERE operation = 'person.list' AND user_id = ? AND outcome = 'forbidden'",
    )
      .bind(coach.id)
      .first<{ n: number }>();
    expect(refused?.n).toBe(1);
  });

  it("holds nothing when its pack is not active", async () => {
    await env.DB.prepare(
      "UPDATE core_extensions SET status = 'disabled' WHERE id = 'ticketing'",
    ).run();
    try {
      expect(await refusal(run("record.list", { object: TICKET }, staff(door)))).toMatchObject({
        code: "forbidden",
      });
    } finally {
      await env.DB.prepare(
        "UPDATE core_extensions SET status = 'active' WHERE id = 'ticketing'",
      ).run();
    }
  });
});
