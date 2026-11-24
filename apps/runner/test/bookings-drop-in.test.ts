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
  type OutsideInvocationContext,
  onRecordMove,
  refreshSchemaRegistry,
  runRefundsDue,
  runUnsettledGuests,
  runWaitlistDue,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, newCustomer, refusal, run, unique } from "./helpers.ts";
import { packFiles } from "./pack-files.ts";

const files: Record<string, Record<string, string>> = {
  programs: packFiles("programs"),
  bookings: packFiles("bookings"),
  memberships: packFiles("memberships"),
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
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
const get = async (object: string, id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object, id }, staff())).values;

const member = async (label: string) =>
  (await newCustomer(staff(), label, { domain: "dropin.test" })).principal;
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
const peopleWith = async (email: string) =>
  Number(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM core_person_emails e WHERE e.email = ? AND e.live = 1",
      )
        .bind(email)
        .first<{ n: number }>()
    )?.n ?? 0,
  );
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
    // Before payment the guest is nobody on file: no Person was made from their address, and
    // neither the booking nor the order is anyone's (ADR 0560, ADR 0428).
    const o = await order(bought.orderId);
    expect(o).toMatchObject({ state: "pending", total: 2500, person_id: null });
    expect(row.person ?? null).toBeNull();
    expect(await peopleWith(email)).toBe(0);

    await pay(bought);
    await waitForBooked(bought.bookingId);
    // Paid: the address is matched now (none on file, so a Person is made), and both are theirs.
    const paidOrder = await order(bought.orderId);
    expect(paidOrder?.state).toBe("paid");
    expect(await peopleWith(email)).toBe(1);
    expect((await get(BOOKING, bought.bookingId)).person).toBe(paidOrder?.person_id);
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
          run(
            "order.startHeld",
            { object: BOOKING, values: { class: id }, email: visitor() },
            guest,
          ),
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
  it("an order left unpaid expires and the place goes back; a payment after that is owed back, never honoured", async () => {
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
    // The money is owed back, asked for by the host, for a person to approve.
    expect(await owed(bought.orderId)).toEqual({ state: "due", entered: "late" });
    await runRefundsDue(db, { integrations });
    expect((await owed(bought.orderId))?.state).toBe("asked");
  });

  it("a payment for a hold whose class the gym cancelled meanwhile is owed back", async () => {
    const id = await klass(yoga, 4 * DAY + 2 * HOUR, 3);
    const bought = await buyAsGuest(id);
    const checkout = await run<{ url: string }>(
      "order.checkout",
      { id: bought.orderId, token: bought.token, returnUrl: RETURN },
      guest,
    );
    await run("x.bookings.cancelClass", { classId: id, reason: "Roof leak" }, staff());
    expect((await get(BOOKING, bought.bookingId)).state).toBe("cancelled_by_us");
    expect((await order(bought.orderId))?.state).toBe("cancelled");
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
      async () => expect(await owed(bought.orderId)).toMatchObject({ entered: "late" }),
      {
        timeout: 15_000,
      },
    );
    expect((await get(BOOKING, bought.bookingId)).state).toBe("cancelled_by_us");
  });

  it("a class cancelled just before a hold commits: the hold is refused, never left on it", async () => {
    // The class moves after the buy has read it and before its batch commits: a closure over its
    // date committed from inside the buy's own planning (a test-only hook on the booking's create).
    const when = Date.now() + 3 * DAY + 5 * HOUR;
    const id = await klass(yoga, 3 * DAY + 5 * HOUR, 3);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(when));
    let fired = false;
    const off = onRecordMove(BOOKING, async (_ctx, move) => {
      if (fired || move.from !== null || move.to.id !== "pending") return;
      fired = true;
      await run(
        "recurring.close",
        {
          object: "bookings.closure",
          values: { name: "Burst pipe", fromDate: date, untilDate: date },
          confirm: 0,
        },
        staff(),
      ).catch(async () =>
        run(
          "record.create",
          {
            object: "bookings.closure",
            values: { name: "Burst pipe", fromDate: date, untilDate: date },
          },
          staff(),
        ),
      );
    });
    try {
      const out = await buyAsGuest(id);
      expect(fired).toBe(true);
      expect(out).toMatchObject({ result: "refused", reason: "not_running" });
    } finally {
      off();
    }
    expect((await get(CLASS, id)).state).toBe("cancelled");
    const live = await run<{ items: { values: Record<string, unknown> }[] }>(
      "record.list",
      { object: BOOKING, filter: { field: "class", op: "eq", value: id } },
      staff(),
    );
    expect(live.items).toEqual([]);
    // And the other way round: cancelled first, the buy is refused (the public no longer sees it).
    expect(await buyAsGuest(id)).toMatchObject({ result: "refused", reason: "not_found" });
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
    expect(
      await run<{ result: string }>("x.bookings.book", { classId: id }, as(waiter)),
    ).toMatchObject({ result: "waiting" });
    // The place freed before the cut-off is held for the waiting list: no drop-in can take it.
    await run(
      "record.update",
      { object: BOOKING, id: a.bookingId, values: { state: "cancel" } },
      staff(),
    );
    expect(await places(id)).toMatchObject({ available: 0 });
    expect(await buyAsGuest(id)).toMatchObject({ result: "refused", reason: "full" });
  });

  it("one live booking per Person: a signed-in member's pending drop-in counts", async () => {
    const who = await member("once");
    const id = await klass(yoga, 5 * HOUR);
    const first = await buy(id, as(who));
    expect(first.result).toBe("pending");
    expect(await buy(id, as(who))).toMatchObject({ result: "refused", reason: "already_booked" });
    expect(await places(id)).toMatchObject({ held: 1 });
  });

  it("a guest learns nothing of who has an address, and holds nothing in their name", async () => {
    const who = await member("privacy");
    const account = await env.DB.prepare("SELECT email FROM core_customer WHERE id = ?")
      .bind(who.customerId)
      .first<{ email: string }>();
    const email = account?.email as string;
    const id = await klass(yoga, 5 * HOUR);
    // A stranger starts a drop-in with the member's address: the same answer as for anyone.
    const stranger = await buyAsGuest(id, email);
    expect(stranger.result).toBe("pending");
    expect(Object.keys(stranger).sort()).toEqual(
      Object.keys(await buyAsGuest(id, visitor())).sort(),
    );
    // Nobody's: not in the member's bookings, and the member still books their own place.
    const mine = await run<{ bookings: { id: string }[] }>(
      "x.bookings.mine",
      { upcoming: false },
      as(who),
    );
    expect(mine.bookings.map((b) => b.id)).not.toContain(stranger.bookingId);
    const own = await buy(id, as(who));
    expect(own.result).toBe("pending");
    await pay(own, as(who));
    await waitForBooked(own.bookingId);
    // The stranger pays: matched to the member now, who already has a place, so it is not kept
    // as a second one: its place goes back, its refund is owed and staff are told.
    await pay(stranger);
    await vi.waitFor(
      async () => expect((await get(BOOKING, stranger.bookingId)).state).toBe("expired"),
      { timeout: 15_000 },
    );
    expect(await owed(stranger.orderId)).toEqual({ state: "due", entered: "duplicate" });
    expect((await get(BOOKING, own.bookingId)).state).toBe("booked");
    // An address several People share gets the same answer too.
    const shared = `${unique("shared")}@dropin.test`.toLowerCase();
    // Two live People with one address cannot be made through the operations (emails are unique),
    // so one is put there the way an old import could have left it, as orders.test.ts does.
    await run("person.create", { givenName: "Twin1", emails: [{ email: shared }] }, staff());
    const second = await run<{ id: string }>(
      "person.create",
      { givenName: "Twin2", emails: [{ email: `${unique("twin")}@dropin.test`.toLowerCase() }] },
      staff(),
    );
    await env.DB.prepare("DROP INDEX IF EXISTS core_person_emails_live_email_uq").run();
    await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE person_id = ?")
      .bind(shared, second.id)
      .run();
    const twin = await buyAsGuest(id, shared);
    expect(twin.result).toBe("pending");
    await pay(twin);
    // Paid, still held, until staff say whose (as a guest order with several matches waits).
    await vi.waitFor(async () => expect((await order(twin.orderId))?.state).toBe("paid"), {
      timeout: 15_000,
    });
    expect((await get(BOOKING, twin.bookingId)).state).toBe("pending");
    const twins = await env.DB.prepare(
      "SELECT e.person_id AS id FROM core_person_emails e WHERE e.email = ? ORDER BY e.person_id",
    )
      .bind(shared)
      .all<{ id: string }>();
    await run("order.setPerson", { id: twin.orderId, personId: twins.results[0]?.id }, staff());
    expect(await get(BOOKING, twin.bookingId)).toMatchObject({
      state: "booked",
      person: twins.results[0]?.id,
    });
    await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE person_id = ?")
      .bind(`${unique("twin")}@dropin.test`.toLowerCase(), second.id)
      .run();
    await env.DB.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS core_person_emails_live_email_uq ON core_person_emails (email) WHERE live = 1",
    ).run();
  });

  it("unpaid guest holds are limited per class; the answer is try again shortly", async () => {
    // Half of 4 places (the default): two unpaid guest holds at once.
    const id = await klass(yoga, 5 * HOUR, 4);
    const results = await Promise.all([1, 2, 3].map(() => buyAsGuest(id)));
    expect(results.filter((r) => r.result === "pending")).toHaveLength(2);
    expect(results.filter((r) => r.result === "refused").map((r) => r.reason)).toEqual([
      "try_later",
    ]);
    expect(await places(id)).toMatchObject({ held: 2, available: 2 });
    // A member is not held to it: they hold their own, one per Person.
    const who = await member("capped");
    expect((await buy(id, as(who))).result).toBe("pending");
  });

  it("a held drop-in is never put on another order, by its member or by staff", async () => {
    const who = await member("second");
    const id = await klass(yoga, 5 * HOUR);
    const bought = await buy(id, as(who));
    const asMember = await refusal(
      run("order.start", { lines: [{ object: BOOKING, id: bought.bookingId }] }, as(who)),
    );
    expect(asMember.details).toMatchObject({ rule: "not_for_sale" });
    const asStaff = await refusal(
      run(
        "order.start",
        { lines: [{ object: BOOKING, id: bought.bookingId }], email: visitor() },
        staff(),
      ),
    );
    expect(asStaff.details).toMatchObject({ rule: "not_for_sale" });
    // Nor is order.startHeld staff's to call but through a pack's tool.
    const direct = await refusal(
      run("order.startHeld", { object: BOOKING, values: { class: id }, email: visitor() }, staff()),
    );
    expect(direct.code).toBe("unknown_operation");
  });

  it("payment and expiry at the same moment: booked and paid, or expired and owed back", async () => {
    for (let n = 0; n < 3; n += 1) {
      const id = await klass(yoga, 5 * HOUR, 2);
      const bought = await buyAsGuest(id);
      await Promise.all([
        pay(bought),
        run(
          "order.expireDue",
          {},
          staff({ actor: "automation", clock: () => new Date(Date.now() + 16 * 60_000) }),
        ),
      ]);
      await vi.waitFor(
        async () => {
          const state = (await get(BOOKING, bought.bookingId)).state;
          const o = await order(bought.orderId);
          if (state === "booked") expect(o?.state).toBe("paid");
          else {
            expect(state).toBe("expired");
            expect(o?.state).toBe("expired");
            expect(await owed(bought.orderId)).toMatchObject({ entered: "late" });
          }
        },
        { timeout: 15_000 },
      );
      const p = await places(id);
      expect(Number(p.held) + Number(p.taken) + Number(p.available)).toBe(2);
    }
  });

  it("a held place that expires goes to the waiting list first", async () => {
    const id = await klass(yoga, 5 * HOUR, 1);
    const held = await buyAsGuest(id);
    const waiter = await member("nextup");
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
    const waits = await run<{ result: string; bookingId: string }>(
      "x.bookings.book",
      { classId: id },
      as(waiter),
    );
    expect(waits.result).toBe("waiting");
    await expire(held.orderId);
    // Handed to the waiting list in the expiry's batch: no guest can take it.
    expect(await buyAsGuest(id)).toMatchObject({ result: "refused", reason: "full" });
    await runWaitlistDue(db);
    expect((await get(BOOKING, waits.bookingId)).state).toBe("booked");
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
    expect(await buy(id, guest, { email: visitor(), forPersonId: kid })).toMatchObject({
      result: "refused",
      reason: "not_found",
    });
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
    await run("approval.approve", { actionIds: waiting.results.map((r) => r.id) }, staff());
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

  it("an approval rejected: the owed refund lapses, staff are told once, and can ask again", async () => {
    const who = await member("rejected");
    const id = await klass(yoga, 5 * HOUR);
    const bought = await buy(id, as(who));
    await pay(bought, as(who));
    await waitForBooked(bought.bookingId);
    await run(
      "x.bookings.cancel",
      { bookingId: bought.bookingId, confirm: true, expect: "cancelled" },
      as(who),
    );
    await sweep();
    expect((await owed(bought.orderId))?.state).toBe("asked");
    const refund = await env.DB.prepare(
      "SELECT pending_action_id AS id FROM core_order_refund WHERE order_id = ?",
    )
      .bind(bought.orderId)
      .first<{ id: string }>();
    await run("approval.reject", { actionIds: [refund?.id] }, staff());
    expect((await sweep()).lapsed).toBeGreaterThanOrEqual(1);
    expect(await owed(bought.orderId)).toMatchObject({ state: "lapsed" });
    const told = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_notifications WHERE title = ? AND body LIKE ?",
    )
      .bind("A refund owed was not approved", `%${bought.orderId}%`)
      .first<{ n: number }>()
      .catch(() => null);
    if (told) expect(Number(told.n)).toBeGreaterThanOrEqual(1);
    // Told once: another sweep does nothing more; and staff can ask again from the order.
    expect((await sweep()).lapsed).toBe(0);
    const again = await run<{ refunds: unknown[] }>(
      "order.refund",
      { id: bought.orderId, reason: "Asked again" },
      staff(),
    );
    expect(again.refunds).toHaveLength(1);
  });

  it("an approval policy that denies the host's refund: nothing lost, staff told", async () => {
    const who = await member("denied");
    const id = await klass(yoga, 5 * HOUR);
    const bought = await buy(id, as(who));
    await pay(bought, as(who));
    await waitForBooked(bought.bookingId);
    await run(
      "x.bookings.cancel",
      { bookingId: bought.bookingId, confirm: true, expect: "cancelled" },
      as(who),
    );
    const out = await runRefundsDue(db, {
      integrations,
      floor: { automation: { outbound: "deny" } },
    });
    expect(out.failed).toBeGreaterThanOrEqual(1);
    const row = await owed(bought.orderId);
    expect(row?.state).toBe("skipped");
    const refunds = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_order_refund WHERE order_id = ?",
    )
      .bind(bought.orderId)
      .first<{ n: number }>();
    expect(Number(refunds?.n)).toBe(0);
  });

  it("a paid drop-in staff move to another class keeps its refund, once, on the new booking", async () => {
    const who = await member("mover");
    const from = await klass(yoga, 5 * HOUR);
    const to = await klass(yoga, 7 * HOUR);
    const bought = await buy(from, as(who));
    await pay(bought, as(who));
    await waitForBooked(bought.bookingId);
    const moved = await run<{ result: string; bookingId: string }>(
      "x.bookings.move",
      { bookingId: bought.bookingId, toClassId: to },
      staff(),
    );
    expect(moved.result).toBe("moved");
    expect(await get(BOOKING, moved.bookingId)).toMatchObject({
      state: "booked",
      dropInOrder: bought.orderId,
      paidOtherwise: true,
    });
    expect(await owed(bought.orderId)).toBeNull();
    const preview = await run<{ dropIn: boolean; state: string }>(
      "x.bookings.cancel",
      { bookingId: moved.bookingId },
      as(who),
    );
    expect(preview).toMatchObject({ dropIn: true, state: "cancelled" });
    await run(
      "x.bookings.cancel",
      { bookingId: moved.bookingId, confirm: true, expect: "cancelled" },
      as(who),
    );
    expect(await owed(bought.orderId)).toEqual({ state: "due", entered: "cancelled" });
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
    const refunds = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_order_refund WHERE order_id = ?",
    )
      .bind(bought.orderId)
      .first<{ n: number }>();
    expect(refunds?.n).toBe(1);
  });
});

