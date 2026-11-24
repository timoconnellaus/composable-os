// Stage 45 step 7: what the roster screens ask the host, on the shipped packs (Programs, Bookings,
// Rostering) in the real host and sandbox: who is reading and what they may do (`me`), each day's
// hours in the zone (`week`'s days, a clock change included), who could be put on a shift and why
// not (`candidates`, the same dry run a write is made with), back to the pattern (`follow`), the
// regular week and changing it from a date (`patterns`, `setPattern`, refused whole on a clash),
// the staff and kinds of work (`people`), the import's dry run (`planCheck`, a person's only) and
// pay's list of everyone (`payBases` with everyone). The harness is rostering.test.ts's.
//
// Clocks: a tool's own calls read the real clock, so shifts are placed from now.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  newId,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
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
  rostering: packFiles(
    import.meta.glob<string>("../../../packs/rostering/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
};
// A shipped fixture pack whose tool calls Rostering's restricted tool and the host's roster read:
// a restricted tool is never reached from another extension's code, whoever called it.
files.rosterrelay = {
  "index.ts": `import { defineExtension, defineTool, z } from "@composable-os/sdk";
export default defineExtension({
  id: "rosterrelay",
  version: "0.1.0",
  contractVersion: 1,
  label: "Roster relay (fixture)",
  requires: ["rostering"],
  permissions: { operations: ["x.rostering.uncovered", "x.rostering.week"], modules: ["ops"] },
  objects: {},
  tools: {
    relay: defineTool({
      description: "Test fixture: asks Rostering's restricted tool for the uncovered shifts.",
      input: z.object({}),
      output: z.object({}).passthrough(),
      risk: "read",
      handler: async (_input, ctx) => ({ uncovered: await ctx.ops.call("x.rostering.uncovered", {}) }),
    }),
    weekRelay: defineTool({
      description: "Test fixture: asks Rostering's team read for the roster, from another pack's code.",
      input: z.object({}),
      output: z.object({}).passthrough(),
      risk: "read",
      handler: async (_input, ctx) => ({ week: await ctx.ops.call("x.rostering.week", {}) }),
    }),
  },
});
`,
};
// A shipped fixture pack whose open tools (no permission of Rostering's, no person's approval)
// call each of the roster screens' host operations directly: the operations' own guards (who
// rosters, a person applies) must refuse them, whoever calls the tool.
const RELAYED = ["candidates", "people", "patterns", "setPattern", "follow", "planCheck"] as const;
files.staffrelay = {
  "index.ts": `import { defineExtension, defineTool, z } from "@composable-os/sdk";
export default defineExtension({
  id: "staffrelay",
  version: "0.1.0",
  contractVersion: 1,
  label: "Staffing relay (fixture)",
  requires: ["rostering"],
  permissions: { operations: [${RELAYED.map((n) => `"staffing.${n}"`).join(", ")}], modules: ["ops"] },
  objects: {},
  tools: {
${RELAYED.map(
  (n) => `    ${n}: defineTool({
      description: "Test fixture: calls the host's staffing.${n} from another pack's open tool.",
      input: z.object({}).passthrough(),
      output: z.object({}).passthrough(),
      risk: "${n === "setPattern" || n === "follow" ? "write" : "read"}",
      handler: async (input, ctx) => ({ out: await ctx.ops.call("staffing.${n}", input) }),
    }),`,
).join("\n")}
  },
});
`,
};
const OURS = new Set(Object.keys(files));

const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    { id: "programs", version: "0.1.0" },
    { id: "bookings", version: "0.1.0" },
    { id: "rostering", version: "0.1.0" },
    { id: "rosterrelay", version: "0.1.0" },
    { id: "staffrelay", version: "0.1.0" },
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
const SHIFT = "rostering.shift";
const DUTY = "rostering.duty";
const SERIES = "rostering.dutyseries";
const MANAGE = "rostering:manage";

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
const asUser = (user: ActingUser, extra: Partial<InvocationContext> = {}) =>
  staff({ user, ...extra });
const run = <T = Record<string, unknown>>(name: string, input: unknown, ctx: InvocationContext) =>
  invokeByName(name, input, ctx) as Promise<T>;
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
/** A staff account given a pack role by a human admin. */
async function fixedRole(name: string, role: string): Promise<ActingUser> {
  const user = await account(name, "member");
  await run("user.setPackRole", { id: user.id, role }, staff());
  return { ...user, role: "viewer" };
}
const grant = (user: ActingUser, permissions: string[]) =>
  run("user.setPermissions", { id: user.id, permissions }, staff());
/** A one-off duty shift starting `in` ms from now, an hour long, worked by `user`. */
async function dutyShift(inMs: number, user: string | null): Promise<string> {
  const startsAt = new Date(Date.now() + inMs).toISOString();
  return create(SHIFT, {
    duty,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: ZONE,
    ...(user ? { staff: user } : {}),
  });
}
const localDate = (inMs: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date(Date.now() + inMs));

let type: string;
let duty: string;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "rostering", "rosterrelay", "staffrelay"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  await run("settings.update", { timezone: ZONE }, staff()).catch(() => undefined);
  type = await create("programs.classtype", { name: unique("Strength") });
  duty = await create(DUTY, { name: unique("Cleaning"), place: "Main floor" });
}, 120_000);

