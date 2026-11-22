// Stage 31a, build step 3: the Bookings pack (packs/bookings) in the real host, beside Programs,
// installed as shipped, with real D1 and the sandbox. The holders that pay for a booking are the
// Memberships pack's (stage 32b, built in parallel); here a fixture holder stands in for it
// (`bkfixture.pass`, a runtime extension, never the real pack's id, so both can share a database),
// and this file installs a test variant of the pack whose `paidBy` also names the fixture (the
// shipped declaration names only `memberships.membership` and `memberships.pass`), so the
// spender's declaration
// (`paidBy`, `at` the class's start, the class type copied, the local weekday and minute) is
// proved against the host's allowance behaviour before the real holder exists (step 4 connects
// it). `cos ext test`'s harness does not simulate allowances (ADR 0493), hence this file.
//
// What it shows: Bookings is refused before Programs; a series makes its classes in local time,
// titled after their class type, and far enough ahead for a class type that opens booking 70 days
// before; a member books on the web's tool with their pass, which spends a use counted at the
// class's time with its class type and local time copied; before booking opens, after it closes,
// a class type booked by staff only and a class that is not scheduled are refused to the member
// (with the class type's own rules over the organisation's, and the organisation's setting when
// the class type has none); one booking per person per class; the places; a cancel more than the
// late-cancel time before is in time and gives the use back, later is late and keeps it, after
// the start is refused and gives nothing back; staff book a walk-in into a staff-only class, paid
// at the desk, spending nothing; and members see places left and their own bookings, never
// anyone else's.
//
// Clocks: the host reads `ctx.clock` in the record operations, which the staff calls here set.
// A pack's tool's own operation calls are made by the runner's executor, which reads the real
// clock, so the classes a member books through a tool are placed hours from the real now, far
// from any boundary; the boundaries to the second are proved by packages/core/test/claimants.test.ts.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CustomerPrincipal,
  type ExtensionHost,
  getObject,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, source, unique } from "./helpers.ts";

const packFiles = (glob: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(glob)
      .map(([path, text]) => [path.split("/").pop() as string, text] as const)
      .filter(([name]) => name !== "vitest.config.ts"),
  );
