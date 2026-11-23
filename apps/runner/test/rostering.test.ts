// Stage 45 step 4 (ADRs 0625 and 0626): restricted pack permissions, the `rostering.team` role and
// the Rostering pack, on the shipped packs (Programs, Bookings, Rostering) in the real host and
// sandbox, where a tool's own operation calls act as the extension's account and the person is the
// tool's verified caller.
//
// The acceptance criteria of this step: 6 (the coach's reach: the roster through the grant, the
// role's today unchanged, nothing of bookings or members), 7 (the team role is refused everything
// but its tools), 8 (restricted permissions: a member is refused the rosterers' tools until an
// admin grants them, an admin holds them, an assistant never reaches a person's tool whatever is
// granted, and its `assign` waits for a person), and the part of 3 the pack owns (a duty series
// fills the horizon, which its setting sets). Also: who grants (a human admin, never oneself, never
// an AI), what a fixed-role account may be given, a restricted tool out of another extension's
// reach, a runtime extension refused the declarations, rosterers by grant told and warned, and
// Bookings' coach fields a person's to change.
//
// Clocks: a tool's own calls read the real clock, so shifts are placed from now.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type AnyOperation,
  coreRegistry,
  type ExtensionHost,
  type InvocationContext,
  invokeByName,
  loadExtensionOperations,
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
const OURS = new Set(Object.keys(files));

const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    { id: "programs", version: "0.1.0" },
    { id: "bookings", version: "0.1.0" },
    { id: "rostering", version: "0.1.0" },
    { id: "rosterrelay", version: "0.1.0" },
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
const SHIFT = "rostering.shift";
const DUTY = "rostering.duty";
const SERIES = "rostering.dutyseries";
const MANAGE = "rostering:manage";
const ROSTER = "rostering:roster";

/** The team's tools: what the team role, or the grant `rostering:roster`, opens. */
const TEAM_TOOLS = [
  "me",
  "week",
  "mine",
  "offers",
  "offer",
  "withdraw",
  "take",
  "away",
  "back",
  "myAway",
].map((t) => `x.rostering.${t}`);
/** The rosterers' tools: restricted. */
const MANAGE_TOOLS = [
  "assign",
  "check",
  "qualify",
  "qualifications",
  "awayFor",
  "awayList",
  "uncovered",
  "markNotWorked",
  "candidates",
  "follow",
  "people",
  "patterns",
  "setPattern",
  "planCheck",
].map((t) => `x.rostering.${t}`);
/** Pay (step 6): restricted, and a person's only. */
const PAY = "rostering:pay";
const PAY_TOOLS = [
  "payBasis",
  "payBases",
  "periods",
  "periodTotals",
  "lock",
  "reopen",
  "export",
].map((t) => `x.rostering.${t}`);

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
/** A coach: the Bookings coach role, and a coach profile naming the account. */
async function coach(name: string): Promise<{ user: ActingUser; profile: string }> {
  const user = await fixedRole(name, "bookings.coach");
  const profile = await create("bookings.coach", { name, user: user.id });
  return { user, profile };
}
/** A one-off class starting `in` ms from now, an hour long, coached by `profile`. */
async function klass(inMs: number, profile: string | null): Promise<string> {
  const startsAt = new Date(Date.now() + inMs).toISOString();
  return create(CLASS, {
    classType: type,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
    timezone: ZONE,
    places: 10,
    ...(profile ? { coach: profile } : {}),
  });
}
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

/** Every operation in the registry that `ctx`'s account is not refused, called with no input. */
async function reach(ctx: InvocationContext): Promise<Set<string>> {
  const all: AnyOperation[] = [
    ...coreRegistry.list(),
    ...(await loadExtensionOperations(db.query)),
  ];
  const open = new Set<string>();
  for (const op of all) {
    const outcome = await run(op.name, {}, ctx).then(
      () => ({ code: "ran" }),
      (e: { code?: string }) => ({ code: e.code ?? "error" }),
    );
    // A staff-facing operation answers `forbidden`; one open to customers or the public only, or
    // a tool-only one, does not exist for staff at all.
    if (outcome.code !== "forbidden" && outcome.code !== "unknown_operation") open.add(op.name);
  }
  return open;
}

async function noticesFor(user: ActingUser, since: string) {
  const rows = await env.DB.prepare(
    "SELECT title, body FROM core_notifications WHERE user_id = ? AND created_at >= ? ORDER BY created_at",
  )
    .bind(user.id, since)
    .all<{ title: string; body: string | null }>();
  return rows.results;
}

let type: string;
let duty: string;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await refreshSchemaRegistry(db.query);
  for (const id of ["programs", "bookings", "rostering", "rosterrelay"]) {
    await run("extension.install", { id, shipped: true }, staff());
  }
  await refreshSchemaRegistry(db.query);
  await run("settings.update", { timezone: ZONE }, staff()).catch(() => undefined);
  type = await create("programs.classtype", { name: unique("Strength") });
  duty = await create(DUTY, { name: unique("Cleaning"), place: "Main floor" });
}, 120_000);

// --- Criterion 3 (the pack's part): a duty series fills the horizon ---------------------------