const SERIES_GEN = async (series: string) => {
  for (let i = 0; i < 20; i++) {
    const out = await run<{ more: boolean }>(
      "recurring.generate",
      { object: SERIES, id: series },
      staff({ actor: "automation" }),
    );
    if (!out.more) break;
  }
};
const shiftsOf = async (series: string) =>
  (
    await run<{ items: { id: string; values: Record<string, unknown> }[] }>(
      "record.list",
      { object: SHIFT, filter: { field: "series", op: "eq", value: series }, limit: 200 },
      staff(),
    )
  ).items.sort((a, b) => String(a.values.startsAt).localeCompare(String(b.values.startsAt)));

// --- me ----------------------------------------------------------------------------------------

describe("who is reading (x.rostering.me)", () => {
  it("says whether the reader rosters and handles pay, from the host, and today in the zone", async () => {
    const mine = await run<Record<string, unknown>>("x.rostering.me", {}, staff());
    expect(mine).toMatchObject({ account: admin.id, rosters: true, pays: true, zone: ZONE });
    expect(mine.today).toBe(localDate(0));
    expect(mine.cutoffMinutes).toBe(60);
    const member = await account("Member Mo", "member");
    expect(await run("x.rostering.me", {}, asUser(member))).toMatchObject({
      rosters: false,
      pays: false,
    });
    const cleaner = await fixedRole("Cleaner Cy", "rostering.team");
    expect(await run("x.rostering.me", {}, asUser(cleaner))).toMatchObject({
      account: cleaner.id,
      rosters: false,
      pays: false,
    });
    // Pay is a person's: an assistant acting for an admin is told no.
    expect(
      await run(
        "x.rostering.me",
        {},
        staff({ actor: "assistant", origin: { surface: "assistant" } }),
      ),
    ).toMatchObject({ rosters: true, pays: false });
    // Granted, a member rosters.
    await grant(member, [MANAGE]);
    expect(await run("x.rostering.me", {}, asUser(member))).toMatchObject({ rosters: true });
  });
});

// --- the week's days -----------------------------------------------------------------------------

describe("the roster's days (x.rostering.week)", () => {
  it("gives each local date's hours in the zone: 25 when the clocks go back, 23 when they go forward", async () => {
    // Sydney: the clocks go back on the first Sunday of April and forward on the first of October.
    const year = new Date().getUTCFullYear() + 1;
    const firstSunday = (month: number) => {
      for (let d = 1; d <= 7; d++) {
        const date = new Date(Date.UTC(year, month - 1, d));
        if (date.getUTCDay() === 0) return date.toISOString().slice(0, 10);
      }
      return "";
    };
    for (const [date, hours] of [
      [firstSunday(4), 25],
      [firstSunday(10), 23],
    ] as const) {
      const week = await run<{ days: { date: string; hours: number }[] }>(
        "x.rostering.week",
        { from: date, to: date },
        staff(),
      );
      expect(week.days).toEqual([{ date, hours }]);
    }
    const plain = await run<{ days: { date: string; hours: number }[] }>(
      "x.rostering.week",
      { from: `${year}-06-01`, to: `${year}-06-07` },
      staff(),
    );
    expect(plain.days).toHaveLength(7);
    expect(plain.days.every((d) => d.hours === 24)).toBe(true);
  });
});

// --- candidates, follow and the pattern -----------------------------------------------------------

