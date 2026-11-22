// Stage 31a step 8 (ADR 0560) on the shipped packs: Programs, Bookings and Memberships in the real
// host and sandbox, with the real payments gatekeeper and its fake provider (never a real one).
// A drop-in: one class paid for on the web (acceptance criterion 8, and the drop-in parts of 6
// and 12):
//   - a visitor pays: the booking is held (a place) while the order is unpaid, booked by the
//     verified payment, spending no use; the price is the class type's, else the organisation's;
//     a class with neither cannot be paid for; tax is the provider's, inside the price;
//   - the order expiring releases the place; a payment after that is late and cannot be honoured
//     (the place may be someone else's): staff refund it;
//   - a full class is refused, a place held for the waiting list included; two visitors for the
//     last place get one; one live booking per Person holds with a pending drop-in;
//   - a parent pays for a linked child (the child's booking, the parent's order); nobody else may;
//   - cancelled in time, or by the gym, a paid drop-in's refund is asked for by the host and waits
//     for a person with orders:refund (the assistant cannot approve it); a pending one's order is
//     cancelled; cancelled late, the money is kept.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
  runRefundsDue,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const packFiles = (glob: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(glob)
      .map(([path, text]) => [path.split("/").pop() as string, text] as const)
      .filter(([name]) => name !== "vitest.config.ts"),
  );