describe("duty series and duty shifts", () => {
  it("a duty series makes its shifts with its regular person for the horizon, which its setting sets", async () => {
    const cleaner = await fixedRole("Cleaner Pat", "rostering.team");
    const now = new Date();
    const first = localDate(DAY);
    const series = await create(SERIES, {
      duty,
      weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      time: "18:00",
      length: 60,
      firstDate: first,
      timezone: ZONE,
      staff: cleaner.id,
    });
    const generate = async () => {
      for (let i = 0; i < 20; i++) {
        const out = await run<{ more: boolean }>(
          "recurring.generate",
          { object: SERIES, id: series },
          staff({ actor: "automation", clock: () => now }),
        );
        if (!out.more) break;
      }
    };
    const made = async () =>
      (
        await run<{ items: { values: Record<string, unknown> }[] }>(
          "record.list",
          { object: SHIFT, filter: { field: "series", op: "eq", value: series }, limit: 200 },
          staff(),
        )
      ).items;
    await generate();
    const eight = await made();
    // Every day from tomorrow for 8 weeks (56 days ahead of today), each the cleaner's.
    expect(eight.length).toBeGreaterThanOrEqual(55);
    expect(eight.length).toBeLessThanOrEqual(57);
    expect(eight.every((s) => s.values.staff === cleaner.id)).toBe(true);
    // The setting reaches further: 70 days.
    await run(
      "extensionSettings.update",
      { extension: "rostering", values: { dutyHorizonDays: 70 } },
      staff(),
    );
    try {
      await generate();
      expect((await made()).length).toBeGreaterThanOrEqual(69);
    } finally {
      await run(
        "extensionSettings.update",
        { extension: "rostering", values: { dutyHorizonDays: null } },
        staff(),
      );
    }
    // The cleaner's roster shows them, through the team role's tools only.
    const mine = await run<{ shifts: { id: string; mine: boolean; title: string }[] }>(
      "x.rostering.mine",
      {},
      asUser(cleaner),
    );
    expect(mine.shifts.length).toBeGreaterThan(20);
    expect(mine.shifts.every((s) => s.mine)).toBe(true);
    await run("record.update", { object: SERIES, id: series, values: { state: "ended" } }, staff());
  }, 120_000);

  it("one person is never on a class and a duty at once, whoever writes", async () => {
    const { user, profile } = await coach("Coach Double");
    const at = 9 * DAY + 3 * HOUR;
    await klass(at, profile);
    const error = await refusal(dutyShift(at + 30 * MINUTE, user.id));
    expect(error.code).toBe("conflict");
    expect(error.details?.rule).toBe("double_booked");
    // Back to back is fine.
    await dutyShift(at + HOUR, user.id);
  });
});

// --- Criterion 6: the coach's reach -----------------------------------------------------------

describe("the coach's reach (criterion 6)", () => {
  it("with rostering:roster a coach reads every future shift and their own, offers and takes, and still reaches class lists only today", async () => {
    const kim = await coach("Coach Kim");
    const lee = await coach("Coach Lee");
    // Kim cannot read the roster until an admin grants it.
    expect((await refusal(run("x.rostering.week", {}, asUser(kim.user)))).code).toBe("forbidden");
    await grant(kim.user, [ROSTER]);
    await grant(lee.user, [ROSTER]);
    // Both may coach the class type (an admin, a rosterer, applies it).
    for (const who of [kim, lee]) {
      await run(
        "x.rostering.qualify",
        { account: who.user.id, kind: { object: "programs.classtype", id: type } },
        staff(),
      );
    }
    const ahead = await klass(5 * DAY, kim.profile);
    // A member booked on it (a walk-in at the desk): never on the roster.
    const walkIn = await run<{ bookingId: string; personId: string }>(
      "x.bookings.bookFor",
      { classId: ahead, newPerson: { givenName: unique("Walkin") }, paidAtDesk: true },
      staff(),
    );
    const week = await run<{ shifts: Record<string, unknown>[] }>(
      "x.rostering.week",
      { from: localDate(0), to: localDate(14 * DAY) },
      asUser(kim.user),
    );
    const row = week.shifts.find((s) => s.id === ahead);
    expect(row).toMatchObject({ object: CLASS, mine: true, name: "Coach Kim", warnings: null });
    const text = JSON.stringify(week);
    expect(text).not.toContain(walkIn.bookingId);
    expect(text).not.toContain(walkIn.personId);
    expect(text).not.toMatch(/"(places|taken|available|bookings?)"/);
    const mine = await run<{ shifts: { id: string }[] }>("x.rostering.mine", {}, asUser(kim.user));
    expect(mine.shifts.map((s) => s.id)).toContain(ahead);
    // The coach role's own reach is unchanged: another day's list and class are not found.
    expect(
      JSON.stringify(await refusal(run("x.bookings.roster", { classId: ahead }, asUser(kim.user)))),
    ).toContain("not_found");
    expect(
      (await refusal(run("record.get", { object: CLASS, id: ahead }, asUser(kim.user)))).code,
    ).toBe("not_found");
    // Kim offers it; Lee sees it and takes it; nobody approves; the shift is Lee's.
    const since = new Date().toISOString();
    const offered = await run<{ offer: { id: string } }>(
      "x.rostering.offer",
      { object: CLASS, id: ahead },
      asUser(kim.user),
    );
    const open = await run<{ open: { id: string }[] }>("x.rostering.offers", {}, asUser(lee.user));
    expect(open.open.map((o) => o.id)).toContain(offered.offer.id);
    await run("x.rostering.take", { offer: offered.offer.id }, asUser(lee.user));
    expect((await get(CLASS, ahead)).coach).toBe(lee.profile);
    // Made for the people who called the tools, never the extension's own account.
    const row2 = await env.DB.prepare(
      "SELECT from_account, made_by, taken_by, state FROM core_staff_offer WHERE id = ?",
    )
      .bind(offered.offer.id)
      .first();
    expect(row2).toEqual({
      from_account: kim.user.id,
      made_by: kim.user.id,
      taken_by: lee.user.id,
      state: "taken",
    });
    // The manager is told, not asked; the offerer is told who took it.
    expect((await noticesFor(admin, since)).map((n) => n.title).join("\n")).toContain(
      "Coach Lee took a shift",
    );
    expect((await noticesFor(kim.user, since)).map((n) => n.title).join("\n")).toContain(
      "Coach Lee took your shift",
    );
  });

  it("a registry walk of a coach's account, before and after the grant, differs only by Rostering's team tools", async () => {
    const { user } = await coach("Coach Walk");
    const before = await reach(asUser(user));
    await grant(user, [ROSTER]);
    const after = await reach(asUser(user));
    const added = [...after].filter((n) => !before.has(n)).sort();
    const lost = [...before].filter((n) => !after.has(n));
    expect(lost).toEqual([]);
    expect(added).toEqual([...TEAM_TOOLS].sort());
  }, 240_000);
});

// --- Criterion 7: the team role ---------------------------------------------------------------