describe("who could be put on a shift (x.rostering.candidates)", () => {
  it("lists the eligible first, then the warned, then those it would clash with, as the host's dry run", async () => {
    const kind = await create(DUTY, { name: unique("Open up") });
    const free = await account(unique("Free Fay"), "member");
    const unqualified = await account(unique("Unqualified Uma"), "member");
    const busy = await account(unique("Busy Bo"), "member");
    const away = await account(unique("Away Al"), "member");
    for (const who of [free, busy, away]) {
      await run(
        "x.rostering.qualify",
        { account: who.id, kind: { object: DUTY, id: kind } },
        staff(),
      );
    }
    const at = 15 * DAY + 2 * HOUR;
    const startsAt = new Date(Date.now() + at).toISOString();
    const shift = await create(SHIFT, {
      duty: kind,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
      timezone: ZONE,
    });
    // Busy is on another shift then; Away said so.
    await create(SHIFT, {
      duty: kind,
      startsAt: new Date(Date.parse(startsAt) + 30 * MINUTE).toISOString(),
      endsAt: new Date(Date.parse(startsAt) + 90 * MINUTE).toISOString(),
      timezone: ZONE,
      staff: busy.id,
    });
    await run(
      "x.rostering.awayFor",
      {
        account: away.id,
        kind: "leave",
        startsAt: `${localDate(at - DAY)}T00:00`,
        endsAt: `${localDate(at + DAY)}T23:00`,
      },
      staff(),
    );
    const answer = await run<{
      current: { account: string | null };
      pattern: unknown;
      people: {
        account: string;
        eligible: boolean;
        warnings: { code: string }[];
        clash: { title: string } | null;
      }[];
    }>("x.rostering.candidates", { object: SHIFT, id: shift }, staff());
    expect(answer.current.account).toBeNull();
    // A one-off has no pattern.
    expect(answer.pattern).toBeNull();
    const at_ = (id: string) => answer.people.findIndex((p) => p.account === id);
    const row = (id: string) => answer.people[at_(id)];
    expect(row(free.id)).toMatchObject({ eligible: true, warnings: [], clash: null });
    expect(row(unqualified.id)?.eligible).toBe(false);
    expect(row(unqualified.id)?.warnings.map((w) => w.code)).toEqual(["not_qualified"]);
    expect(row(away.id)?.warnings.map((w) => w.code)).toEqual(["unavailable"]);
    expect(row(busy.id)?.clash).not.toBeNull();
    expect(at_(free.id)).toBeLessThan(at_(unqualified.id));
    expect(at_(away.id)).toBeLessThan(at_(busy.id));
    // The same as the write: putting Busy on it is refused, naming the other shift.
    const error = await refusal(
      run("x.rostering.assign", { object: SHIFT, id: shift, account: busy.id }, staff()),
    );
    expect(error.details?.rule ?? (error.details?.details as { rule?: string })?.rule).toBe(
      "double_booked",
    );
    // Someone who does not roster is refused it.
    const member = await account("Member Ned", "member");
    expect(
      (await refusal(run("x.rostering.candidates", { object: SHIFT, id: shift }, asUser(member))))
        .code,
    ).toBe("forbidden");
  });

  it("a shift of a pattern names its regular person; back to the pattern drops its own", async () => {
    const regular = await fixedRole(unique("Regular Rae"), "rostering.team");
    const other = await fixedRole(unique("Other Oz"), "rostering.team");
    const series = await create(SERIES, {
      duty,
      weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      time: "05:00",
      length: 30,
      firstDate: localDate(3 * DAY),
      lastDate: localDate(9 * DAY),
      timezone: ZONE,
      staff: regular.id,
    });
    await SERIES_GEN(series);
    const [first] = await shiftsOf(series);
    expect(first).toBeTruthy();
    const id = first?.id as string;
    await run("x.rostering.assign", { object: SHIFT, id, account: other.id }, staff());
    const swapped = await run<{ pattern: { account: string; own: boolean } }>(
      "x.rostering.candidates",
      { object: SHIFT, id },
      staff(),
    );
    expect(swapped.pattern).toMatchObject({ account: regular.id, own: true });
    await run("x.rostering.follow", { object: SHIFT, id }, staff());
    expect((await get(SHIFT, id)).staff).toBe(regular.id);
    const back = await run<{ pattern: { own: boolean } }>(
      "x.rostering.candidates",
      { object: SHIFT, id },
      staff(),
    );
    expect(back.pattern.own).toBe(false);
    // A one-off shift has no pattern to go back to.
    const oneOff = await dutyShift(25 * DAY, other.id);
    const error = await refusal(run("x.rostering.follow", { object: SHIFT, id: oneOff }, staff()));
    expect(JSON.stringify(error)).toContain("recurring_not_generated");
    // An assistant's request waits for a person (personApproves).
    const asked = await run<{ status?: string }>(
      "x.rostering.follow",
      { object: SHIFT, id },
      staff({ actor: "assistant", origin: { surface: "assistant" } }),
    ).catch((e: { code?: string }) => ({ status: e.code }));
    expect(JSON.stringify(asked)).toMatch(/approval|pending|queued/);
    await run("record.update", { object: SERIES, id: series, values: { state: "ended" } }, staff());
  });
});