const files: Record<string, Record<string, string>> = {
  programs: packFiles(
    import.meta.glob<string>("../../../packs/programs/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  bookings: packFiles(
    import.meta.glob<string>("../../../packs/bookings/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  memberships: packFiles(
    import.meta.glob<string>("../../../packs/memberships/*.ts", {
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
    { id: "bookings", version: "0.1.0" },
    { id: "memberships", version: "0.1.0" },
    { id: "programs", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    files[id]
      ? host.commit({
          id,
          files: files[id] as Record<string, string>,
          message: `Shipped ${id} 0.1.0`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const RETURN = "https://gym.test/classes";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CLASS = "bookings.class";
const BOOKING = "bookings.booking";

let admin: ActingUser;
const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  integrations,
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
const run = <T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
) => invokeByName(name, input, ctx) as Promise<T>;
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
const get = async (object: string, id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object, id }, staff())).values;

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    return { code: e.code, message: e.message, details: e.details };
  }
  throw new Error("expected a refusal");
}

async function member(label: string): Promise<CustomerPrincipal> {
  const tag = unique(label).toLowerCase();
  const email = `${tag}@dropin.test`;
  const person = await run<{ id: string }>(
    "person.create",
    { givenName: `Given-${tag}`, emails: [{ email }] },
    staff(),
  );
  const customerId = `cus_${tag}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_customer (id, person_id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(customerId, person.id, email, now, now)
    .run();
  return { kind: "customer", customerId, personId: person.id };
}
const visitor = () => `${unique("visitor")}@dropin.test`.toLowerCase();

async function klass(type: string, startsIn: number, places = 10): Promise<string> {
  const startsAt = new Date(Date.now() + startsIn).toISOString();
  return create(CLASS, {
    classType: type,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: "UTC",
    places,
  });
}

type Bought = {
  result: string;
  bookingId: string;
  orderId: string;
  total: number;
  currency: string;
  token: string | null;
  reason?: string;
};
const buy = (classId: string, ctx: OutsideInvocationContext, extra: Record<string, unknown> = {}) =>
  run<Bought>("x.bookings.buy", { classId, ...extra }, ctx);
const buyAsGuest = (classId: string, email = visitor()) => buy(classId, guest, { email });

const places = async (id: string) => {
  const v = await get(CLASS, id);
  return { held: v.held, taken: v.taken, available: v.available };
};
const order = (id: string) =>
  env.DB.prepare("SELECT state, person_id, total, tax_amount FROM core_order WHERE id = ?")
    .bind(id)
    .first<{ state: string; person_id: string | null; total: number; tax_amount: number }>();
const owed = (orderId: string) =>
  env.DB.prepare("SELECT state, entered FROM core_sellable_refund_due WHERE order_id = ?")
    .bind(orderId)
    .first<{ state: string; entered: string }>();

/** The provider's page: open it for `bought` and pay. */
async function pay(bought: Bought, ctx: OutsideInvocationContext = guest, country?: string) {
  const checkout = await run<{ url: string; amount: number }>(
    "order.checkout",
    { id: bought.orderId, ...(bought.token ? { token: bought.token } : {}), returnUrl: RETURN },
    ctx,
  );
  expect(checkout.amount).toBe(bought.total);
  const paid = await runner.gatekeeperFetch(
    "payments",
    new Request(checkout.url, {
      method: "POST",
      body: new URLSearchParams({ outcome: "pay", ...(country ? { country } : {}) }),
      redirect: "manual",
    }),
  );
  expect(paid.status).toBe(303);
}
const waitForBooked = (bookingId: string) =>
  vi.waitFor(async () => expect((await get(BOOKING, bookingId)).state).toBe("booked"), {
    timeout: 15_000,
  });

/** The minute cron's sweep until `orderId` is expired, as if 16 minutes had passed. */
async function expire(orderId: string) {
  for (let batch = 0; batch < 20; batch += 1) {
    const swept = await run<{ expired: string[] }>(
      "order.expireDue",
      {},
      staff({ actor: "automation", clock: () => new Date(Date.now() + 16 * 60_000) }),
    );
    if (swept.expired.includes(orderId) || !swept.expired.length) break;
  }
  expect((await order(orderId))?.state).toBe("expired");
}

let yoga: string;
let free: string;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "memberships"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  await run(
    "order.settings.update",
    { currency: "AUD", returnOrigins: ["https://gym.test"] },
    staff(),
  );
  await run("integration.setVendor", { vendor: "payments", enabled: true }, staff());
  const payments = await run<{ connection: { id: string } }>(
    "connection.create",
    { vendor: "payments", scope: "org" },
    staff(),
  );
  await run(
    "connection.bindResource",
    { id: payments.connection.id, url: "payments://merchant/fake" },
    staff(),
  );
  // A class type with its own drop-in price, and one with none (the organisation's, below).
  yoga = await create("programs.classtype", { name: unique("Yoga"), "bookings.dropInPrice": 25 });
  free = await create("programs.classtype", { name: unique("Open gym") });
}, 120_000);

afterAll(async () => {
  await run("order.settings.update", { tax: false }, staff()).catch(() => undefined);
});

describe("a visitor pays for one class (criterion 8)", () => {
  it("holds the place while unpaid, books on the verified payment, and spends no use", async () => {
    const id = await klass(yoga, 5 * HOUR, 4);
    const email = visitor();
    const bought = await buyAsGuest(id, email);
    expect(bought).toMatchObject({ result: "pending", total: 2500, currency: "AUD" });
    expect(bought.token).toMatch(/^[0-9a-f]{64}$/);
    // A place is held by the pending booking (a real place, counted against the class).
    expect(await places(id)).toEqual({ held: 1, taken: 0, available: 3 });
    const row = await get(BOOKING, bought.bookingId);
    expect(row).toMatchObject({
      state: "pending",
      paidOtherwise: true,
      dropInPrice: 25,
      dropInOrder: bought.orderId,
    });
    // The order is the visitor's Person's (made from their address), and so is the booking.
    const o = await order(bought.orderId);
    expect(o).toMatchObject({ state: "pending", total: 2500 });
    expect(row.person).toBe(o?.person_id);
    expect(row.madeBy).toBe(o?.person_id);

    await pay(bought);
    await waitForBooked(bought.bookingId);
    expect((await order(bought.orderId))?.state).toBe("paid");
    expect(await places(id)).toEqual({ held: 0, taken: 1, available: 3 });
    // Paid by its order: no holder, no use.
    expect((await get(BOOKING, bought.bookingId)).holder ?? null).toBeNull();
  });

  it("is priced by the class type, else the organisation's setting; neither: not offered online", async () => {
    const none = await klass(free, 5 * HOUR);
    expect(await buyAsGuest(none)).toMatchObject({ result: "refused", reason: "no_drop_in" });
    expect(await places(none)).toEqual({ held: 0, taken: 0, available: 10 });
    await run(
      "extensionSettings.update",
      { extension: "bookings", values: { dropInPrice: 18.5 } },
      staff(),
    );
    try {
      expect(await buyAsGuest(none)).toMatchObject({ result: "pending", total: 1850 });
      // The class type's own price wins over the organisation's.
      const own = await klass(yoga, 5 * HOUR);
      expect(await buyAsGuest(own)).toMatchObject({ result: "pending", total: 2500 });
    } finally {
      await run(
        "extensionSettings.update",
        { extension: "bookings", values: { dropInPrice: null } },
        staff(),
      );
    }
  });

  it("a caller never sets the price, the state or who pays: those are the host's", async () => {
    const id = await klass(yoga, 5 * HOUR);
    for (const values of [{ dropInPrice: 1 }, { state: "booked" }, { paidOtherwise: true }]) {
      const out = await refusal(
        run(
          "order.startHeld",
          { object: BOOKING, values: { class: id, ...values }, email: visitor() },
          { ...guest, tool: { extension: "bookings", tool: "buy" } } as OutsideInvocationContext,
        ),
      );
      expect(out.code).toBe("invalid_input");
    }
    // Nor is it reached except through a pack's tool, nor put on an order of its own.
    expect(
      (
        await refusal(
          run("order.startHeld", { object: BOOKING, values: { class: id }, email: visitor() }, guest),
        )
      ).code,
    ).toBe("unknown_operation");
    const bought = await buyAsGuest(id);
    const again = await refusal(
      run(
        "order.start",
        { lines: [{ object: BOOKING, id: bought.bookingId }], email: visitor() },
        guest,
      ),
    );
    expect(again.details).toMatchObject({ rule: "not_for_sale" });
  });

  it("tax is the provider's, inside the price", async () => {
    await run("order.settings.update", { tax: true }, staff());
    try {
      const id = await klass(yoga, 5 * HOUR);
      const bought = await buyAsGuest(id);
      expect(bought.total).toBe(2500);
      await pay(bought, guest, "AU");
      await waitForBooked(bought.bookingId);
      // AU 10% inclusive on the fake provider's table: 2500 / 11, rounded.
      expect(await order(bought.orderId)).toMatchObject({ total: 2500, tax_amount: 227 });
      const line = await env.DB.prepare("SELECT tax_code FROM core_order_line WHERE order_id = ?")
        .bind(bought.orderId)
        .first<{ tax_code: string | null }>();
      expect(line?.tax_code).toBe("txcd_50021003");
    } finally {
      await run("order.settings.update", { tax: false }, staff());
    }
  });
});

describe("the place and the clock", () => {
  it("an order left unpaid expires and the place goes back; a payment after that cannot be honoured", async () => {
    const id = await klass(yoga, 5 * HOUR, 1);
    const bought = await buyAsGuest(id);
    const checkout = await run<{ url: string }>(
      "order.checkout",
      { id: bought.orderId, token: bought.token, returnUrl: RETURN },
      guest,
    );
    expect(await places(id)).toMatchObject({ held: 1, available: 0 });
    await expire(bought.orderId);
    expect((await get(BOOKING, bought.bookingId)).state).toBe("expired");
    expect(await places(id)).toEqual({ held: 0, taken: 0, available: 1 });
    // Someone else takes the place meanwhile.
    const next = await buyAsGuest(id);
    expect(next.result).toBe("pending");
    // The first visitor pays on the page they still had open: a late payment, never a booking.
    const paid = await runner.gatekeeperFetch(
      "payments",
      new Request(checkout.url, {
        method: "POST",
        body: new URLSearchParams({ outcome: "pay" }),
        redirect: "manual",
      }),
    );
    expect(paid.status).toBe(303);
    await vi.waitFor(
      async () => {
        const late = await run<{ items: { orderId: string }[] }>("order.paidLate", {}, staff());
        expect(late.items.map((i) => i.orderId)).toContain(bought.orderId);
      },
      { timeout: 15_000 },
    );
    expect((await get(BOOKING, bought.bookingId)).state).toBe("expired");
    const honour = await refusal(run("order.honourLate", { id: bought.orderId }, staff()));
    expect(honour.details).toMatchObject({ rule: "held_gone" });
    expect((await order(bought.orderId))?.state).toBe("expired");
    expect(await places(id)).toMatchObject({ held: 1, available: 0 });
  });

  it("a buyer cancelling the unpaid order gives the place back", async () => {
    const who = await member("cancels");
    const id = await klass(yoga, 5 * HOUR, 1);
    const bought = await buy(id, as(who));
    expect(bought.token).toBeNull();
    await run("order.cancel", { id: bought.orderId }, as(who));
    expect((await get(BOOKING, bought.bookingId)).state).toBe("expired");
    expect(await places(id)).toEqual({ held: 0, taken: 0, available: 1 });
  });

  it("two visitors at once for the last place: one holds it, the other is told it is full", async () => {
    const id = await klass(yoga, 5 * HOUR, 1);
    const results = await Promise.all([buyAsGuest(id), buyAsGuest(id), buyAsGuest(id)]);
    expect(results.filter((r) => r.result === "pending")).toHaveLength(1);
    expect(results.filter((r) => r.result === "refused").map((r) => r.reason)).toEqual([
      "full",
      "full",
    ]);
    expect(await places(id)).toEqual({ held: 1, taken: 0, available: 0 });
  });

  it("a full class is refused, and so is a place held for the waiting list", async () => {
    const id = await klass(yoga, 5 * HOUR, 1);
    const a = await buyAsGuest(id);
    await pay(a);
    await waitForBooked(a.bookingId);
    expect(await buyAsGuest(id)).toMatchObject({ result: "refused", reason: "full" });
    // A member waits (a waiting list is for members with something to spend; joining is theirs).
    const waiter = await member("waiter");
    await run(
      "x.memberships.givePass",
      {
        personId: waiter.personId,
        passTypeId: await create("memberships.passtype", {
          title: unique("Pack "),
          price: 50,
          uses: 5,
          validDays: 60,
          status: "on_sale",
        }),
        reason: "Integration test",
      },
      staff(),
    );
    expect(await run<{ result: string }>("x.bookings.book", { classId: id }, as(waiter))).toMatchObject(
      { result: "waiting" },
    );
    // The place freed before the cut-off is held for the waiting list: no drop-in can take it.
    await run("record.update", { object: BOOKING, id: a.bookingId, values: { state: "cancel" } }, staff());
    expect(await places(id)).toMatchObject({ available: 0 });
    expect(await buyAsGuest(id)).toMatchObject({ result: "refused", reason: "full" });
  });

  it("one live booking per Person: a pending drop-in counts", async () => {
    const who = await member("once");
    const id = await klass(yoga, 5 * HOUR);
    const first = await buy(id, as(who));
    expect(first.result).toBe("pending");
    expect(await buy(id, as(who))).toMatchObject({ result: "refused", reason: "already_booked" });
    // The same address as a guest is the same Person.
    const account = await env.DB.prepare("SELECT email FROM core_customer WHERE id = ?")
      .bind(who.customerId)
      .first<{ email: string }>();
    expect(await buyAsGuest(id, account?.email)).toMatchObject({
      result: "refused",
      reason: "already_booked",
    });
    expect(await places(id)).toMatchObject({ held: 1 });
  });

  it("the booking's rules hold: not open yet, and a class booked by staff only", async () => {
    const later = await klass(yoga, 10 * DAY);
    expect(await buyAsGuest(later)).toMatchObject({ result: "refused", reason: "not_open" });
    const squad = await create("programs.classtype", {
      name: unique("Squad"),
      "bookings.staffOnly": true,
      "bookings.dropInPrice": 30,
    });
    const id = await klass(squad, 5 * HOUR);
    expect(await buyAsGuest(id)).toMatchObject({ result: "refused", reason: "staff_only" });
    expect(await places(later)).toMatchObject({ held: 0 });
  });
});

describe("a parent pays for a child (ADR 0540)", () => {
  it("the child's booking, the parent's order; nobody unlinked may", async () => {
    const parent = await member("parent");
    const kid = (await run<{ id: string }>("person.create", { givenName: unique("Kid") }, staff()))
      .id;
    await run("person.link.add", { guardianId: parent.personId, dependantId: kid }, staff());
    const id = await klass(yoga, 5 * HOUR);
    const bought = await buy(id, as(parent), { forPersonId: kid });
    expect(bought.result).toBe("pending");
    expect(await get(BOOKING, bought.bookingId)).toMatchObject({
      person: kid,
      madeBy: parent.personId,
    });
    expect((await order(bought.orderId))?.person_id).toBe(parent.personId);
    await pay(bought, as(parent));
    await waitForBooked(bought.bookingId);
    const stranger = await member("stranger");
    expect(await buy(id, as(stranger), { forPersonId: kid })).toMatchObject({
      result: "refused",
      reason: "not_found",
    });
    // A guest cannot name anyone.
    expect(
      await buy(id, guest, { email: visitor(), forPersonId: kid }),
    ).toMatchObject({ result: "refused", reason: "not_found" });
    // The parent reads the child's drop-in.
    const mine = await run<{ bookings: { id: string; dropInOrderId: string | null }[] }>(
      "x.bookings.mine",
      { personId: kid },
      as(parent),
    );
    expect(mine.bookings).toEqual([
      expect.objectContaining({ id: bought.bookingId, dropInOrderId: bought.orderId }),
    ]);
  });
});

describe("refunds through approval (decision 15, criterion 6's drop-in part)", () => {
  const sweep = () => runRefundsDue(db, { integrations });

  it("cancelled in time: the host asks for the refund, a person approves it, the card gets it back", async () => {
    const who = await member("refund");
    const id = await klass(yoga, 5 * HOUR);
    const bought = await buy(id, as(who));
    await pay(bought, as(who));
    await waitForBooked(bought.bookingId);
    const preview = await run<{ state: string; dropIn: boolean; message: string }>(
      "x.bookings.cancel",
      { bookingId: bought.bookingId },
      as(who),
    );
    expect(preview).toMatchObject({ state: "cancelled", dropIn: true });
    expect(preview.message).toContain("refunded");
    await run(
      "x.bookings.cancel",
      { bookingId: bought.bookingId, confirm: true, expect: "cancelled" },
      as(who),
    );
    // Owed in the cancel's batch; nothing asked of the provider yet.
    expect(await owed(bought.orderId)).toEqual({ state: "due", entered: "cancelled" });
    // (Another test's paid drop-in, cancelled by staff in time, may be asked for in this sweep.)
    expect((await sweep()).failed).toBe(0);
    expect((await owed(bought.orderId))?.state).toBe("asked");
    const refund = await env.DB.prepare(
      "SELECT amount, status, pending_action_id FROM core_order_refund WHERE order_id = ?",
    )
      .bind(bought.orderId)
      .first<{ amount: number; status: string; pending_action_id: string }>();
    expect(refund).toMatchObject({ amount: 2500, status: "requested" });
    // A second sweep asks nothing more.
    expect(await sweep()).toMatchObject({ asked: 0 });
    // The assistant cannot approve a refund; a person with orders:refund does.
    await run(
      "approval.approve",
      { actionIds: [refund?.pending_action_id] },
      staff({ actor: "assistant" }),
    ).catch(() => undefined);
    const action = await env.DB.prepare("SELECT status FROM core_pending_action WHERE id = ?")
      .bind(refund?.pending_action_id)
      .first<{ status: string }>();
    expect(action?.status).toBe("pending");
    expect((await order(bought.orderId))?.state).toBe("paid");
    // Gatekeeper actions apply in order: approve every refund the sweep asked for, together.
    const waiting = await env.DB.prepare(
      "SELECT pending_action_id AS id FROM core_order_refund WHERE status = 'requested' AND pending_action_id IS NOT NULL ORDER BY pending_action_id",
    ).all<{ id: string }>();
    await run(
      "approval.approve",
      { actionIds: waiting.results.map((r) => r.id) },
      staff(),
    );
    await vi.waitFor(async () => expect((await order(bought.orderId))?.state).toBe("refunded"), {
      timeout: 15_000,
    });
  });

  it("cancelled late: the money is kept, nothing is owed", async () => {
    const who = await member("late");
    const id = await klass(yoga, 30 * 60_000);
    const bought = await buy(id, as(who));
    await pay(bought, as(who));
    await waitForBooked(bought.bookingId);
    const done = await run<{ state: string }>(
      "x.bookings.cancel",
      { bookingId: bought.bookingId, confirm: true, expect: "late_cancelled" },
      as(who),
    );
    expect(done.state).toBe("late_cancelled");
    expect(await owed(bought.orderId)).toBeNull();
  });

  it("a class the gym cancels: a paid drop-in is refunded through approval, a pending one's order cancelled", async () => {
    // Six days ahead, a date no other class of this file is on.
    const id = await klass(yoga, 6 * DAY + 3 * HOUR, 5);
    const paid = await buyAsGuest(id);
    await pay(paid);
    await waitForBooked(paid.bookingId);
    const pending = await buyAsGuest(id);
    expect(await places(id)).toMatchObject({ held: 1, taken: 1 });
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(
      new Date(Date.now() + 6 * DAY + 3 * HOUR),
    );
    const closure = { name: "Storm", fromDate: date, untilDate: date };
    const asked = await refusal(
      run("record.create", { object: "bookings.closure", values: closure }, staff()),
    );
    const count = (asked.details as { count?: number }).count ?? 1;
    await run(
      "recurring.close",
      { object: "bookings.closure", values: closure, confirm: count },
      staff(),
    );
    expect((await get(CLASS, id)).state).toBe("cancelled");
    expect((await get(BOOKING, paid.bookingId)).state).toBe("cancelled_by_us");
    expect((await get(BOOKING, pending.bookingId)).state).toBe("cancelled_by_us");
    expect(await places(id)).toMatchObject({ held: 0, taken: 0 });
    // The unpaid one's order is cancelled in the same batch: its page can no longer take money.
    expect((await order(pending.orderId))?.state).toBe("cancelled");
    expect(await owed(pending.orderId)).toBeNull();
    // The paid one is owed, and asked for: it waits for a person.
    expect(await owed(paid.orderId)).toEqual({ state: "due", entered: "cancelled_by_us" });
    await sweep();
    expect((await owed(paid.orderId))?.state).toBe("asked");
    expect((await order(paid.orderId))?.state).toBe("paid");
  });

  it("staff cancelling a class: paid drop-ins (one cancelled late) refunded through approval, a pending one's order cancelled", async () => {
    const id = await klass(yoga, 40 * 60_000, 5);
    const paid = await buyAsGuest(id);
    await pay(paid);
    await waitForBooked(paid.bookingId);
    const lateOne = await member("latecc");
    const late = await buy(id, as(lateOne));
    await pay(late, as(lateOne));
    await waitForBooked(late.bookingId);
    // Inside the late-cancel hour: the money is kept, nothing owed yet.
    await run(
      "x.bookings.cancel",
      { bookingId: late.bookingId, confirm: true, expect: "late_cancelled" },
      as(lateOne),
    );
    expect(await owed(late.orderId)).toBeNull();
    const pending = await buyAsGuest(id);
    // The gym cancels the class (a person's act, ADR 0552): every booking follows in its batch.
    await run("x.bookings.cancelClass", { classId: id, reason: "Coach ill" }, staff());
    expect((await get(CLASS, id)).state).toBe("cancelled");
    for (const b of [paid, late, pending]) {
      expect((await get(BOOKING, b.bookingId)).state).toBe("cancelled_by_us");
    }
    expect(await places(id)).toMatchObject({ held: 0, taken: 0 });
    expect((await order(pending.orderId))?.state).toBe("cancelled");
    expect(await owed(pending.orderId)).toBeNull();
    // The class the gym cancelled gives a drop-in payer their money back, late cancel or not.
    expect(await owed(paid.orderId)).toEqual({ state: "due", entered: "cancelled_by_us" });
    expect(await owed(late.orderId)).toEqual({ state: "due", entered: "cancelled_by_us" });
    expect((await sweep()).failed).toBe(0);
    for (const b of [paid, late]) {
      expect((await owed(b.orderId))?.state).toBe("asked");
      expect((await order(b.orderId))?.state).toBe("paid");
    }
  });

  it("a refund staff already made by hand is not asked for twice", async () => {
    const who = await member("byhand");
    const id = await klass(yoga, 5 * HOUR);
    const bought = await buy(id, as(who));
    await pay(bought, as(who));
    await waitForBooked(bought.bookingId);
    await run("order.refund", { id: bought.orderId, reason: "Goodwill" }, staff());
    await run(
      "x.bookings.cancel",
      { bookingId: bought.bookingId, confirm: true, expect: "cancelled" },
      as(who),
    );
    expect((await owed(bought.orderId))?.state).toBe("due");
    expect(await sweep()).toMatchObject({ skipped: 1 });
    expect((await owed(bought.orderId))?.state).toBe("skipped");
    const refunds = await env.DB.prepare("SELECT COUNT(*) AS n FROM core_order_refund WHERE order_id = ?")
      .bind(bought.orderId)
      .first<{ n: number }>();
    expect(refunds?.n).toBe(1);
  });
});
