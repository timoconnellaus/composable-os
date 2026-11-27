// Stage 31a step 7 (ADRs 0550 to 0553) on the shipped packs: Programs, Bookings and Memberships in
// the real host and sandbox, members paying with passes the staff give.
//
// Attendance (acceptance criterion 7): two coaches ticking one name at once mark it once and the
// second is told who was first; the list opens an hour before the class; a booking cancelled (by
// the member or with its class) cannot be ticked; 30 minutes after a class ends its still-booked
// bookings become no-shows only if its attendance was taken, the use kept; a late correction. The
// coach role holds the day, the list and ticking, and nothing else; a coach's tool run is held to
// the day of the call that started it (#290).
//
// Moves (criterion 11): staff move a member to another class with their use in one batch, refused
// whole when the new class is full (its waitlist's held places included) or the use cannot be
// spent; a place a move frees before the cut-off goes to the waitlist; the moved state is entered
// only by such a move; a booking paid at the desk moves paid at the desk; not after the class
// starts.
//
// Cancelling a class (criterion 6): every booking and waiter cancelled in its batch, every use
// returned, every place given back; refused to an AI without a person's approval (whatever the
// preset), applied once a person approves; a booking racing the cancel never stays booked on it.
// Emails (step 9) and drop-in refunds (step 8) are not here yet.
//
// Clocks: a tool's own calls read the real clock, so classes are placed from now; the timed-move
// sweep is run with a clock past the classes' ends. A coach's calls on a class minutes away run at
// its start, so its day is the coach's today even when the run crosses local midnight (#290).
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  newId,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
  runTimedMovesDue,
  runWaitlistDue,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
// A shipped fixture pack whose tool calls Bookings' roster: a limit to today must follow the call.
files.relay = {
  "index.ts": `import { defineExtension, defineTool, z } from "@composable-os/sdk";
export default defineExtension({
  id: "relay",
  version: "0.1.0",
  contractVersion: 1,
  label: "Relay (fixture)",
  requires: ["bookings"],
  permissions: { operations: ["x.bookings.roster"], modules: ["ops"] },
  objects: {},
  tools: {
    relay: defineTool({
      description: "Test fixture: reads a class's list through Bookings' own roster tool.",
      input: z.object({ classId: z.string() }),
      output: z.object({}).passthrough(),
      risk: "read",
      handler: (input, ctx) => ctx.ops.call("x.bookings.roster", input),
    }),
  },
});
`,
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
    { id: "relay", version: "0.1.0" },
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
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZONE = "Australia/Sydney";
const CLASS = "bookings.class";
const BOOKING = "bookings.booking";
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
const run = <T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
) => invokeByName(name, input, ctx) as Promise<T>;
const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
const get = async (object: string, id: string) =>
  (await run<{ values: Record<string, unknown> }>("record.get", { object, id }, staff())).values;
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeTruthy();
  return error as { code: string; details?: Record<string, unknown> };
}

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

