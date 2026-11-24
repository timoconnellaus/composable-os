// Stage 31a steps 4 and 5 (ADR 0520) on the shipped packs: Programs, Bookings and Memberships in
// the real host and sandbox, with the payments gatekeeper's fake provider for memberships.
//
// Step 4, spending (acceptance criterion 3): a membership of 3 a week, off-peak, for one class
// type, granted by the provider's verified events, pays for bookings in the class's week (not the
// week of booking); a fourth in that week is refused and one the next week is booked; two bookings
// at once for the last use, one succeeds; a class at 18:00 and one of another type are refused. An
// unlimited membership is spent before a pass and still writes a use; a pass named is the one
// spent; a pass that ends before the class cannot pay for it.
//
// Step 5, the waitlist (acceptance criterion 5): joining a full class spends nothing and says
// where they stand; a place given back before the cut-off is the waitlist's (the public sees the
// class full, a direct booking joins the waitlist), and the minute cron's step moves the first
// waiter who can pay in, spending their use then, and passes over one with nothing to spend; from
// the cut-off a member cannot join, and a freed place goes to whoever books first; leaving the
// waitlist; and a race of cancels, direct bookings and two promotions never over-fills the class or
// loses a place. Messages (promoted, passed over, a place free) are step 9's; the host records
// what they will say (`promotedAt`, `passedOverReason`).
//
// Clocks: a tool's own calls read the real clock (the runner's executor), so classes are placed
// from now, and the cron step is run on the real clock too.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type InvocationContext,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
  runWaitlistDue,
} from "@composable-os/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, newCustomer, run, unique } from "./helpers.ts";
import { gymHost as shippedHost } from "./pack-files.ts";

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const RETURN = "https://gym.test/account";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = "Australia/Sydney";
const CLASS = "bookings.class";
const BOOKING = "bookings.booking";
const MEMBERSHIP = "memberships.membership";
const PASS = "memberships.pass";

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
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  integrations,
  extensionHost: shippedHost,
});
const guest: OutsideInvocationContext = {
  principal: { kind: "public" },
  db,
  integrations,
  extensionHost: shippedHost,
};
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
const get = async (object: string, id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object, id }, staff())).values;

const member = async (label: string) => (await newCustomer(staff(), label)).principal;

/** The instant of a wall-clock time on a local date in ZONE. */
function local(date: string, hour: number, minute = 0): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: ZONE,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return (
      Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - instant
    );
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first)).toISOString();
}

/** A local date (YYYY-MM-DD) `days` after another. */
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** The Monday (local date) of the week `weeks` after this one in ZONE. */
function monday(weeks: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date());
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 Sunday
  return addDays(today, -((dow + 6) % 7) + 7 * weeks);
}

async function klass(type: string, startsAt: string, places = 10): Promise<string> {
  return create(CLASS, {
    classType: type,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: ZONE,
    places,
  });
}

type BookOut = {
  result: string;
  bookingId?: string;
  holderId?: string | null;
  position?: number | null;
  waiting?: number | null;
  reason?: string;
  detail?: string | null;
};
const book = (who: CustomerPrincipal, classId: string, extra: Record<string, unknown> = {}) =>
  run<BookOut>("x.bookings.book", { classId, ...extra }, as(who));

