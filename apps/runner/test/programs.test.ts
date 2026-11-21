// Stage 41, build steps 2 and 3: the Programs pack (packs/programs) in the real host. Its
// source is installed the way a product that lists the pack installs it (a shipped extension,
// committed to the workspace and run in the sandbox), with real D1.
//
// Acceptance criteria: 1 (a product without the pack has none of it; with it, its objects and
// tools), 2 (one layout for a class program with levels and a client program with typed sets; a
// broken layout refused with its path), 3 (versions: editing a published program changes nothing
// for people already assigned; an old version read and restored), 4 (assign to a person and to
// a class type: the right dated sessions; a person sees only their own), 5 (logging: a client
// against targets with effort, a coach for a client, a member on a class session; nobody on a
// session that is not theirs), 7's data half (one row per logged set in the rec_* view).
// Criterion 6 is the stage 22 isolation suite (packages/core/test/isolation-suite.ts) and the
// isolation case below.
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
import type { Layout } from "../../../packs/programs/layout.ts";
import { listedPacks } from "../src/extensions/shipped-list.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const files = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../packs/programs/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  )
    .map(([path, text]) => [path.split("/").pop() as string, text] as const)
    // The pack's extension files, as a release carries them (not its config or tests).
    .filter(([name]) => name !== "vitest.config.ts"),
);

/** The extension host of a deployment whose product lists Programs. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [...(await host.shipped()), { id: "programs", version: "0.1.0" }],
  commitShipped: (id) =>
    id === "programs"
      ? host.commit({
          id,
          files,
          message: "Shipped programs 0.1.0",
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const EXERCISE = "programs.exercise";
const PROGRAM = "programs.program";
const CLASSTYPE = "programs.classtype";
const ASSIGNMENT = "programs.assignment";
const SESSION = "programs.session";
const LOG = "programs.log";

let admin: ActingUser;
let coach: ActingUser;
let a: CustomerPrincipal;
let b: CustomerPrincipal;
let bank: Record<"pike" | "row" | "hollow", string>;
let handstands: string;

const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  extensionHost: shippedHost,
  ...extra,
});
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({
  principal,
  db,
  extensionHost: shippedHost,
});
const guest: OutsideInvocationContext = {
  principal: { kind: "public" },
  db,
  extensionHost: shippedHost,
};

function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
): Promise<T> {
  return invokeByName(name, input, ctx) as Promise<T>;
}

/** What a call was refused with: its code, message and the host's details (unwrapped from a tool's). */
async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: Record<string, unknown> };
    const inner = (e.details?.details ?? e.details) as Record<string, unknown> | undefined;
    return { code: e.code, message: e.message, inner: e.details?.code, details: inner };
  }
  throw new Error("expected a refusal");
}

async function create(object: string, values: Record<string, unknown>): Promise<string> {
  return (await run<{ id: string }>("record.create", { object, values }, staff(admin))).id;
}

async function createCustomer(label: string): Promise<CustomerPrincipal> {
  const tag = unique(label).toLowerCase();
  const email = `${tag}@members.test`;
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
  return { kind: "customer", customerId, personId: person.id };
}