describe("the team role (criterion 7)", () => {
  it("is refused every operation in the registry but Rostering's team tools", async () => {
    const cleaner = await fixedRole("Cleaner Walk", "rostering.team");
    const open = await reach(asUser(cleaner));
    expect([...open].sort()).toEqual([...TEAM_TOOLS].sort());
    // No record read, not even of Rostering's own objects.
    for (const object of [SHIFT, DUTY, SERIES, CLASS, "person"]) {
      expect((await refusal(run("record.list", { object }, asUser(cleaner)))).code, object).toBe(
        "forbidden",
      );
    }
  }, 240_000);

  it("sees the roster and adds leave; the rosterers are told, other staff never learn it", async () => {
    const cleaner = await fixedRole("Cleaner Jo", "rostering.team");
    const colleague = await account("Colleague", "member");
    const shift = await dutyShift(11 * DAY, cleaner.id);
    const since = new Date().toISOString();
    const away = await run<{ count: number; shifts: { id: string }[] }>(
      "x.rostering.away",
      {
        kind: "leave",
        note: "A private reason",
        startsAt: `${localDate(10 * DAY)}T00:00`,
        endsAt: `${localDate(13 * DAY)}T00:00`,
      },
      asUser(cleaner),
    );
    expect(away.shifts.map((s) => s.id)).toContain(shift);
    // An admin (a rosterer) is told; the colleague is not, and their roster shows no warning.
    expect((await noticesFor(admin, since)).map((n) => n.title).join("\n")).toContain(
      "Cleaner Jo is away",
    );
    const theirs = await run<{ shifts: { id: string; warnings: unknown }[] }>(
      "x.rostering.week",
      { from: localDate(10 * DAY), to: localDate(12 * DAY) },
      asUser(colleague),
    );
    expect(theirs.shifts.find((s) => s.id === shift)?.warnings).toBeNull();
    const rosterers = await run<{ shifts: { id: string; warnings: { code: string }[] }[] }>(
      "x.rostering.week",
      { from: localDate(10 * DAY), to: localDate(12 * DAY) },
      staff(),
    );
    expect(rosterers.shifts.find((s) => s.id === shift)?.warnings.map((w) => w.code)).toContain(
      "unavailable",
    );
    // Their own time off, with the note; nobody else's.
    const mine = await run<{ items: { note: string | null }[] }>(
      "x.rostering.myAway",
      {},
      asUser(cleaner),
    );
    expect(mine.items.map((i) => i.note)).toContain("A private reason");
    // An assistant acting for them reads the times, never the note.
    const asAi = await run<{ items: { note: string | null }[] }>(
      "x.rostering.myAway",
      {},
      asUser(cleaner, { actor: "assistant", origin: { surface: "assistant" } }),
    );
    expect(asAi.items.length).toBe(mine.items.length);
    expect(asAi.items.every((i) => i.note === null)).toBe(true);
    expect((await refusal(run("x.rostering.awayList", {}, asUser(colleague)))).code).toBe(
      "forbidden",
    );
    // The note never reaches the audit log.
    const audit = await env.DB.prepare(
      "SELECT operation FROM core_audit WHERE input LIKE '%A private reason%' OR result LIKE '%A private reason%' OR error LIKE '%A private reason%'",
    ).all<{ operation: string }>();
    expect(audit.results).toEqual([]);
    const called = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit WHERE operation = 'x.rostering.away' AND user_id = ?",
    )
      .bind(cleaner.id)
      .first<{ n: number }>();
    expect(called?.n).toBe(1);
  });
});

// --- Criterion 8: restricted permissions -------------------------------------------------------