// --- patterns and changing one ------------------------------------------------------------------

describe("the regular week (x.rostering.patterns, setPattern)", () => {
  it("lists every live pattern with its person, and changes one from a date; a clash on any date is refused whole", async () => {
    const before = await fixedRole(unique("Pat Before"), "rostering.team");
    const after = await fixedRole(unique("Pat After"), "rostering.team");
    const series = await create(SERIES, {
      duty,
      weekdays: ["mon", "wed", "fri"],
      time: "21:00",
      length: 60,
      firstDate: localDate(2 * DAY),
      lastDate: localDate(30 * DAY),
      timezone: ZONE,
      staff: before.id,
    });
    await SERIES_GEN(series);
    const listed = await run<{
      patterns: { id: string; account: string | null; weekdays: string[] }[];
    }>("x.rostering.patterns", {}, staff());
    expect(listed.patterns.find((p) => p.id === series)).toMatchObject({
      account: before.id,
      weekdays: ["mon", "wed", "fri"],
    });
    const from = localDate(16 * DAY);
    await run(
      "x.rostering.setPattern",
      { object: SERIES, id: series, account: after.id, from },
      staff(),
    );
    const made = await shiftsOf(series);
    const dateOf = (s: { values: Record<string, unknown> }) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(
        new Date(String(s.values.startsAt)),
      );
    for (const s of made) {
      expect([dateOf(s), s.values.staff]).toEqual([
        dateOf(s),
        dateOf(s) >= from ? after.id : before.id,
      ]);
    }
    // Put Before somewhere at 21:30 on a later pattern date: changing back from today clashes.
    const later = made.find((s) => dateOf(s) >= from);
    const startsAt = new Date(
      Date.parse(String(later?.values.startsAt)) + 30 * MINUTE,
    ).toISOString();
    await create(SHIFT, {
      duty,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
      timezone: ZONE,
      staff: before.id,
    });
    const error = await refusal(
      run("x.rostering.setPattern", { object: SERIES, id: series, account: before.id }, staff()),
    );
    expect(JSON.stringify(error)).toContain("double_booked");
    expect(JSON.stringify(error)).toContain(later ? dateOf(later) : "");
    // Nothing changed.
    expect((await get(SERIES, series)).staff).toBe(after.id);
    await run("record.update", { object: SERIES, id: series, values: { state: "ended" } }, staff());
  });
});

// --- people and kinds -----------------------------------------------------------------------------

describe("the staff and the kinds of work (x.rostering.people)", () => {
  it("lists active staff by name and every kind of work (class types and duties); never a deactivated account", async () => {
    const gone = await account(unique("Gone Gil"), "member");
    await env.DB.prepare("UPDATE core_user SET deactivated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), gone.id)
      .run();
    const answer = await run<{
      people: { account: string }[];
      kinds: { object: string; id: string }[];
    }>("x.rostering.people", {}, staff());
    const accounts = answer.people.map((p) => p.account);
    expect(accounts).toContain(admin.id);
    expect(accounts).not.toContain(gone.id);
    expect(answer.kinds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ object: "programs.classtype", id: type }),
        expect.objectContaining({ object: DUTY, id: duty }),
      ]),
    );
    expect(JSON.stringify(answer)).not.toMatch(/email|@example/);
  });
});

// --- the import's dry run -------------------------------------------------------------------------