async function createStaff(role: "member", name: string): Promise<ActingUser> {
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

/** A program that is both: an item with sparse levels (a class) and items with typed sets. */
function layout(reps = 5, weeks = 2): Layout {
  return {
    weeks: Array.from({ length: weeks }, (_, w) => ({
      label: `Week ${w + 1}`,
      sessions: [
        {
          name: `Press ${w + 1}`,
          day: 1,
          focus: "Line",
          blocks: [
            {
              label: "A",
              rounds: 3,
              items: [
                {
                  kind: "levels",
                  label: "A1",
                  levels: [
                    {
                      mode: "one",
                      level: 1,
                      exercise: {
                        exercise: bank.pike,
                        sets: [{ kind: "reps", reps, tempo: "5050" }],
                      },
                    },
                    {
                      mode: "alternatives",
                      level: 5,
                      exercises: [
                        { exercise: bank.pike, sets: [{ kind: "reps", reps: reps + 3, load: 10 }] },
                        { exercise: bank.hollow, sets: [{ kind: "hold", seconds: 20, holds: 3 }] },
                      ],
                    },
                  ],
                  notes: [
                    { text: "Coach: watch the knees" },
                    { text: "Breathe out", members: true },
                  ],
                },
                {
                  kind: "all",
                  label: "A2",
                  exercises: [
                    {
                      exercise: bank.row,
                      sets: [
                        { kind: "reps", reps: 8, load: 20, rest: 90 },
                        { kind: "reps", reps: 8, load: 22.5, rest: 90 },
                      ],
                      note: "pause at the top",
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          name: `Pull ${w + 1}`,
          day: 4,
          blocks: [
            {
              label: "A",
              items: [
                {
                  kind: "all",
                  label: "A1",
                  exercises: [{ exercise: bank.row, sets: [{ kind: "reps", reps: 10 }] }],
                },
              ],
            },
          ],
        },
      ],
    })),
  };
}

async function program(title: string, kind: "class" | "client", value = layout()) {
  return create(PROGRAM, { title, kind, guidance: "Coaches only", layout: value });
}

const publish = (id: string, note?: string) =>
  run<{ version: number }>(
    "record.publish",
    { object: PROGRAM, id, ...(note ? { note } : {}) },
    staff(admin),
  );

interface Sessions {
  sessions: {
    id: string;
    name: string;
    date: string;
    kind: string;
    programVersion: number;
    plan: Layout["weeks"][number]["sessions"][number];
    exercises: { id: string; name: string; last: { reps: number | null }[] }[];
  }[];
}

beforeAll(async () => {
  admin = await createAdmin();
  coach = await createStaff("member", "Coach Sam");

  // This runner is built for the CRM, whose product does not list Programs: its release has no
  // programs pack, and the host has none of its objects or tools.
  expect(listedPacks("*").map((p) => p.id)).not.toContain("programs");
  await refreshSchemaRegistry(db.query);
  expect(getObject(PROGRAM)).toBeUndefined();
  expect(await refusal(run("x.programs.assign", {}, staff(admin)))).toMatchObject({
    code: "unknown_operation",
  });

  // A deployment of a product that lists it installs it as shipped.
  await run("extension.install", { id: "programs", shipped: true }, staff(admin));
  await refreshSchemaRegistry(db.query);

  bank = {
    pike: await create(EXERCISE, { name: "Pike compression", measure: "reps", cues: "Reach long" }),
    row: await create(EXERCISE, { name: "Ring row", measure: "weight_reps" }),
    hollow: await create(EXERCISE, { name: "Hollow hold", measure: "hold" }),
  };
  handstands = await create(CLASSTYPE, { name: "Handstands", order: 1 });
  a = await createCustomer("a");
  b = await createCustomer("b");
}, 120_000);

describe("the pack in a product (criterion 1)", () => {
  it("is installed as shipped with its objects and tools", async () => {
    const row = await env.DB.prepare("SELECT source, status FROM core_extensions WHERE id = ?")
      .bind("programs")
      .first();
    expect(row).toEqual({ source: "shipped", status: "active" });
    for (const object of [EXERCISE, PROGRAM, CLASSTYPE, ASSIGNMENT, SESSION, LOG]) {
      expect(getObject(object), object).toBeDefined();
    }
    expect(getObject(PROGRAM)?.publishable?.content).toContain("layout");
    expect(getObject(SESSION)?.signedIn?.when).toEqual({ field: "kind", in: ["class"] });
  });
});

describe("one layout (criterion 2)", () => {
  it("a class program with levels and a client program with typed sets are the same object and schema", async () => {
    const forClass = await program("Handstand class", "class");
    const forClient = await program("Ada's block", "client");
    const both = await run<{
      items: { id: string; values: { kind: string; weekCount: number } }[];
    }>(
      "record.list",
      { object: PROGRAM, filter: { field: "id", op: "in", value: [forClass, forClient] } },
      staff(admin),
    );
    expect(both.items.map((p) => [p.values.kind, p.values.weekCount]).sort()).toEqual([
      ["class", 2],
      ["client", 2],
    ]);
  });

  it("a layout that breaks the schema is refused with the path of the fault, for staff and an AI", async () => {
    const id = await program("To break", "client");
    const broken = layout() as unknown as {
      weeks: {
        sessions: { day: number; blocks: { items: { levels?: { level: number }[] }[] }[] }[];
      }[];
    };
    (broken.weeks[1]?.sessions[0]?.blocks[0]?.items[0]?.levels?.[1] as { level: number }).level = 1;
    for (const ctx of [
      staff(coach),
      staff(admin, {
        actor: "mcp",
        origin: { surface: "mcp", clientId: "c", clientName: "Claude", sessionId: unique("s") },
      }),
    ]) {
      const refused = await refusal(
        run("record.update", { object: PROGRAM, id, values: { layout: broken } }, ctx),
      );
      expect(refused).toMatchObject({
        code: "invalid_input",
        message: `Invalid value for ${PROGRAM}.layout: layout.weeks.1.sessions.0.blocks.0.items.0.levels.1.level: 1 is there twice (also entry 0)`,
      });
    }
    const badDay = layout();
    (badDay.weeks[0]?.sessions[1] as { day: number }).day = 8;
    expect(
      (
        await refusal(
          run("record.update", { object: PROGRAM, id, values: { layout: badDay } }, staff(coach)),
        )
      ).message,
    ).toBe(`Invalid value for ${PROGRAM}.layout: layout.weeks.0.sessions.1.day: At most 7`);
    const ghost = layout();
    const pull = ghost.weeks[0]?.sessions[1]?.blocks[0]?.items[0] as {
      exercises: { exercise: string }[];
    };
    pull.exercises[0] = {
      exercise: "rec_01NOTINTHEBANK000000000000",
      sets: [{ kind: "reps", reps: 1 }],
    } as never;
    expect(
      (
        await refusal(
          run("record.update", { object: PROGRAM, id, values: { layout: ghost } }, staff(coach)),
        )
      ).message,
    ).toBe(
      `layout.weeks.0.sessions.1.blocks.0.items.0.exercises.0.exercise: no live ${EXERCISE} with id rec_01NOTINTHEBANK000000000000`,
    );
  });
});

describe("versions and assign (criteria 3 and 4)", () => {
  it("assigning to a person makes the right dated sessions from the published version", async () => {
    const id = await program("Client block", "client");
    expect(
      await refusal(
        run(
          "x.programs.assign",
          { programId: id, personId: a.personId, startDate: "2026-12-07" },
          staff(coach),
        ),
      ),
    ).toMatchObject({
      inner: "invalid_input",
      message: expect.stringContaining("has not been published"),
    });
    await publish(id, "First");
    const out = await run<{
      assignmentId: string;
      sessions: number;
      endDate: string;
      programVersion: number;
    }>(
      "x.programs.assign",
      { programId: id, personId: a.personId, startDate: "2026-12-07" },
      staff(coach),
    );
    expect(out).toMatchObject({ sessions: 4, endDate: "2026-12-20", programVersion: 1 });
    const sessions = await run<{ items: { values: Record<string, unknown> }[] }>(
      "record.list",
      {
        object: SESSION,
        filter: { field: "assignment", op: "eq", value: out.assignmentId },
        sort: { field: "date", direction: "asc" },
      },
      staff(admin),
    );
    expect(
      sessions.items.map((s) => [s.values.name, s.values.date, s.values.state, s.values.person]),
    ).toEqual([
      ["Press 1", "2026-12-07", "planned", a.personId],
      ["Pull 1", "2026-12-10", "planned", a.personId],
      ["Press 2", "2026-12-14", "planned", a.personId],
      ["Pull 2", "2026-12-17", "planned", a.personId],
    ]);
    const assignment = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: ASSIGNMENT, id: out.assignmentId },
      staff(admin),
    );
    expect(assignment.values).toMatchObject({
      state: "active",
      programVersion: 1,
      sessionCount: 4,
      assignedBy: coach.id,
    });
    // Called again, it makes nothing twice: a new assignment, or this one if it had stopped part-way.
    const again = await run<{ assignmentId: string }>(
      "x.programs.assign",
      { programId: id, personId: a.personId, startDate: "2026-12-07" },
      staff(coach),
    );
    expect(again.assignmentId).not.toBe(out.assignmentId);
  });

  it("editing a published program changes nothing for people assigned until a new version is published and assigned", async () => {
    const id = await program("Versioned", "client", layout(5));
    await publish(id);
    const first = await run<{ assignmentId: string }>(
      "x.programs.assign",
      { programId: id, personId: a.personId, startDate: "2027-01-04" },
      staff(coach),
    );
    // The coach edits the working copy: 5 reps become 12. Not published.
    await run(
      "record.update",
      { object: PROGRAM, id, values: { layout: layout(12) } },
      staff(coach),
    );
    const seen = await run<Sessions>("x.programs.today", { date: "2027-01-04" }, as(a));
    const press = seen.sessions.find((s) => s.name === "Press 1");
    const a1 = press?.plan.blocks[0]?.items[0] as {
      levels: { exercise?: { sets: { reps: number }[] } }[];
    };
    expect(a1.levels[0]?.exercise?.sets[0]?.reps).toBe(5);
    expect(press?.programVersion).toBe(1);
    // Assigned again before it is published, it is still version 1: the working copy is no one's.
    const meanwhile = await run<{ programVersion: number }>(
      "x.programs.assign",
      { programId: id, personId: a.personId, startDate: "2027-01-18" },
      staff(coach),
    );
    expect(meanwhile.programVersion).toBe(1);
    const fresh = await run<Sessions>("x.programs.today", { date: "2027-01-18" }, as(a));
    const a1Fresh = fresh.sessions[0]?.plan.blocks[0]?.items[0] as {
      levels: { exercise?: { sets: { reps: number }[] } }[];
    };
    expect(a1Fresh.levels[0]?.exercise?.sets[0]?.reps).toBe(5);
    // Published as version 2: still nothing changes for the existing assignment...
    expect((await publish(id)).version).toBe(2);
    const still = await run<Sessions>("x.programs.today", { date: "2027-01-04" }, as(a));
    expect(still.sessions.map((s) => s.programVersion)).toEqual([1]);
    // ...until version 2 is assigned.
    const second = await run<{ programVersion: number }>(
      "x.programs.assign",
      { programId: id, personId: a.personId, startDate: "2027-02-01" },
      staff(coach),
    );
    expect(second.programVersion).toBe(2);
    const later = await run<Sessions>("x.programs.today", { date: "2027-02-01" }, as(a));
    const a1Later = later.sessions[0]?.plan.blocks[0]?.items[0] as {
      levels: { exercise?: { sets: { reps: number }[] } }[];
    };
    expect(a1Later.levels[0]?.exercise?.sets[0]?.reps).toBe(12);
    // An old version is read, and restored into the working copy.
    const v1 = await run<{ values: { layout: Layout } }>(
      "record.version",
      { object: PROGRAM, id, version: 1 },
      staff(coach),
    );
    expect(JSON.stringify(v1.values.layout)).toBe(JSON.stringify(layout(5)));
    await run("record.restoreVersion", { object: PROGRAM, id, version: 1 }, staff(coach));
    const working = await run<{ values: { layout: Layout } }>(
      "record.get",
      { object: PROGRAM, id },
      staff(coach),
    );
    expect(JSON.stringify(working.values.layout)).toBe(JSON.stringify(layout(5)));
    expect(first.assignmentId).toBeTruthy();
  });

  it("publishing is a person's with the permission: not a coach without it, not an AI, not the pack", async () => {
    const id = await program("Gated", "client");
    expect(
      await refusal(run("record.publish", { object: PROGRAM, id }, staff(coach))),
    ).toMatchObject({
      code: "forbidden",
      details: { permission: "records:publish" },
    });
    expect(
      await refusal(
        run(
          "record.publish",
          { object: PROGRAM, id },
          staff(admin, {
            actor: "assistant",
            origin: { surface: "assistant", sessionId: unique("ath") },
          }),
        ),
      ),
    ).toMatchObject({ code: "forbidden" });
  });

  it("assigning to a class type dates its sessions, which every signed-in member reads and the public do not", async () => {
    const id = await program("Handstands, term 1", "class");
    await publish(id);
    const out = await run<{ assignmentId: string; sessions: number }>(
      "x.programs.assign",
      { programId: id, classTypeId: handstands, startDate: "2027-03-01" },
      staff(admin),
    );
    expect(out.sessions).toBe(4);
    for (const member of [a, b]) {
      const today = await run<Sessions>(
        "x.programs.classToday",
        { classTypeId: handstands, date: "2027-03-04" },
        as(member),
      );
      expect(today.sessions.map((s) => [s.name, s.date, s.kind])).toEqual([
        ["Pull 1", "2027-03-04", "class"],
      ]);
    }
    // Members read the levels, and the notes marked for them, not the coaches'.
    const monday = await run<Sessions>(
      "x.programs.classToday",
      { classTypeId: handstands, date: "2027-03-01" },
      as(a),
    );
    const item = monday.sessions[0]?.plan.blocks[0]?.items[0] as {
      levels: unknown[];
      notes: { text: string }[];
    };
    expect(item.levels).toHaveLength(2);
    expect(item.notes).toEqual([{ text: "Breathe out", members: true }]);
    const coachView = await run<Sessions>(
      "x.programs.classToday",
      { classTypeId: handstands, date: "2027-03-01" },
      staff(coach),
    );
    expect(JSON.stringify(coachView)).toContain("Coach: watch the knees");
    // A class session is not a member's own: it is not in their today, and it is not theirs to mark.
    expect(
      (await run<Sessions>("x.programs.today", { date: "2027-03-01" }, as(a))).sessions,
    ).toEqual([]);
    expect(
      await refusal(
        run("x.programs.sessionComplete", { sessionId: monday.sessions[0]?.id }, as(a)),
      ),
    ).toMatchObject({ inner: "not_found" });
    expect(
      await refusal(run("x.programs.classToday", { classTypeId: handstands }, guest)),
    ).toMatchObject({
      code: "unknown_operation",
    });
  });

  it("a person sees only their own assignments and sessions", async () => {
    const id = await program("B's own", "client");
    await publish(id);
    const theirs = await run<{ assignmentId: string }>(
      "x.programs.assign",
      { programId: id, personId: b.personId, startDate: "2027-04-05" },
      staff(admin),
    );
    const mine = await run<{ items: { id: string; values: { kind: string } }[] }>(
      "my.list",
      { object: ASSIGNMENT, limit: 200 },
      as(a),
    );
    expect(mine.items.map((i) => i.id)).not.toContain(theirs.assignmentId);
    expect(new Set(mine.items.map((i) => i.values.kind))).toEqual(new Set(["personal", "class"]));
    expect(
      await refusal(run("my.get", { object: ASSIGNMENT, id: theirs.assignmentId }, as(a))),
    ).toMatchObject({
      code: "not_found",
    });
    expect(
      (await run<Sessions>("x.programs.today", { date: "2027-04-05" }, as(a))).sessions,
    ).toEqual([]);
    expect(
      (await run<Sessions>("x.programs.today", { date: "2027-04-05" }, as(b))).sessions,
    ).toHaveLength(1);
  });
});

describe("logging (criterion 5)", () => {
  let session: string;
  let classSession: string;
  let bSession: string;

  beforeAll(async () => {
    const id = await program("Logging block", "client");
    await publish(id);
    await run(
      "x.programs.assign",
      { programId: id, personId: a.personId, startDate: "2027-05-03" },
      staff(coach),
    );
    await run(
      "x.programs.assign",
      { programId: id, personId: b.personId, startDate: "2027-05-03" },
      staff(coach),
    );
    const cls = await program("Logging class", "class");
    await publish(cls);
    await run(
      "x.programs.assign",
      { programId: cls, classTypeId: handstands, startDate: "2027-05-03" },
      staff(coach),
    );
    session = (await run<Sessions>("x.programs.today", { date: "2027-05-03" }, as(a))).sessions[0]
      ?.id as string;
    bSession = (await run<Sessions>("x.programs.today", { date: "2027-05-03" }, as(b))).sessions[0]
      ?.id as string;
    classSession = (
      await run<Sessions>(
        "x.programs.classToday",
        { classTypeId: handstands, date: "2027-05-03" },
        as(a),
      )
    ).sessions[0]?.id as string;
  }, 60_000);

  it("a client logs sets against their targets with effort, and sees last time's numbers next time", async () => {
    const one = await run<Record<string, unknown>>(
      "x.programs.logAdd",
      { sessionId: session, item: "A2", setNumber: 1, actual: { reps: 8, load: 20 }, rpe: 7 },
      as(a),
    );
    expect(one).toMatchObject({
      exercise: bank.row,
      target: { reps: 8, load: 20 },
      actual: { reps: 8, load: 20 },
      rpe: 7,
      recordedAs: "self",
      recordedByName: null,
    });
    await run(
      "x.programs.logAdd",
      { sessionId: session, item: "A2", setNumber: 2, actual: { reps: 6, load: 22.5 }, rpe: 9.5 },
      as(a),
    );
    const level = await run<Record<string, unknown>>(
      "x.programs.logAdd",
      {
        sessionId: session,
        item: "A1",
        level: 5,
        exerciseId: bank.hollow,
        setNumber: 1,
        actual: { seconds: 18 },
        rpe: 8,
      },
      as(a),
    );
    expect(level).toMatchObject({ level: 5, exercise: bank.hollow, target: { seconds: 20 } });
    // Effort in halves only: the tool's input is refused before anything is written.
    expect(
      await refusal(
        run(
          "x.programs.logAdd",
          { sessionId: session, item: "A2", setNumber: 3, actual: { reps: 1 }, rpe: 7.3 },
          as(a),
        ),
      ),
    ).toMatchObject({ inner: "invalid_input" });
    const fixed = await run<Record<string, unknown>>(
      "x.programs.logUpdate",
      { logId: one.id, actual: { reps: 9 }, note: "Easy" },
      as(a),
    );
    expect(fixed).toMatchObject({
      actual: { reps: 9, load: 20 },
      note: "Easy",
      target: { reps: 8 },
    });
    // The next week's session shows the last numbers at each exercise.
    const next = await run<Sessions>("x.programs.today", { date: "2027-05-10" }, as(a));
    const row = next.sessions[0]?.exercises.find((e) => e.id === bank.row);
    expect(row?.last.map((s) => s.reps)).toEqual([9, 6]);
    const done = await run<{ changed: boolean; session: { state: string } }>(
      "x.programs.sessionComplete",
      { sessionId: session },
      as(a),
    );
    expect(done).toMatchObject({ changed: true, session: { state: "done" } });
  });

  it("a coach logs for a client, and the row says who recorded it", async () => {
    const set = await run<Record<string, unknown>>(
      "x.programs.logAdd",
      { sessionId: session, item: "A1", level: 1, setNumber: 1, actual: { reps: 5 } },
      staff(coach),
    );
    expect(set).toMatchObject({
      recordedAs: "staff",
      recordedByName: "Coach Sam",
      target: { reps: 5 },
    });
    const row = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: LOG, id: set.id },
      staff(admin),
    );
    expect(row.values).toMatchObject({ person: a.personId, recordedBy: coach.id });
    // The client reads it as theirs, with who recorded it.
    const theirs = await run<{ logged: { recordedByName: string | null }[] }>(
      "x.programs.sessionGet",
      { sessionId: session },
      as(a),
    );
    expect(theirs.logged.map((l) => l.recordedByName)).toContain("Coach Sam");
  });

  it("a class member logs the level taken and numbers on a class session", async () => {
    const set = await run<Record<string, unknown>>(
      "x.programs.logAdd",
      {
        sessionId: classSession,
        item: "A1",
        level: 1,
        setNumber: 1,
        actual: { reps: 4 },
        rpe: 6.5,
      },
      as(b),
    );
    expect(set).toMatchObject({ level: 1, target: { reps: 5 }, actual: { reps: 4 } });
    // Their set is theirs: A reading the class session sees none of B's.
    const forA = await run<{ logged: unknown[] }>(
      "x.programs.sessionGet",
      { sessionId: classSession },
      as(a),
    );
    expect(forA.logged).toEqual([]);
    // A coach logs for a member on a class session by naming them.
    expect(
      await refusal(
        run(
          "x.programs.logAdd",
          { sessionId: classSession, item: "A1", level: 1, setNumber: 2, actual: { reps: 4 } },
          staff(coach),
        ),
      ),
    ).toMatchObject({ inner: "invalid_input" });
    const named = await run<Record<string, unknown>>(
      "x.programs.logAdd",
      {
        sessionId: classSession,
        item: "A1",
        level: 1,
        setNumber: 2,
        actual: { reps: 4 },
        personId: b.personId,
      },
      staff(coach),
    );
    expect(named).toMatchObject({ recordedAs: "staff" });
  });

  it("nobody can log on a session that is not theirs", async () => {
    const before = await env.DB.prepare(`SELECT count(*) AS n FROM x_programs_log`).first<{
      n: number;
    }>();
    const onB = await refusal(
      run(
        "x.programs.logAdd",
        { sessionId: bSession, item: "A2", setNumber: 1, actual: { reps: 8 } },
        as(a),
      ),
    );
    const onNothing = await refusal(
      run(
        "x.programs.logAdd",
        {
          sessionId: "rec_01NOSUCHSESSION000000000000",
          item: "A2",
          setNumber: 1,
          actual: { reps: 8 },
        },
        as(a),
      ),
    );
    expect(onB.inner).toBe("not_found");
    expect(JSON.stringify(onB).replaceAll(bSession, "<id>")).toBe(
      JSON.stringify(onNothing).replaceAll("rec_01NOSUCHSESSION000000000000", "<id>"),
    );
    // Not by editing their own set onto B's session either: a log's session is not theirs to set.
    const mine = (await run<{ items: { id: string }[] }>("my.list", { object: LOG }, as(a)))
      .items[0]?.id;
    expect(
      await refusal(
        run("my.update", { object: LOG, id: mine, values: { session: bSession } }, as(a)),
      ),
    ).toMatchObject({ code: "unknown_operation" });
    // B's set is not A's to change.
    const bSet = await run<{ id: string }>(
      "x.programs.logAdd",
      { sessionId: bSession, item: "A2", setNumber: 1, actual: { reps: 8 } },
      as(b),
    );
    expect(
      await refusal(run("x.programs.logUpdate", { logId: bSet.id, actual: { reps: 99 } }, as(a))),
    ).toMatchObject({ inner: "not_found" });
    const after = await env.DB.prepare(`SELECT count(*) AS n FROM x_programs_log`).first<{
      n: number;
    }>();
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);
  });

  it("history and progress are worked out in the host from the person's own sets", async () => {
    const mine = await run<{
      sets: { actual: { reps: number | null } }[];
      best: Record<string, unknown>;
    }>("x.programs.history", { exerciseId: bank.row }, as(a));
    expect(mine.sets.map((s) => s.actual.reps)).toEqual([9, 6]);
    expect(mine.best).toEqual({ load: 22.5, reps: 9, seconds: null });
    const forB = await run<{ sets: unknown[] }>(
      "x.programs.history",
      { exerciseId: bank.row },
      as(b),
    );
    expect(forB.sets).toHaveLength(1);
    const coachView = await run<{ sets: unknown[] }>(
      "x.programs.history",
      { exerciseId: bank.row, personId: a.personId },
      staff(coach),
    );
    expect(coachView.sets).toHaveLength(2);
    expect(
      await refusal(
        run("x.programs.history", { exerciseId: bank.row, personId: b.personId }, as(a)),
      ),
    ).toMatchObject({ inner: "invalid_input" });
    const progress = await run<{
      exercises: { id: string; sets: number }[];
      assignments: { done: number }[];
    }>("x.programs.progress", {}, as(a));
    expect(progress.exercises.find((e) => e.id === bank.row)?.sets).toBe(2);
    expect(progress.assignments.some((x) => x.done === 1)).toBe(true);
  });

  it("the rec_* view gives one row per logged set with exercise, person, date, target and actual (criterion 7)", async () => {
    const rows = await run<{ rows: Record<string, unknown>[] }>(
      "query.sql",
      {
        sql:
          "SELECT l.exercise, e.name AS exercise_name, l.person, l.date, l.set_number, l.target_reps, l.target_seconds, l.target_load, l.actual_reps, l.actual_seconds, l.actual_load, l.rpe, l.recorded_as " +
          "FROM rec_x_programs_log l JOIN rec_x_programs_exercise e ON e.id = l.exercise WHERE l.session = ? ORDER BY l.item, l.set_number, l.recorded_as",
        params: [session],
      },
      staff(admin),
    );
    expect(rows.rows).toEqual([
      {
        exercise: bank.hollow,
        exercise_name: "Hollow hold",
        person: a.personId,
        date: "2027-05-03",
        set_number: 1,
        target_seconds: 20,
        target_reps: null,
        target_load: null,
        actual_seconds: 18,
        actual_reps: null,
        actual_load: null,
        rpe: 8,
        recorded_as: "self",
      },
      {
        exercise: bank.pike,
        exercise_name: "Pike compression",
        person: a.personId,
        date: "2027-05-03",
        set_number: 1,
        target_seconds: null,
        target_reps: 5,
        target_load: null,
        actual_seconds: null,
        actual_reps: 5,
        actual_load: null,
        rpe: null,
        recorded_as: "staff",
      },
      {
        exercise: bank.row,
        exercise_name: "Ring row",
        person: a.personId,
        date: "2027-05-03",
        set_number: 1,
        target_seconds: null,
        target_reps: 8,
        target_load: 20,
        actual_seconds: null,
        actual_reps: 9,
        actual_load: 20,
        rpe: 7,
        recorded_as: "self",
      },
      {
        exercise: bank.row,
        exercise_name: "Ring row",
        person: a.personId,
        date: "2027-05-03",
        set_number: 2,
        target_seconds: null,
        target_reps: 8,
        target_load: 22.5,
        actual_seconds: null,
        actual_reps: 6,
        actual_load: 22.5,
        rpe: 9.5,
        recorded_as: "self",
      },
    ]);
  });
});

describe("the statement budget of an assignment (ADR 0448)", () => {
  it("a program of 52 weeks of 14 sessions is assigned in batches of 50", async () => {
    const big: Layout = {
      weeks: Array.from({ length: 52 }, () => ({
        sessions: Array.from({ length: 14 }, (_, s) => ({
          name: `S${s + 1}`,
          day: (s % 7) + 1,
          blocks: [
            {
              label: "A",
              items: [
                {
                  kind: "all",
                  label: "A1",
                  exercises: [{ exercise: bank.row, sets: [{ kind: "reps", reps: 8 }] }],
                },
              ],
            },
          ],
        })),
      })),
    };
    const id = await program("A year", "client", big);
    await publish(id);
    const out = await run<{ sessions: number; endDate: string }>(
      "x.programs.assign",
      { programId: id, personId: b.personId, startDate: "2028-01-03" },
      staff(admin),
    );
    expect(out).toEqual(expect.objectContaining({ sessions: 728, endDate: "2028-12-31" }));
  }, 120_000);
});