describe("restricted permissions (criterion 8, ADR 0625)", () => {
  it("a member is refused every rosterers' tool until granted; an admin holds them", async () => {
    const member = await account("Member Max", "member");
    const viewer = await account("Viewer Val", "viewer");
    const shift = await dutyShift(12 * DAY, null);
    const inputs: Record<string, unknown> = {
      "x.rostering.assign": { object: SHIFT, id: shift, account: member.id },
      "x.rostering.check": { object: SHIFT, id: shift },
      "x.rostering.qualify": { account: member.id, kind: { object: DUTY, id: duty } },
      "x.rostering.qualifications": {},
      "x.rostering.awayFor": {
        account: member.id,
        kind: "leave",
        startsAt: `${localDate(20 * DAY)}T00:00`,
        endsAt: `${localDate(21 * DAY)}T00:00`,
      },
      "x.rostering.awayList": {},
      "x.rostering.uncovered": {},
      "x.rostering.markNotWorked": { object: SHIFT, id: shift, reason: "Not here" },
      "x.rostering.candidates": { object: SHIFT, id: shift },
      "x.rostering.follow": { object: SHIFT, id: shift },
      "x.rostering.people": {},
      "x.rostering.patterns": {},
      "x.rostering.setPattern": { object: SERIES, id: "missing", account: null },
      "x.rostering.planCheck": {
        plans: [{ account: member.id, date: localDate(30 * DAY), time: "06:00", length: 60 }],
      },
    };
    for (const name of MANAGE_TOOLS) {
      for (const who of [member, viewer]) {
        const error = await refusal(run(name, inputs[name], asUser(who)));
        expect([name, who.role, error.code]).toEqual([name, who.role, "forbidden"]);
      }
    }
    // The member still holds the team's tools (a tool permission only adds a way in).
    await run("x.rostering.week", {}, asUser(member));
    // An admin holds them.
    const listed = await run<{ items: { id: string }[] }>("x.rostering.uncovered", {}, staff());
    expect(listed.items.map((i) => i.id)).toContain(shift);
    // Granted by a human admin, the member holds them, and is a rosterer: told and warned.
    await grant(member, [MANAGE]);
    await run("x.rostering.uncovered", {}, asUser(member));
    await run("x.rostering.assign", inputs["x.rostering.assign"], asUser(member));
    expect((await get(SHIFT, shift)).staff).toBe(member.id);
    // Taken away, the next call is refused.
    await grant(member, []);
    expect((await refusal(run("x.rostering.uncovered", {}, asUser(member)))).code).toBe(
      "forbidden",
    );
  });

  it("an assistant never makes a person's call, whatever is granted; its assign waits for a person", async () => {
    const granted = await account("Granted Gus", "member");
    await grant(granted, [MANAGE]);
    const shift = await dutyShift(13 * DAY, null);
    for (const actor of ["assistant", "mcp"] as const) {
      const ctx = asUser(granted, {
        actor,
        origin: { surface: actor === "mcp" ? "mcp" : "assistant" },
      });
      // Everyone's time off, and saying someone is away: a person's.
      expect((await refusal(run("x.rostering.awayList", {}, ctx))).code).toBe("forbidden");
      expect(
        (
          await refusal(
            run(
              "x.rostering.awayFor",
              {
                account: granted.id,
                kind: "leave",
                startsAt: `${localDate(20 * DAY)}T00:00`,
                endsAt: `${localDate(21 * DAY)}T00:00`,
              },
              ctx,
            ),
          )
        ).code,
      ).toBe("forbidden");
      // A roster change waits for a person.
      expect(
        (
          await refusal(
            run("x.rostering.assign", { object: SHIFT, id: shift, account: granted.id }, ctx),
          )
        ).code,
      ).toBe("pending_approval");
      // Reads are applied.
      await run("x.rostering.uncovered", {}, ctx);
    }
    expect((await get(SHIFT, shift)).staff ?? null).toBeNull();
    // A member without the grant gets nothing by asking through an assistant either.
    const plain = await account("Plain Pia", "member");
    expect(
      (
        await refusal(
          run(
            "x.rostering.uncovered",
            {},
            asUser(plain, { actor: "assistant", origin: { surface: "assistant" } }),
          ),
        )
      ).code,
    ).toBe("forbidden");
  });

  it("only a human admin grants it: never oneself, never an assistant or MCP, never a member", async () => {
    const member = await account("Member Mo", "member");
    // An admin cannot grant it to their own account (they would keep it once made a member).
    expect(
      (await refusal(run("user.setPermissions", { id: admin.id, permissions: [MANAGE] }, staff())))
        .code,
    ).toBe("forbidden");
    expect(
      (
        await refusal(
          run(
            "user.setPermissions",
            { id: member.id, permissions: [MANAGE] },
            staff({ actor: "assistant", origin: { surface: "assistant" } }),
          ),
        )
      ).code,
    ).toBe("forbidden");
    expect(
      (
        await refusal(
          run(
            "user.setPermissions",
            { id: member.id, permissions: [MANAGE] },
            staff({ actor: "mcp", origin: { surface: "mcp" } }),
          ),
        )
      ).code,
    ).toBe("forbidden");
    expect(
      (
        await refusal(
          run("user.setPermissions", { id: member.id, permissions: [MANAGE] }, asUser(member)),
        )
      ).code,
    ).toBe("forbidden");
    // The list says which are restricted.
    const list = await run<{ items: { permission: string; restricted: boolean }[] }>(
      "user.grantablePermissions",
      {},
      staff(),
    );
    expect(list.items.find((i) => i.permission === MANAGE)?.restricted).toBe(true);
    expect(list.items.find((i) => i.permission === ROSTER)?.restricted).toBe(false);
  });

  it("a fixed-role account may be granted the rosterers' permission, never a core one", async () => {
    const coachAcct = await coach("Coach Rosters");
    await grant(coachAcct.user, [ROSTER, MANAGE]);
    await run("x.rostering.uncovered", {}, asUser(coachAcct.user));
    expect(
      (
        await refusal(
          run(
            "user.setPermissions",
            { id: coachAcct.user.id, permissions: [MANAGE, "orders:refund"] },
            staff(),
          ),
        )
      ).code,
    ).toBe("invalid_input");
    // Still nothing of what the coach role does not reach.
    expect((await refusal(run("person.list", {}, asUser(coachAcct.user)))).code).toBe("forbidden");
  });

  it("is never reached from another extension's code, whoever called it", async () => {
    // An admin holds the restricted tool, but a run of another pack's tool cannot call it for them.
    const error = await refusal(run("x.rosterrelay.relay", {}, staff()));
    expect(JSON.stringify(error)).toContain("forbidden");
  });

  it("a runtime extension may not declare a restricted permission or the roster's rules", async () => {
    const tool = `relay: defineTool({ description: "Runtime fixture tool with a permission.", input: z.object({}), output: z.object({}), risk: "read", permission: "rogue:pay", handler: async () => ({}) }),`;
    const source = (
      extra: string,
    ) => `import { defineExtension, defineTool, z } from "@composable-os/sdk";
export default defineExtension({
  id: "rogue",
  version: "0.1.0",
  contractVersion: 1,
  objects: {},
  ${extra}
  tools: { ${tool} },
});
`;
    for (const extra of [
      `restricted: ["rogue:pay"],`,
      `restricted: ["rogue:pay"], staffing: { rosters: "rogue:pay" },`,
    ]) {
      const out = await run<{ ok: boolean; issues: { code: string; path: string }[] }>(
        "extension.check",
        { id: "rogue", files: { "index.ts": source(extra) } },
        staff(),
      );
      expect(out.issues.some((i) => i.code === "outside_audience" && i.path === "restricted")).toBe(
        true,
      );
    }
  });
});

// --- Bookings' additions --------------------------------------------------------------------------

describe("Bookings' coach fields are a person's to change (ADR 0626)", () => {
  it("an assistant's swap of a class's or a series' coach waits for a person; a person's is made", async () => {
    const { profile } = await coach("Coach Swap");
    const other = await coach("Coach Other");
    const k = await klass(15 * DAY, profile);
    const ai = staff({ actor: "assistant", origin: { surface: "assistant" } });
    expect(
      (
        await refusal(
          run("record.update", { object: CLASS, id: k, values: { coach: other.profile } }, ai),
        )
      ).code,
    ).toBe("pending_approval");
    expect((await get(CLASS, k)).coach).toBe(profile);
    // The other fields are not: an assistant's note on the class is made.
    await run("record.update", { object: CLASS, id: k, values: { notes: "Bring water" } }, ai);
    await run("record.update", { object: CLASS, id: k, values: { coach: other.profile } }, staff());
    expect((await get(CLASS, k)).coach).toBe(other.profile);
  });
});

// --- The review of PR #284 ---------------------------------------------------------------------

/** Whether a call was refused because only a rosterer may say who works a shift. */
async function rosteringRefusal(promise: Promise<unknown>) {
  const error = await refusal(promise);
  expect([error.code, error.details?.rule]).toEqual(["forbidden", "rostering"]);
}