async function counter(id: string) {
  return env.DB.prepare(
    "SELECT places, held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(CLASS, id)
    .first();
}

/** The fake provider's page: pay. */
async function pay(url: string) {
  const paid = await runner.gatekeeperFetch(
    "payments",
    new Request(url, {
      method: "POST",
      body: new URLSearchParams({ outcome: "pay" }),
      redirect: "manual",
    }),
  );
  expect(paid.status).toBe(303);
}

type Holding = { id: string; kind: string; status: string; live: boolean };
const holdings = async (who: CustomerPrincipal) =>
  (await run<{ holdings: Holding[] }>("x.memberships.mine", {}, as(who))).holdings;

/** A member subscribed to `plan` through the fake provider; their membership's id. */
async function subscribe(who: CustomerPrincipal, plan: string): Promise<string> {
  const started = await run<{ url: string }>(
    "subscription.start",
    { plan: { object: "memberships.plan", id: plan }, returnUrl: RETURN },
    as(who),
  );
  await pay(started.url);
  await vi.waitFor(
    async () => expect((await holdings(who)).find((h) => h.kind === "membership")?.live).toBe(true),
    { timeout: 20_000 },
  );
  return ((await holdings(who)).find((h) => h.kind === "membership") as Holding).id;
}

/** A pass of `uses` given by staff (a person) to a member; its id. */
async function givePass(who: CustomerPrincipal, uses = 5, validDays = 60): Promise<string> {
  const type = await create("memberships.passtype", {
    title: unique("Pack "),
    price: 50,
    uses,
    validDays,
    status: "on_sale",
  });
  const given = await run<{ passId: string }>(
    "x.memberships.givePass",
    { personId: who.personId, passTypeId: type, reason: "Integration test" },
    staff(),
  );
  return given.passId;
}

const left = async (pass: string) => (await get(PASS, pass)).left;

let yoga: string;
let spin: string;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "memberships"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  await run("settings.update", { timezone: ZONE }, staff()).catch(() => undefined);
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
  // Booking opens five weeks ahead for these class types, so the weeks used below are open.
  yoga = await create("programs.classtype", { name: unique("Yoga"), "bookings.opensDays": 35 });
  spin = await create("programs.classtype", { name: unique("Spin"), "bookings.opensDays": 35 });
}, 120_000);

describe("spending (step 4)", () => {
  it("3 a week, off-peak, one class type: counted in the class's week, the fourth refused, the last use once", async () => {
    const plan = await create("memberships.plan", {
      title: unique("Three a week "),
      price: 45,
      uses: 3,
      per: "week",
      classTypes: [yoga],
      fromMinute: 6 * 60,
      untilMinute: 16 * 60,
      trialDays: 7,
      status: "on_sale",
    });
    const who = await member("weekly");
    const membership = await subscribe(who, plan);
    // Two weeks out, and the week after: booked today, counted in the class's week.
    const week = monday(2);
    const next = monday(3);
    const tue7 = await klass(yoga, local(addDays(week, 1), 7));
    const tue8 = await klass(yoga, local(addDays(week, 1), 8));
    const tue9 = await klass(yoga, local(addDays(week, 1), 9));
    const wed9 = await klass(yoga, local(addDays(week, 2), 9));
    const thu9 = await klass(yoga, local(addDays(week, 3), 9));

    expect(await book(who, tue7)).toMatchObject({ result: "booked", holderId: membership });
    expect(await book(who, tue8)).toMatchObject({ result: "booked", holderId: membership });
    // Two at once for the last use of the week: exactly one is booked.
    const raced = await Promise.all([book(who, tue9), book(who, wed9)]);
    expect(raced.filter((r) => r.result === "booked")).toHaveLength(1);
    expect(raced.filter((r) => r.result === "refused")).toEqual([
      expect.objectContaining({ reason: "no_use" }),
    ]);
    // A fourth in that week is refused with the reason; the week after has its own three.
    expect(await book(who, thu9)).toMatchObject({
      result: "refused",
      reason: "no_use",
      detail: "no_uses_left",
    });
    const during = (iso: string) =>
      run<{ period: { used: number; left: number } }>(
        "allowance.get",
        { object: MEMBERSHIP, id: membership, at: iso },
        as(who),
      );
    expect((await during(local(addDays(week, 1), 7))).period).toMatchObject({ used: 3, left: 0 });
    // Now (this week) nothing is spent: the uses are next weeks'.
    expect((await during(new Date().toISOString())).period).toMatchObject({ used: 0, left: 3 });

    expect(await book(who, await klass(yoga, local(addDays(next, 1), 7)))).toMatchObject({
      result: "booked",
    });
    // Off-peak only: 18:00 is not paid for; nor is another class type.
    expect(await book(who, await klass(yoga, local(addDays(next, 2), 18)))).toMatchObject({
      result: "refused",
      reason: "no_use",
    });
    expect(await book(who, await klass(spin, local(addDays(next, 2), 10)))).toMatchObject({
      result: "refused",
      reason: "no_use",
    });
    expect((await during(local(addDays(next, 1), 7))).period).toMatchObject({ used: 1, left: 2 });

    // A cancel in time gives the week's use back: the fourth can now be booked.
    const mine = await run<{ bookings: { id: string; classId: string }[] }>(
      "x.bookings.mine",
      {},
      as(who),
    );
    const first = mine.bookings.find((b) => b.classId === tue7)?.id as string;
    await run(
      "x.bookings.cancel",
      { bookingId: first, confirm: true, expect: "cancelled" },
      as(who),
    );
    expect(await book(who, thu9)).toMatchObject({ result: "booked" });
  });

  it("an unlimited membership is spent first and writes a use; a named pass is spent; a pass ending first cannot pay", async () => {
    const plan = await create("memberships.plan", {
      title: unique("Unlimited "),
      price: 80,
      per: "week",
      trialDays: 7,
      status: "on_sale",
    });
    const who = await member("unlimited");
    const membership = await subscribe(who, plan);
    const pass = await givePass(who, 5);
    const at = local(addDays(monday(2), 4), 10);
    const auto = await book(who, await klass(spin, at));
    expect(auto).toMatchObject({ result: "booked", holderId: membership });
    const uses = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_allowance_use WHERE record_id = ? AND returned_at IS NULL",
    )
      .bind(membership)
      .first<{ n: number }>();
    expect(uses?.n).toBe(1);
    // They name the pass: it is the one spent.
    const named = await book(who, await klass(spin, local(addDays(monday(2), 4), 12)), {
      holderId: pass,
    });
    expect(named).toMatchObject({ result: "booked", holderId: pass });
    expect(await left(pass)).toBe(4);

    // A pass of one day cannot pay for a class two weeks out.
    const brief = await member("brief");
    await givePass(brief, 5, 1);
    expect(await book(brief, await klass(spin, at))).toMatchObject({
      result: "refused",
      reason: "no_use",
      detail: "ended",
    });
  });
});