describe("round two (review)", () => {
  const sweep = () => runRefundsDue(db, { integrations });
  const openCheckout = (bought: Bought, returnUrl: string) =>
    run<{ url: string }>(
      "order.checkout",
      { id: bought.orderId, token: bought.token, returnUrl },
      guest,
    );
  const payPage = async (url: string) => {
    const paid = await runner.gatekeeperFetch(
      "payments",
      new Request(url, {
        method: "POST",
        body: new URLSearchParams({ outcome: "pay" }),
        redirect: "manual",
      }),
    );
    expect(paid.status).toBe(303);
  };
  const refundsOf = (orderId: string) =>
    env.DB.prepare(
      "SELECT amount, payment_ref AS ref FROM core_order_refund WHERE order_id = ? ORDER BY id",
    )
      .bind(orderId)
      .all<{ amount: number; ref: string }>();
  const paymentsOf = (orderId: string) =>
    env.DB.prepare(
      "SELECT payment_ref AS ref, outcome FROM core_order_payment WHERE order_id = ? ORDER BY received_at",
    )
      .bind(orderId)
      .all<{ ref: string; outcome: string }>();
  const owedRows = (orderId: string) =>
    env.DB.prepare(
      "SELECT entered, amount, payment_ref AS ref, state FROM core_sellable_refund_due WHERE order_id = ? ORDER BY created_at",
    )
      .bind(orderId)
      .all<{ entered: string; amount: number | null; ref: string | null; state: string }>();

  it("paid twice: one booked place, and only the second payment is owed back", async () => {
    const id = await klass(yoga, 5 * HOUR);
    const bought = await buyAsGuest(id);
    const first = await openCheckout(bought, RETURN);
    const second = await openCheckout(bought, "https://gym.test/again");
    await payPage(first.url);
    await waitForBooked(bought.bookingId);
    await payPage(second.url);
    await vi.waitFor(
      async () => expect((await paymentsOf(bought.orderId)).results).toHaveLength(2),
      {
        timeout: 15_000,
      },
    );
    const payments = (await paymentsOf(bought.orderId)).results;
    const rows = (await owedRows(bought.orderId)).results;
    expect(rows).toEqual([
      { entered: "duplicate_payment", amount: 2500, ref: payments[1]?.ref, state: "due" },
    ]);
    await sweep();
    expect((await refundsOf(bought.orderId)).results).toEqual([
      { amount: 2500, ref: payments[1]?.ref },
    ]);
    expect((await get(BOOKING, bought.bookingId)).state).toBe("booked");
    expect((await order(bought.orderId))?.state).toBe("paid");
  });

  it("two late payments on an expired order: two refunds, each once", async () => {
    const id = await klass(yoga, 5 * HOUR);
    const bought = await buyAsGuest(id);
    const first = await openCheckout(bought, RETURN);
    const second = await openCheckout(bought, "https://gym.test/again");
    await expire(bought.orderId);
    await payPage(first.url);
    await payPage(second.url);
    await vi.waitFor(async () => expect((await owedRows(bought.orderId)).results).toHaveLength(2), {
      timeout: 15_000,
    });
    await sweep();
    await sweep();
    const payments = (await paymentsOf(bought.orderId)).results.map((p) => p.ref).sort();
    const refunds = (await refundsOf(bought.orderId)).results;
    expect(refunds.map((r) => r.ref).sort()).toEqual(payments);
    expect(refunds.every((r) => r.amount === 2500)).toBe(true);
  });

  it("a member with a cap: their own unpaid drop-in turns no visitor away", async () => {
    const id = await klass(yoga, 5 * HOUR, 4);
    const who = await member("capmember");
    expect((await buy(id, as(who))).result).toBe("pending");
    const results: Bought[] = [];
    for (const n of [1, 2, 3]) {
      void n;
      results.push(await buyAsGuest(id));
    }
    expect(results.map((r) => r.result)).toEqual(["pending", "pending", "refused"]);
    expect(results[2]?.reason).toBe("try_later");
  });

  it("an address erased, or only in the Trash, by payment: released, owed back, admins told", async () => {
    for (const how of ["erase", "trash"] as const) {
      const email = visitor();
      const id = await klass(yoga, 5 * HOUR);
      const bought = await buyAsGuest(id, email);
      // The page is open before the address is erased (an erase also clears the order's link).
      const page = await openCheckout(bought, RETURN);
      const p = await run<{ id: string }>(
        "person.create",
        { givenName: `Later-${how}`, emails: [{ email }] },
        staff(),
      );
      if (how === "erase") await run("person.erase", { id: p.id }, staff());
      else await run("person.delete", { id: p.id }, staff());
      await payPage(page.url);
      await vi.waitFor(
        async () => expect((await get(BOOKING, bought.bookingId)).state).toBe("expired"),
        { timeout: 15_000 },
      );
      if (how === "erase") {
        // Erase closed the unpaid order itself (stage 44 step 8, ADR 0646): the payment that comes
        // after never makes it paid, and it is owed back automatically, asked for by the host for
        // a person with orders:refund to approve (ADR 0429), as any payment after a drop-in's
        // place went back.
        await vi.waitFor(
          async () =>
            expect((await paymentsOf(bought.orderId)).results.map((p) => p.outcome)).toEqual([
              "late",
            ]),
          { timeout: 15_000 },
        );
        expect((await order(bought.orderId))?.state).toBe("cancelled");
        const owed = (await owedRows(bought.orderId)).results;
        expect(owed).toEqual([
          {
            entered: "late",
            amount: expect.any(Number),
            ref: (await paymentsOf(bought.orderId)).results[0]?.ref,
            state: "due",
          },
        ]);
      } else {
        expect((await order(bought.orderId))?.state).toBe("paid");
        expect((await owedRows(bought.orderId)).results).toEqual([
          { entered: "unmatched", amount: null, ref: null, state: "due" },
        ]);
      }
      expect(await places(id)).toMatchObject({ held: 0, taken: 0 });
    }
  });

  it("several People share the address and nobody settles it before booking closes: released, owed", async () => {
    const shared = `${unique("unsettled")}@dropin.test`.toLowerCase();
    await run("person.create", { givenName: "U1", emails: [{ email: shared }] }, staff());
    const second = await run<{ id: string }>(
      "person.create",
      { givenName: "U2", emails: [{ email: `${unique("u2")}@dropin.test`.toLowerCase() }] },
      staff(),
    );
    await env.DB.prepare("DROP INDEX IF EXISTS core_person_emails_live_email_uq").run();
    await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE person_id = ?")
      .bind(shared, second.id)
      .run();
    try {
      const id = await klass(yoga, 2 * HOUR);
      const bought = await buyAsGuest(id, shared);
      await pay(bought);
      await vi.waitFor(async () => expect((await order(bought.orderId))?.state).toBe("paid"), {
        timeout: 15_000,
      });
      expect((await get(BOOKING, bought.bookingId)).state).toBe("pending");
      // More than a tick's scan of other paid orders with no one on them (other packs' guests,
      // and ones already dealt with) never keeps it from being looked at.
      const stamp = new Date(Date.now() - DAY).toISOString();
      for (let n = 0; n < 60; n += 1) {
        const fake = `ord_FAKEGUEST${String(n).padStart(4, "0")}${unique("x").slice(-8)}`;
        await env.DB.prepare(
          "INSERT INTO core_order (id, person_id, email, currency, total, paid, state, pay, placed_as, refunded, created_at, updated_at, paid_at, version) VALUES (?, NULL, NULL, 'AUD', 1000, 1000, 'paid', 'full', 'public', 0, ?, ?, ?, 1)",
        )
          .bind(fake, stamp, stamp, stamp)
          .run();
        await env.DB.prepare(
          "INSERT INTO core_order_line (id, order_id, position, object_type, record_id, title, quantity, unit_price, line_total, created_at) VALUES (?, ?, 0, 'ticketing.tickettype', ?, 'Ticket', 1, 1000, 1000, ?)",
        )
          .bind(`orl_${fake.slice(4)}`, fake, `rec_${fake.slice(4)}`, stamp)
          .run();
      }
      // Not yet: booking for the class is still open.
      await runUnsettledGuests(db);
      expect((await get(BOOKING, bought.bookingId)).state).toBe("pending");
      // After it closes (the class's start), the minute cron releases it.
      const out = await runUnsettledGuests(db, { clock: () => new Date(Date.now() + 3 * HOUR) });
      expect(out.released).toBeGreaterThanOrEqual(1);
      expect((await get(BOOKING, bought.bookingId)).state).toBe("expired");
      expect((await owedRows(bought.orderId)).results).toEqual([
        { entered: "unsettled", amount: null, ref: null, state: "due" },
      ]);
    } finally {
      await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE person_id = ?")
        .bind(`${unique("u2")}@dropin.test`.toLowerCase(), second.id)
        .run();
      await env.DB.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS core_person_emails_live_email_uq ON core_person_emails (email) WHERE live = 1",
      ).run();
    }
  });

  it("erasing a Person deletes their bookings (booked, a paid drop-in, waiting), places back", async () => {
    const id = await klass(yoga, 5 * HOUR, 2);
    const booked = await member("erasebooked");
    await run(
      "x.memberships.givePass",
      {
        personId: booked.personId,
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
    const b1 = await run<{ bookingId: string }>("x.bookings.book", { classId: id }, as(booked));
    const dropper = await member("erasedrop");
    const drop = await buy(id, as(dropper));
    await pay(drop, as(dropper));
    await waitForBooked(drop.bookingId);
    const waiter = await member("erasewait");
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
    const w = await run<{ result: string; bookingId: string }>(
      "x.bookings.book",
      { classId: id },
      as(waiter),
    );
    expect(w.result).toBe("waiting");
    for (const who of [booked, dropper, waiter]) {
      await run("person.erase", { id: who.personId }, staff());
    }
    for (const bookingId of [b1.bookingId, drop.bookingId, w.bookingId]) {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM core_capacity_claim WHERE for_id = ? AND state IN ('held', 'confirmed')",
      )
        .bind(bookingId)
        .first<{ n: number }>();
      expect(Number(row?.n)).toBe(0);
      expect(await refusal(get(BOOKING, bookingId))).toMatchObject({ code: "not_found" });
    }
    expect(await places(id)).toMatchObject({ held: 0, taken: 0 });
    // The drop-in's order stays (the money's record) with no one on it, and nothing is owed.
    expect((await order(drop.orderId))?.person_id ?? null).toBeNull();
    expect((await owedRows(drop.orderId)).results).toEqual([]);
  });

  it("a booking outside a guest's unpaid hold always has its Person, for every writer", async () => {
    const id = await klass(yoga, 5 * HOUR);
    const walkIn = await run<{ result: string; bookingId: string }>(
      "x.bookings.bookFor",
      { classId: id, newPerson: { givenName: unique("Walk") }, paidAtDesk: true },
      staff(),
    );
    expect(walkIn.result).toBe("booked");
    for (const actor of ["human", "assistant"] as const) {
      const out = await refusal(
        run(
          "record.update",
          { object: BOOKING, id: walkIn.bookingId, values: { person: null } },
          staff({ actor }),
        ),
      );
      expect(out.details).toMatchObject({ rule: "guest_held" });
    }
    expect(
      (
        await refusal(
          run(
            "record.create",
            { object: BOOKING, values: { class: id, state: "waiting" } },
            staff(),
          ),
        )
      ).details,
    ).toMatchObject({ rule: "guest_held" });
    expect(
      (
        await refusal(
          run(
            "record.createMany",
            { object: BOOKING, records: [{ class: id, state: "waiting" }] },
            staff(),
          ),
        )
      ).details,
    ).toMatchObject({ rule: "guest_held" });
  });
});