const files = {
  programs: packFiles(
    import.meta.glob<string>("../../../packs/programs/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  bookings: testVariant(
    packFiles(
      import.meta.glob<string>("../../../packs/bookings/*.ts", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    ),
  ),
};

/** The pack as shipped, with the fixture holder added to `paidBy` (tests only). */
function testVariant(pack: Record<string, string>): Record<string, string> {
  const shipped = 'paidBy: ["memberships.membership", "memberships.pass"]';
  const index = pack["index.ts"] ?? "";
  if (!index.includes(shipped)) throw new Error("the Bookings pack's paidBy changed");
  return {
    ...pack,
    "index.ts": index.replace(
      shipped,
      'paidBy: ["memberships.membership", "memberships.pass", "bkfixture.pass"]',
    ),
  };
}

/** The extension host of a deployment whose product lists Programs and Bookings. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()),
    { id: "bookings", version: "0.1.0" },
    { id: "programs", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    id === "programs" || id === "bookings"
      ? host.commit({
          id,
          files: files[id],
          message: `Shipped ${id} 0.1.0`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const CLASS = "bookings.class";
const BOOKING = "bookings.booking";
const SERIES = "bookings.series";
const CLASS_TYPE = "programs.classtype";
const PASS = "bkfixture.pass";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let admin: ActingUser;

const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  extensionHost: shippedHost,
  ...extra,
});
const guest: OutsideInvocationContext = {
  principal: { kind: "public" },
  db,
  extensionHost: shippedHost,
};
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  extensionHost: shippedHost,
});

function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
): Promise<T> {
  return invokeByName(name, input, ctx) as Promise<T>;
}

async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    return { code: e.code, message: e.message, details: e.details };
  }
  throw new Error("expected a refusal");
}

const create = async (object: string, values: Record<string, unknown>) =>
  (await run<{ id: string }>("record.create", { object, values }, staff())).id;
const get = (object: string, id: string) =>
  run<{ id: string; values: Record<string, unknown> }>("record.get", { object, id }, staff());

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

/** A pass (the fixture holder) for `who`: uses per week, for the class types listed (empty: any). */
const pass = (who: CustomerPrincipal, uses = 3, classTypes: string[] = []) =>
  create(PASS, {
    name: unique("Pass"),
    person: who.personId,
    uses,
    per: "total",
    ...(classTypes.length ? { classTypes } : {}),
  });

let classType: string;
let staffOnlyType: string;
let lateType: string;
let farType: string;

/** A one-off class `startsIn` ms from now, in Sydney, of `type`, with `places`. */
const klass = (startsIn: number, type = classType, places = 10) =>
  create(CLASS, {
    classType: type,
    startsAt: new Date(Date.now() + startsIn).toISOString(),
    endsAt: new Date(Date.now() + startsIn + HOUR).toISOString(),
    timezone: "Australia/Sydney",
    places,
  });

interface Booked {
  result: string;
  bookingId?: string;
  reason?: string;
  opensAt?: string | null;
  holderId?: string | null;
}
const book = (who: CustomerPrincipal, classId: string, extra: Record<string, unknown> = {}) =>
  run<Booked>("x.bookings.book", { classId, ...extra }, as(who));

const left = async (passId: string) => Number((await get(PASS, passId)).values.left);

beforeAll(async () => {
  admin = await createAdmin();
  // The default policy: an AI's destructive call waits for a person.
  await setPreset("balanced");
  // Bookings requires Programs: installed first, it is refused and says so.
  await refreshSchemaRegistry(db.query);
  const early = await refusal(run("extension.install", { id: "bookings", shipped: true }, staff()));
  expect(JSON.stringify(early)).toContain("requires the programs extension");
  await run("extension.install", { id: "programs", shipped: true }, staff());
  await run("extension.install", { id: "bookings", shipped: true }, staff());
  // The fixture holder: what the Memberships pack's pass will be.
  await run(
    "extension.install",
    {
      id: "bkfixture",
      files: source(
        "bkfixture",
        `objects: {
          pass: {
            label: "Pass", plural: "Passes", titleField: "name",
            fields: {
              name: { type: "text", label: "Name" },
              person: { type: "relation", label: "Person", to: "person", required: true },
              uses: { type: "number", label: "Uses" },
              per: { type: "select", label: "Per", options: [
                { value: "total", label: "Total" }, { value: "week", label: "Week" },
              ] },
              classTypes: { type: "relation", label: "Class types", to: "programs.classtype", many: true },
            },
            allowance: {
              holds: {
                person: "person",
                uses: "uses",
                per: { field: "per" },
                spendsOn: { object: "bookings.booking", when: [{ field: "classType", in: "classTypes" }] },
              },
            },
          },
        },
        permissions: { modules: [] },`,
      ),
    },
    staff(),
  );
  await refreshSchemaRegistry(db.query);
  expect(getObject(BOOKING)?.allowance).toMatchObject({
    kind: "spender",
    paidBy: ["memberships.membership", "memberships.pass", "bkfixture.pass"],
    waived: "paidOtherwise",
  });
  classType = await create(CLASS_TYPE, { name: unique("Strength") });
  staffOnlyType = await create(CLASS_TYPE, {
    name: unique("Kids"),
    "bookings.staffOnly": true,
  });
  // Its own rules: late from 4 hours before, booking closes 2 hours before.
  lateType = await create(CLASS_TYPE, {
    name: unique("Yoga"),
    "bookings.lateMinutes": 240,
    "bookings.closesMinutes": 120,
  });
  // Booking opens 70 days ahead: the timetable must reach that far.
  farType = await create(CLASS_TYPE, { name: unique("Camp"), "bookings.opensDays": 70 });
});

describe("the timetable", () => {
  it("a series makes its classes at the local time, titled after their class type, far enough ahead", async () => {
    const now = "2026-03-30T00:00:00.000Z";
    const seriesId = await run<{ id: string }>(
      "record.create",
      {
        object: SERIES,
        values: {
          classType: farType,
          weekdays: ["tue", "thu"],
          time: "06:00",
          length: 60,
          places: 12,
          firstDate: "2026-03-31",
          timezone: "Australia/Sydney",
        },
      },
      staff({ clock: () => new Date(now) }),
    ).then((r) => r.id);
    // The minute cron runs the series as the host, a batch at a time.
    for (let i = 0; i < 6; i++) {
      const out = await run<{ more: boolean }>(
        "recurring.generate",
        { object: SERIES, id: seriesId },
        staff({ actor: "automation", clock: () => new Date(now) }),
      );
      if (!out.more) break;
    }
    const made = await run<{ items: { values: Record<string, unknown> }[] }>(
      "record.list",
      {
        object: CLASS,
        filter: { field: "series", op: "eq", value: seriesId },
        sort: { field: "startsAt", direction: "asc" },
        limit: 100,
      },
      staff(),
    );
    const starts = made.items.map((c) => String(c.values.startsAt));
    // 06:00 in Sydney: 19:00 UTC the day before in summer time (to 5 April), 20:00 after.
    expect(starts[0]).toBe("2026-03-30T19:00:00.000Z");
    expect(starts).toContain("2026-04-06T20:00:00.000Z");
    // The class type opens 70 days ahead, so the horizon reaches past the default 56.
    expect((starts.at(-1) ?? "").slice(0, 10) >= "2026-06-04").toBe(true);
    const type = await get(CLASS_TYPE, farType);
    expect(made.items[0]?.values).toMatchObject({
      title: type.values.name,
      classType: farType,
      places: 12,
      state: "scheduled",
    });
  });

  it("the public reads the timetable with places left, and never who is booked", async () => {
    const id = await klass(5 * HOUR, classType, 8);
    const who = await member("pub");
    await pass(who);
    expect((await book(who, id)).result).toBe("booked");
    const out = await run<{ classes: Record<string, unknown>[] }>(
      "x.bookings.timetable",
      { from: new Date(Date.now()).toISOString() },
      guest,
    );
    const shown = out.classes.find((c) => c.id === id);
    expect(shown).toMatchObject({ places: { status: "available", available: 7 } });
    expect(JSON.stringify(out)).not.toContain(who.personId);
    // The public cannot read bookings at all.
    expect(await refusal(run("x.bookings.mine", {}, guest))).toMatchObject({
      code: expect.any(String),
    });
  });
});

describe("a member books and cancels", () => {
  it("books with their pass: a use is spent at the class's time, its type and local time copied", async () => {
    const who = await member("book");
    const passId = await pass(who, 3);
    const id = await klass(3 * HOUR);
    const done = await book(who, id);
    expect(done).toMatchObject({ result: "booked", holderId: passId });
    expect(await left(passId)).toBe(2);
    const booking = await get(BOOKING, done.bookingId as string);
    const start = new Date((await get(CLASS, id)).values.startsAt as string);
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Australia/Sydney",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(start)
      .split(":")
      .map(Number) as [number, number];
    expect(booking.values).toMatchObject({
      person: who.personId,
      state: "booked",
      holder: passId,
      classType,
      minute: local[0] * 60 + local[1],
    });
    // One booking per person per class: a second is refused, and spends nothing.
    expect(await book(who, id)).toMatchObject({ result: "refused", reason: "already_booked" });
    expect(await left(passId)).toBe(2);
    // Their own bookings, with the class.
    const mine = await run<{ bookings: { id: string; classId: string }[] }>(
      "x.bookings.mine",
      {},
      as(who),
    );
    expect(mine.bookings.map((b) => b.id)).toEqual([done.bookingId]);
  });

  it("cancels in time (the use comes back), late (it is kept), and not at all after the start", async () => {
    const who = await member("cancel");
    const passId = await pass(who, 5);
    // In time: 3 hours before, late from the organisation's 60 minutes.
    const early = await book(who, await klass(3 * HOUR));
    expect(await left(passId)).toBe(4);
    const preview = await run<{ result: string; state: string }>(
      "x.bookings.cancel",
      { bookingId: early.bookingId },
      as(who),
    );
    expect(preview).toMatchObject({ result: "preview", state: "cancelled" });
    expect((await get(BOOKING, early.bookingId as string)).values.state).toBe("booked");
    expect(
      await run(
        "x.bookings.cancel",
        { bookingId: early.bookingId, confirm: true, expect: "cancelled" },
        as(who),
      ),
    ).toMatchObject({ result: "cancelled", late: false });
    expect(await left(passId)).toBe(5);

    // Late: the class type's own rule (late from 4 hours) over the organisation's.
    const late = await book(who, await klass(3 * HOUR, lateType));
    expect(late.result).toBe("booked");
    expect(await left(passId)).toBe(4);
    expect(await run("x.bookings.cancel", { bookingId: late.bookingId }, as(who))).toMatchObject({
      result: "preview",
      state: "late_cancelled",
      late: true,
    });
    // Asking to cancel "in time" is refused: it is late, and the use is not given back.
    expect(
      await run(
        "x.bookings.cancel",
        { bookingId: late.bookingId, confirm: true, expect: "cancelled" },
        as(who),
      ),
    ).toMatchObject({ result: "refused", reason: "changed" });
    expect(
      await run(
        "x.bookings.cancel",
        { bookingId: late.bookingId, confirm: true, expect: "late_cancelled" },
        as(who),
      ),
    ).toMatchObject({ result: "late_cancelled" });
    expect(await left(passId)).toBe(4);

    // After the start: staff booked them in (not bound), and the member cannot cancel at all,
    // so a cancel after the class never returns a use (ADR 0493's warning).
    const startedId = await klass(-10 * MINUTE);
    const started = await run<Booked>(
      "x.bookings.bookFor",
      { classId: startedId, personId: who.personId },
      staff(),
    );
    expect(started.result).toBe("booked");
    expect(await left(passId)).toBe(3);
    expect(await run("x.bookings.cancel", { bookingId: started.bookingId }, as(who))).toMatchObject(
      { result: "refused", reason: "too_late" },
    );
    for (const expect_ of ["cancelled", "late_cancelled"]) {
      expect(
        await run(
          "x.bookings.cancel",
          { bookingId: started.bookingId, confirm: true, expect: expect_ },
          as(who),
        ),
      ).toMatchObject({ result: "refused" });
    }
    expect((await get(BOOKING, started.bookingId as string)).values.state).toBe("booked");
    expect(await left(passId)).toBe(3);
  });

  it("the organisation's setting applies where the class type has none", async () => {
    const who = await member("setting");
    await pass(who, 5);
    const id = await klass(45 * MINUTE);
    const booked = await book(who, id);
    // Late from 60 minutes (the default): 45 minutes before is late.
    expect(await run("x.bookings.cancel", { bookingId: booked.bookingId }, as(who))).toMatchObject({
      state: "late_cancelled",
    });
    // The organisation moves it to 30 minutes: now in time.
    await run(
      "extensionSettings.update",
      { extension: "bookings", values: { lateMinutes: 30 } },
      staff(),
    );
    try {
      expect(
        await run("x.bookings.cancel", { bookingId: booked.bookingId }, as(who)),
      ).toMatchObject({ state: "cancelled" });
    } finally {
      await run(
        "extensionSettings.update",
        { extension: "bookings", values: { lateMinutes: null } },
        staff(),
      );
    }
  });

  it("is refused before booking opens, after it closes, for a staff-only class type and with nothing to pay", async () => {
    const who = await member("rules");
    const passId = await pass(who, 5);
    // Opens 7 days before (the organisation's default): 10 days ahead is not open yet.
    const notYet = await book(who, await klass(10 * DAY));
    expect(notYet).toMatchObject({ result: "refused", reason: "not_open" });
    expect(Date.parse(notYet.opensAt as string)).toBeGreaterThan(Date.now() + 2 * DAY);
    // Closes 2 hours before (the class type's own): an hour ahead is closed.
    expect(await book(who, await klass(HOUR, lateType))).toMatchObject({
      result: "refused",
      reason: "closed",
    });
    // Booked by the gym only.
    expect(await book(who, await klass(3 * HOUR, staffOnlyType))).toMatchObject({
      result: "refused",
      reason: "staff_only",
    });
    expect(await left(passId)).toBe(5);
    // Nothing to pay with: a member with no pass, and a pass for other class types only.
    const none = await member("nopass");
    expect(await book(none, await klass(3 * HOUR))).toMatchObject({
      result: "refused",
      reason: "no_use",
    });
    const other = await member("other");
    await pass(other, 5, [lateType]);
    expect(await book(other, await klass(3 * HOUR))).toMatchObject({
      result: "refused",
      reason: "no_use",
      detail: "not_covered",
    });
  });

  it("the places are the database's: a class of 2 takes exactly 2 of 6 members at once", async () => {
    const id = await klass(4 * HOUR, classType, 2);
    const members = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => member(`race${n}`)));
    await Promise.all(members.map((who) => pass(who, 3)));
    const results = await Promise.all(members.map((who) => book(who, id)));
    expect(results.filter((r) => r.result === "booked")).toHaveLength(2);
    expect(results.filter((r) => r.result === "refused").map((r) => r.reason)).toEqual(
      expect.arrayContaining(["full"]),
    );
    expect((await get(CLASS, id)).values).toMatchObject({ taken: 2, available: 0 });
  });

  it("a class the host cancels cancels its bookings, gives every use back, and cannot be booked", async () => {
    const who = await member("closed");
    const whoPass = await pass(who, 5);
    const other = await member("closed2");
    const otherPass = await pass(other, 5);
    // Six days ahead: a date no other class of this file is on.
    const id = await klass(6 * DAY);
    const first = await book(who, id);
    expect(first.result).toBe("booked");
    await run(
      "x.bookings.cancel",
      { bookingId: first.bookingId, confirm: true, expect: "cancelled" },
      as(who),
    );
    const kept = await book(other, id);
    expect(kept.result).toBe("booked");
    expect(await left(otherPass)).toBe(4);
    // A closure over its date: refused until a person confirms the count, which names the
    // bookings it cancels with it (ADR 0507).
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(
      new Date(Date.now() + 6 * DAY),
    );
    const closure = { name: "Flood", fromDate: date, untilDate: date };
    expect(
      await refusal(run("record.create", { object: "bookings.closure", values: closure }, staff())),
    ).toMatchObject({
      code: "conflict",
      details: { rule: "recurring_confirm", count: 1, followers: 1 },
    });
    await run(
      "recurring.close",
      { object: "bookings.closure", values: closure, confirm: 1 },
      staff(),
    );
    expect((await get(CLASS, id)).values).toMatchObject({ state: "cancelled", taken: 0 });
    // In the closure's batch: the live booking is cancelled by the gym and its use is back.
    expect((await get(BOOKING, kept.bookingId as string)).values.state).toBe("cancelled_by_us");
    expect(await left(otherPass)).toBe(5);
    expect(await left(whoPass)).toBe(5);
    const mine = await run<{ bookings: { id: string; state: string; classState: string }[] }>(
      "x.bookings.mine",
      {},
      as(other),
    );
    expect(mine.bookings.find((b) => b.id === kept.bookingId)).toMatchObject({
      state: "cancelled_by_us",
      classState: "cancelled",
    });
    // The member who still reads it through an old booking cannot book it; nor can staff.
    expect(await book(who, id)).toMatchObject({ result: "refused", reason: "not_running" });
    expect(
      await run(
        "x.bookings.bookFor",
        { classId: id, personId: who.personId, paidAtDesk: true },
        staff(),
      ),
    ).toMatchObject({ result: "refused", reason: "not_running" });
  });

  it("a series ended cancels its booked classes and their bookings, uses given back", async () => {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + DAY);
    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const seriesId = (
      await run<{ id: string }>(
        "record.create",
        {
          object: SERIES,
          values: {
            classType,
            weekdays: [days[tomorrow.getUTCDay()]],
            time: "12:00",
            length: 60,
            places: 8,
            firstDate: tomorrow.toISOString().slice(0, 10),
            lastDate: tomorrow.toISOString().slice(0, 10),
            timezone: "UTC",
          },
        },
        staff(),
      )
    ).id;
    await run(
      "recurring.generate",
      { object: SERIES, id: seriesId },
      staff({ actor: "automation" }),
    );
    const made = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: CLASS, filter: { field: "series", op: "eq", value: seriesId } },
      staff(),
    );
    const classId = made.items[0]?.id as string;
    expect(classId).toBeTruthy();
    const who = await member("ended");
    const whoPass = await pass(who, 3);
    const done = await book(who, classId);
    expect(done.result).toBe("booked");
    expect(await left(whoPass)).toBe(2);
    expect(
      await refusal(
        run("record.update", { object: SERIES, id: seriesId, values: { state: "ended" } }, staff()),
      ),
    ).toMatchObject({ details: { rule: "recurring_confirm", count: 1, followers: 1 } });
    await run(
      "recurring.change",
      { object: SERIES, id: seriesId, values: { state: "ended" }, confirm: 1 },
      staff(),
    );
    expect((await get(CLASS, classId)).values.state).toBe("cancelled");
    expect((await get(BOOKING, done.bookingId as string)).values.state).toBe("cancelled_by_us");
    expect(await left(whoPass)).toBe(3);
  });
});