describe("the waitlist (step 5)", () => {
  it("joins spend nothing; a freed place is the waitlist's; the first who can pay is moved in, one who cannot is passed over", async () => {
    const type = await create("programs.classtype", { name: unique("Strength") });
    const k = await klass(type, new Date(Date.now() + 2 * DAY).toISOString(), 1);
    const [a, b, c, d] = (await Promise.all(["wa", "wb", "wc", "wd"].map((l) => member(l)))) as [
      CustomerPrincipal,
      CustomerPrincipal,
      CustomerPrincipal,
      CustomerPrincipal,
    ];
    await givePass(a);
    const bPass = await givePass(b);
    await givePass(d);
    // c holds nothing: joining spends nothing, so they may wait.
    const aBooked = await book(a, k);
    expect(aBooked.result).toBe("booked");
    const cWaits = await book(c, k);
    expect(cWaits).toMatchObject({ result: "waiting", position: 1, waiting: 1 });
    const bWaits = await book(b, k);
    expect(bWaits).toMatchObject({ result: "waiting", position: 2, waiting: 2 });
    expect(await left(bPass)).toBe(5);
    // Without the waitlist, full is full.
    expect(await book(d, k, { waitlist: false })).toMatchObject({
      result: "refused",
      reason: "full",
    });

    // a cancels in time: the place is the waitlist's, in the cancel's batch.
    await run(
      "x.bookings.cancel",
      { bookingId: aBooked.bookingId, confirm: true, expect: "cancelled" },
      as(a),
    );
    expect(await counter(k)).toEqual({ places: 1, held: 1, taken: 0 });
    const shown = await run<{ status: string }>("capacity.get", { object: CLASS, id: k }, guest);
    expect(shown.status).toBe("sold_out");
    // Someone booking now joins the waitlist behind them.
    expect(await book(d, k)).toMatchObject({ result: "waiting", position: 3 });

    const tick = await runWaitlistDue(db);
    expect(tick).toMatchObject({ promoted: 1, passedOver: 1 });
    const cBooking = await get(BOOKING, cWaits.bookingId as string);
    expect(cBooking).toMatchObject({ state: "waiting", passedOverReason: "no_holder" });
    expect(cBooking.passedOverAt).toBeTruthy();
    const bBooking = await get(BOOKING, bWaits.bookingId as string);
    expect(bBooking).toMatchObject({ state: "booked", holder: bPass });
    expect(bBooking.promotedAt).toBeTruthy();
    // The use is spent on moving in.
    expect(await left(bPass)).toBe(4);
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 1 });
    // d stands behind c, who keeps their place.
    const dMine = await run<{ bookings: { state: string; position: number | null }[] }>(
      "x.bookings.mine",
      { state: "waiting" },
      as(d),
    );
    expect(dMine.bookings).toEqual([expect.objectContaining({ state: "waiting", position: 2 })]);
    // b reads why they are in; c reads why they were passed over; neither reads the other.
    const cMine = await run<{ bookings: { id: string }[] }>("x.bookings.mine", {}, as(c));
    expect(cMine.bookings.map((x) => x.id)).toEqual([cWaits.bookingId]);

    // d leaves the waitlist.
    const dLeft = await run<{ result: string }>(
      "x.bookings.leaveWaitlist",
      {
        bookingId: (await run<{ bookings: { id: string }[] }>("x.bookings.mine", {}, as(d)))
          .bookings[0]?.id,
      },
      as(d),
    );
    expect(dLeft.result).toBe("left");
  });

  it("from the cut-off: nobody joins, and a freed place goes to whoever books first", async () => {
    const type = await create("programs.classtype", { name: unique("Late") });
    // 100 minutes ahead: inside the 2-hour cut-off, before the 1-hour late cancel.
    const k = await klass(type, new Date(Date.now() + 100 * 60_000).toISOString(), 1);
    const [a, b] = await Promise.all([member("ca"), member("cb")]);
    await givePass(a);
    await givePass(b);
    const aBooked = await book(a, k);
    expect(aBooked.result).toBe("booked");
    expect(await book(b, k)).toMatchObject({ result: "refused", reason: "waitlist_closed" });
    await run(
      "x.bookings.cancel",
      { bookingId: aBooked.bookingId, confirm: true, expect: "cancelled" },
      as(a),
    );
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 0 });
    expect(await book(b, k)).toMatchObject({ result: "booked" });
  });

  it("12 at once into a class of 4, then a cancel, a direct booking and two promotions at once: never over its places, no place lost", async () => {
    const type = await create("programs.classtype", { name: unique("Race") });
    const k = await klass(type, new Date(Date.now() + 3 * DAY).toISOString(), 4);
    const people = await Promise.all(Array.from({ length: 13 }, (_, i) => member(`race${i}`)));
    for (const p of people) await givePass(p);
    const [outsider, ...members] = people as [CustomerPrincipal, ...CustomerPrincipal[]];
    const first = await Promise.all(members.map((p) => book(p, k)));
    expect(first.filter((r) => r.result === "booked")).toHaveLength(4);
    expect(first.filter((r) => r.result === "waiting")).toHaveLength(8);
    expect(await counter(k)).toEqual({ places: 4, held: 0, taken: 4 });
    // Settled, every waiter has a place of their own in the queue (staff read it).
    const queue = new Map<number, string>();
    for (const r of first.filter((x) => x.result === "waiting")) {
      const at = await run<{ position: number }>(
        "waitlist.position",
        { object: BOOKING, id: r.bookingId },
        staff(),
      );
      queue.set(at.position, r.bookingId as string);
    }
    expect([...queue.keys()].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const leaver = members[first.findIndex((r) => r.result === "booked")] as CustomerPrincipal;
    const leaving = first.find((r) => r.result === "booked")?.bookingId as string;
    const settled = await Promise.allSettled([
      run(
        "x.bookings.cancel",
        { bookingId: leaving, confirm: true, expect: "cancelled" },
        as(leaver),
      ),
      book(outsider, k),
      runWaitlistDue(db),
      runWaitlistDue(db),
    ]);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    await runWaitlistDue(db);
    expect(await counter(k)).toEqual({ places: 4, held: 0, taken: 4 });
    // The place went to the first waiter, never to the one who booked directly.
    expect((await get(BOOKING, queue.get(1) as string)).state).toBe("booked");
    expect((await get(BOOKING, queue.get(2) as string)).state).toBe("waiting");
    const direct = (settled[1] as PromiseFulfilledResult<BookOut>).value;
    expect(direct.result).toBe("waiting");
  });
});

