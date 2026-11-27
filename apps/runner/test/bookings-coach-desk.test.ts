// A coach who also works the desk (issue #258, ADR 0600), on the shipped packs: Programs, Bookings
// and Memberships in the real host and sandbox.
//
// An ordinary member of staff does the coach's work and the desk's in one sign-in. A coach (the
// `bookings.coach` pack role) is refused every desk tool; an admin grants them `bookings:desk`,
// and then each desk tool works on any day while each coach tool, and the role's record reads,
// stay today's. The grant opens the desk's tools and nothing else; a tool run started through it
// is not held to the role's today, a run started through the role is, nested tools included;
// only a human admin grants it, it is audited, and taking it away counts from the next call.
//
// Clocks: a tool's own calls read the real clock, so classes are placed from now. The coach's work
// on a class minutes away runs at its start, so its day is the coach's today even when the run
// crosses local midnight (#290).
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
// A shipped fixture pack with a grantable tool that calls Bookings' coach tool and desk tool: what a
// run started through a grant reaches is the granted tool's, not held to the role's today.
files.deskrelay = {
  "index.ts": `import { defineExtension, defineTool, z } from "@composable-os/sdk";
export default defineExtension({
  id: "deskrelay",
  version: "0.1.0",
  contractVersion: 1,
  label: "Desk relay (fixture)",
  requires: ["bookings"],
  permissions: { operations: ["x.bookings.roster", "x.bookings.classList"], modules: ["ops"] },
  grantable: ["deskrelay:relay"],
  objects: {},
  tools: {
    relay: defineTool({
      description: "Test fixture: reads a class's lists through Bookings' roster and classList.",
      input: z.object({ classId: z.string() }),
      output: z.object({}).passthrough(),
      risk: "read",
      permission: "deskrelay:relay",
      handler: async (input, ctx) => ({
        roster: await ctx.ops.call("x.bookings.roster", input),
        list: await ctx.ops.call("x.bookings.classList", input),
      }),
    }),
  },
});
`,
};
const OURS = new Set(Object.keys(files));

const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    { id: "bookings", version: "0.1.0" },
    { id: "memberships", version: "0.1.0" },
    { id: "programs", version: "0.1.0" },
    { id: "deskrelay", version: "0.1.0" },
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
const DESK = "bookings:desk";

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
  return error as { code: string; message?: string; details?: Record<string, unknown> };
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