describe("who works a shift is a rosterer's to say, by every path (the review of PR #284, ADR 0626)", () => {
  let member: ActingUser;
  let viewer: ActingUser;
  let coachUser: ActingUser;
  let rosterer: ActingUser;
  let victim: ActingUser;
  beforeAll(async () => {
    member = await account("Member Rex", "member");
    viewer = await account("Viewer Vi", "viewer");
    coachUser = (await coach("Coach Pat")).user;
    rosterer = await account("Rosterer Ro", "member");
    await grant(rosterer, [MANAGE]);
    victim = await account("Victim Vic", "member");
  });
  const shiftValues = (inMs: number, staffId: string | null) => {
    const startsAt = new Date(Date.now() + inMs).toISOString();
    return {
      duty,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
      timezone: ZONE,
      ...(staffId ? { staff: staffId } : {}),
    };
  };

  it("a duty shift's person by record.update and record.create: refused to a member, a viewer and a coach; made by a rosterer and an admin", async () => {
    let at = 30 * DAY;
    const next = () => {
      at += 3 * HOUR;
      return at;
    };
    for (const who of [member, viewer, coachUser]) {
      const shift = await dutyShift(next(), null);
      const error = await refusal(
        run(
          "record.update",
          { object: SHIFT, id: shift, values: { staff: victim.id } },
          asUser(who),
        ),
      );
      expect(error.code, who.name).toBe("forbidden");
      expect((await get(SHIFT, shift)).staff ?? null).toBeNull();
    }
    // A member: refused for the rosterers' reason, on themselves too, and on a create.
    const open = await dutyShift(next(), null);
    await rosteringRefusal(
      run(
        "record.update",
        { object: SHIFT, id: open, values: { staff: victim.id } },
        asUser(member),
      ),
    );
    await rosteringRefusal(
      run(
        "record.update",
        { object: SHIFT, id: open, values: { staff: member.id } },
        asUser(member),
      ),
    );
    await rosteringRefusal(
      run(
        "record.create",
        { object: SHIFT, values: shiftValues(next(), victim.id) },
        asUser(member),
      ),
    );
    // Creating one with nobody on it, and other fields of it, stay open to a member.
    const theirs = await run<{ id: string }>(
      "record.create",
      { object: SHIFT, values: shiftValues(next(), null) },
      asUser(member),
    );
    await run(
      "record.update",
      { object: SHIFT, id: theirs.id, values: { notes: "Mop" } },
      asUser(member),
    );
    // A rosterer by grant, and an admin.
    await run(
      "record.update",
      { object: SHIFT, id: open, values: { staff: victim.id } },
      asUser(rosterer),
    );
    expect((await get(SHIFT, open)).staff).toBe(victim.id);
    await run(
      "record.update",
      { object: SHIFT, id: theirs.id, values: { staff: victim.id } },
      staff(),
    );
    // Nor may a member take someone, or themselves, off: they offer it instead.
    await rosteringRefusal(
      run("record.update", { object: SHIFT, id: open, values: { staff: null } }, asUser(member)),
    );
    await rosteringRefusal(
      run("record.update", { object: SHIFT, id: open, values: { staff: null } }, asUser(victim)),
    );
  });

  it("record.createMany and record.import: refused to a member, made by a rosterer", async () => {
    await rosteringRefusal(
      run(
        "record.createMany",
        { object: SHIFT, records: [shiftValues(40 * DAY, victim.id)] },
        asUser(member),
      ),
    );
    const imported = await run(
      "record.import",
      {
        object: SHIFT,
        records: [{ key: unique("k"), values: shiftValues(40 * DAY + 2 * HOUR, victim.id) }],
      },
      asUser(member),
    ).catch((e: unknown) => e);
    expect(JSON.stringify(imported)).toMatch(/rosters|rostering/);
    expect(JSON.stringify(imported)).not.toContain('"created"');
    const made = await run<{ ids: string[] }>(
      "record.createMany",
      { object: SHIFT, records: [shiftValues(40 * DAY + 4 * HOUR, victim.id)] },
      asUser(rosterer),
    );
    expect(made.ids).toHaveLength(1);
  });

  it("a duty series' regular person, by record.create, record.update and recurring.change: a rosterer's", async () => {
    const values = {
      duty,
      weekdays: ["mon"],
      time: "05:00",
      length: 30,
      firstDate: localDate(60 * DAY),
      timezone: ZONE,
    };
    await rosteringRefusal(
      run(
        "record.create",
        { object: SERIES, values: { ...values, staff: victim.id } },
        asUser(member),
      ),
    );
    // With nobody on it, a member may make one; naming a person is a rosterer's.
    const series = await run<{ id: string }>(
      "record.create",
      { object: SERIES, values },
      asUser(member),
    );
    await rosteringRefusal(
      run(
        "record.update",
        { object: SERIES, id: series.id, values: { staff: victim.id } },
        asUser(member),
      ),
    );
    await rosteringRefusal(
      run(
        "recurring.change",
        { object: SERIES, id: series.id, values: { staff: victim.id }, confirm: 1 },
        asUser(member),
      ),
    );
    await run(
      "record.update",
      { object: SERIES, id: series.id, values: { staff: victim.id } },
      asUser(rosterer),
    );
    await run(
      "record.update",
      { object: SERIES, id: series.id, values: { state: "ended" } },
      staff(),
    );
  });

  it("recurring.follow back to the pattern's person: a rosterer's", async () => {
    const series = await create(SERIES, {
      duty,
      weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      time: "04:00",
      length: 20,
      firstDate: localDate(2 * DAY),
      lastDate: localDate(4 * DAY),
      timezone: ZONE,
      staff: victim.id,
    });
    await run("recurring.generate", { object: SERIES, id: series }, staff({ actor: "automation" }));
    const made = await run<{ items: { id: string }[] }>(
      "record.list",
      { object: SHIFT, filter: { field: "series", op: "eq", value: series }, limit: 5 },
      staff(),
    );
    const one = made.items[0]?.id as string;
    await run("record.update", { object: SHIFT, id: one, values: { staff: rosterer.id } }, staff());
    await rosteringRefusal(run("recurring.follow", { object: SHIFT, id: one }, asUser(member)));
    expect((await get(SHIFT, one)).staff).toBe(rosterer.id);
    await run("recurring.follow", { object: SHIFT, id: one }, asUser(rosterer));
    expect((await get(SHIFT, one)).staff).toBe(victim.id);
    await run("record.update", { object: SERIES, id: series, values: { state: "ended" } }, staff());
  });

  it("restoring a shift with its person from the Trash: a rosterer's", async () => {
    const shift = await dutyShift(70 * DAY, victim.id);
    await run("record.delete", { object: SHIFT, id: shift }, staff());
    await rosteringRefusal(run("record.restore", { object: SHIFT, id: shift }, asUser(member)));
    await run("record.restore", { object: SHIFT, id: shift }, asUser(rosterer));
    expect((await get(SHIFT, shift)).staff).toBe(victim.id);
  });

  it("Bookings with Rostering: a class's coach, and a coach profile's account, are a rosterer's", async () => {
    const a = await coach("Coach Ash");
    const classValues = (inMs: number) => ({
      classType: type,
      startsAt: new Date(Date.now() + inMs).toISOString(),
      endsAt: new Date(Date.now() + inMs + HOUR).toISOString(),
      timezone: ZONE,
      places: 10,
    });
    // A member makes a class with no coach, as before; naming one is a rosterer's.
    const k = await run<{ id: string }>(
      "record.create",
      { object: CLASS, values: classValues(33 * DAY) },
      asUser(member),
    );
    await rosteringRefusal(
      run(
        "record.update",
        { object: CLASS, id: k.id, values: { coach: a.profile } },
        asUser(member),
      ),
    );
    await rosteringRefusal(
      run(
        "record.create",
        { object: CLASS, values: { ...classValues(34 * DAY), coach: a.profile } },
        asUser(member),
      ),
    );
    await run(
      "record.update",
      { object: CLASS, id: k.id, values: { coach: a.profile } },
      asUser(rosterer),
    );
    // Giving a's profile to another account would put it on every class of the profile.
    const spare = await account("Spare Sam", "member");
    await rosteringRefusal(
      run(
        "record.update",
        { object: "bookings.coach", id: a.profile, values: { user: spare.id } },
        asUser(member),
      ),
    );
    // A new profile with an account is nobody's shift yet: open to whoever may write it.
    await run(
      "record.create",
      { object: "bookings.coach", values: { name: unique("Coach"), user: victim.id } },
      asUser(member),
    );
  });

  it("the host's own writes are not the caller's: a leaver is taken off their shifts", async () => {
    const leaver = await account("Leaver Lou", "member");
    const shift = await dutyShift(80 * DAY, leaver.id);
    const asked = await refusal(run("user.deactivate", { id: leaver.id }, staff()));
    const count = Number((asked.details as { count?: number } | undefined)?.count ?? 1);
    await run("user.deactivate", { id: leaver.id, confirm: count }, staff());
    expect((await get(SHIFT, shift)).staff ?? null).toBeNull();
  });
});