describe("review findings (PR #248)", () => {
  it("finding 4: waiters who cannot pay ahead of one who can, past a page: the queue is worked down, not given away", async () => {
    const type = await create("programs.classtype", { name: unique("Long") });
    const k = await klass(type, new Date(Date.now() + 2 * DAY).toISOString(), 1);
    const [a, broke1, broke2, payer] = (await Promise.all(
      ["la", "lb1", "lb2", "lp"].map((l) => member(l)),
    )) as [CustomerPrincipal, CustomerPrincipal, CustomerPrincipal, CustomerPrincipal];
    await givePass(a);
    await givePass(payer);
    const aBooked = await book(a, k);
    // Two who hold nothing wait first, then one who can pay.
    await book(broke1, k);
    await book(broke2, k);
    const pWaits = await book(payer, k);
    expect(pWaits.result).toBe("waiting");
    await run(
      "x.bookings.cancel",
      { bookingId: aBooked.bookingId, confirm: true, expect: "cancelled" },
      as(a),
    );
    // A page of two: both passed over, the place kept for the queue (not given to the public).
    const first = await runWaitlistDue(db, { maxWaiters: 2 });
    expect(first).toMatchObject({ promoted: 0, passedOver: 2, released: 0 });
    expect(await counter(k)).toEqual({ places: 1, held: 1, taken: 0 });
    // The next tick tries the next waiter, who can pay.
    const second = await runWaitlistDue(db, { maxWaiters: 2 });
    expect(second.promoted).toBe(1);
    expect((await get(BOOKING, pWaits.bookingId as string)).state).toBe("booked");
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 1 });
  });

  it("finding 5: a waiter takes a free place themselves; never one held for the queue", async () => {
    const type = await create("programs.classtype", { name: unique("Free") });
    const k = await klass(type, new Date(Date.now() + 2 * DAY).toISOString(), 1);
    const [a, b, c] = (await Promise.all(["fa", "fb", "fc"].map((l) => member(l)))) as [
      CustomerPrincipal,
      CustomerPrincipal,
      CustomerPrincipal,
    ];
    await givePass(a);
    const bPass = await givePass(b);
    await givePass(c);
    expect((await book(a, k)).result).toBe("booked");
    const bWaits = await book(b, k);
    const cWaits = await book(c, k);
    expect([bWaits.result, cWaits.result]).toEqual(["waiting", "waiting"]);
    // Booking again while full: still waiting, with where they stand (not "already booked").
    expect(await book(c, k)).toMatchObject({ result: "waiting", position: 2 });
    // Staff add a place: it is free to anyone, the waiters included; c takes it themselves.
    await run("record.update", { object: CLASS, id: k, values: { places: 2 } }, staff());
    expect(await book(c, k)).toMatchObject({ result: "booked", bookingId: cWaits.bookingId });
    expect(await counter(k)).toEqual({ places: 2, held: 0, taken: 2 });
    // A place held for the queue is not taken that way: a cancels, the hold is b's to be given.
    const mineA = await run<{ bookings: { id: string; state: string | null }[] }>(
      "x.bookings.mine",
      {},
      as(a),
    );
    await run(
      "x.bookings.cancel",
      { bookingId: mineA.bookings[0]?.id, confirm: true, expect: "cancelled" },
      as(a),
    );
    expect(await counter(k)).toEqual({ places: 2, held: 1, taken: 1 });
    expect(await left(bPass)).toBe(5);
    // b's own booking would jump nobody, but the place is the queue's: the host gives it.
    expect(await book(b, k)).toMatchObject({ result: "waiting", position: 1 });
    await runWaitlistDue(db);
    expect((await get(BOOKING, bWaits.bookingId as string)).state).toBe("booked");
    expect(await left(bPass)).toBe(4);
  });

  it("round two, finding 2: a waiter passed over for an older place is tried again for a newer one", async () => {
    const type = await create("programs.classtype", { name: unique("Twice") });
    const k = await klass(type, new Date(Date.now() + 2 * DAY).toISOString(), 2);
    const [x, y, a, b] = (await Promise.all(["tx", "ty", "ta", "tb"].map((l) => member(l)))) as [
      CustomerPrincipal,
      CustomerPrincipal,
      CustomerPrincipal,
      CustomerPrincipal,
    ];
    await givePass(x);
    await givePass(y);
    await givePass(b);
    const xBooked = await book(x, k);
    const yBooked = await book(y, k);
    // a waits first with nothing to pay; b behind, with a pass.
    const aWaits = await book(a, k);
    const bWaits = await book(b, k);
    expect([aWaits.result, bWaits.result]).toEqual(["waiting", "waiting"]);
    await run(
      "x.bookings.cancel",
      { bookingId: xBooked.bookingId, confirm: true, expect: "cancelled" },
      as(x),
    );
    // A page of one: a passed over, the place kept for the queue.
    expect(await runWaitlistDue(db, { maxWaiters: 1 })).toMatchObject({
      passedOver: 1,
      promoted: 0,
    });
    // a gets a pass; y frees a second place.
    await givePass(a);
    await run(
      "x.bookings.cancel",
      { bookingId: yBooked.bookingId, confirm: true, expect: "cancelled" },
      as(y),
    );
    await runWaitlistDue(db);
    // Both are moved in: a is tried again for the newer place, nothing goes to the public.
    expect((await get(BOOKING, aWaits.bookingId as string)).state).toBe("booked");
    expect((await get(BOOKING, bWaits.bookingId as string)).state).toBe("booked");
    expect(await counter(k)).toEqual({ places: 2, held: 0, taken: 2 });
  });

  it("round two: a class marked done early takes nobody in from its waitlist, and its holds go back", async () => {
    const type = await create("programs.classtype", { name: unique("Done") });
    const k = await klass(type, new Date(Date.now() + 2 * DAY).toISOString(), 1);
    const [a, b] = (await Promise.all(["da", "db"].map((l) => member(l)))) as [
      CustomerPrincipal,
      CustomerPrincipal,
    ];
    await givePass(a);
    await givePass(b);
    const aBooked = await book(a, k);
    const bWaits = await book(b, k);
    await run(
      "x.bookings.cancel",
      { bookingId: aBooked.bookingId, confirm: true, expect: "cancelled" },
      as(a),
    );
    expect(await counter(k)).toEqual({ places: 1, held: 1, taken: 0 });
    await run("record.update", { object: CLASS, id: k, values: { state: "done" } }, staff());
    // The waiter's own move in is refused; the host does not promote; the hold goes back.
    expect(await book(b, k)).toMatchObject({ result: "refused" });
    await runWaitlistDue(db);
    expect((await get(BOOKING, bWaits.bookingId as string)).state).toBe("waiting");
    expect(await counter(k)).toEqual({ places: 1, held: 0, taken: 0 });
  });

  it("round two: erasing a waiting member who named a pass takes them out of the queue", async () => {
    const type = await create("programs.classtype", { name: unique("Erase") });
    const k = await klass(type, new Date(Date.now() + 2 * DAY).toISOString(), 1);
    const [a, b, c] = (await Promise.all(["ea", "eb", "ec"].map((l) => member(l)))) as [
      CustomerPrincipal,
      CustomerPrincipal,
      CustomerPrincipal,
    ];
    await givePass(a);
    const bPass = await givePass(b);
    await givePass(c);
    const aBooked = await book(a, k);
    const bWaits = await book(b, k, { holderId: bPass });
    const cWaits = await book(c, k);
    expect(cWaits).toMatchObject({ result: "waiting", position: 2 });
    await run("person.erase", { id: b.personId }, staff());
    const after = await run<{ position: number }>(
      "waitlist.position",
      { object: BOOKING, id: cWaits.bookingId },
      staff(),
    );
    expect(after.position).toBe(1);
    const gone = await run("record.get", { object: BOOKING, id: bWaits.bookingId }, staff())
      .then(() => "found")
      .catch((e: { code?: string }) => e.code);
    expect(gone).toBe("not_found");
    await run(
      "x.bookings.cancel",
      { bookingId: aBooked.bookingId, confirm: true, expect: "cancelled" },
      as(a),
    );
    await runWaitlistDue(db);
    expect((await get(BOOKING, cWaits.bookingId as string)).state).toBe("booked");
  });

  it("a member cannot read another member's place in the queue", async () => {
    const type = await create("programs.classtype", { name: unique("Private") });
    const k = await klass(type, new Date(Date.now() + 2 * DAY).toISOString(), 1);
    const [a, b, c] = (await Promise.all(["pa", "pb", "pc"].map((l) => member(l)))) as [
      CustomerPrincipal,
      CustomerPrincipal,
      CustomerPrincipal,
    ];
    await givePass(a);
    await book(a, k);
    const bWaits = await book(b, k);
    expect(bWaits.result).toBe("waiting");
    const own = await run<{ position: number }>(
      "waitlist.position",
      { object: BOOKING, id: bWaits.bookingId },
      as(b),
    );
    expect(own.position).toBe(1);
    const other = await run("waitlist.position", { object: BOOKING, id: bWaits.bookingId }, as(c))
      .then(() => null)
      .catch((e: { code?: string }) => e.code);
    expect(other).toBe("not_found");
  });
});
