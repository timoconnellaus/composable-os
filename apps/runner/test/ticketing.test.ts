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
  customerMayGetCode,
  type ExtensionHost,
  extensionDashboardId,
  getObject,
  type InvocationContext,
  invokeByName,
  linkCustomer,
  loadExtensionOperations,
  memoryWidgetCache,
  type OutsideInvocationContext,
  recordsOnLocalDate,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eventTimeText, ticketingAutomations } from "../../../packs/ticketing/automations.ts";
import {
  createTicketingHooks,
  type estimate,
  eventDay,
  eventTime,
  TICKETING_HOOKS_CALL as HOOKS_CALL,
  orderStatus,
  type TicketingClient,
} from "../../../packs/ticketing/client/index.ts";
import { runZonedDateRelative } from "../src/automations/schedule.ts";
import { listedPacks } from "../src/extensions/shipped-list.ts";
import { fakeProviderStub } from "../src/integrations/fake.ts";
import { blobStore, integrationRuntime } from "../src/integrations/runtime.ts";
import { runWorkflows, setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const files = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../packs/ticketing/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  )
    .map(([path, text]) => [path.split("/").pop() as string, text] as const)
    // The pack's extension files, as a release carries them (not its config or tests).
    .filter(([name]) => name !== "vitest.config.ts"),
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
  status: "on_sale" | "draft" = "on_sale",
): Promise<{ event: string; types: string[] }> {
  const event = await createRecord(EVENT, { name: unique("Gains"), places });
  if (status === "on_sale") {
    await run(
      "record.update",
      { object: EVENT, id: event, values: { status: "on_sale" } },
      staff(admin),
    );
  }
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

describe("a guest buyer signs in later (ADR 0458)", () => {
  it("with sign-up `buyers`, the buyer's code may go out; signed in, they see their tickets", async () => {
    const { types } = await eventWith([{ price: 30 }]);
    const email = buyerEmail();
    const abandonedEmail = buyerEmail();
    await run("customer.settings.update", { signup: "buyers" }, staff(admin));
    try {
      const order = await run<Order>(
        "x.ticketing.orderStart",
        { lines: [{ ticketTypeId: types[0], quantity: 2 }], email },
        guest,
      );
      // Started, not paid: the address cannot get a code yet.
      expect(await customerMayGetCode(db.query, email)).toBe(false);
      // Another guest only starts a checkout.
      await run<Order>(
        "x.ticketing.orderStart",
        { lines: [{ ticketTypeId: types[0], quantity: 1 }], email: abandonedEmail },
        guest,
      );
      await checkoutAndPay(order, guest);
      await waitForState(order.id, "paid");
      expect(await customerMayGetCode(db.query, email)).toBe(true);
      expect(await customerMayGetCode(db.query, abandonedEmail)).toBe(false);

      // The sign-in makes the account (the customer auth's own write), and links it to the
      // buyer's Person, as an invited customer's first sign-in does.
      const customerId = `cus_${unique("buyer").toLowerCase()}`;
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO core_customer (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
      )
        .bind(customerId, email, now, now)
        .run();
      const linked = await linkCustomer(db, customerId);
      expect(linked.linkState).toBe("linked");
      const tickets = await ticketsOf(order.id);
      expect(new Set(tickets.map((t) => t.values.holder))).toEqual(new Set([linked.personId]));
      const principal: CustomerPrincipal = {
        kind: "customer",
        customerId,
        personId: linked.personId as string,
      };
      const c = hooksFor(as(principal));
      c.hooks.useMyTickets();
      const mine = (await c.last()) as { items: { code: string | null }[] };
      expect(mine.items).toHaveLength(2);
      const theirs = await run<{ id: string; state: string }>(
        "order.get",
        { id: order.id },
        as(principal),
      );
      expect(theirs).toMatchObject({ id: order.id, state: "paid" });
    } finally {
      await run("customer.settings.update", { signup: "invite_only" }, staff(admin));
    }
  });
});

// --- The sales summary ---------------------------------------------------------------------------

describe("the sales summary", () => {
  it("reports sold, held, remaining and revenue per ticket type from the host's numbers", async () => {
    const { event, types } = await eventWith([{ price: 45, places: 10 }, { price: 120 }], 20);
    const paid = await run<Order>(
      "x.ticketing.orderStart",
      {
        lines: [
          { ticketTypeId: types[0], quantity: 2 },
          { ticketTypeId: types[1], quantity: 1 },
        ],
        email: buyerEmail(),
      },
      guest,
    );
    await checkoutAndPay(paid, guest);
    await waitForState(paid.id, "paid");
    // One more held by an order still being paid.
    await run(
      "x.ticketing.orderStart",
      { lines: [{ ticketTypeId: types[0] }], email: buyerEmail() },
      guest,
    );
    const summary = await run<{
      ticketTypes: {
        id: string;
        sold: number;
        held: number;
        remaining: number | null;
        revenue: number;
      }[];
      totals: { sold: number; held: number; remaining: number | null; revenue: number };
    }>("x.ticketing.salesSummary", { eventId: event }, staff(admin));
    const byId = Object.fromEntries(summary.ticketTypes.map((t) => [t.id, t]));
    expect(byId[types[0] as string]).toMatchObject({
      sold: 2,
      held: 1,
      remaining: 7,
      revenue: 9000,
    });
    // Unlimited on its own: what is left is the event's (20 - 4).
    expect(byId[types[1] as string]).toMatchObject({
      sold: 1,
      held: 0,
      remaining: 16,
      revenue: 12000,
    });
    expect(summary.totals).toEqual({ sold: 3, held: 1, remaining: 16, revenue: 21000 });
    expect((summary as { currency?: string }).currency).toBe("AUD");
  });
});

// --- Step 5: the headless hooks against the host ----------------------------------------------

/** A client over the host's own operations, for the caller `ctx`: what a generated client does over HTTP. */
function hostClient(
  ctx: InvocationContext | OutsideInvocationContext,
): TicketingClient & { operations: Record<string, unknown> } {
  return {
    // Every operation: these tests run every hook (ADR 0453).
    operations: Object.fromEntries(
      Object.values(HOOKS_CALL)
        .flat()
        .map((n) => [n, true]),
    ),
    query: ((name: string, input: unknown) => ({
      queryKey: [name, input],
      queryFn: () => run(name, input, ctx),
    })) as TicketingClient["query"],
    mutation: ((name: string) => ({
      mutationKey: [name],
      mutationFn: (input: unknown) => run(name, input, ctx),
    })) as TicketingClient["mutation"],
  };
}

/** React stand-ins: each hook's query and mutation, run once. */
function hooksFor(ctx: InvocationContext | OutsideInvocationContext) {
  const queries: (() => Promise<unknown>)[] = [];
  const state = new Map<number, unknown>();
  let slot = 0;
  const react: Parameters<typeof createTicketingHooks>[0] = {
    useQuery: (options) => {
      queries.push(options.queryFn);
      return { data: undefined, isPending: true, error: null };
    },
    useMutation: (options) => ({
      mutate: (input) => void options.mutationFn(input),
      mutateAsync: options.mutationFn,
      data: undefined,
      isPending: false,
      error: null,
    }),
    useState: <T>(initial: T) => {
      const at = slot++;
      if (!state.has(at)) state.set(at, initial);
      return [
        state.get(at) as T,
        (next: T | ((p: T) => T)) =>
          state.set(
            at,
            typeof next === "function" ? (next as (p: T) => T)(state.get(at) as T) : next,
          ),
      ];
    },
  };
  const hooks = createTicketingHooks(react, hostClient(ctx));
  return { hooks, last: () => (queries.at(-1) as () => Promise<never>)(), reset: () => (slot = 0) };
}

describe("the hooks against the host (step 5)", () => {
  it("a guest finds an event, picks, starts and opens the checkout; the order page waits, then shows it paid", async () => {
    const { event, types } = await eventWith([{ price: 25 }, { price: 40, maxPerOrder: 2 }]);
    const g = hooksFor(guest);
    g.hooks.useEventsOnSale({ event });
    const onSale = (await g.last()) as { events: Parameters<typeof estimate>[0][] };
    const found = onSale.events[0] as Parameters<typeof estimate>[0];
    expect(found.id).toBe(event);
    g.reset();
    g.hooks.useTicketPicker(found).set(types[0] as string, 2);
    g.reset();
    g.hooks.useTicketPicker(found).set(types[1] as string, 5);
    g.reset();
    const picker = g.hooks.useTicketPicker(found);
    expect(picker.quantities).toEqual({ [types[0] as string]: 2, [types[1] as string]: 2 });
    expect(picker.estimate).toEqual({ full: 13000, deposit: null, currency: "AUD" });
    const order = await g.hooks
      .useStartOrder()
      .mutateAsync({ lines: picker.lines, email: buyerEmail() });
    // The host's total is what is paid, and agrees with the preview.
    expect(order.total).toBe(picker.estimate.full);
    const page = await g.hooks
      .useCheckout()
      .mutateAsync({ id: order.id, token: order.token as string, returnUrl: RETURN });
    g.hooks.useOrder({ id: order.id, token: order.token });
    expect(orderStatus((await g.last()) as never).waiting).toBe(true);
    await runner.gatekeeperFetch(
      "payments",
      new Request(page.url, {
        method: "POST",
        body: new URLSearchParams({ outcome: "pay" }),
        redirect: "manual",
      }),
    );
    await waitForState(order.id, "paid");
    g.hooks.useOrder({ id: order.id, token: order.token });
    expect(orderStatus((await g.last()) as never)).toMatchObject({ kind: "paid", waiting: false });
  });

  it("a customer's tickets, and a door account's scan, through the hooks", async () => {
    const buyer = await createCustomer("hooks");
    const { types } = await eventWith([{}]);
    const c = hooksFor(as(buyer.principal));
    const order = await c.hooks
      .useStartOrder()
      .mutateAsync({ lines: [{ ticketTypeId: types[0] as string }] });
    await checkoutAndPay(order as Order, as(buyer.principal));
    await waitForState(order.id, "paid");
    c.hooks.useMyTickets();
    const mine = (await c.last()) as { items: { code: string | null }[] };
    expect(mine.items).toHaveLength(1);
    const d = hooksFor(staff(door));
    const scan = await d.hooks.useCheckIn().mutateAsync({ code: mine.items[0]?.code as string });
    expect(scan.accepted).toBe(true);
  });
});

// --- Step 4: the staff side --------------------------------------------------------------------

describe("the staff side (step 4)", () => {
  it("the Ticket sales dashboard's every widget runs over real sales, and its counts click through", async () => {
    const { event, types } = await eventWith([{ price: 30 }]);
    const order = await run<Order>(
      "x.ticketing.orderStart",
      { lines: [{ ticketTypeId: types[0], quantity: 2 }], email: buyerEmail() },
      guest,
    );
    await checkoutAndPay(order, guest);
    await waitForState(order.id, "paid");
    const dashboardId = extensionDashboardId("ticketing", "ticketSales");
    const dashboard = await run<{ widgets: { id: string }[] }>(
      "dashboard.get",
      { id: dashboardId },
      staff(admin),
    );
    expect(dashboard.widgets.map((w) => w.id)).toEqual([
      "revenue",
      "sold",
      "unused",
      "by-event",
      "by-day",
      "places",
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const results: Record<string, { rows: Record<string, unknown>[] }> = {};
    for (const { id } of dashboard.widgets) {
      results[id] = await run(
        "widget.run",
        {
          dashboardId,
          widgetId: id,
          filters: { paid: { from: "2020-01-01", to: `${Number(today.slice(0, 4)) + 1}-01-01` } },
          refresh: true,
        },
        staff(admin, { widgetCache: memoryWidgetCache() }),
      );
    }
    expect(Number(results.sold?.rows[0]?.value)).toBeGreaterThanOrEqual(2);
    const mine = results["by-event"]?.rows.find((r) => r.event_id === event);
    expect(Number(mine?.tickets)).toBe(2);
    const places = results.places?.rows.find((r) => r.id === event);
    expect(places).toMatchObject({ taken: 2, held: 0 });
  });

  it("ships its views, the Person page's Tickets tab and the automations", async () => {
    const row = await env.DB.prepare(
      "SELECT manifest FROM core_extensions WHERE id = 'ticketing'",
    ).first<{ manifest: string }>();
    const manifest = JSON.parse(row?.manifest ?? "{}");
    expect(Object.values(manifest.views).map((v) => (v as { label: string }).label)).toEqual([
      "On sale",
      "This week's events",
      "Unused tickets",
    ]);
    expect(manifest.recordTabs.personTickets).toMatchObject({
      on: "person",
      view: { relation: "holder" },
    });
    expect(Object.keys(manifest.automations)).toEqual([
      "ticketsByEmail",
      "eventReminder",
      "eventEnded",
      "balanceReminders",
    ]);
    // Each view's filter runs as a list.
    for (const view of Object.values(manifest.views) as { object: string; filter: unknown }[]) {
      await run("record.list", { object: view.object, filter: view.filter }, staff(admin));
    }
  });
});

// --- Criterion 9: public reads (ADR 0438) -----------------------------------------------------------

interface OnSale {
  events: {
    id: string;
    name: string | null;
    availability: { status: string; available?: number | null };
    ticketTypes: {
      id: string;
      price: number | null;
      currency: string | null;
      availability: { status: string };
    }[];
  }[];
}

describe("public reads (criterion 9)", () => {
  it("the public sees only events on sale, and only their declared fields", async () => {
    const onSale = await eventWith([{ price: 45, places: 3 }], 50);
    const draft = await eventWith([{ price: 99 }], 50, "draft");
    await run(
      "record.update",
      { object: EVENT, id: onSale.event, values: { venue: "The gym" } },
      staff(admin),
    );
    for (const ctx of [guest, as((await createCustomer("visitor")).principal)]) {
      const seen = await run<OnSale>("x.ticketing.eventsOnSale", { limit: 50 }, ctx);
      const ids = seen.events.map((e) => e.id);
      expect(ids).toContain(onSale.event);
      expect(ids).not.toContain(draft.event);
      const event = seen.events.find((e) => e.id === onSale.event);
      expect(event?.ticketTypes.map((t) => t.id)).toEqual(onSale.types);
      expect(event?.ticketTypes[0]?.price).toBe(45);
      // The currency the price is in comes from the host, beside it: no client states its own.
      expect(event?.ticketTypes[0]?.currency).toBe("AUD");
      expect(event?.ticketTypes[0]?.availability).toEqual({ status: "low", available: 3 });
      // Only one event asked for: a draft one is not there at all.
      expect(
        (await run<OnSale>("x.ticketing.eventsOnSale", { event: draft.event }, ctx)).events,
      ).toEqual([]);
      // Nothing undeclared: not the places, the held count or who made it.
      const text = JSON.stringify(seen);
      for (const word of ["places", "held", "taken", "createdBy", "updatedBy"]) {
        expect(text).not.toContain(`"${word}"`);
      }
    }
    // The public never reads records directly: public.list is for a pack's tool only.
    expect(await refusal(run("public.list", { object: EVENT }, guest))).toMatchObject({
      code: "unknown_operation",
    });
    // A customer's my.* reaches an event only as far as the seam lets them: one their ticket
    // points to (ADR 0439), or what the public may read of one on sale. Never a draft one.
    const someone = await createCustomer("direct");
    const theirs = await run<{ items: { id: string; values: Record<string, unknown> }[] }>(
      "my.list",
      { object: EVENT, limit: 100 },
      as(someone.principal),
    );
    expect(theirs.items.map((e) => e.id)).not.toContain(draft.event);
    for (const word of ["places", "held", "taken", "createdBy"]) {
      expect(JSON.stringify(theirs)).not.toContain(`"${word}"`);
    }
  });

  it("places are told only about what the caller may read", async () => {
    const onSale = await eventWith([{ places: 5 }]);
    const draft = await eventWith([{ places: 5 }], 100, "draft");
    expect(
      await run("capacity.get", { object: TICKET_TYPE, id: onSale.types[0] }, guest),
    ).toMatchObject({ status: "low", available: 5 });
    for (const id of [draft.types[0], draft.event]) {
      const object = id === draft.event ? EVENT : TICKET_TYPE;
      expect(await refusal(run("capacity.get", { object, id }, guest))).toMatchObject({
        code: "not_found",
      });
    }
  });
});

// --- Decision: buying only what you may read ----------------------------------------------------

describe("a customer or guest buys only what they may read", () => {
  it("a ticket type of a draft event cannot be bought, and answers as one that does not exist", async () => {
    const draft = await eventWith([{}], 100, "draft");
    const email = buyerEmail();
    const notThere = await refusal(
      run(
        "x.ticketing.orderStart",
        { lines: [{ ticketTypeId: "rec_01NOSUCHRECORD000000000000" }], email },
        guest,
      ),
    );
    const hidden = await refusal(
      run("x.ticketing.orderStart", { lines: [{ ticketTypeId: draft.types[0] }], email }, guest),
    );
    expect(hidden).toEqual(notThere);
    expect(hidden.details).toMatchObject({ rule: "not_for_sale" });
    const customer = await createCustomer("drafty");
    expect(
      await refusal(
        run(
          "x.ticketing.orderStart",
          { lines: [{ ticketTypeId: draft.types[0] }] },
          as(customer.principal),
        ),
      ),
    ).toEqual(notThere);
    // Staff may still start an order for anything sellable.
    const order = await run<Order>(
      "order.start",
      { lines: [{ object: TICKET_TYPE, id: draft.types[0] }], email },
      staff(admin),
    );
    expect(order.state).toBe("pending");
  });
});

// --- Decision: what counts towards quarantine ---------------------------------------------------

describe("quarantine counts the pack's failures, not the caller's", () => {
  it("ten calls ending in not_found leave the pack active", async () => {
    for (let i = 0; i < 10; i += 1) {
      const refused = await refusal(
        run(
          "x.ticketing.undoCheckIn",
          { ticketId: `rec_01NOSUCHTICKET${i}00000000000` },
          staff(admin),
        ),
      );
      expect(refused).toMatchObject({ code: "extension_error", inner: "not_found" });
    }
    const row = await env.DB.prepare(
      "SELECT status, failure_count FROM core_extensions WHERE id = 'ticketing'",
    ).first();
    expect(row).toEqual({ status: "active", failure_count: 0 });
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

// --- A holder's tickets name their event, live, whatever its state (ADR 0439) -------------------

describe("a holder's tickets name their event and ticket type, whatever the event's state", () => {
  it("shows the event's name, live dates and venue and the type's name after the event ends; no one else reads them", async () => {
    const { event, types } = await eventWith([{}]);
    const typeId = types[0] as string;
    const a = await createCustomer("holder");
    const b = await createCustomer("stranger");
    const order = await run<Order>(
      "x.ticketing.orderStart",
      { lines: [{ ticketTypeId: typeId, quantity: 1 }] },
      as(a.principal),
    );
    await checkoutAndPay(order, as(a.principal));
    await waitForState(order.id, "paid");
    const staffEvent = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: EVENT, id: event },
      staff(admin),
    );
    const staffType = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: TICKET_TYPE, id: typeId },
      staff(admin),
    );
    // Staff move the date after the sale, then the event ends: it is no longer on sale.
    await run(
      "record.update",
      {
        object: EVENT,
        id: event,
        values: { startsAt: "2027-05-01T02:00:00.000Z", venue: "Phuket" },
      },
      staff(admin),
    );
    await run(
      "record.update",
      { object: EVENT, id: event, from: "on_sale", values: { status: "ended" } },
      staff(admin),
    );
    type Mine = { items: Record<string, unknown>[] };
    const mine = await run<Mine>("x.ticketing.myTickets", {}, as(a.principal));
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({
      event,
      ticketType: typeId,
      eventName: staffEvent.values.name,
      startsAt: "2027-05-01T02:00:00.000Z",
      venue: "Phuket",
      eventStatus: "ended",
      ticketTypeName: staffType.values.name,
    });
    // Only the declared fields: not the event's places or description, not the type's price.
    const one = await run<{ values: Record<string, unknown> }>(
      "my.get",
      { object: EVENT, id: event },
      as(a.principal),
    );
    // The declared fields, and the public's fields of an event on sale, which this one no longer
    // is: those are empty for it (a column the holder's declaration does not list shows only on
    // the records the public's covers).
    expect(one.values).toMatchObject({ name: staffEvent.values.name, venue: "Phuket" });
    expect(one.values.description ?? null).toBeNull();
    expect(one.values.image ?? null).toBeNull();
    for (const key of ["places", "held", "taken", "available", "createdBy"]) {
      expect(one.values).not.toHaveProperty(key);
    }
    const type = await run<{ values: Record<string, unknown> }>(
      "my.get",
      { object: TICKET_TYPE, id: typeId },
      as(a.principal),
    );
    // Its name; its price and the rest are the public's, while its event is on sale, and empty.
    expect(type.values).toMatchObject({ name: staffType.values.name, price: null, event: null });
    // Someone with no ticket for it reads none of it: not found, as an id that does not exist.
    for (const [object, id] of [
      [EVENT, event],
      [TICKET_TYPE, typeId],
    ] as const) {
      const theirs = await refusal(run("my.get", { object, id }, as(b.principal)));
      const guess = "rec_01NOTAREALID0000000000000";
      const none = await refusal(run("my.get", { object, id: guess }, as(b.principal)));
      expect(theirs).toEqual(JSON.parse(JSON.stringify(none).split(guess).join(id)));
      expect(theirs.code).toBe("not_found");
    }
    // Reading is not buying: the holder cannot start an order for a type of an ended event.
    const again = await refusal(
      run(
        "x.ticketing.orderStart",
        { lines: [{ ticketTypeId: typeId, quantity: 1 }] },
        as(a.principal),
      ),
    );
    const guessed = await refusal(
      run(
        "x.ticketing.orderStart",
        { lines: [{ ticketTypeId: "rec_01NOTAREALID0000000000000", quantity: 1 }] },
        as(a.principal),
      ),
    );
    expect(again.code).toBeDefined();
    expect(again).toMatchObject({ code: guessed.code, inner: guessed.inner });
    // The order page still names what was bought: an order line keeps its title (stage 25).
    const page = await run<{ lines: { title: string }[] }>(
      "order.get",
      { id: order.id },
      as(a.principal),
    );
    expect(page.lines.map((l) => l.title)).toEqual([staffType.values.name]);
  });
});

// --- An event's own time zone (ADR 0460) ----------------------------------------------------------

describe("an event's own time zone", () => {
  it("defaults to the deployment's zone, refuses one that is not a zone, and is in every holder-facing output", async () => {
    const before = await run<{ timezone: string }>("settings.get", {}, staff(admin));
    await run("settings.update", { timezone: "Australia/Sydney" }, staff(admin));
    try {
      const plain = await createRecord(EVENT, { name: unique("Local") });
      const read = await run<{ values: Record<string, unknown> }>(
        "record.get",
        { object: EVENT, id: plain },
        staff(admin),
      );
      expect(read.values.timezone).toBe("Australia/Sydney");
      expect(
        await refusal(
          run(
            "record.update",
            { object: EVENT, id: plain, values: { timezone: "Mars/Olympus" } },
            staff(admin),
          ),
        ),
      ).toMatchObject({ code: "invalid_input" });

      // A camp in Thailand sold from Sydney: 06:30 on 2 March in Bangkok is 23:30 UTC on 1 March.
      const camp = await createRecord(EVENT, {
        name: unique("Camp"),
        places: 50,
        timezone: "Asia/Bangkok",
        startsAt: "2027-03-01T23:30:00.000Z",
        endsAt: "2027-03-05T15:00:00.000Z",
      });
      await run(
        "record.update",
        { object: EVENT, id: camp, values: { status: "on_sale" } },
        staff(admin),
      );
      await createRecord(TICKET_TYPE, { event: camp, name: unique("Shared room"), price: 450 });
      const seen = await run<{ events: Parameters<typeof eventTime>[0][] }>(
        "x.ticketing.eventsOnSale",
        { event: camp },
        guest,
      );
      const shown = seen.events[0] as Parameters<typeof eventTime>[0];
      expect(shown.timeZone).toBe("Asia/Bangkok");
      const text = eventTime(shown, { viewer: "Australia/Sydney", locale: "en-GB" });
      expect(text).toContain("2 Mar 2027");
      expect(text).toContain("06:30");
      expect(text).toContain("(Bangkok time)");
      expect(eventDay(shown)).toBe("2027-03-02");
      // The emails say Bangkok's day and time, and the zone.
      const mail = eventTimeText(shown.startsAt, shown.timeZone) ?? "";
      expect(mail).toContain("2 March 2027");
      expect(mail).toContain("06:30");
      expect(mail).toContain("(Asia/Bangkok time)");

      // The reminder is due on Bangkok's 1 March, not on the day the UTC date says.
      const reminder = ticketingAutomations.eventReminder.trigger as {
        object: string;
        field: string;
        zoneField: string;
        offsetDays: number;
      };
      const due = (at: string) =>
        recordsOnLocalDate(db.query, reminder, new Date(at), "Australia/Sydney", 500);
      // 17:00 on 28 February in Bangkok (21:00 in Sydney): not yet.
      expect((await due("2027-02-28T10:00:00Z")).map((m) => m.id)).not.toContain(camp);
      // 01:00 on 1 March in Bangkok: the day before.
      expect(await due("2027-02-28T18:00:00Z")).toContainEqual({ id: camp, day: "2027-03-01" });
      // 01:00 on 2 March in Bangkok: the day itself, too late.
      expect((await due("2027-03-01T18:00:00Z")).map((m) => m.id)).not.toContain(camp);

      // It ends on Bangkok's day: 22:00 on 5 March there, so it is ended on 6 March there.
      const status = async () =>
        (
          await run<{ values: { status: string } }>(
            "record.get",
            { object: EVENT, id: camp },
            staff(admin),
          )
        ).values.status;
      // 23:30 on 5 March in Bangkok (03:30 on 6 March in Sydney): not yet.
      await runWorkflows(() => runZonedDateRelative(env, new Date("2027-03-05T16:30:00Z")));
      expect(await status()).toBe("on_sale");
      // 00:30 on 6 March in Bangkok.
      await runWorkflows(() => runZonedDateRelative(env, new Date("2027-03-05T17:30:00Z")));
      expect(await status()).toBe("ended");
    } finally {
      await run("settings.update", { timezone: before.timezone }, staff(admin));
    }
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

  it("is refused every other operation in the registry, whatever its input", async () => {
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

// --- Stage 42 section 4: tax at checkout on tickets (ADR 0479) -----------------------------------
// The same pack with tax turned on by a human admin: the ticket type's default code, the event's
// place, the real gatekeeper's fake provider calculating tax as the provider does (registered in
// AU at 10%, NZ at 15% and GB at 20%; elsewhere nothing), and everything else exactly as above.

describe("tax at checkout on tickets (stage 42 criteria 12a, 12b and 12c)", () => {
  const ADMISSION = "txcd_50010001";
  const NZ_PLACE = { taxCountry: "NZ", taxRegion: "Otago", taxPostcode: "9300" };

  /** Pays on the fake provider's page from `country`, the billing address Stripe requires. */
  async function payFrom(url: string, country: string | null) {
    return runner.gatekeeperFetch(
      "payments",
      new Request(url, {
        method: "POST",
        body: new URLSearchParams({ outcome: "pay", ...(country ? { country } : {}) }),
        redirect: "manual",
      }),
    );
  }

  async function openCheckout(order: Order, ctx: OutsideInvocationContext, amount?: number) {
    return run<{ url: string; amount: number }>(
      "order.checkout",
      {
        id: order.id,
        ...(order.token ? { token: order.token } : {}),
        returnUrl: RETURN,
        ...(amount ? { amount } : {}),
      },
      ctx,
    );
  }

  type PaymentRow = {
    amount: number;
    tax_amount: number | null;
    tax_country: string | null;
    payment_ref: string;
  };
  async function paymentsOf(orderId: string) {
    const { results } = await env.DB.prepare(
      "SELECT amount, tax_amount, tax_country, payment_ref FROM core_order_payment WHERE order_id = ? AND outcome = 'applied' ORDER BY received_at, event_id",
    )
      .bind(orderId)
      .all<PaymentRow>();
    return results;
  }

  /** An event on sale in New Zealand, its tax address set, with ticket types of it. */
  async function taxedEvent(types: Record<string, unknown>[]) {
    const made = await eventWith(types);
    await run("record.update", { object: EVENT, id: made.event, values: NZ_PLACE }, staff(admin));
    return made;
  }

  beforeAll(async () => {
    await run("order.settings.update", { tax: true }, staff(admin));
  });
  afterAll(async () => {
    await run("order.settings.update", { tax: false }, staff(admin));
  });

  it("declares the admission code by default", async () => {
    expect(getObject(TICKET_TYPE)?.sellable?.tax).toMatchObject({
      code: ADMISSION,
      place: { via: "event", country: "taxCountry" },
    });
    const settings = await run<{ taxObjects: { object: string; code: string }[] }>(
      "order.settings.get",
      {},
      staff(admin),
    );
    expect(settings.taxObjects).toContainEqual(
      expect.objectContaining({ object: TICKET_TYPE, code: ADMISSION }),
    );
  });

  it("two ticket types: each line's code and the event's place; tax per payment and in total (12a)", async () => {
    const { event, types } = await taxedEvent([{ price: 45 }, { price: 120 }]);
    const order = await run<Order>(
      "x.ticketing.orderStart",
      {
        lines: [
          { ticketTypeId: types[0], quantity: 2 },
          { ticketTypeId: types[1], quantity: 1 },
        ],
        email: buyerEmail(),
      },
      guest,
    );
    expect(order.total).toBe(21000);
    expect(await counter(EVENT, event)).toEqual({ held: 3, taken: 0 });
    const checkout = await openCheckout(order, guest);
    // The amount asked is the price: tax is inside it.
    expect(checkout.amount).toBe(21000);
    const sent = await env.DB.prepare(
      "SELECT tax_lines FROM core_order_checkout WHERE order_id = ?",
    )
      .bind(order.id)
      .first<{ tax_lines: string }>();
    const place = { country: "NZ", region: "Otago", postcode: "9300" };
    expect(JSON.parse(sent?.tax_lines ?? "null")).toEqual([
      expect.objectContaining({ amount: 9000, taxCode: ADMISSION, place }),
      expect.objectContaining({ amount: 12000, taxCode: ADMISSION, place }),
    ]);
    // The provider requires the billing address: without it nothing is paid.
    expect((await payFrom(checkout.url, null)).status).toBe(400);
    expect((await orderState(order.id)).state).toBe("pending");
    // Paid from Australia; admission is taxed where the event is (New Zealand, 15%).
    expect((await payFrom(checkout.url, "AU")).status).toBe(303);
    await waitForState(order.id, "paid");
    const paid = await run<{
      total: number;
      paid: number;
      taxAmount: number;
      taxCountry: string;
      lines: { taxAmount: number }[];
    }>("order.get", { id: order.id }, staff(admin));
    // 9000 - round(9000 / 1.15) = 1174; 12000 - round(12000 / 1.15) = 1565.
    expect(paid).toMatchObject({ total: 21000, paid: 21000, taxAmount: 2739, taxCountry: "NZ" });
    expect(paid.lines.map((l) => l.taxAmount)).toEqual([1174, 1565]);
    expect(await paymentsOf(order.id)).toEqual([
      expect.objectContaining({ amount: 21000, tax_amount: 2739, tax_country: "NZ" }),
    ]);
    // Places held and confirmed, tickets granted and checked in, as without tax.
    expect(await counter(EVENT, event)).toEqual({ held: 0, taken: 3 });
    const tickets = await ticketsOf(order.id);
    expect(tickets.map((t) => t.values.state)).toEqual(["valid", "valid", "valid"]);
    const scan = await run<{ accepted: boolean }>(
      "x.ticketing.checkIn",
      { code: tickets[0]?.values.code },
      staff(door),
    );
    expect(scan.accepted).toBe(true);
  });

  it("a deposit and the balance in two parts: each payment taxed on its own amount (12b)", async () => {
    const { types } = await taxedEvent([
      { price: 1000, depositAmount: 200, balanceDue: NEXT_YEAR },
    ]);
    const buyer = await createCustomer("taxdeposit");
    const order = await run<Order>(
      "x.ticketing.orderStart",
      { lines: [{ ticketTypeId: types[0] }], pay: "deposit" },
      as(buyer.principal),
    );
    for (const [amount, country, paidSoFar] of [
      [undefined, "AU", 20000],
      [30000, "GB", 50000],
      [50000, "NZ", 100000],
    ] as const) {
      const checkout = await openCheckout(order, as(buyer.principal), amount);
      expect((await payFrom(checkout.url, country)).status).toBe(303);
      await vi.waitFor(async () => expect((await orderState(order.id)).paid).toBe(paidSoFar), {
        timeout: 20_000,
      });
    }
    // The buyer's address moved between payments; the event's place did not, nor did the rate.
    const rows = await paymentsOf(order.id);
    expect(rows.map((r) => [r.amount, r.tax_amount, r.tax_country])).toEqual([
      [20000, 2609, "NZ"],
      [30000, 3913, "NZ"],
      [50000, 6522, "NZ"],
    ]);
    const paid = await run<{ state: string; total: number; paid: number; taxAmount: number }>(
      "order.get",
      { id: order.id },
      staff(admin),
    );
    // Owed exactly as without tax; the order's tax is the sum of what the provider said.
    expect(paid).toMatchObject({
      state: "paid",
      total: 100000,
      paid: 100000,
      taxAmount: 2609 + 3913 + 6522,
    });
    expect(await ticketsOf(order.id)).toHaveLength(1);
  });

  it("a part-paid order cancelled, then each payment refunded as its own action (12c)", async () => {
    const { event, types } = await taxedEvent([
      { price: 1000, depositAmount: 200, balanceDue: NEXT_YEAR },
    ]);
    const buyer = await createCustomer("taxcancel");
    const order = await run<Order>(
      "x.ticketing.orderStart",
      { lines: [{ ticketTypeId: types[0] }], pay: "deposit" },
      as(buyer.principal),
    );
    for (const [amount, paidSoFar] of [
      [undefined, 20000],
      [30000, 50000],
    ] as const) {
      const checkout = await openCheckout(order, as(buyer.principal), amount);
      await payFrom(checkout.url, "AU");
      await vi.waitFor(async () => expect((await orderState(order.id)).paid).toBe(paidSoFar), {
        timeout: 20_000,
      });
    }
    await run("order.cancel", { id: order.id }, staff(admin));
    expect((await orderState(order.id)).state).toBe("cancelled");
    expect((await ticketsOf(order.id)).map((t) => t.values.state)).toEqual(["void"]);
    expect(await counter(EVENT, event)).toEqual({ held: 0, taken: 0 });

    const asked = await run<{
      refunds: { paymentRef: string; amount: number; pendingActionId: string }[];
    }>("order.refund", { id: order.id, reason: "Event cancelled" }, staff(admin));
    const payments = await paymentsOf(order.id);
    // One refund per payment, each back to its own payment, for that payment's amount.
    expect(asked.refunds.map((r) => `${r.paymentRef}:${r.amount}`).sort()).toEqual(
      payments.map((p) => `${p.payment_ref}:${p.amount}`).sort(),
    );
    for (const refund of asked.refunds) {
      await run("approval.approve", { actionIds: [refund.pendingActionId] }, staff(admin));
    }
    await vi.waitFor(
      async () => {
        const row = await env.DB.prepare("SELECT refunded FROM core_order WHERE id = ?")
          .bind(order.id)
          .first<{ refunded: number }>();
        expect(row?.refunded).toBe(50000);
      },
      { timeout: 20_000 },
    );
    const refunds = await env.DB.prepare(
      "SELECT payment_ref, amount, tax_amount FROM core_order_refund WHERE order_id = ? AND status = 'confirmed'",
    )
      .bind(order.id)
      .all<{ payment_ref: string; amount: number; tax_amount: number | null }>();
    // Each payment's tax is known (the provider reported it). A refund's is recorded only when the
    // provider's refund event says it: Stripe's Refund carries no tax figure, and the fake provider
    // behaves the same, so none is recorded rather than one the host worked out (ADR 0479).
    expect(refunds.results.map((r) => r.tax_amount)).toEqual([null, null]);
    expect(payments.map((p) => p.tax_amount)).toEqual([2609, 3913]);
    expect((await orderState(order.id)).state).toBe("cancelled");
  });
});

// --- Issue #257: the day-before reminder reaches the holder -----------------------------------------

describe("the event reminder (issue #257)", () => {
  it("queues an email to the holder's primary address the day before", async () => {
    const { event, tickets } = await paidTickets(2);
    // Tomorrow, in UTC: the reminder is due today.
    const tomorrow = new Date(Date.now() + DAY);
    tomorrow.setUTCHours(12, 0, 0, 0);
    await run(
      "record.update",
      {
        object: EVENT,
        id: event,
        values: { startsAt: tomorrow.toISOString(), timezone: "UTC" },
      },
      staff(admin),
    );
    // A person binds the reminder's mail connection (ADR 0170), an email-send sender.
    await run("integration.setVendor", { vendor: "email-send", enabled: true }, staff(admin));
    const sender = await run<{ connection: { id: string } }>(
      "connection.create",
      { vendor: "email-send", scope: "org" },
      staff(admin),
    );
    await run(
      "connection.bindResource",
      {
        id: sender.connection.id,
        url: `email-send://sender/${encodeURIComponent("tickets@example.com")}`,
      },
      staff(admin),
    );
    await run(
      "automation.bindConnection",
      { id: "ticketing.eventReminder", slot: "mail", connectionId: sender.connection.id },
      staff(admin),
    );
    const holder = tickets[0]?.values.holder as string;
    expect(holder).toBeTruthy();
    const now = new Date();
    now.setUTCHours(Math.max(now.getUTCHours(), 1), 10, 0, 0);
    await runZonedDateRelative(env, now);
    // Under Balanced the send waits for a person (the run waits for the decision): it is queued,
    // to the holder's own address.
    const to = (
      await run<{ emails: { email: string }[] }>("person.get", { id: holder }, staff(admin))
    ).emails[0]?.email as string;
    expect(to).toBeTruthy();
    await vi.waitFor(
      async () => {
        const pending = await env.DB.prepare(
          "SELECT input FROM core_pending_action WHERE operation = 'integration.outbound' AND action_kind = 'email.send' AND input LIKE ?",
        )
          .bind(`%${to}%`)
          .all<{ input: string }>();
        expect(pending.results.some((r) => r.input.includes("Tomorrow:"))).toBe(true);
      },
      { timeout: 30_000, interval: 250 },
    );
  });
});