describe("an AI's roster change is approved only by someone who could make it (the review of PR #284)", () => {
  async function pendingId(promise: Promise<unknown>): Promise<string> {
    const e = await refusal(promise);
    expect(e.code).toBe("pending_approval");
    return (e.details as { actionId: string }).actionId;
  }
  const ai = (user: ActingUser) =>
    asUser(user, { actor: "assistant", origin: { surface: "assistant" } });

  it("a restricted tool's call: a member's approval is refused, a rosterer's applies", async () => {
    const proposer = await account("Proposer Pam", "member");
    await grant(proposer, [MANAGE]);
    const approver = await account("Approver Al", "member");
    await grant(approver, [MANAGE]);
    const target = await account("Target Tia", "member");
    const plain = await account("Plain Pete", "member");
    const shift = await dutyShift(90 * DAY, null);
    const id = await pendingId(
      run("x.rostering.assign", { object: SHIFT, id: shift, account: target.id }, ai(proposer)),
    );
    expect((await refusal(run("approval.approve", { actionIds: [id] }, asUser(plain)))).code).toBe(
      "forbidden",
    );
    expect((await get(SHIFT, shift)).staff ?? null).toBeNull();
    await run("approval.approve", { actionIds: [id] }, asUser(approver));
    expect((await get(SHIFT, shift)).staff).toBe(target.id);
  });

  it("revoking the proposer's grant still fails the apply, whoever approves", async () => {
    const proposer = await account("Proposer Pia", "member");
    await grant(proposer, [MANAGE]);
    const target = await account("Target Ty", "member");
    const shift = await dutyShift(91 * DAY, null);
    const id = await pendingId(
      run("x.rostering.assign", { object: SHIFT, id: shift, account: target.id }, ai(proposer)),
    );
    await grant(proposer, []);
    await run("approval.approve", { actionIds: [id] }, staff()).catch(() => undefined);
    expect((await get(SHIFT, shift)).staff ?? null).toBeNull();
  });

  it("an AI's change of a class's coach: a member's approval is refused, a rosterer's applies", async () => {
    const a = await coach("Coach Cy");
    const b = await coach("Coach Di");
    const k = await klass(35 * DAY, a.profile);
    const rosterer = await account("Rosterer Ray", "member");
    await grant(rosterer, [MANAGE]);
    const plain = await account("Plain Peg", "member");
    const id = await pendingId(
      run(
        "record.update",
        { object: CLASS, id: k, values: { coach: b.profile } },
        staff({ actor: "assistant", origin: { surface: "assistant" } }),
      ),
    );
    expect((await refusal(run("approval.approve", { actionIds: [id] }, asUser(plain)))).code).toBe(
      "forbidden",
    );
    expect((await get(CLASS, k)).coach).toBe(a.profile);
    await run("approval.approve", { actionIds: [id] }, asUser(rosterer));
    expect((await get(CLASS, k)).coach).toBe(b.profile);
  });
});