describe("the import's dry run (x.rostering.planCheck)", () => {
  it("names each date a plan would clash with a shift or an earlier plan, and the dates someone is away; a person only", async () => {
    const who = await fixedRole(unique("Plan Pia"), "rostering.team");
    // Already on a shift then (a one-off, an hour long).
    const plain = await dutyShift(20 * DAY, who.id);
    const shift = await get(SHIFT, plain);
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(String(shift.startsAt)));
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(
      new Date(String(shift.startsAt)),
    );
    const checked = await run<{
      plans: {
        key: string | null;
        dates: number;
        clashes: { date: string; other: { title: string }; ended: boolean }[];
      }[];
    }>(
      "x.rostering.planCheck",
      {
        plans: [
          { key: "row 1", account: who.id, date: day, time: local, length: 30 },
          // A second row at the same time: the same shift is in its way.
          { key: "row 2", account: who.id, date: day, time: local, length: 30 },
          // Someone else: no clash.
          { key: "row 3", account: admin.id, date: day, time: local, length: 30 },
        ],
      },
      staff(),
    );
    expect(checked.plans[0]?.clashes).toHaveLength(1);
    expect(checked.plans[0]?.clashes[0]?.ended).toBe(false);
    expect(checked.plans[0]?.clashes[0]?.date).toBe(day);
    // Row 2 clashes too (with the same existing shift, which is checked first).
    expect(checked.plans[1]?.clashes).toHaveLength(1);
    expect(checked.plans[2]?.clashes).toEqual([]);
    // Two plans against each other, with no shift between them.
    const far = localDate(40 * DAY);
    const pair = await run<{ plans: { clashes: { other: { title: string } }[] }[] }>(
      "x.rostering.planCheck",
      {
        plans: [
          { key: "first row", account: who.id, date: far, time: "10:00", length: 60 },
          { key: "second row", account: who.id, date: far, time: "10:30", length: 60 },
        ],
      },
      staff(),
    );
    expect(pair.plans[0]?.clashes).toEqual([]);
    expect(pair.plans[1]?.clashes[0]?.other.title).toBe("first row");
    // A weekly plan makes its dates from today to the horizon.
    const weekly = await run<{ plans: { dates: number }[] }>(
      "x.rostering.planCheck",
      {
        plans: [
          { account: null, weekdays: ["mon"], time: "06:00", length: 60, firstDate: localDate(0) },
        ],
        horizonDays: 28,
      },
      staff(),
    );
    expect(weekly.plans[0]?.dates).toBeGreaterThanOrEqual(4);
    expect(weekly.plans[0]?.dates).toBeLessThanOrEqual(5);
    // A person's only: it reads people's time off.
    const error = await refusal(
      run(
        "x.rostering.planCheck",
        { plans: [{ account: null, date: far, time: "10:00", length: 60 }] },
        staff({ actor: "assistant", origin: { surface: "assistant" } }),
      ),
    );
    expect(error.code).toBe("forbidden");
  });

  it("refuses a date that is not on the calendar, saying so", async () => {
    for (const plan of [
      { account: null, date: "2026-02-30", time: "10:00", length: 60 },
      { account: null, weekdays: ["mon"], time: "06:00", length: 60, firstDate: "2026-13-01" },
      {
        account: null,
        weekdays: ["mon"],
        time: "06:00",
        length: 60,
        firstDate: localDate(0),
        lastDate: "2026-04-31",
      },
    ]) {
      const error = await refusal(run("x.rostering.planCheck", { plans: [plan] }, staff()));
      expect(error.message).toMatch(/is not a real date/);
    }
  });
});

// --- pay's people ---------------------------------------------------------------------------------

describe("who is counted, everyone (x.rostering.payBases)", () => {
  it("with everyone, lists active staff with no basis set as not counted", async () => {
    const fresh = await account(unique("Fresh Flo"), "member");
    const some = await run<{ items: { account: string }[] }>("x.rostering.payBases", {}, staff());
    expect(some.items.map((i) => i.account)).not.toContain(fresh.id);
    const all = await run<{ items: { account: string; basis: string; history: unknown[] }[] }>(
      "x.rostering.payBases",
      { everyone: true },
      staff(),
    );
    expect(all.items.find((i) => i.account === fresh.id)).toMatchObject({
      basis: "not_counted",
      history: [],
    });
  });
});