describe("round three (review)", () => {
  it("a release that fails affects only its own record, never the tick's expiry", async () => {
    const shared = `${unique("racing")}@dropin.test`.toLowerCase();
    await run("person.create", { givenName: "R1", emails: [{ email: shared }] }, staff());
    const second = await run<{ id: string }>(
      "person.create",
      { givenName: "R2", emails: [{ email: `${unique("r2")}@dropin.test`.toLowerCase() }] },
      staff(),
    );
    await env.DB.prepare("DROP INDEX IF EXISTS core_person_emails_live_email_uq").run();
    await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE person_id = ?")
      .bind(shared, second.id)
      .run();
    const off = onRecordMove(BOOKING, (_ctx, move) => {
      if (move.id === target && move.to.id === "expired") {
        throw new Error("conflict: settled at the same moment");
      }
    });
    let target = "";
    try {
      const id = await klass(yoga, 2 * HOUR);
      const unsettled = await buyAsGuest(id, shared);
      target = unsettled.bookingId;
      await pay(unsettled);
      await vi.waitFor(async () => expect((await order(unsettled.orderId))?.state).toBe("paid"), {
        timeout: 15_000,
      });
      // Another order due to expire on the same tick.
      const due = await buyAsGuest(await klass(yoga, 5 * HOUR));
      const later = () => new Date(Date.now() + 3 * HOUR);
      const swept = await run<{ expired: string[] }>(
        "order.expireDue",
        {},
        staff({ actor: "automation", clock: later }),
      );
      expect(swept.expired).toContain(due.orderId);
      const out = await runUnsettledGuests(db, { clock: later });
      expect(out.failed).toBeGreaterThanOrEqual(1);
      expect((await get(BOOKING, unsettled.bookingId)).state).toBe("pending");
      expect((await order(due.orderId))?.state).toBe("expired");
    } finally {
      off();
      await env.DB.prepare("UPDATE core_person_emails SET email = ? WHERE person_id = ?")
        .bind(`${unique("r2")}@dropin.test`.toLowerCase(), second.id)
        .run();
      await env.DB.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS core_person_emails_live_email_uq ON core_person_emails (email) WHERE live = 1",
      ).run();
    }
  });

  it("erasing a parent keeps their child's place and their child's place in the queue", async () => {
    const parent = await member("eraseparent");
    const kid = (await run<{ id: string }>("person.create", { givenName: unique("Kid") }, staff()))
      .id;
    await run("person.link.add", { guardianId: parent.personId, dependantId: kid }, staff());
    await run(
      "x.memberships.givePass",
      {
        personId: kid,
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
    const full = await klass(yoga, 5 * HOUR, 1);
    const booked = await run<{ result: string; bookingId: string }>(
      "x.bookings.book",
      { classId: full, forPersonId: kid },
      as(parent),
    );
    expect(booked.result).toBe("booked");
    // The child also waits on another full class.
    const other = await klass(yoga, 6 * HOUR, 1);
    await buyAsGuest(other).then((b) => pay(b));
    const waits = await run<{ result: string; bookingId: string }>(
      "x.bookings.book",
      { classId: other, forPersonId: kid },
      as(parent),
    );
    expect(waits.result).toBe("waiting");
    await run("person.erase", { id: parent.personId }, staff());
    expect(await get(BOOKING, booked.bookingId)).toMatchObject({ state: "booked", person: kid });
    const claims = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_capacity_claim WHERE for_id = ? AND state IN ('held', 'confirmed')",
    )
      .bind(booked.bookingId)
      .first<{ n: number }>();
    expect(Number(claims?.n)).toBe(1);
    expect(await places(full)).toMatchObject({ available: 0 });
    expect((await get(BOOKING, waits.bookingId)).state).toBe("waiting");
  });

  it("a payment owed back after staff refunded part of it: the rest is asked for", async () => {
    const id = await klass(yoga, 5 * HOUR);
    const bought = await buyAsGuest(id);
    const pageOf = (returnUrl: string) =>
      run<{ url: string }>(
        "order.checkout",
        { id: bought.orderId, token: bought.token, returnUrl },
        guest,
      );
    const first = await pageOf(RETURN);
    const second = await pageOf("https://gym.test/again");
    for (const page of [first, second]) {
      const paid = await runner.gatekeeperFetch(
        "payments",
        new Request(page.url, {
          method: "POST",
          body: new URLSearchParams({ outcome: "pay" }),
          redirect: "manual",
        }),
      );
      expect(paid.status).toBe(303);
      if (page === first) await waitForBooked(bought.bookingId);
    }
    await vi.waitFor(
      async () =>
        expect(
          await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM core_sellable_refund_due WHERE order_id = ?",
          )
            .bind(bought.orderId)
            .first<{ n: number }>()
            .then((r) => Number(r?.n)),
        ).toBe(1),
      { timeout: 15_000 },
    );
    // Staff refund 1000 of it by hand first (the newest payment, the second).
    await run("order.refund", { id: bought.orderId, amount: 1000, reason: "Part" }, staff());
    expect((await runRefundsDue(db, { integrations })).failed).toBe(0);
    const asked = await env.DB.prepare(
      "SELECT amount FROM core_order_refund WHERE order_id = ? AND id LIKE 'rfd_%' ORDER BY amount",
    )
      .bind(bought.orderId)
      .all<{ amount: number }>();
    expect(asked.results.map((r) => r.amount)).toEqual([1000, 1500]);
  });

  it("a payment after the order was refunded is owed back with that reason", async () => {
    const id = await klass(yoga, 5 * HOUR);
    const bought = await buyAsGuest(id);
    const pageOf = (returnUrl: string) =>
      run<{ url: string }>(
        "order.checkout",
        { id: bought.orderId, token: bought.token, returnUrl },
        guest,
      );
    const first = await pageOf(RETURN);
    const second = await pageOf("https://gym.test/again");
    const payPage = async (url: string) =>
      runner.gatekeeperFetch(
        "payments",
        new Request(url, {
          method: "POST",
          body: new URLSearchParams({ outcome: "pay" }),
          redirect: "manual",
        }),
      );
    await payPage(first.url);
    await waitForBooked(bought.bookingId);
    const refund = await run<{ refunds: { pendingActionId: string }[] }>(
      "order.refund",
      { id: bought.orderId, reason: "Gone" },
      staff(),
    );
    // Gatekeeper actions apply in order: every refund still waiting, together.
    const waiting = await env.DB.prepare(
      "SELECT r.pending_action_id AS id FROM core_order_refund r JOIN core_pending_action p ON p.id = r.pending_action_id WHERE p.status = 'pending' ORDER BY r.pending_action_id",
    ).all<{ id: string }>();
    expect(waiting.results.map((r) => r.id)).toContain(refund.refunds[0]?.pendingActionId);
    await run("approval.approve", { actionIds: waiting.results.map((r) => r.id) }, staff());
    await vi.waitFor(async () => expect((await order(bought.orderId))?.state).toBe("refunded"), {
      timeout: 15_000,
    });
    await payPage(second.url);
    await vi.waitFor(
      async () => {
        const row = await env.DB.prepare(
          "SELECT reason FROM core_sellable_refund_due WHERE order_id = ? AND payment_ref IS NOT NULL",
        )
          .bind(bought.orderId)
          .first<{ reason: string }>();
        expect(row?.reason).toBe("Paid again after it was refunded");
      },
      { timeout: 15_000 },
    );
  });
});