describe("a tool's caller is the person the host verified (ADR 0625)", () => {
  it("another pack's code, or an automation, calling a team tool is refused as no staff caller", async () => {
    const viaPack = await refusal(run("x.rosterrelay.weekRelay", {}, staff()));
    expect(JSON.stringify(viaPack)).toContain("staff_caller");
    const viaAutomation = await refusal(
      run(
        "x.rostering.week",
        {},
        staff({
          actor: "automation",
          origin: { surface: "automation", automationId: "fixture.probe" },
        }),
      ),
    );
    expect(JSON.stringify(viaAutomation)).toContain("staff_caller");
  });

  it("a runtime extension may not declare the roster's rules", async () => {
    const out = await run<{ issues: { code: string; path: string }[] }>(
      "extension.check",
      {
        id: "rogue",
        files: {
          "index.ts": `import { defineExtension } from "@composable-os/sdk";
export default defineExtension({ id: "rogue", version: "0.1.0", contractVersion: 1, objects: {}, staffing: { rosters: "rogue:x" } });
`,
        },
      },
      staff(),
    );
    expect(out.issues.some((i) => i.code === "outside_audience" && i.path === "staffing")).toBe(
      true,
    );
  });
});

// --- Pay (step 6, ADR 0627) -----------------------------------------------------------------------

describe("pay (step 6: criteria 8 and 10 on the shipped packs)", () => {
  const start = () => localDate(-28 * DAY);
  const inputs = (account: string): Record<string, unknown> => ({
    "x.rostering.payBasis": { account, basis: "by_time" },
    "x.rostering.payBases": {},
    "x.rostering.periods": {},
    "x.rostering.periodTotals": { start: start() },
    "x.rostering.lock": { start: start() },
    "x.rostering.reopen": { start: start(), reason: "A correction" },
    "x.rostering.export": { start: start() },
  });
  const setStart = () =>
    run(
      "extensionSettings.update",
      { extension: "rostering", values: { payPeriodStart: start() } },
      staff(),
    );

  it("a member, a viewer and a rosterer are refused every pay tool until granted pay; an AI always", async () => {
    await setStart();
    const member = await account("Member Pay", "member");
    const viewer = await account("Viewer Pay", "viewer");
    const rosterer = await account("Rosterer Pay", "member");
    await grant(rosterer, [MANAGE]);
    for (const name of PAY_TOOLS) {
      for (const who of [member, viewer, rosterer]) {
        const error = await refusal(run(name, inputs(who.id)[name], asUser(who)));
        expect([name, who.name, error.code]).toEqual([name, who.name, "forbidden"]);
      }
    }
    // An admin holds them; a member granted pay holds them.
    await run("x.rostering.periods", {}, staff());
    await grant(member, [PAY]);
    await run("x.rostering.periods", {}, asUser(member));
    await run("x.rostering.periodTotals", { start: start() }, asUser(member));
    // An assistant or an MCP client acting for an admin or a granted member: refused, every one.
    for (const who of [admin, member]) {
      for (const actor of ["assistant", "mcp"] as const) {
        const ctx = asUser(who, {
          actor,
          origin: { surface: actor === "mcp" ? "mcp" : "assistant" },
        });
        for (const name of PAY_TOOLS) {
          const error = await refusal(run(name, inputs(who.id)[name], ctx));
          expect([name, actor, error.code]).toEqual([name, actor, "forbidden"]);
        }
      }
    }
    // Marking a shift not worked: an assistant's request waits for a person.
    const shift = await dutyShift(-2 * HOUR, admin.id);
    const asked = await refusal(
      run(
        "x.rostering.markNotWorked",
        { object: SHIFT, id: shift, reason: "Not here" },
        staff({ actor: "assistant", origin: { surface: "assistant" } }),
      ),
    );
    expect(asked.code).toBe("pending_approval");
  });

  it("a class with set-up minutes is totalled, locked, exported and then kept", async () => {
    await setStart();
    const paid = await coach("Paid Coach Pat");
    const withSetup = await create("programs.classtype", {
      name: unique("Spin"),
      "bookings.rosterBeforeMinutes": 15,
      "bookings.rosterAfterMinutes": 5,
    });
    const startsAt = new Date(Date.now() - 20 * DAY).toISOString();
    const klassId = await create(CLASS, {
      classType: withSetup,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(),
      timezone: ZONE,
      places: 10,
      coach: paid.profile,
    });
    await run(
      "x.rostering.payBasis",
      { account: paid.user.id, basis: "by_class", from: localDate(-60 * DAY) },
      staff(),
    );
    type Totals = {
      totals: { account: string; shifts: number; minutes: number; hours: string }[];
      period: { locked: boolean };
    };
    const preview = await run<Totals>("x.rostering.periodTotals", { start: start() }, staff());
    expect(preview.period.locked).toBe(false);
    expect(preview.totals.find((t) => t.account === paid.user.id)).toMatchObject({
      shifts: 1,
      minutes: 80,
      hours: "1.33",
    });
    await run("x.rostering.lock", { start: start() }, staff());
    const locked = await run<Totals>("x.rostering.periodTotals", { start: start() }, staff());
    expect(locked.period.locked).toBe(true);
    const file = await run<{ csv: string; locked: boolean }>(
      "x.rostering.export",
      { start: start() },
      staff(),
    );
    expect(file.locked).toBe(true);
    expect(file.csv).toContain("Paid Coach Pat");
    expect(file.csv).not.toContain("PREVIEW");
    // The class is kept: its time is refused, for an admin too.
    const moved = await refusal(
      run(
        "record.update",
        {
          object: CLASS,
          id: klassId,
          values: { endsAt: new Date(Date.parse(startsAt) + 2 * HOUR).toISOString() },
        },
        staff(),
      ),
    );
    expect(moved.details?.rule).toBe("pay_period_locked");
    // Nothing of what it totals in the audit log: which period, and who.
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation LIKE 'staffing.pay%' OR operation LIKE 'x.rostering.%'",
    ).all<{ input: string | null; result: string | null }>();
    for (const r of audit.results) {
      expect(`${r.input} ${r.result}`).not.toMatch(/"minutes"|"hours"|by_class|"csv"/);
    }
    await run("x.rostering.reopen", { start: start(), reason: "Checked again" }, staff());
  });
});

// --- The review of PR #287 -----------------------------------------------------------------------