describe("staff and privacy", () => {
  it("staff book a walk-in into a staff-only class, paid at the desk, spending nothing", async () => {
    const id = await klass(2 * HOUR, staffOnlyType, 4);
    const done = await run<Booked & { personId: string }>(
      "x.bookings.bookFor",
      { classId: id, newPerson: { givenName: unique("Walk") }, paidAtDesk: true },
      staff(),
    );
    expect(done).toMatchObject({ result: "booked", holderId: null });
    const booking = await get(BOOKING, done.bookingId as string);
    expect(booking.values).toMatchObject({
      person: done.personId,
      state: "booked",
      paidOtherwise: true,
      bookedBy: admin.id,
    });
    expect((await get(CLASS, id)).values.taken).toBe(1);
    // Whether it spends is decided when it is made: staff cannot turn it off afterwards.
    expect(
      await refusal(
        run(
          "record.update",
          { object: BOOKING, id: done.bookingId, values: { paidOtherwise: false } },
          staff(),
        ),
      ),
    ).toMatchObject({ code: "invalid_input" });
    // Without paidAtDesk, a walk-in with nothing to spend is refused, and nobody is left on file:
    // the person and the booking are one batch.
    const nobody = unique("Nobody");
    expect(
      await run("x.bookings.bookFor", { classId: id, newPerson: { givenName: nobody } }, staff()),
    ).toMatchObject({ result: "refused", reason: "no_use" });
    const named = await run<{ items: unknown[] }>(
      "person.list",
      { filter: { field: "displayName", op: "contains", value: nobody } },
      staff(),
    );
    expect(named.items).toEqual([]);
    // The class's list, for staff.
    const list = await run<{ bookings: { person: { id: string } | null; paidAtDesk: boolean }[] }>(
      "x.bookings.classList",
      { classId: id },
      staff(),
    );
    expect(list.bookings).toEqual([
      expect.objectContaining({
        person: expect.objectContaining({ id: done.personId }),
        paidAtDesk: true,
      }),
    ]);
  });

  it("a member reads and cancels only their own bookings", async () => {
    const ann = await member("ann");
    const bob = await member("bob");
    await pass(ann, 3);
    await pass(bob, 3);
    const id = await klass(5 * HOUR);
    const hers = await book(ann, id);
    await book(bob, id);
    const bobs = await run<{ bookings: { id: string }[] }>("x.bookings.mine", {}, as(bob));
    expect(bobs.bookings.map((b) => b.id)).not.toContain(hers.bookingId);
    expect(await run("x.bookings.cancel", { bookingId: hers.bookingId }, as(bob))).toMatchObject({
      result: "refused",
      reason: "not_found",
    });
    expect(
      await run(
        "x.bookings.cancel",
        { bookingId: hers.bookingId, confirm: true, expect: "cancelled" },
        as(bob),
      ),
    ).toMatchObject({ result: "refused", reason: "not_found" });
    expect((await get(BOOKING, hers.bookingId as string)).values.state).toBe("booked");
  });
});