// --- What one call reads (ADR 0629: a D1 call runs at most 1,000 queries) -------------------------

/** How many statements `call` prepares against D1 (each query is one). */
async function queriesOf(
  call: () => Promise<unknown>,
): Promise<{ queries: number; outcome: string }> {
  const d1 = env.DB as unknown as { prepare: (...a: unknown[]) => unknown };
  const prepare = d1.prepare.bind(d1);
  let queries = 0;
  d1.prepare = (...a: unknown[]) => {
    queries++;
    return prepare(...a);
  };
  try {
    const outcome = await call().then(
      () => "ok",
      (e: { code?: string }) => String(e.code),
    );
    return { queries, outcome };
  } finally {
    d1.prepare = prepare;
  }
}

/** Well under D1's 1,000 a call, for the largest input each takes. */
const CEILING = 250;

describe("what one call reads, at the largest input (ADR 0629)", () => {
  it("planCheck, candidates, patterns, week, people and payBases each stay well under D1's limit", async () => {
    // A business's worth of staff and patterns, every one on the plans.
    const staffers: ActingUser[] = [];
    for (let i = 0; i < 110; i++) staffers.push(await account(`Load ${i} ${unique("")}`, "member"));
    for (let i = 0; i < 40; i++) {
      await create(SERIES, {
        duty,
        weekdays: ["mon", "thu"],
        time: "02:00",
        length: 15,
        firstDate: localDate(200 * DAY),
        lastDate: localDate(240 * DAY),
        timezone: ZONE,
        staff: staffers[i]?.id,
      });
    }
    // The largest plan check: 20,000 dated shifts, 200 plans of 100 days, every plan its own person.
    const plans = Array.from({ length: 200 }, (_, i) => ({
      account: staffers[i % staffers.length]?.id ?? null,
      kind: { object: DUTY, id: duty },
      weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      time: `${String(i % 24).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
      length: 30,
      firstDate: localDate(0),
    }));
    const plan = await queriesOf(() =>
      run("x.rostering.planCheck", { plans, horizonDays: 99 }, staff()),
    );
    expect(plan.outcome).toBe("ok");
    expect(plan.queries).toBeLessThan(CEILING);
    // One more date than the budget is refused, never cut short.
    const over = await refusal(
      run("x.rostering.planCheck", { plans: [...plans, plans[0]], horizonDays: 99 }, staff()),
    );
    expect(JSON.stringify(over)).toContain("too_large");
    const s = await dutyShift(62 * DAY, null);
    for (const [label, call] of [
      ["candidates", () => run("x.rostering.candidates", { object: SHIFT, id: s }, staff())],
      ["patterns", () => run("x.rostering.patterns", {}, staff())],
      [
        "week",
        () => run("x.rostering.week", { from: localDate(0), to: localDate(61 * DAY) }, staff()),
      ],
      ["people", () => run("x.rostering.people", {}, staff())],
      ["payBases", () => run("x.rostering.payBases", { everyone: true }, staff())],
    ] as const) {
      const counted = await queriesOf(call);
      expect([label, counted.outcome]).toEqual([label, "ok"]);
      expect([label, counted.queries < CEILING]).toEqual([label, true]);
    }
  }, 240_000);
});

// --- The operations' own guards (not only the tools' permissions) ---------------------------------

describe("each screen operation guards itself, whoever's tool calls it", () => {
  it("another shipped pack's open tool calling it for a member is refused: only someone who rosters", async () => {
    const member = await account(unique("Guarded Mo"), "member");
    const s = await dutyShift(63 * DAY, null);
    const inputs: Record<(typeof RELAYED)[number], unknown> = {
      candidates: { object: SHIFT, id: s },
      people: {},
      patterns: {},
      setPattern: { object: SERIES, id: "missing", account: null },
      follow: { object: SHIFT, id: s },
      planCheck: {
        plans: [{ account: null, date: localDate(64 * DAY), time: "10:00", length: 30 }],
      },
    };
    for (const name of RELAYED) {
      const error = await refusal(run(`x.staffrelay.${name}`, inputs[name], asUser(member)));
      expect([name, JSON.stringify(error)]).toEqual([
        name,
        expect.stringContaining('"rule":"rostering"'),
      ]);
    }
  });

  it("an admin's call through a tool that asks nobody to approve it: setPattern and follow are a person's to apply", async () => {
    const s = await dutyShift(65 * DAY, null);
    for (const [name, input] of [
      ["setPattern", { object: SERIES, id: "missing", account: null }],
      ["follow", { object: SHIFT, id: s }],
    ] as const) {
      const error = await refusal(run(`x.staffrelay.${name}`, input, staff()));
      expect([name, JSON.stringify(error)]).toEqual([
        name,
        expect.stringContaining('"rule":"person_applies"'),
      ]);
    }
  });
});

// --- An assistant never learns who is away (ADR 0629) -----------------------------------------------

describe("who is away is a person's to read", () => {
  it("candidates, week and check give an assistant acting for a rosterer no unavailable warning; a person sees it", async () => {
    const away = await account(unique("Away Ari"), "member");
    const at = 66 * DAY + 3 * HOUR;
    const shift = await dutyShift(at, away.id);
    await run(
      "x.rostering.awayFor",
      {
        account: away.id,
        kind: "leave",
        startsAt: `${localDate(at - DAY)}T00:00`,
        endsAt: `${localDate(at + DAY)}T23:00`,
      },
      staff(),
    );
    const ai = staff({ actor: "assistant", origin: { surface: "assistant" } });
    const codes = (out: unknown) => JSON.stringify(out).includes('"unavailable"');
    const week = { from: localDate(at), to: localDate(at) };
    expect(codes(await run("x.rostering.week", week, staff()))).toBe(true);
    expect(codes(await run("x.rostering.week", week, ai))).toBe(false);
    expect(codes(await run("x.rostering.check", { object: SHIFT, id: shift }, staff()))).toBe(true);
    expect(codes(await run("x.rostering.check", { object: SHIFT, id: shift }, ai))).toBe(false);
    const other = await dutyShift(at + 30 * MINUTE, null);
    expect(codes(await run("x.rostering.candidates", { object: SHIFT, id: other }, staff()))).toBe(
      true,
    );
    expect(codes(await run("x.rostering.candidates", { object: SHIFT, id: other }, ai))).toBe(
      false,
    );
  });
});

// --- setPattern's dates and ended patterns -----------------------------------------------------------

describe("changing a pattern from a date", () => {
  it("refuses a date that is not real, a past date, and an ended pattern", async () => {
    const series = await create(SERIES, {
      duty,
      weekdays: ["sun"],
      time: "03:00",
      length: 15,
      firstDate: localDate(70 * DAY),
      timezone: ZONE,
    });
    const at = (from: string) =>
      refusal(
        run("x.rostering.setPattern", { object: SERIES, id: series, account: null, from }, staff()),
      );
    expect(JSON.stringify(await at("2026-02-30"))).toContain("not a real date");
    expect(JSON.stringify(await at("2000-01-01"))).toContain('"rule":"past"');
    await run("record.update", { object: SERIES, id: series, values: { state: "ended" } }, staff());
    expect(
      JSON.stringify(
        await refusal(
          run("x.rostering.setPattern", { object: SERIES, id: series, account: null }, staff()),
        ),
      ),
    ).toContain("pattern_ended");
  });
});

// --- one person's roster past the limit of one kind ------------------------------------------------

describe("one person's roster in a busy range (x.rostering.mine)", () => {
  it("keeps their own later shifts when more than 1,000 of others' come first", async () => {
    const who = await fixedRole(unique("Late Lou"), "rostering.team");
    const day = 300 * DAY;
    // 1,001 shifts with nobody on them in the morning, then theirs in the evening.
    for (let made = 0; made < 1001; made += 50) {
      const records = Array.from({ length: Math.min(50, 1001 - made) }, (_, i) => {
        const startsAt = new Date(Date.now() + day + (made + i) * 1000).toISOString();
        return {
          duty,
          startsAt,
          endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
          timezone: ZONE,
        };
      });
      await run("record.createMany", { object: SHIFT, records }, staff());
    }
    const theirs = await dutyShift(day + 10 * HOUR, who.id);
    const week = await run<{ shifts: { id: string }[]; truncated: boolean }>(
      "x.rostering.mine",
      { from: localDate(day - DAY), to: localDate(day + DAY) },
      asUser(who),
    );
    expect(week.shifts.map((s) => s.id)).toEqual([theirs]);
    expect(week.truncated).toBe(false);
  }, 120_000);
});
