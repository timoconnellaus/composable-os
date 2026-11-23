// Stage 44 step 7 (ADR 0647, the owner's decision 1) on the shipped packs: Programs, Bookings and
// Memberships in the real host, with the real payments gatekeeper and its fake provider (never a
// real one). A member cools off a membership that paid for bookings ahead: each is cancelled as the
// business's (`cancelled_by_us`), its place freed so the waiting list moves people in as usual, and
// the member's own place on a waiting list it would pay for goes too; with 60 ahead, 20 go in the
// end's own batch and the minute cron's follow-ups release the rest, every batch well under D1's
// 1,000 statements. Every name and figure is invented.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
  runCoolOffSweep,
  runWaitlistDue,
} from "@composable-os/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

/** A deployment whose product lists Programs, Bookings and Memberships, each as shipped. */
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
const RETURN = "https://gym.test/account";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = "Australia/Sydney";
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

async function member(label: string): Promise<CustomerPrincipal> {
  const tag = unique(label).toLowerCase();
  const email = `${tag}@members.test`;
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

let yoga: string;
let unlimited: string;

// Every D1 batch the Worker sends, by size, while a probe watches.
const batches: number[] = [];
const failures: string[] = [];
let watching = false;

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
  yoga = await create("programs.classtype", { name: unique("Yoga"), "bookings.opensDays": 35 });
  unlimited = await create("memberships.plan", {
    title: unique("Unlimited "),
    price: 70,
    per: "week",
    status: "on_sale",
  });
  await run(
    "extensionSettings.update",
    { extension: "memberships", values: { coolingOffDays: 14 } },
    staff(),
  );
  const original = env.DB.batch.bind(env.DB);
  // biome-ignore lint/suspicious/noExplicitAny: a probe's instrument.
  (env.DB as any).batch = async (statements: D1PreparedStatement[]) => {
    if (watching) batches.push(statements.length);
    try {
      return await original(statements);
    } catch (e) {
      if (watching) failures.push(`${statements.length}: ${(e as Error).message.slice(0, 200)}`);
      throw e;
    }
  };
}, 120_000);

async function subscriptionOf(personId: string) {
  return env.DB.prepare(
    "SELECT id, state FROM core_subscription WHERE holder_person_id = ? ORDER BY created_at DESC",
  )
    .bind(personId)
    .first<{ id: string; state: string }>();
}

async function coolOffWith(n: number, extras = false) {
  const who = await member(`cool${n}`);
  await subscribe(who, unlimited);
  const sub = await subscriptionOf(who.personId);
  const week = monday(1);
  const bookings: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const c = await klass(yoga, local(addDays(week, Math.floor(i / 12)), 6 + (i % 12)), 10);
    const b = await book(who, c);
    if (b.result !== "booked") throw new Error(`booking ${i}: ${JSON.stringify(b)}`);
    bookings.push(b.bookingId as string);
  }
  let full = "";
  let waitingOwn = "";
  let otherBooking = "";
  if (extras) {
    // A class of one place the member holds, and another member waiting for it with a pass.
    full = await klass(yoga, local(addDays(week, 3), 19), 1);
    bookings.push((await book(who, full)).bookingId as string);
    const other = await member("waiter");
    await givePass(other, 5);
    otherBooking = (await book(other, full)).bookingId as string;
    // The member waiting on another full class, which the membership would pay for.
    const full2 = await klass(yoga, local(addDays(week, 3), 20), 1);
    const someone = await member("someone");
    await givePass(someone, 5);
    await book(someone, full2);
    waitingOwn = (await book(who, full2)).bookingId as string;
  }
  batches.length = 0;
  failures.length = 0;
  watching = true;
  await run("subscription.coolOff", { id: sub?.id }, as(who));
  await vi.waitFor(async () => expect((await subscriptionOf(who.personId))?.state).toBe("ended"), {
    timeout: 30_000,
  });
  await vi.waitFor(
    async () =>
      expect(
        (
          await env.DB.prepare(
            "SELECT state FROM core_subscription_cool_off WHERE subscription_id = ?",
          )
            .bind(sub?.id)
            .first<{ state: string }>()
        )?.state,
      ).toBe("ended"),
    { timeout: 30_000 },
  );
  const endBatch = Math.max(0, ...batches);
  // The minute cron's follow-ups, until nothing is left to release.
  for (let i = 0; i < 10; i += 1) {
    const left = await env.DB.prepare(
      "SELECT release_left FROM core_subscription_cool_off WHERE subscription_id = ?",
    )
      .bind(sub?.id)
      .first<{ release_left: number }>();
    if (!left?.release_left) break;
    await runCoolOffSweep(db, { integrations });
  }
  watching = false;
  const states = await Promise.all(bookings.map(async (b) => (await get(BOOKING, b)).state));
  const dues = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_sellable_refund_due d JOIN core_order o ON o.id = d.order_id WHERE o.subscription_id = ?",
  )
    .bind(sub?.id)
    .first<{ n: number }>();
  return {
    sub: sub?.id as string,
    states,
    dues: dues?.n ?? 0,
    endBatch,
    largest: Math.max(0, ...batches),
    failures: [...failures],
    full,
    otherBooking,
    waitingOwn,
  };
}

describe("cooling off releases the bookings ahead (the real Bookings pack)", () => {
  it("each ahead is cancelled as the business's, the waiter moves in, the member's own waiting place goes", async () => {
    const out = await coolOffWith(3, true);
    expect(out.failures).toEqual([]);
    expect(out.states).toEqual([
      "cancelled_by_us",
      "cancelled_by_us",
      "cancelled_by_us",
      "cancelled_by_us",
    ]);
    expect((await get(BOOKING, out.waitingOwn)).state).toBe("cancelled_by_us");
    expect(out.dues).toBe(1);
    // The place freed: the waiting list moves its first waiter in through the usual promotion.
    await runWaitlistDue(db, {});
    expect((await get(BOOKING, out.otherBooking)).state).toBe("booked");
    expect(out.endBatch).toBeLessThan(500);
  }, 180_000);

  it("60 ahead: 20 in the end's batch, the rest by follow-ups; every batch well under D1's limit", async () => {
    const out = await coolOffWith(60);
    expect(out.failures).toEqual([]);
    expect(out.states.every((s) => s === "cancelled_by_us")).toBe(true);
    expect(out.dues).toBe(1);
    console.log("cooling off batches", { end: out.endBatch, largest: out.largest });
    expect(out.largest).toBeLessThan(700);
  }, 600_000);
});