describe("a redacted input in the approval queue is read only by who could approve it", () => {
  it("why a shift was not worked: a viewer and a member see it redacted; a rosterer and an admin see it", async () => {
    const shift = await dutyShift(-30 * HOUR, admin.id);
    const asked = await refusal(
      run(
        "x.rostering.markNotWorked",
        { object: SHIFT, id: shift, reason: "A private reason" },
        staff({ actor: "assistant", origin: { surface: "assistant" } }),
      ),
    );
    expect(asked.code).toBe("pending_approval");
    const actionId = (asked.details as { actionId: string }).actionId;
    const row = await env.DB.prepare("SELECT change_set_id FROM core_pending_action WHERE id = ?")
      .bind(actionId)
      .first<{ change_set_id: string }>();
    const changeSetId = row?.change_set_id as string;
    const viewer = await account("Viewer Rex", "viewer");
    const member = await account("Member Rex", "member");
    const rosterer = await account("Rosterer Rex", "member");
    await grant(rosterer, [MANAGE]);
    const reads = async (user: ActingUser) => {
      const got = JSON.stringify(await run("approval.get", { changeSetId }, asUser(user)));
      const status = JSON.stringify(await run("approval.status", { actionId }, asUser(user)));
      const list = JSON.stringify(await run("approval.list", { status: "all" }, asUser(user)));
      expect(list).not.toContain("A private reason");
      expect(got.includes("A private reason")).toBe(status.includes("A private reason"));
      return got.includes("A private reason");
    };
    expect(await reads(viewer)).toBe(false);
    expect(await reads(member)).toBe(false);
    expect(await reads(rosterer)).toBe(true);
    expect(await reads(admin)).toBe(true);
    const redacted = await run<{ actions: { id: string; input: { reason?: unknown } }[] }>(
      "approval.get",
      { changeSetId },
      asUser(member),
    );
    expect(redacted.actions.find((a) => a.id === actionId)?.input.reason).toBe("[redacted]");
    // What the queue's notice says names nothing of it.
    const notices = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notifications WHERE title LIKE '%A private reason%' OR body LIKE '%A private reason%'",
    ).first<{ n: number }>();
    expect(notices?.n).toBe(0);
  });
});

describe("what pay is totalled from is a rosterer's to change, with Rostering installed", () => {
  const minutes = "bookings.rosterBeforeMinutes";
  const ai = () => staff({ actor: "assistant", origin: { surface: "assistant" } });
  async function people() {
    const member = await account(unique("Member Min"), "member");
    const rosterer = await account(unique("Rosterer Min"), "member");
    await grant(rosterer, [MANAGE]);
    return { member, rosterer };
  }
  const rostering = async (promise: Promise<unknown>) => {
    const e = await refusal(promise);
    expect([e.code, e.details?.rule]).toEqual(["forbidden", "rostering"]);
  };

  it("a class type's set-up and pack-down minutes, by update, create and createMany", async () => {
    const { member, rosterer } = await people();
    const kind = await create("programs.classtype", { name: unique("Pilates") });
    await rostering(
      run(
        "record.update",
        { object: "programs.classtype", id: kind, values: { [minutes]: 30 } },
        asUser(member),
      ),
    );
    await rostering(
      run(
        "record.update",
        { object: "programs.classtype", id: kind, values: { "bookings.rosterAfterMinutes": 30 } },
        asUser(member),
      ),
    );
    await rostering(
      run(
        "record.create",
        { object: "programs.classtype", values: { name: unique("Barre"), [minutes]: 30 } },
        asUser(member),
      ),
    );
    await rostering(
      run(
        "record.createMany",
        { object: "programs.classtype", records: [{ name: unique("Barre"), [minutes]: 30 }] },
        asUser(member),
      ),
    );
    // The rest of a class type is still a member's, and a rosterer sets the minutes.
    await run(
      "record.update",
      { object: "programs.classtype", id: kind, values: { "bookings.colour": "#123456" } },
      asUser(member),
    );
    await run(
      "record.update",
      { object: "programs.classtype", id: kind, values: { [minutes]: 15 } },
      asUser(rosterer),
    );
    expect((await get("programs.classtype", kind))[minutes]).toBe(15);
  });

  it("an assistant's change of them waits, and only a rosterer's approval applies it", async () => {
    const { member, rosterer } = await people();
    const kind = await create("programs.classtype", { name: unique("Spin") });
    const asked = await refusal(
      run(
        "record.update",
        { object: "programs.classtype", id: kind, values: { [minutes]: 45 } },
        ai(),
      ),
    );
    expect(asked.code).toBe("pending_approval");
    const id = (asked.details as { actionId: string }).actionId;
    expect((await refusal(run("approval.approve", { actionIds: [id] }, asUser(member)))).code).toBe(
      "forbidden",
    );
    await run("approval.approve", { actionIds: [id] }, asUser(rosterer));
    expect((await get("programs.classtype", kind))[minutes]).toBe(45);
  });

  it("the times of a class that has started: a rosterer's; a future class still a member's", async () => {
    const { member, rosterer } = await people();
    const c = await coach(unique("Coach Min"));
    const started = await klass(-2 * DAY, c.profile);
    const future = await klass(20 * DAY, c.profile);
    const later = (id: string, hours: number) =>
      get(CLASS, id).then((v) => ({
        endsAt: new Date(Date.parse(String(v.startsAt)) + hours * HOUR).toISOString(),
      }));
    await rostering(
      run(
        "record.update",
        { object: CLASS, id: started, values: await later(started, 5) },
        asUser(member),
      ),
    );
    // Nor moved into the past by a member.
    await rostering(
      run(
        "record.update",
        {
          object: CLASS,
          id: future,
          values: {
            startsAt: new Date(Date.now() - 3 * DAY).toISOString(),
            endsAt: new Date(Date.now() - 3 * DAY + HOUR).toISOString(),
          },
        },
        asUser(member),
      ),
    );
    await run(
      "record.update",
      { object: CLASS, id: future, values: await later(future, 2) },
      asUser(member),
    );
    await run(
      "record.update",
      { object: CLASS, id: started, values: await later(started, 2) },
      asUser(rosterer),
    );
  });
});