/** A staff account with the role `role` and nothing else. */
async function account(name: string, role: "member" | "viewer"): Promise<ActingUser> {
  const id = newId("user");
  const email = `${unique("staff")}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 1, ?, ?, ?)",
  )
    .bind(id, name, email, now, now, role)
    .run();
  return { id, email, name, role };
}

/** A staff account given the Bookings coach role by a human admin. */
async function coach(name: string): Promise<ActingUser> {
  const user = await account(name, "member");
  await run("user.setPackRole", { id: user.id, role: "bookings.coach" }, staff());
  return { ...user, role: "viewer" };
}
const grant = (user: ActingUser, permissions: string[]) =>
  run("user.setPermissions", { id: user.id, permissions }, staff());
const asUser = (user: ActingUser, extra: Partial<InvocationContext> = {}) =>
  staff({ user, ...extra });

async function givePass(who: CustomerPrincipal, uses = 10): Promise<string> {
  const passType = await create("memberships.passtype", {
    title: unique("Pack "),
    price: 50,
    uses,
    validDays: 60,
    status: "on_sale",
  });
  const given = await run<{ passId: string }>(
    "x.memberships.givePass",
    { personId: who.personId, passTypeId: passType, reason: "Integration test" },
    staff(),
  );
  return given.passId;
}

/** A one-off class starting `in` ms from now, an hour long. */
async function klass(inMs: number, places = 10): Promise<string> {
  const startsAt = new Date(Date.now() + inMs).toISOString();
  return create(CLASS, {
    classType: type,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: ZONE,
    places,
  });
}
const localDate = (inMs: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date(Date.now() + inMs));
/** A clock stopped at a class's start: the class is on that clock's today in any zone. */
const startOf = async (classId: string) => {
  const at = new Date(String((await get(CLASS, classId)).startsAt));
  return () => at;
};

type Out = Record<string, unknown> & { result: string; bookingId?: string };
async function booked(who: CustomerPrincipal, classId: string): Promise<string> {
  const out = await run<Out>("x.bookings.book", { classId }, as(who));
  if (out.result !== "booked") throw new Error(`Not booked: ${JSON.stringify(out)}`);
  return out.bookingId as string;
}
const stateOf = async (booking: string) => (await get(BOOKING, booking)).state;

/** The desk's work, any day, as `who`: every desk tool, each answered and not refused. */
async function deskWork(who: InvocationContext, label: string) {
  const person = await member(`${label}desk`);
  await givePass(person);
  const ahead = await klass(6 * DAY);
  const further = await klass(8 * DAY);
  const aheadDay = await run<{ classes: { id: string }[] }>(
    "x.bookings.day",
    { date: localDate(6 * DAY), timeZone: ZONE },
    who,
  );
  expect(aheadDay.classes.map((c) => c.id)).toContain(ahead);
  const found = await run<{ people: { id: string }[] }>(
    "x.bookings.findPeople",
    { query: `Given-${label}desk` },
    who,
  );
  expect(found.people.map((p) => p.id)).toContain(person.personId);
  const made = await run<Out & { personId: string }>(
    "x.bookings.bookFor",
    { classId: ahead, personId: person.personId },
    who,
  );
  expect(made).toMatchObject({ result: "booked", personId: person.personId });
  const walkIn = await run<Out & { personId: string }>(
    "x.bookings.bookFor",
    // A walk-in holds no pass yet: they pay at the desk.
    { classId: ahead, newPerson: { givenName: unique("Walkin") }, paidAtDesk: true },
    who,
  );
  expect(walkIn).toMatchObject({ result: "booked" });
  const list = await run<{ bookings: { id: string }[] }>(
    "x.bookings.classList",
    { classId: ahead },
    who,
  );
  expect(list.bookings.map((b) => b.id)).toEqual(
    expect.arrayContaining([made.bookingId, walkIn.bookingId]),
  );
  const moved = await run<Out>(
    "x.bookings.move",
    { bookingId: made.bookingId, toClassId: further },
    who,
  );
  expect(moved).toMatchObject({ result: "moved" });
  expect(await run<Out>("x.bookings.cancelFor", { bookingId: moved.bookingId }, who)).toMatchObject(
    { result: "cancelled" },
  );
  const ill = await member(`${label}ill`);
  await givePass(ill);
  const again = await booked(ill, ahead);
  expect(
    await run<Out>("x.bookings.returnUse", { bookingId: again, reason: "Was ill" }, who),
  ).toMatchObject({ result: "excused" });
  return { ahead, walkIn: walkIn.bookingId as string };
}

/** The coach's work, today, as `signedIn`: the day, the list, a tick, an untick, a no-show, mark all. */
async function coachWork(signedIn: InvocationContext, label: string) {
  const today = await klass(2 * MINUTE);
  const clock = await startOf(today);
  const who: InvocationContext = { ...signedIn, clock };
  const people = await Promise.all(["a", "b", "c"].map((l) => member(`${label}${l}`)));
  await Promise.all(people.map((p) => givePass(p)));
  const [a, b, c] = (await Promise.all(people.map((p) => booked(p, today)))) as [
    string,
    string,
    string,
  ];
  const day = await run<{ classes: { id: string }[] }>(
    "x.bookings.day",
    { date: new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(clock()), timeZone: ZONE },
    who,
  );
  expect(day.classes.map((k) => k.id)).toContain(today);
  const roster = await run<{ bookings: { id: string }[] }>(
    "x.bookings.roster",
    { classId: today },
    who,
  );
  expect(roster.bookings.map((x) => x.id)).toEqual(expect.arrayContaining([a, b, c]));
  expect(await run<Out>("x.bookings.markAttended", { bookingId: a }, who)).toMatchObject({
    result: "attended",
  });
  expect(await run<Out>("x.bookings.undoAttended", { bookingId: a }, who)).toMatchObject({
    result: "booked",
  });
  // Not yet started: answered (not refused) that a no-show waits for the start.
  expect(await run<Out>("x.bookings.markNoShow", { bookingId: b }, who)).toMatchObject({
    result: "refused",
    reason: "not_started",
  });
  expect(await run<Out>("x.bookings.markAll", { classId: today }, who)).toMatchObject({
    result: "marked",
    ticked: 3,
  });
  expect(await stateOf(c)).toBe("attended");
  return { today };
}

let type: string;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["bookings", "memberships", "deskrelay"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  await run("settings.update", { timezone: ZONE }, staff()).catch(() => undefined);
  type = await create("bookings.classtype", { name: unique("Strength") });
}, 120_000);

afterAll(() => setPreset("balanced"));

describe("one person, the coach's work and the desk's (issue #258)", () => {
  it("an ordinary member of staff does both in one sign-in, today and any day", async () => {
    const both = asUser(await account("Coach and desk", "member"));
    await coachWork(both, "ordinary");
    const { ahead } = await deskWork(both, "ordinary");
    // Not held to today: another day's list is theirs too.
    expect(
      (await run<{ bookings: unknown[] }>("x.bookings.roster", { classId: ahead }, both)).bookings
        .length,
    ).toBeGreaterThan(0);
  });

  it("a coach without the desk permission is refused every desk tool", async () => {
    const kim = await coach("Coach Kim");
    const who = await member("nodesk");
    await givePass(who);
    const ahead = await klass(6 * DAY);
    const later = await booked(who, ahead);
    for (const [name, input] of [
      ["x.bookings.findPeople", { query: "Given" }],
      ["x.bookings.bookFor", { classId: ahead, personId: who.personId }],
      ["x.bookings.bookFor", { classId: ahead, newPerson: { givenName: "Walk" } }],
      ["x.bookings.classList", { classId: ahead }],
      ["x.bookings.cancelFor", { bookingId: later }],
      ["x.bookings.move", { bookingId: later, toClassId: ahead }],
      ["x.bookings.returnUse", { bookingId: later, reason: "Was ill" }],
    ] as const) {
      const error = await refusal(run(name, input, asUser(kim)));
      expect([name, error.code]).toEqual([name, "forbidden"]);
    }
    // And the day view is the coach's today only.
    expect(
      (
        await run<{ classes: unknown[] }>(
          "x.bookings.day",
          { date: localDate(6 * DAY), timeZone: ZONE },
          asUser(kim),
        )
      ).classes,
    ).toEqual([]);
    expect(await stateOf(later)).toBe("booked");
  });

  it("with the desk permission: each desk tool works on any day; each coach tool, and the role's reads, stay today's", async () => {
    const sam = await coach("Coach Sam");
    await grant(sam, [DESK]);
    const who = asUser(sam);
    await coachWork(who, "granted");
    const { ahead, walkIn } = await deskWork(who, "granted");
    // What the coach role gives stays today's: another day's roster, its names, its class record.
    expect(
      JSON.stringify(await refusal(run("x.bookings.roster", { classId: ahead }, who))),
    ).toContain("not_found");
    expect(await run<Out>("x.bookings.markAttended", { bookingId: walkIn }, who)).toMatchObject({
      result: "refused",
      reason: "not_found",
    });
    expect(await run<Out>("x.bookings.markAll", { classId: ahead }, who)).toMatchObject({
      result: "marked",
      ticked: 0,
    });
    expect(await stateOf(walkIn)).toBe("booked");
    expect((await refusal(run("record.get", { object: CLASS, id: ahead }, who))).code).toBe(
      "not_found",
    );
    const listed = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: CLASS, filter: { field: "id", op: "eq", value: ahead } },
      who,
    );
    expect(listed.items).toEqual([]);
    expect((await refusal(run("record.count", { object: CLASS }, who))).code).toBe("forbidden");
  });

  it("the desk permission gives the desk's tools and nothing else", async () => {
    const lee = await coach("Coach Lee");
    await grant(lee, [DESK]);
    const who = await member("nothingelse");
    const pass = await givePass(who);
    const today = await klass(3 * MINUTE);
    const booking = await booked(who, today);
    for (const [name, input] of [
      ["person.list", {}],
      ["person.get", { id: who.personId }],
      ["person.create", { givenName: "Someone" }],
      ["organisation.list", {}],
      ["order.list", {}],
      ["order.refund", { id: "ord_x", reason: "No" }],
      ["record.list", { object: BOOKING }],
      ["record.get", { object: BOOKING, id: booking }],
      ["record.update", { object: BOOKING, id: booking, values: { state: "cancel" } }],
      ["record.create", { object: BOOKING, values: { class: today, person: who.personId } }],
      ["record.list", { object: PASS }],
      ["record.get", { object: PASS, id: pass }],
      ["record.list", { object: "memberships.membership" }],
      ["record.list", { object: "person" }],
      ["query.sql", { sql: "SELECT 1" }],
      ["search.global", { query: "Given" }],
      ["search.hybrid", { query: "Given" }],
      ["export.csv", { object: "person" }],
      ["view.list", {}],
      ["settings.update", { timezone: "UTC" }],
      ["extensionSettings.update", { extension: "bookings", values: { lateMinutes: 5 } }],
      ["user.list", {}],
      ["user.me", {}],
      ["user.setPermissions", { id: lee.id, permissions: [DESK, "memberships:passes"] }],
      ["thread.open", {}],
      ["thread.search", { query: "Given" }],
      ["x.bookings.cancelClass", { classId: today, reason: "No coach" }],
      ["x.memberships.givePass", { personId: who.personId, passTypeId: "x", reason: "Free" }],
      ["x.deskrelay.relay", { classId: today }],
    ] as const) {
      const error = await refusal(run(name, input, asUser(lee)));
      expect([name, error.code]).toEqual([
        name,
        expect.stringMatching(/forbidden|unknown_operation/),
      ]);
    }
  });

  it("a tool run carries the authority that allowed it, into the tools it calls", async () => {
    const ash = await coach("Coach Ash");
    const who = await member("relayed");
    await givePass(who);
    const ahead = await klass(6 * DAY);
    const today = await klass(4 * MINUTE);
    await booked(who, ahead);
    await booked(who, today);
    // Through the coach role: roster's own reads are held to today, another day not found.
    expect(
      JSON.stringify(await refusal(run("x.bookings.roster", { classId: ahead }, asUser(ash)))),
    ).toContain("not_found");
    // Granted a tool that calls roster and classList: the run is the grant's, not the role's,
    // so its nested tool calls reach another day's class; the role's own call still does not.
    await grant(ash, [DESK, "deskrelay:relay"]);
    const relayed = await run<{ roster: { bookings: unknown[] }; list: { bookings: unknown[] } }>(
      "x.deskrelay.relay",
      { classId: ahead },
      asUser(ash),
    );
    expect(relayed.roster.bookings).toHaveLength(1);
    expect(relayed.list.bookings).toHaveLength(1);
    expect(
      JSON.stringify(await refusal(run("x.bookings.roster", { classId: ahead }, asUser(ash)))),
    ).toContain("not_found");
    // A desk tool's nested writes (a booking made on another day's class) are not held either.
    const someone = await member("relayedbook");
    await givePass(someone);
    expect(
      await run<Out>(
        "x.bookings.bookFor",
        { classId: ahead, personId: someone.personId },
        asUser(ash),
      ),
    ).toMatchObject({ result: "booked" });
    // A run carrying the role's limit (a coach-role call's) holds it on what it calls, whatever
    // the account was granted: the limit is in the run, never in the input.
    const limit = {
      "bookings.class": { at: "startsAt", until: "endsAt", zone: "timezone" },
      "bookings.booking": { at: "class.startsAt", until: "class.endsAt", zone: "class.timezone" },
    };
    expect(
      JSON.stringify(
        await refusal(run("x.deskrelay.relay", { classId: ahead }, staff({ roleToday: limit }))),
      ),
    ).toContain("not_found");
  });

  it("only a human admin grants it, it is audited, and taking it away counts from the next call", async () => {
    const jo = await coach("Coach Jo");
    const other = await account("Desk member", "member");
    for (const ctx of [
      staff({ actor: "assistant" }),
      staff({ actor: "mcp", origin: { surface: "mcp" } }),
      staff({ actor: "automation", origin: { surface: "automation" } }),
      asUser(other),
      asUser(jo),
    ]) {
      const error = await refusal(
        run("user.setPermissions", { id: jo.id, permissions: [DESK] }, ctx),
      );
      expect(error.code).toBe("forbidden");
    }
    // A core permission is not for a fixed role's account; nor is a role-held one.
    for (const permissions of [["orders:refund"], ["records:publish"], ["bookings:coach"]]) {
      expect(
        (await refusal(run("user.setPermissions", { id: jo.id, permissions }, staff()))).code,
      ).toBe("invalid_input");
    }
    // An account granted a core permission is not given a fixed role until it is taken away.
    const pub = await account("Publisher", "member");
    await grant(pub, ["records:publish"]);
    expect(
      (await refusal(run("user.setPackRole", { id: pub.id, role: "bookings.coach" }, staff())))
        .code,
    ).toBe("conflict");

    const who = await member("revoked");
    await givePass(who);
    const ahead = await klass(6 * DAY);
    await grant(jo, [DESK]);
    expect(
      await run<Out>("x.bookings.bookFor", { classId: ahead, personId: who.personId }, asUser(jo)),
    ).toMatchObject({ result: "booked" });
    const audit = await env.DB.prepare(
      "SELECT a.user_id, a.actor, c.diff FROM core_audit_changes c JOIN core_audit a ON a.id = c.audit_id WHERE c.record_id = ? AND a.operation = 'user.setPermissions' ORDER BY c.id",
    )
      .bind(jo.id)
      .all<{ user_id: string; actor: string; diff: string }>();
    expect(audit.results.map((r) => [r.user_id, r.actor, JSON.parse(r.diff)])).toEqual([
      [admin.id, "human", { permissions: { before: [], after: [DESK] } }],
    ]);
    // Taken away: the very next call is refused, whatever the adapter built the account as.
    await grant(jo, []);
    expect(
      (
        await refusal(
          run("x.bookings.findPeople", { query: "Given" }, asUser({ ...jo, role: "member" })),
        )
      ).code,
    ).toBe("forbidden");
    // Taking the role away leaves what was granted, which a viewer then holds on its own.
    await grant(jo, [DESK]);
    await run("user.setPackRole", { id: jo.id, role: null }, staff());
    const person = await member("afterrole");
    await givePass(person);
    expect(
      await run<Out>(
        "x.bookings.bookFor",
        { classId: ahead, personId: person.personId },
        asUser({ ...jo, role: "viewer" }),
      ),
    ).toMatchObject({ result: "booked" });
    expect(
      (await refusal(run("x.bookings.markAttended", { bookingId: "x" }, asUser(jo)))).code,
    ).toBe("forbidden");
  });
});