describe("the desk: who is booked, and who may give a use back", () => {
  it("a walk-in already on file is offered, not made twice", async () => {
    const id = await klass(3 * HOUR, classType, 5);
    const email = `${unique("taken").toLowerCase()}@members.test`;
    const name = unique("Same");
    const onFile = await run<{ id: string }>(
      "person.create",
      { givenName: name, emails: [{ email }] },
      staff(),
    );
    // The same email: refused, naming who has it.
    expect(
      await run(
        "x.bookings.bookFor",
        { classId: id, newPerson: { givenName: "Other", email }, paidAtDesk: true },
        staff(),
      ),
    ).toMatchObject({
      result: "refused",
      reason: "person_exists",
      people: [expect.objectContaining({ id: onFile.id })],
    });
    // The same name: a possible duplicate, listed; then booked once staff confirm.
    const asked = await run<Booked & { people?: { id: string }[] }>(
      "x.bookings.bookFor",
      { classId: id, newPerson: { givenName: name }, paidAtDesk: true },
      staff(),
    );
    expect(asked).toMatchObject({ result: "refused", reason: "possible_duplicates" });
    expect(asked.people?.map((p) => p.id)).toContain(onFile.id);
    expect(
      await run(
        "x.bookings.bookFor",
        { classId: id, newPerson: { givenName: name }, paidAtDesk: true, confirmNew: true },
        staff(),
      ),
    ).toMatchObject({ result: "booked" });
    // Or the one on file, found and booked by id.
    const found = await run<{ people: { id: string }[] }>(
      "x.bookings.findPeople",
      { query: name },
      staff(),
    );
    expect(found.people.map((p) => p.id)).toContain(onFile.id);
  });

  it("staff's cancel is decided by the clock; giving a use back after the late point is a person's, destructive", async () => {
    const who = await member("desk");
    const whoPass = await pass(who, 5);
    // Thirty minutes before: late (from an hour before).
    const late = await book(who, await klass(30 * MINUTE));
    expect(await left(whoPass)).toBe(4);
    expect(await run("x.bookings.cancelFor", { bookingId: late.bookingId }, staff())).toMatchObject(
      { result: "late_cancelled", late: true },
    );
    expect(await left(whoPass)).toBe(4);
    // Three hours before: in time.
    const early = await book(who, await klass(3 * HOUR));
    expect(
      await run("x.bookings.cancelFor", { bookingId: early.bookingId }, staff()),
    ).toMatchObject({ result: "cancelled", late: false });
    expect(await left(whoPass)).toBe(4);
    // Giving a use back late is a person's own act through returnUse (ADR 0513): the assistant
    // is refused, and no other staff write may (the in-time window binds staff, `bindsStaff`).
    const again = await book(who, await klass(20 * MINUTE));
    expect(await left(whoPass)).toBe(3);
    expect(
      await refusal(
        run(
          "x.bookings.returnUse",
          { bookingId: again.bookingId, reason: "Coach was ill" },
          staff({ actor: "assistant" }),
        ),
      ),
    ).toMatchObject({ code: expect.stringMatching(/forbidden|actor/) });
    for (const state of ["cancelled", "excused"]) {
      expect(
        await refusal(
          run(
            "record.update",
            { object: BOOKING, id: again.bookingId, values: { state } },
            staff(),
          ),
        ),
      ).toMatchObject({ code: "invalid_input" });
    }
    expect((await get(BOOKING, again.bookingId as string)).values.state).toBe("booked");
    expect(
      await run(
        "x.bookings.returnUse",
        { bookingId: again.bookingId, reason: "Coach was ill" },
        staff(),
      ),
    ).toMatchObject({ result: "excused" });
    expect((await get(BOOKING, again.bookingId as string)).values.state).toBe("excused");
    expect(await left(whoPass)).toBe(4);
    expect((await get(BOOKING, again.bookingId as string)).values.note).toBe(
      "Use given back: Coach was ill",
    );
  });

  it("the booking rules are a person's: the assistant's change waits for one", async () => {
    const type = await create(CLASS_TYPE, { name: unique("Rules") });
    expect(
      await refusal(
        run(
          "record.update",
          { object: CLASS_TYPE, id: type, values: { "bookings.lateMinutes": 5 } },
          staff({ actor: "assistant" }),
        ),
      ),
    ).toMatchObject({ code: "pending_approval" });
    expect(
      await refusal(
        run(
          "extensionSettings.update",
          { extension: "bookings", values: { lateMinutes: 5 } },
          staff({ actor: "mcp" }),
        ),
      ),
    ).toMatchObject({ code: "pending_approval" });
    await run(
      "record.update",
      { object: CLASS_TYPE, id: type, values: { "bookings.lateMinutes": 90 } },
      staff(),
    );
    expect((await get(CLASS_TYPE, type)).values["bookings.lateMinutes"]).toBe(90);
  });

  it("a trashed class type does not open its classes to members", async () => {
    const who = await member("trashed");
    await pass(who, 5);
    const type = await create(CLASS_TYPE, { name: unique("Gone") });
    const id = await klass(3 * HOUR, type);
    await run("record.delete", { object: CLASS_TYPE, id: type }, staff());
    expect(await book(who, id)).toMatchObject({ result: "refused", reason: "staff_only" });
  });

  it("a one-off class needs its places", async () => {
    expect(
      await refusal(
        run(
          "record.create",
          {
            object: CLASS,
            values: { classType, startsAt: new Date(Date.now() + DAY).toISOString() },
          },
          staff(),
        ),
      ),
    ).toMatchObject({ code: "invalid_input" });
  });
});