/** A staff account (a member of the staff) given the Bookings coach role by a human admin. */
async function coach(name: string): Promise<ActingUser> {
  const id = newId("user");
  const email = `${unique("coach")}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 1, ?, ?, 'member')",
  )
    .bind(id, name, email, now, now)
    .run();
  await run("user.setPackRole", { id, role: "bookings.coach" }, staff());
  return { id, email, name, role: "viewer" };
}
const asCoach = (user: ActingUser, clock?: () => Date) =>
  staff({ user, ...(clock ? { clock } : {}) });

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
/** A clock stopped at a class's start: the class is on that clock's today in any zone. */
const startOf = async (classId: string) => {
  const at = new Date(String((await get(CLASS, classId)).startsAt));
  return () => at;
};

/** A one-off class starting `in` ms from now, an hour long. */
async function klass(type: string, inMs: number, places = 10): Promise<string> {
  const startsAt = new Date(Date.now() + inMs).toISOString();
  return create(CLASS, {
    classType: type,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: ZONE,
    places,
  });
}

type Out = Record<string, unknown> & { result: string; bookingId?: string };
const book = (who: CustomerPrincipal, classId: string, extra: Record<string, unknown> = {}) =>
  run<Out>("x.bookings.book", { classId, ...extra }, as(who));
async function booked(who: CustomerPrincipal, classId: string): Promise<string> {
  const out = await book(who, classId);
  if (out.result !== "booked") throw new Error(`Not booked: ${JSON.stringify(out)}`);
  return out.bookingId as string;
}
const stateOf = async (booking: string) => (await get(BOOKING, booking)).state;

async function counter(id: string) {
  return env.DB.prepare(
    "SELECT places, held, taken FROM core_capacity WHERE object_type = ? AND record_id = ?",
  )
    .bind(CLASS, id)
    .first();
}
/** A Person's journey signals (stage 53): which, about what record, and who stood behind it. */
async function signalsOf(personId: string) {
  const { results } = await env.DB.prepare(
    "SELECT signal, object_type, standing, bulk, last_at FROM core_person_signal WHERE person_id = ? ORDER BY signal",
  )
    .bind(personId)
    .all<{
      signal: string;
      object_type: string;
      standing: string;
      bulk: number;
      last_at: string;
    }>();
  return results;
}

/** How many times a booking entered a state (its state history). */
async function entered(booking: string, state: string) {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM core_transition_history WHERE object_type = ? AND record_id = ? AND position_id = ?",
  )
    .bind(BOOKING, booking, state)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

let type: string;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["bookings", "memberships"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  await run("settings.update", { timezone: ZONE }, staff()).catch(() => undefined);
  type = await create("bookings.classtype", { name: unique("Strength") });
}, 120_000);

afterAll(() => setPreset("balanced"));

// --- Attendance and no-shows (criterion 7) -------------------------------------------------------

describe("attendance (criterion 7)", () => {
  it("two coaches ticking one name at once mark it once, and the second is told who was first", async () => {
    const [kim, sam] = await Promise.all([coach("Coach Kim"), coach("Coach Sam")]);
    const k = await klass(type, 2 * MINUTE);
    const clock = await startOf(k);
    const who = await member("tick");
    const pass = await givePass(who);
    const booking = await booked(who, k);
    const [a, b] = await Promise.all([
      run<Out>("x.bookings.markAttended", { bookingId: booking }, asCoach(kim, clock)),
      run<Out>("x.bookings.markAttended", { bookingId: booking }, asCoach(sam, clock)),
    ]);
    const results = [a, b].map((r) => r.result).sort();
    expect(results).toEqual(["already", "attended"]);
    const winner = a.result === "attended" ? "Coach Kim" : "Coach Sam";
    const loser = a.result === "attended" ? b : a;
    expect(loser).toMatchObject({ result: "already", markedBy: winner });
    expect(loser.message).toContain(winner);
    expect(await entered(booking, "attended")).toBe(1);
    expect(await get(BOOKING, booking)).toMatchObject({
      state: "attended",
      markedByName: winner,
    });
    // Ticked keeps its place and its use.
    expect(await counter(k)).toMatchObject({ taken: 1 });
    expect(await left(pass)).toBe(4);
    // Eight ticks at once of one name by both coaches: still one move.
    const other = await member("tick8");
    await givePass(other);
    const many = await booked(other, k);
    const ticks = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run<Out>("x.bookings.markAttended", { bookingId: many }, asCoach(i % 2 ? kim : sam, clock)),
      ),
    );
    expect(ticks.filter((t) => t.result === "attended")).toHaveLength(1);
    expect(ticks.filter((t) => t.result === "already")).toHaveLength(7);
    expect(await entered(many, "attended")).toBe(1);
  });

  it("the list opens an hour before; a cancelled booking, or one of a cancelled class, cannot be ticked", async () => {
    const later = await klass(type, 3 * HOUR);
    const who = await member("early");
    await givePass(who);
    const booking = await booked(who, later);
    const early = await run<Out>("x.bookings.markAttended", { bookingId: booking }, staff());
    expect(early).toMatchObject({ result: "refused", reason: "not_started" });
    expect(Date.parse(String(early.opensAt))).toBeGreaterThan(Date.now() + HOUR);
    // A no-show only once the class has started; the host's window, for staff too.
    expect(await run<Out>("x.bookings.markNoShow", { bookingId: booking }, staff())).toMatchObject({
      result: "refused",
      reason: "not_started",
    });
    // Nor through the generic write, by a person.
    expect(
      await refusal(
        run(
          "record.update",
          { object: BOOKING, id: booking, values: { state: "attended" } },
          staff(),
        ),
      ),
    ).toMatchObject({ code: "invalid_input", details: { rule: "state_window_not_open" } });
    expect(await stateOf(booking)).toBe("booked");

    // Soon: the member cancels in time; their booking cannot be ticked.
    const soon = await klass(type, 30 * MINUTE + 2 * HOUR);
    const gone = await booked(who, soon);
    await run(
      "x.bookings.cancel",
      { bookingId: gone, confirm: true, expect: "cancelled" },
      as(who),
    );
    expect(await run<Out>("x.bookings.markAttended", { bookingId: gone }, staff())).toMatchObject({
      result: "refused",
      reason: "not_booked",
      state: "cancelled",
    });
    // A class the gym cancels takes its bookings with it: nothing left to tick.
    const now = await klass(type, 20 * MINUTE);
    const third = await booked(who, now);
    await run("x.bookings.cancelClass", { classId: now, reason: "Flood in the hall" }, staff());
    expect(await run<Out>("x.bookings.markAttended", { bookingId: third }, staff())).toMatchObject({
      result: "refused",
      reason: "not_booked",
      state: "cancelled_by_us",
    });
  });

  it("no-shows: written 30 minutes after the class only where attendance was taken; the use is kept; corrections", async () => {
    const taken = await klass(type, 30 * MINUTE);
    const forgotten = await klass(type, 30 * MINUTE);
    const people = await Promise.all(["ns1", "ns2", "ns3", "ns4", "ns5"].map((l) => member(l)));
    const passes = await Promise.all(people.map((p) => givePass(p)));
    const [p1, p2, p3, p4, p5] = people as [
      CustomerPrincipal,
      CustomerPrincipal,
      CustomerPrincipal,
      CustomerPrincipal,
      CustomerPrincipal,
    ];
    const came = await booked(p1, taken);
    const absent = await booked(p2, taken);
    const absent2 = await booked(p3, taken);
    const notTicked = [await booked(p4, forgotten), await booked(p5, forgotten)];
    expect(await run<Out>("x.bookings.markAttended", { bookingId: came }, staff())).toMatchObject({
      result: "attended",
    });
    // Each is a journey signal of the member's, written in the batch that made it (stage 53,
    // ADR 0802): the pass given, the class booked, the class attended.
    // The member's own booking stands as theirs; the pass and the tick, made through the pack's
    // tools by a person, as the host's (ADR 0590's marks).
    const ticked = await signalsOf(p1.personId);
    expect(ticked.map((r) => [r.signal, r.object_type, r.standing, r.bulk])).toEqual([
      ["bookings.attended", BOOKING, "host", 0],
      ["bookings.booked", BOOKING, "customer", 0],
      ["memberships.passStarted", PASS, "host", 0],
    ]);

    // Not yet: the class ends in 90 minutes, and the host waits 30 minutes more.
    const before = await runTimedMovesDue(db, { clock: () => new Date(Date.now() + 100 * MINUTE) });
    expect(before.moved).toBe(0);
    expect(await stateOf(absent)).toBe("booked");

    const after = await runTimedMovesDue(db, {
      clock: () => new Date(Date.now() + 2 * HOUR + MINUTE),
    });
    expect(after.failed).toBe(0);
    expect(await stateOf(absent)).toBe("no_show");
    expect(await stateOf(absent2)).toBe("no_show");
    expect(await stateOf(came)).toBe("attended");
    // The forgotten list makes nobody a no-show.
    for (const id of notTicked) expect(await stateOf(id)).toBe("booked");
    // A no-show and an attended booking keep their uses; their places too.
    for (const pass of passes) expect(await left(pass)).toBe(4);
    expect(await counter(taken)).toMatchObject({ taken: 3 });
    // A re-run moves nothing twice.
    const again = await runTimedMovesDue(db, {
      clock: () => new Date(Date.now() + 2 * HOUR + MINUTE),
    });
    expect(await entered(absent, "no_show")).toBe(1);
    expect(again.failed).toBe(0);

    // A late correction: the no-show did come (ticked after the class).
    expect(await run<Out>("x.bookings.markAttended", { bookingId: absent }, staff())).toMatchObject(
      { result: "attended" },
    );
    // And one ticked by mistake is unticked: booked again, then a no-show at the next sweep.
    expect(await run<Out>("x.bookings.undoAttended", { bookingId: came }, staff())).toMatchObject({
      result: "booked",
    });
    await runTimedMovesDue(db, { clock: () => new Date(Date.now() + 2 * HOUR + MINUTE) });
    expect(await stateOf(came)).toBe("no_show");
    // A tick taken back is not a new booking: the signals are as they were.
    expect(await signalsOf(p1.personId)).toEqual(ticked);
    expect(await left(passes[0] as string)).toBe(4);

    // The sweep's step is the host's: refused from any origin the host did not set.
    expect(
      await refusal(
        run(
          "state.after",
          { object: BOOKING, id: notTicked[0], rule: 0, from: "booked" },
          staff({ actor: "automation", origin: { surface: "ui" } }),
        ),
      ),
    ).toMatchObject({ code: expect.stringMatching(/forbidden|unknown_operation/) });
    // A no-show is never written through a staff write before the class starts (above), nor a
    // move into it by a customer.
  });

  it("the coach's today is the class's own: a class running past its local midnight is ticked until it ends", async () => {
    const kim = await coach("Coach Night");
    // A whole-hour zone where it is now just past midnight.
    const now = new Date();
    const offset = (24 - now.getUTCHours()) % 24;
    const hours = offset > 14 ? offset - 24 : offset;
    // Zones on a whole hour with no clock change, by offset.
    const ZONES: Record<number, string> = {
      14: "Pacific/Kiritimati",
      13: "Pacific/Tongatapu",
      12: "Pacific/Tarawa",
      11: "Pacific/Noumea",
      10: "Australia/Brisbane",
      9: "Asia/Tokyo",
      8: "Asia/Shanghai",
      7: "Asia/Bangkok",
      6: "Asia/Dhaka",
      5: "Asia/Tashkent",
      4: "Asia/Dubai",
      3: "Europe/Moscow",
      2: "Africa/Johannesburg",
      1: "Africa/Lagos",
      0: "UTC",
      [-1]: "Atlantic/Cape_Verde",
      [-2]: "America/Noronha",
      [-3]: "America/Sao_Paulo",
      [-4]: "America/La_Paz",
      [-5]: "America/Bogota",
      [-6]: "America/Guatemala",
      [-7]: "America/Phoenix",
      [-8]: "Pacific/Pitcairn",
      [-9]: "Pacific/Gambier",
    };
    const zone = ZONES[hours] as string;
    const minutesPast = now.getUTCMinutes();
    const startedAt = Date.now() - (minutesPast + 10) * MINUTE; // yesterday, locally
    const make = (starts: number, ends: number) =>
      create(CLASS, {
        classType: type,
        startsAt: new Date(starts).toISOString(),
        endsAt: new Date(ends).toISOString(),
        timezone: zone,
        places: 5,
      });
    const running = await make(startedAt, Date.now() + HOUR);
    const over = await make(startedAt - 3 * HOUR, startedAt - 2 * HOUR);
    const who = await member("night");
    const desk = await run<Out>(
      "x.bookings.bookFor",
      { classId: running, personId: who.personId, paidAtDesk: true },
      staff(),
    );
    expect(
      (await run<{ bookings: unknown[] }>("x.bookings.roster", { classId: running }, asCoach(kim)))
        .bookings,
    ).toHaveLength(1);
    expect(
      await run<Out>("x.bookings.markAttended", { bookingId: desk.bookingId }, asCoach(kim)),
    ).toMatchObject({ result: "attended" });
    // Yesterday's class, over: not the coach's.
    expect((await refusal(run("record.get", { object: CLASS, id: over }, asCoach(kim)))).code).toBe(
      "not_found",
    );
  });

  it("a tool run is held to the day of the call that started it, not the clock its own calls read (#290)", async () => {
    const kim = await coach("Coach Day");
    const k = await klass(type, 2 * MINUTE);
    const atStart = await startOf(k);
    const dayBefore = () => new Date(atStart().getTime() - DAY);
    const who = await member("runday");
    await givePass(who);
    const booking = await booked(who, k);
    // Started on the day before: the run's nested reads hold to that day, so the class is not
    // today's, whatever the real clock reads when they are made.
    expect(
      JSON.stringify(
        await refusal(run("x.bookings.roster", { classId: k }, asCoach(kim, dayBefore))),
      ),
    ).toContain("not_found");
    expect(
      await run<Out>("x.bookings.markAttended", { bookingId: booking }, asCoach(kim, dayBefore)),
    ).toMatchObject({ result: "refused", reason: "not_found" });
    // Started on the class's day: the same run reaches it.
    expect(
      (
        await run<{ bookings: unknown[] }>(
          "x.bookings.roster",
          { classId: k },
          asCoach(kim, atStart),
        )
      ).bookings,
    ).toHaveLength(1);
    expect(
      await run<Out>("x.bookings.markAttended", { bookingId: booking }, asCoach(kim, atStart)),
    ).toMatchObject({ result: "attended" });
  });

  it("the coach role: the day, the list and ticking; nothing else", async () => {
    const kim = await coach("Coach Kim");
    const k = await klass(type, 2 * MINUTE);
    const clock = await startOf(k);
    const asKim = asCoach(kim, clock);
    const who = await member("roster");
    const pass = await givePass(who);
    const booking = await booked(who, k);
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(clock());
    const day = await run<{ classes: { id: string }[] }>(
      "x.bookings.day",
      { date, timeZone: ZONE },
      asKim,
    );
    expect(day.classes.map((c) => c.id)).toContain(k);
    const list = await run<{ bookings: Record<string, unknown>[] }>(
      "x.bookings.roster",
      { classId: k },
      asKim,
    );
    expect(list.bookings).toEqual([
      expect.objectContaining({ id: booking, state: "booked", person: expect.any(Object) }),
    ]);
    // Nothing of what anyone paid with.
    expect(JSON.stringify(list)).not.toContain(pass);
    expect(await run<Out>("x.bookings.markAttended", { bookingId: booking }, asKim)).toMatchObject({
      result: "attended",
    });
    // Its own class records it may read, today's only; nothing else.
    await run("record.get", { object: CLASS, id: k }, asKim);
    const ahead = await klass(type, 5 * DAY);
    const later = await booked(who, ahead);
    expect((await refusal(run("record.get", { object: CLASS, id: ahead }, asKim))).code).toBe(
      "not_found",
    );
    const listed = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: CLASS, filter: { field: "id", op: "in", value: [k, ahead] }, limit: 10 },
      asKim,
    );
    expect(listed.items.map((c) => c.id)).toContain(k);
    expect(listed.items.map((c) => c.id)).not.toContain(ahead);
    // Through its tools too: not another day's list, its classes or its names.
    expect(
      JSON.stringify(await refusal(run("x.bookings.roster", { classId: ahead }, asKim))),
    ).toContain("not_found");
    const aheadDate = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(
      new Date(Date.now() + 5 * DAY),
    );
    const aheadDay = await run<{ classes: { id: string }[] }>(
      "x.bookings.day",
      { date: aheadDate, timeZone: ZONE },
      asKim,
    );
    expect(aheadDay.classes).toEqual([]);
    expect(await run<Out>("x.bookings.markAttended", { bookingId: later }, asKim)).toMatchObject({
      result: "refused",
      reason: "not_found",
    });
    // A list's limit is in its query: a page of one, newest first, is today's class, with no
    // cursor pointing at another day's; a projection without the date still finds it.
    const page = await run<{ items: { id: string }[]; nextCursor: string | null }>(
      "record.list",
      {
        object: CLASS,
        filter: { field: "id", op: "in", value: [k, ahead] },
        sort: { field: "startsAt", direction: "desc" },
        limit: 1,
      },
      asKim,
    );
    expect(page.items.map((c) => c.id)).toEqual([k]);
    expect(page.nextCursor).toBeNull();
    const projected = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: CLASS, filter: { field: "id", op: "in", value: [k, ahead] }, fields: ["title"] },
      asKim,
    );
    expect(projected.items.map((c) => c.id)).toEqual([k]);
    // The limit follows a tool run into the tools it calls, and refuses what it cannot check.
    const limit = {
      "bookings.class": { at: "startsAt", until: "endsAt", zone: "timezone" },
      "bookings.booking": { at: "class.startsAt", until: "class.endsAt", zone: "class.timezone" },
    };
    await run("extension.install", { id: "relay", shipped: true }, staff()).catch(() => undefined);
    await refreshSchemaRegistry(db.query);
    expect(
      JSON.stringify(
        await refusal(run("x.relay.relay", { classId: ahead }, staff({ roleToday: limit, clock }))),
      ),
    ).toContain("not_found");
    expect(
      await run<{ bookings: unknown[] }>(
        "x.relay.relay",
        { classId: k },
        staff({ roleToday: limit, clock }),
      ),
    ).toMatchObject({ bookings: [expect.anything()] });
    // Without the limit the same nested call reaches it (staff are not limited).
    expect(
      (await run<{ bookings: unknown[] }>("x.relay.relay", { classId: ahead }, staff())).bookings,
    ).toHaveLength(1);
    expect(
      (await refusal(run("record.count", { object: CLASS }, staff({ roleToday: limit, clock }))))
        .code,
    ).toBe("forbidden");
    // Other staff are not limited.
    expect(
      (await run<{ bookings: unknown[] }>("x.bookings.roster", { classId: ahead }, staff()))
        .bookings,
    ).toHaveLength(1);
    for (const [name, input] of [
      ["x.bookings.classList", { classId: k }],
      ["x.bookings.bookFor", { classId: k, personId: who.personId }],
      ["x.bookings.cancelFor", { bookingId: booking }],
      ["x.bookings.move", { bookingId: booking, toClassId: k }],
      ["x.bookings.cancelClass", { classId: k, reason: "No coach" }],
      ["x.bookings.findPeople", { query: "Given" }],
      ["x.bookings.returnUse", { bookingId: booking, reason: "Coach was ill" }],
      ["x.memberships.givePass", { personId: who.personId, passTypeId: "x", reason: "Free" }],
      ["person.list", {}],
      ["person.get", { id: who.personId }],
      ["order.list", {}],
      ["record.list", { object: BOOKING }],
      ["record.get", { object: BOOKING, id: booking }],
      ["record.list", { object: PASS }],
      ["record.update", { object: BOOKING, id: booking, values: { state: "booked" } }],
      ["extensionSettings.update", { extension: "bookings", values: { lateMinutes: 5 } }],
      ["query.sql", { sql: "SELECT 1" }],
    ] as const) {
      const error = await refusal(run(name, input, asKim));
      expect([name, error.code]).toEqual([
        name,
        expect.stringMatching(/forbidden|unknown_operation/),
      ]);
    }
  });
});

// --- Moving people (criterion 11) ----------------------------------------------------------------

describe("moving people (criterion 11)", () => {
  it("staff move a member with their use in one batch; refused whole when the new class is full or the use cannot be spent", async () => {
    const who = await member("mover");
    const pass = await givePass(who);
    const from = await klass(type, 2 * DAY);
    const to = await klass(type, 3 * DAY);
    const old = await booked(who, from);
    expect(await left(pass)).toBe(4);
    const moved = await run<Out>("x.bookings.move", { bookingId: old, toClassId: to }, staff());
    expect(moved).toMatchObject({ result: "moved", fromBookingId: old, holderId: pass });
    const fresh = moved.bookingId as string;
    expect(await get(BOOKING, old)).toMatchObject({ state: "moved" });
    expect(await get(BOOKING, fresh)).toMatchObject({
      state: "booked",
      class: to,
      person: who.personId,
      movedFrom: old,
      holder: pass,
    });
    // One use, moved with it: returned on the old, spent again on the new, in the same batch.
    expect(await left(pass)).toBe(4);
    const uses = await env.DB.prepare(
      "SELECT spender_id, returned_at, moved_from FROM core_allowance_use WHERE record_id = ? ORDER BY spent_at, id",
    )
      .bind(pass)
      .all<Record<string, unknown>>();
    expect(uses.results).toEqual([
      expect.objectContaining({ spender_id: old, returned_at: expect.any(String) }),
      expect.objectContaining({
        spender_id: fresh,
        returned_at: null,
        moved_from: expect.any(String),
      }),
    ]);
    expect(await counter(from)).toMatchObject({ held: 0, taken: 0 });
    expect(await counter(to)).toMatchObject({ held: 0, taken: 1 });
    // The member reads the new booking as theirs.
    const mine = await run<{ bookings: { id: string; state: string }[] }>(
      "x.bookings.mine",
      { upcoming: false },
      as(who),
    );
    expect(mine.bookings.map((b) => [b.id, b.state])).toEqual(
      expect.arrayContaining([
        [old, "moved"],
        [fresh, "booked"],
      ]),
    );

    // A full class: refused whole, nothing changed.
    const full = await klass(type, 4 * DAY, 1);
    const other = await member("full");
    await givePass(other);
    await booked(other, full);
    expect(
      await run<Out>("x.bookings.move", { bookingId: fresh, toClassId: full }, staff()),
    ).toMatchObject({ result: "refused", reason: "full" });
    expect(await stateOf(fresh)).toBe("booked");
    expect(await counter(to)).toMatchObject({ taken: 1 });
    expect(await counter(full)).toMatchObject({ taken: 1 });
    expect(await left(pass)).toBe(4);

    // The use cannot be spent there (the pass ends before it): refused whole.
    const brief = await member("brief");
    const briefPass = await givePass(brief, 5, 5);
    const soon = await booked(brief, from);
    const far = await klass(type, 12 * DAY);
    expect(
      await run<Out>("x.bookings.move", { bookingId: soon, toClassId: far }, staff()),
    ).toMatchObject({ result: "refused", reason: "no_use", detail: "ended" });
    expect(await stateOf(soon)).toBe("booked");
    expect(await left(briefPass)).toBe(4);
    expect(await counter(far)).toMatchObject({ taken: 0 });

    // Already booked on the class: refused.
    const twice = await booked(brief, to);
    expect(
      await run<Out>("x.bookings.move", { bookingId: soon, toClassId: to }, staff()),
    ).toMatchObject({ result: "refused", reason: "already_booked" });
    expect(await stateOf(twice)).toBe("booked");

    // The assistant may move a member (a write, applied and audited under balanced).
    const third = await klass(type, 5 * DAY);
    expect(
      await run<Out>(
        "x.bookings.move",
        { bookingId: fresh, toClassId: third },
        staff({ actor: "assistant" }),
      ),
    ).toMatchObject({ result: "moved" });
  });

  it("the moved state is a move's alone: never a write of its own, never after the class starts", async () => {
    const who = await member("nomove");
    const pass = await givePass(who);
    const b = await booked(who, await klass(type, 2 * DAY));
    // A write into `moved` would give the use back with nothing spent again.
    expect(
      await refusal(
        run("record.update", { object: BOOKING, id: b, values: { state: "moved" } }, staff()),
      ),
    ).toMatchObject({
      code: "invalid_input",
      details: { rule: "allowance", reason: "move_needs_target" },
    });
    expect(await left(pass)).toBe(4);

    // After its class starts, a booking no longer moves: giving its use back is returnUse's.
    // (A walk-in paid at the desk: a pass given today was not live when the class started.)
    const started = await klass(type, -10 * MINUTE);
    const walkIn = await run<Out>(
      "x.bookings.bookFor",
      { classId: started, personId: who.personId, paidAtDesk: true },
      staff(),
    );
    expect(walkIn.result).toBe("booked");
    expect(await left(pass)).toBe(4);
    expect(
      await run<Out>(
        "x.bookings.move",
        { bookingId: walkIn.bookingId, toClassId: await klass(type, 2 * DAY + HOUR) },
        staff(),
      ),
    ).toMatchObject({ result: "refused", reason: "started" });
    expect(await stateOf(walkIn.bookingId as string)).toBe("booked");
    expect(await left(pass)).toBe(4);
  });

  it("a move racing the member's own cancel: one happens, the other is told it changed", async () => {
    const who = await member("racemove");
    const pass = await givePass(who);
    const b = await booked(who, await klass(type, 2 * DAY));
    const to = await klass(type, 3 * DAY);
    const [moved, cancelled] = await Promise.all([
      run<Out>("x.bookings.move", { bookingId: b, toClassId: to }, staff()),
      run<Out>("x.bookings.cancel", { bookingId: b, confirm: true, expect: "cancelled" }, as(who)),
    ]);
    const results = [moved.result, cancelled.result].sort();
    expect([
      ["cancelled", "refused"],
      ["moved", "refused"],
    ]).toContainEqual(results);
    const loser = moved.result === "refused" ? moved : cancelled;
    expect(loser.reason).toBe("changed");
    // One use, spent once or given back once.
    expect(await left(pass)).toBe(moved.result === "moved" ? 4 : 5);
  });

  it("a move into a class type the pass does not cover is refused whole", async () => {
    const other = await create("bookings.classtype", { name: unique("Other") });
    const who = await member("cover");
    const passType = await create("memberships.passtype", {
      title: unique("Strength only "),
      price: 50,
      uses: 5,
      validDays: 60,
      classTypes: [type],
      status: "on_sale",
    });
    const given = await run<{ passId: string }>(
      "x.memberships.givePass",
      { personId: who.personId, passTypeId: passType, reason: "Integration test" },
      staff(),
    );
    const b = await booked(who, await klass(type, 2 * DAY));
    const elsewhere = await klass(other, 3 * DAY);
    expect(
      await run<Out>("x.bookings.move", { bookingId: b, toClassId: elsewhere }, staff()),
    ).toMatchObject({ result: "refused", reason: "no_use" });
    expect(await stateOf(b)).toBe("booked");
    expect(await left(given.passId)).toBe(4);
    expect(await counter(elsewhere)).toMatchObject({ taken: 0 });
  });

  it("with the family link: a moved child's booking stays the child's, made by the parent; a parent cannot tick, move or cancel", async () => {
    const parent = await member("famparent");
    const kid = (await run<{ id: string }>("person.create", { givenName: unique("Kid") }, staff()))
      .id;
    await run("person.link.add", { guardianId: parent.personId, dependantId: kid }, staff());
    const kidPass = await givePass({ kind: "customer", customerId: "none", personId: kid });
    const from = await klass(type, 2 * DAY);
    const to = await klass(type, 3 * DAY);
    const booked = await book(parent, from, { forPersonId: kid });
    expect(booked).toMatchObject({ result: "booked", holderId: kidPass });
    const old = booked.bookingId as string;
    expect(await get(BOOKING, old)).toMatchObject({ person: kid, madeBy: parent.personId });
    const moved = await run<Out>("x.bookings.move", { bookingId: old, toClassId: to }, staff());
    expect(moved).toMatchObject({ result: "moved", holderId: kidPass });
    // The new booking carries who made it (set by the host, never by the caller) and whose it is.
    expect(await get(BOOKING, moved.bookingId as string)).toMatchObject({
      person: kid,
      madeBy: parent.personId,
      state: "booked",
    });
    expect(await left(kidPass)).toBe(4);
    // The parent still reads the child's moved booking.
    const mineKid = await run<{ bookings: { id: string }[] }>(
      "x.bookings.mine",
      { personId: kid },
      as(parent),
    );
    expect(mineKid.bookings.map((b) => b.id)).toContain(moved.bookingId);
    // Nobody sets who made a booking, staff included.
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: BOOKING, id: moved.bookingId, values: { madeBy: null } },
            staff(),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    // Ticking, moving and cancelling a class are staff tools: a parent reaches none of them.
    for (const [name, input] of [
      ["x.bookings.markAttended", { bookingId: moved.bookingId }],
      ["x.bookings.move", { bookingId: moved.bookingId, toClassId: from }],
      ["x.bookings.cancelClass", { classId: to, reason: "A parent's try" }],
      ["x.bookings.roster", { classId: to }],
    ] as const) {
      const error = await refusal(run(name, input, as(parent)));
      expect([name, error.code]).toEqual([
        name,
        expect.stringMatching(/unknown_operation|forbidden/),
      ]);
    }
    // A class the gym cancels gives the child's use back.
    await run("x.bookings.cancelClass", { classId: to, reason: "Coach ill" }, staff());
    expect(await stateOf(moved.bookingId as string)).toBe("cancelled_by_us");
    expect(await left(kidPass)).toBe(5);
  });

  it("the coach's today and a parent's family scope are apart: a coach's limit is the staff sign-in's only", async () => {
    const kim = await coach("Coach Parent");
    // The same human, as a member (another sign-in), is a parent of a child booked five days out.
    const parent = await member("coachparent");
    const kid = (await run<{ id: string }>("person.create", { givenName: unique("Kid") }, staff()))
      .id;
    await run("person.link.add", { guardianId: parent.personId, dependantId: kid }, staff());
    await givePass({ kind: "customer", customerId: "none", personId: kid });
    const ahead = await klass(type, 5 * DAY);
    const booked = await book(parent, ahead, { forPersonId: kid });
    expect(booked.result).toBe("booked");
    // As the member, the parent reads the child's booking whatever day it is.
    const mineKid = await run<{ bookings: { id: string }[] }>(
      "x.bookings.mine",
      { personId: kid },
      as(parent),
    );
    expect(mineKid.bookings.map((b) => b.id)).toContain(booked.bookingId);
    // As the coach (the staff sign-in), today's limit holds, and there is no family scope.
    expect(
      JSON.stringify(await refusal(run("x.bookings.roster", { classId: ahead }, asCoach(kim)))),
    ).toContain("not_found");
    expect((await refusal(run("x.bookings.mine", { personId: kid }, asCoach(kim)))).code).toMatch(
      /forbidden|unknown_operation/,
    );
  });

  it("a booking paid at the desk moves paid at the desk, spending nothing", async () => {
    const who = await member("desk");
    const pass = await givePass(who);
    const desk = await run<Out>(
      "x.bookings.bookFor",
      { classId: await klass(type, 2 * DAY), personId: who.personId, paidAtDesk: true },
      staff(),
    );
    const moved = await run<Out>(
      "x.bookings.move",
      { bookingId: desk.bookingId, toClassId: await klass(type, 3 * DAY) },
      staff(),
    );
    expect(moved).toMatchObject({ result: "moved", holderId: null });
    expect(await get(BOOKING, moved.bookingId as string)).toMatchObject({
      state: "booked",
      paidOtherwise: true,
    });
    expect(await left(pass)).toBe(5);
  });

  it("a move frees its place to the waitlist before the cut-off, and never takes one held for a waitlist", async () => {
    const [a, b, c, d] = await Promise.all(["wa", "wb", "wc", "wd"].map((l) => member(l)));
    for (const p of [a, b, c, d] as CustomerPrincipal[]) await givePass(p);
    // `from`: one place, a booked; b waits. Moving a frees it, and b is the waitlist's.
    const from = await klass(type, 2 * DAY, 1);
    const elsewhere = await klass(type, 2 * DAY + 2 * HOUR);
    const aBooking = await booked(a as CustomerPrincipal, from);
    const bWaits = await book(b as CustomerPrincipal, from);
    expect(bWaits.result).toBe("waiting");
    expect(
      await run<Out>("x.bookings.move", { bookingId: aBooking, toClassId: elsewhere }, staff()),
    ).toMatchObject({ result: "moved" });
    // The place is held for the waitlist in the move's batch: nobody booking directly takes it.
    expect(await counter(from)).toEqual({ places: 1, held: 1, taken: 0 });
    expect(await book(c as CustomerPrincipal, from)).toMatchObject({ result: "waiting" });
    // A staff move onto it is refused: the held place is the waitlist's.
    const dBooking = await booked(d as CustomerPrincipal, elsewhere);
    expect(
      await run<Out>("x.bookings.move", { bookingId: dBooking, toClassId: from }, staff()),
    ).toMatchObject({ result: "refused", reason: "full" });
    expect(await stateOf(dBooking)).toBe("booked");
    // The host moves b in.
    await runWaitlistDue(db);
    expect(await stateOf(bWaits.bookingId as string)).toBe("booked");
    expect(await counter(from)).toEqual({ places: 1, held: 0, taken: 1 });
  });
});

// --- Cancelling a class (criterion 6) ------------------------------------------------------------

describe("cancelling a class (criterion 6)", () => {
  it("cancels every booking and waiter in its batch, gives back every use and every place", async () => {
    const k = await klass(type, 2 * DAY, 2);
    const people = await Promise.all(["c1", "c2", "c3"].map((l) => member(l)));
    const passes = await Promise.all(people.map((p) => givePass(p)));
    const b1 = await booked(people[0] as CustomerPrincipal, k);
    const b2 = await booked(people[1] as CustomerPrincipal, k);
    const w = await book(people[2] as CustomerPrincipal, k);
    expect(w.result).toBe("waiting");
    // One cancels in time: their place is held for the waiter, until the class goes.
    await run(
      "x.bookings.cancel",
      { bookingId: b2, confirm: true, expect: "cancelled" },
      as(people[1] as CustomerPrincipal),
    );
    expect(await counter(k)).toEqual({ places: 2, held: 1, taken: 1 });
    const out = await run<Out>(
      "x.bookings.cancelClass",
      { classId: k, reason: "Coach ill" },
      staff(),
    );
    expect(out).toEqual({ result: "cancelled", classId: k, bookingsCancelled: 2 });
    expect(await get(CLASS, k)).toMatchObject({ state: "cancelled", cancelledReason: "Coach ill" });
    expect(await stateOf(b1)).toBe("cancelled_by_us");
    expect(await stateOf(w.bookingId as string)).toBe("cancelled_by_us");
    expect(await stateOf(b2)).toBe("cancelled");
    expect(await counter(k)).toEqual({ places: 2, held: 0, taken: 0 });
    for (const pass of passes) expect(await left(pass)).toBe(5);
    // Nobody books it now, staff included.
    expect(
      await run<Out>(
        "x.bookings.bookFor",
        { classId: k, personId: (people[1] as CustomerPrincipal).personId },
        staff(),
      ),
    ).toMatchObject({ result: "refused", reason: "not_running" });
    // Twice: not scheduled, and the call fails (an approved request shows it did not apply).
    const twice = await refusal(
      run<Out>("x.bookings.cancelClass", { classId: k, reason: "Again" }, staff()),
    );
    expect(JSON.stringify(twice)).toContain("not_scheduled");
  });

  it("gives back the use of every booking on it, ticked and cancelled late included, once each; never after it ended", async () => {
    const k = await klass(type, 30 * MINUTE);
    const [ticked, late, still] = await Promise.all(["gt", "gl", "gs"].map((l) => member(l)));
    const passes = await Promise.all(
      [ticked, late, still].map((p) => givePass(p as CustomerPrincipal)),
    );
    const bt = await booked(ticked as CustomerPrincipal, k);
    const bl = await booked(late as CustomerPrincipal, k);
    const bs = await booked(still as CustomerPrincipal, k);
    expect(await run<Out>("x.bookings.markAttended", { bookingId: bt }, staff())).toMatchObject({
      result: "attended",
    });
    // Half an hour before: a late cancel, which keeps the use.
    await run(
      "x.bookings.cancel",
      { bookingId: bl, confirm: true, expect: "late_cancelled" },
      as(late as CustomerPrincipal),
    );
    expect(await stateOf(bl)).toBe("late_cancelled");
    for (const pass of passes) expect(await left(pass)).toBe(4);
    await run("x.bookings.cancelClass", { classId: k, reason: "Hall flooded" }, staff());
    for (const id of [bt, bl, bs]) expect(await stateOf(id)).toBe("cancelled_by_us");
    for (const pass of passes) expect(await left(pass)).toBe(5);
    expect(await counter(k)).toEqual({ places: 10, held: 0, taken: 0 });
    // Each use given back once: one return per booking.
    for (const id of [bt, bl, bs]) {
      const rows = await env.DB.prepare(
        "SELECT count(*) AS n FROM core_allowance_use WHERE spender_id = ? AND returned_at IS NOT NULL",
      )
        .bind(id)
        .first<{ n: number }>();
      expect(rows?.n).toBe(1);
    }
    // Unticking it now is refused: nothing takes a place on a cancelled class.
    expect(await run<Out>("x.bookings.undoAttended", { bookingId: bt }, staff())).toMatchObject({
      result: "refused",
      reason: "not_booked",
    });
    expect(
      await refusal(
        run("record.update", { object: BOOKING, id: bt, values: { state: "booked" } }, staff()),
      ),
    ).toMatchObject({ code: "invalid_input" });
    expect(await counter(k)).toMatchObject({ taken: 0 });

    // A class that has ended is not cancelled: it happened.
    const over = await klass(type, -2 * HOUR);
    const ended = await refusal(
      run("x.bookings.cancelClass", { classId: over, reason: "Too late" }, staff()),
    );
    expect(JSON.stringify(ended)).toContain("ended");
    expect((await get(CLASS, over)).state).toBe("scheduled");
  });

  it("is refused to an AI without a person's approval, whatever the preset; applied once a person approves", async () => {
    await setPreset("autonomous");
    try {
      const k = await klass(type, 2 * DAY);
      const who = await member("ai");
      const pass = await givePass(who);
      const b = await booked(who, k);
      const asked = await refusal(
        run(
          "x.bookings.cancelClass",
          { classId: k, reason: "The assistant thinks so" },
          staff({ actor: "assistant" }),
        ),
      );
      expect(asked.code).toBe("pending_approval");
      expect(
        (
          await refusal(
            run(
              "x.bookings.cancelClass",
              { classId: k, reason: "An MCP client" },
              staff({ actor: "mcp" }),
            ),
          )
        ).code,
      ).toBe("pending_approval");
      // Nothing happened: the class runs, the booking stands, the use is spent.
      expect((await get(CLASS, k)).state).toBe("scheduled");
      expect(await stateOf(b)).toBe("booked");
      expect(await left(pass)).toBe(4);
      // No other staff write cancels a class: the move is the host's and the tool's alone.
      expect(
        await refusal(
          run("record.update", { object: CLASS, id: k, values: { state: "cancelled" } }, staff()),
        ),
      ).toMatchObject({ code: "invalid_input" });
      // A person approves the assistant's request: it is applied.
      const actionId = String(asked.details?.actionId);
      const approve = (confirm?: string) =>
        run<{ results: { status: string }[] }>(
          "approval.approve",
          { actionIds: [actionId], ...(confirm ? { confirm } : {}) },
          staff(),
        );
      const decided = await approve().catch(
        async (error: { details?: { confirmLabel?: string } }) => {
          const label = error.details?.confirmLabel;
          if (!label) throw error;
          return approve(label);
        },
      );
      expect(decided.results.map((r) => r.status)).toEqual(["applied"]);
      expect((await get(CLASS, k)).state).toBe("cancelled");
      expect(await stateOf(b)).toBe("cancelled_by_us");
      expect(await left(pass)).toBe(5);
    } finally {
      await setPreset("balanced");
    }
  });

  it("a cancel racing an untick: the use comes back once", async () => {
    const k = await klass(type, 30 * MINUTE);
    const who = await member("untick");
    const pass = await givePass(who);
    const b = await booked(who, k);
    await run("x.bookings.markAttended", { bookingId: b }, staff());
    await Promise.allSettled([
      run("x.bookings.cancelClass", { classId: k, reason: "Race" }, staff()),
      run("x.bookings.undoAttended", { bookingId: b }, staff()),
    ]);
    for (let i = 0; i < 3 && (await get(CLASS, k)).state !== "cancelled"; i++) {
      await run("x.bookings.cancelClass", { classId: k, reason: "Again" }, staff()).catch(
        () => undefined,
      );
    }
    expect(await stateOf(b)).toBe("cancelled_by_us");
    expect(await left(pass)).toBe(5);
    const returned = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_allowance_use WHERE spender_id = ? AND returned_at IS NOT NULL",
    )
      .bind(b)
      .first<{ n: number }>();
    expect(returned?.n).toBe(1);
    expect(await counter(k)).toMatchObject({ held: 0, taken: 0 });
  });

  it("a class with no end time is not cancelled: whether it ended cannot be told", async () => {
    const k = await klass(type, 2 * DAY);
    // An old class from before the end time was required: its end emptied in the table itself.
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'x%bookings%class' LIMIT 1",
    ).first<{ name: string }>();
    const columns = await env.DB.prepare(`PRAGMA table_info("${table?.name}")`).all<{
      name: string;
    }>();
    const endsColumn = columns.results.find((c) => /ends/i.test(c.name))?.name;
    expect(endsColumn).toBeTruthy();
    await env.DB.prepare(`UPDATE "${table?.name}" SET "${endsColumn}" = NULL WHERE id = ?`)
      .bind(k)
      .run();
    expect((await get(CLASS, k)).endsAt ?? null).toBeNull();
    const out = await refusal(
      run("x.bookings.cancelClass", { classId: k, reason: "No end" }, staff()),
    );
    expect(JSON.stringify(out)).toContain("no_end");
    expect((await get(CLASS, k)).state).toBe("scheduled");
  });

  it("a booking racing a class's cancel never stays booked on it: no place or use lost", async () => {
    const k = await klass(type, 2 * DAY, 30);
    const people = await Promise.all(Array.from({ length: 10 }, (_, i) => member(`race${i}`)));
    const passes = await Promise.all(people.map((p) => givePass(p)));
    await booked(people[0] as CustomerPrincipal, k);
    const outcomes = await Promise.allSettled([
      ...people.slice(1).map((p) => book(p, k)),
      run<Out>("x.bookings.cancelClass", { classId: k, reason: "Race" }, staff()),
    ]);
    // The cancel may have to be asked again if a booking landed under it; ask until it is done.
    for (let i = 0; i < 5 && (await get(CLASS, k)).state !== "cancelled"; i++) {
      await run("x.bookings.cancelClass", { classId: k, reason: "Race again" }, staff()).catch(
        () => undefined,
      );
    }
    expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);
    expect((await get(CLASS, k)).state).toBe("cancelled");
    const all = await run<{ items: { values: Record<string, unknown> }[] }>(
      "record.list",
      { object: BOOKING, filter: { field: "class", op: "eq", value: k }, limit: 50 },
      staff(),
    );
    expect(all.items.filter((b) => b.values.state === "booked")).toEqual([]);
    expect(await counter(k)).toEqual({ places: 30, held: 0, taken: 0 });
    for (const pass of passes) expect(await left(pass)).toBe(5);
  });
});
