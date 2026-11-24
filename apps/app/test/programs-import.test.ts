// `cos programs import` (stage 41) against the real host: the CLI's own engine
// (packages/create-composable-os/src/programs-import) over cos-app's real HTTP surface, with a
// person's staff device session, as the command runs it. Programs is reconciled into the host
// from its own manifest.
//
// A folder imports (class types, exercises with their easier and harder versions, programs in the
// shorthand with an item that has an exercise for everyone and levels, past sessions and their
// sets); a dry run writes nothing; a bad folder stops before any write, each problem with its file
// and line; a re-run makes nothing twice; a coach's edit since is kept; what the import brings in
// starts no automation and sends no message; a member reads their own imported training; one
// batch of 25 sets stays far inside D1's limits.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type AutomationDefinition,
  applyPlan,
  type CustomerPrincipal,
  type InvocationContext,
  invoke,
  issueDeviceSession,
  matchNotificationRoutes,
  memoryEventSink,
  type OutsideInvocationContext,
  planReconcile,
  type RecordEventMessage,
  recordTriggerSource,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { type CrmDb, createCrmDb } from "@composable-os/db";
import { toManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ImportHost,
  sessionHost,
} from "../../../packages/create-composable-os/src/import-door/host.ts";
import { runProgramsImport } from "../../../packages/create-composable-os/src/programs-import/engine.ts";
import {
  type ProgramsFolder,
  readProgramsFolder,
} from "../../../packages/create-composable-os/src/programs-import/format.ts";
import programs from "../../../packs/programs/index.ts";
import { handleApi } from "../src/server/http/api.ts";
import { boundTestEnv } from "./bound-env.ts";
import { ORIGIN, signUp, unique } from "./mcp-helpers.ts";

const hostEnv = boundTestEnv(env);
const db = createCrmDb(env.DB);
const EXERCISE = "programs.exercise";
const PROGRAM = "programs.program";
const SESSION = "programs.session";
const LOG = "programs.log";

const fetcher = (async (input: string, init?: RequestInit) =>
  (await handleApi(new Request(input, init), hostEnv)) ??
  new Response("Not found", { status: 404 })) as unknown as typeof fetch;

let admin: ActingUser;
let accessToken: string;
const asStaff = (): ImportHost =>
  sessionHost(ORIGIN, async () => ({ authorization: `Bearer ${accessToken}` }), fetcher);
const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  ...extra,
});
const as = (principal: CustomerPrincipal): OutsideInvocationContext => ({ principal, db });

const tag = unique("prg")
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");
const email = (who: string) => `${who}-${tag}@members.test`;
const people: Record<string, CustomerPrincipal> = {};

/** A gym's folder: exercises, class types, two programs and past training. */
function folder(change: (f: ProgramsFolder) => void = () => {}): ProgramsFolder {
  const f: ProgramsFolder = {
    exercises: [
      "key,name,measure,theme,equipment,easier,harder",
      `hollow-${tag},Hollow hold ${tag},hold,mobility,none,,`,
      `row-${tag},Ring row ${tag},weight_reps,strength,rings,,pullup-${tag}`,
      `pullup-${tag},Pull up ${tag},reps,strength,bar,row-${tag},`,
      `tuck-${tag},Tuck planche ${tag},reps,handstands,parallettes,,`,
    ].join("\n"),
    classTypes: ["key,name,order", `mob-${tag},Mobility ${tag},1`, `hand-${tag},Handstands ${tag},2`].join(
      "\n",
    ),
    programs: new Map([
      [
        `class-${tag}.txt`,
        [
          `Title: Handstand class ${tag}`,
          "Guidance: Levels are a guide.",
          "Session: Monday",
          "Block A: 3 rounds",
          `A1: Hollow hold ${tag} x 30 sec`,
          `  1: Tuck planche ${tag} x 3`,
          `  4: Pull up ${tag} x 5`,
          `A2: Ring row ${tag} x 8`,
        ].join("\n"),
      ],
      [
        `client-${tag}.txt`,
        [
          `Title: Strength for one ${tag}`,
          "Kind: client",
          "Session: Tuesday",
          `A1: Pull up ${tag} x 5`,
        ].join("\n"),
      ],
    ]),
    training: [
      "email,date,session,exercise,set,reps,seconds,load,rpe,note,item,level,program",
      `${email("ana")},2025-03-03,Pull day ${tag},pullup-${tag},1,5,,,8,,A1,,client-${tag}`,
      `${email("ana")},2025-03-03,Pull day ${tag},pullup-${tag},2,4,,,8.5,last one slow,A1,,`,
      `${email("ana")},2025-03-03,Pull day ${tag},row-${tag},,8,,20,,,A2,,`,
      `${email("ana")},2025-03-03,Pull day ${tag},row-${tag},,8,,20,,,A2,,`,
      `${email("ana")},2025-03-10,Handstands ${tag},hollow-${tag},,,30,,,,,,`,
      `${email("ben")},2025-03-03,Pull day ${tag},Ring row ${tag},,6,,15,,,,,`,
      `nobody-${tag}@members.test,2025-03-03,Pull day ${tag},pullup-${tag},,5,,,,,,,`,
    ].join("\n"),
  };
  change(f);
  return f;
}

const run = (plan = readProgramsFolder(folder()), dryRun = false) =>
  runProgramsImport(plan, asStaff(), { dryRun });

const rows = async (object: string) => {
  const table = `x_${object.replace(".", "_")}`;
  return (
    await env.DB.prepare(
      `SELECT t.* FROM ${table} t JOIN core_import_key k ON k.record_id = t.id WHERE k.object_type = ? AND k.import_key LIKE ?`,
    )
      .bind(object, `%${tag}%`)
      .all<Record<string, unknown>>()
  ).results;
};
const keyed = async (object: string) =>
  (
    await env.DB.prepare(
      "SELECT count(*) AS n FROM core_import_key WHERE object_type = ? AND import_key LIKE ?",
    )
      .bind(object, `%${tag}%`)
      .first<{ n: number }>()
  )?.n ?? 0;
const personKeys = async (object: string, person: string) =>
  (
    await env.DB.prepare(
      "SELECT count(*) AS n FROM core_import_key WHERE object_type = ? AND import_key LIKE ?",
    )
      .bind(object, `${person}|%`)
      .first<{ n: number }>()
  )?.n ?? 0;

beforeAll(async () => {
  const user = await signUp(hostEnv as never, "admin");
  admin = { id: user.id, email: user.email, name: "Admin", role: "admin" };
  const plan = await planReconcile(db.query, toManifest(programs), {
    now: new Date().toISOString(),
  });
  await applyPlan((statements) => db.batch(statements), plan);
  await refreshSchemaRegistry(db.query);
  accessToken = (
    await issueDeviceSession(
      db,
      { audience: "staff", subjectId: admin.id },
      "Programs import test",
      new Date(),
    )
  ).accessToken;
  // The members come first, through the people import (here: as staff would have them).
  for (const who of ["ana", "ben"]) {
    const person = await invoke(
      "person.create",
      { givenName: who, emails: [{ email: email(who) }] },
      staff(),
    );
    people[who] = { kind: "customer", customerId: `cus_${who}${tag}`, personId: person.id };
  }
  // An exercise the host's bank has already, which a training row names by its name.
  await invoke(
    "record.create",
    { object: EXERCISE, values: { name: `Ring row ${tag} old`, measure: "reps" } },
    staff(),
  );
}, 120_000);

describe("cos programs import against the real host", () => {
  it("a bad folder stops before any write, each problem with its file and line", async () => {
    const bad = readProgramsFolder(
      folder((f) => {
        f.exercises = `${f.exercises}\nbad-${tag},Bad ${tag},kilos,,,,`;
        f.training = `${f.training}\n${email("ana")},2025-02-30,Pull day ${tag},pullup-${tag},,5,,,,,,,`;
      }),
    );
    expect(bad.problems.map((p) => p.file)).toEqual(["exercises.csv:6", "training.csv:9"]);
    expect((await run(bad)).wroteNothing).toBe(true);
    // What only the host can say stops it too: an exercise no one has, a line no one can read.
    const unknown = await run(
      readProgramsFolder(
        folder((f) => {
          f.training = `${f.training}\n${email("ana")},2025-03-03,Pull day ${tag},Muscle up ${tag},,1,,,,,,,`;
          f.programs.set(`odd-${tag}.txt`, `Session: Monday\nA1: Levitation ${tag} x 3`);
        }),
      ),
    );
    expect(unknown.problems.map((p) => p.file)).toEqual(["training.csv:9"]);
    const unread = await run(
      readProgramsFolder(
        folder((f) => f.programs.set(`odd-${tag}.txt`, `Session: Monday\nA1: Levitation ${tag} x 3`)),
      ),
    );
    expect(unread.problems).toEqual(
      expect.arrayContaining([
        { file: `programs/odd-${tag}.txt:2`, message: expect.stringContaining("Levitation") },
      ]),
    );
    expect(unread.problems.every((p) => p.file.startsWith(`programs/odd-${tag}.txt`))).toBe(true);
    expect(unread.wroteNothing).toBe(true);
    for (const object of [EXERCISE, PROGRAM, SESSION, LOG]) expect(await keyed(object)).toBe(0);
  });

  it("a dry run checks everything on the host and writes nothing", async () => {
    const report = await run(undefined, true);
    expect(report.problems).toEqual([]);
    expect(report.wroteNothing).toBe(true);
    expect(report.records.filter((r) => r.object === LOG)).toHaveLength(6);
    expect(new Set(report.records.map((r) => r.outcome))).toEqual(new Set(["created"]));
    for (const object of [EXERCISE, PROGRAM, SESSION, LOG]) expect(await keyed(object)).toBe(0);
  });

  it("imports class types, exercises, programs and past training, keys swapped for ids", async () => {
    const report = await run();
    expect(report.problems).toEqual([]);
    expect(report.unmatched).toMatchObject([{ file: "training.csv:8" }]);
    // Exercises, and their versions by id.
    const exercises = await rows(EXERCISE);
    expect(exercises).toHaveLength(4);
    const id = (name: string) => exercises.find((e) => e.name === `${name} ${tag}`)?.id as string;
    const row = await invoke("record.get", { object: EXERCISE, id: id("Ring row") }, staff());
    expect(row.values).toMatchObject({ harder: [id("Pull up")], equipment: ["rings"] });
    // Programs: working copies, never published; the class one with an item for everyone and
    // levels beside it.
    const [klass, client] = ["class", "client"].map(
      (k) => report.records.find((r) => r.object === PROGRAM && r.key === `${k}-${tag}`)?.id,
    );
    const program = await invoke("record.get", { object: PROGRAM, id: klass }, staff());
    expect(program.values).toMatchObject({ kind: "class", publishedVersion: null });
    const a1 = (
      program.values.layout as { weeks: { sessions: { blocks: { items: unknown[] }[] }[] }[] }
    ).weeks[0]?.sessions[0]?.blocks[0]?.items[0];
    expect(a1).toMatchObject({
      kind: "levels",
      exercises: [{ exercise: id("Hollow hold") }],
      levels: [
        { level: 1, exercise: { exercise: id("Tuck planche") } },
        { level: 4, exercise: { exercise: id("Pull up") } },
      ],
    });
    expect((await invoke("record.get", { object: PROGRAM, id: client }, staff())).values.kind).toBe(
      "client",
    );
    // Past sessions: done, imported, with no assignment; one per person, day and name.
    const sessions = await rows(SESSION);
    expect(sessions).toHaveLength(3);
    for (const s of sessions) {
      expect(s).toMatchObject({ state: "done", source: "import", assignment: null });
    }
    const pullDay = sessions.find(
      (s) => s.person === people.ana?.personId && s.date === "2025-03-03",
    );
    expect(pullDay?.program).toBe(client);
    // Their sets: one row each, the set numbers counted where the file left them out.
    const sets = await rows(LOG);
    expect(sets).toHaveLength(6);
    const ana = sets.filter((s) => s.session === pullDay?.id);
    expect(
      ana
        .map((s) => [s.exercise, s.set_number, s.actual_reps, s.actual_load, s.rpe, s.source])
        .sort(),
    ).toEqual(
      [
        [id("Pull up"), 1, 5, null, 8, "import"],
        [id("Pull up"), 2, 4, null, 8.5, "import"],
        [id("Ring row"), 1, 8, 20, null, "import"],
        [id("Ring row"), 2, 8, 20, null, "import"],
      ].sort(),
    );
    // A row naming an exercise by its name on the host: ben's ring row is the folder's (its
    // name), not the older one the bank had.
    const bens = sets.filter((s) => s.person === people.ben?.personId);
    expect(bens.map((s) => s.exercise)).toEqual([id("Ring row")]);
    expect(await personKeys(SESSION, people.ana?.personId as string)).toBe(2);
  });

  it("a member reads their own imported sessions and sets, and nobody else's", async () => {
    const ana = people.ana as CustomerPrincipal;
    const mine = await invoke("my.list", { object: LOG, limit: 50 }, as(ana));
    expect(mine.items).toHaveLength(5);
    const sessions = await invoke("my.list", { object: SESSION, limit: 50 }, as(ana));
    expect(sessions.items.map((s: { values: Record<string, unknown> }) => s.values.source)).toEqual(
      ["import", "import"],
    );
    const ben = await invoke("my.list", { object: LOG, limit: 50 }, as(people.ben as never));
    expect(ben.items).toHaveLength(1);
  });

  it("a re-run makes nothing twice and changes nothing", async () => {
    const report = await run();
    expect(report.problems).toEqual([]);
    expect(report.wroteNothing).toBe(true);
    expect(new Set(report.records.map((r) => r.outcome))).toEqual(new Set(["unchanged"]));
    expect(await rows(SESSION)).toHaveLength(3);
    expect(await rows(LOG)).toHaveLength(6);
    expect(await rows(PROGRAM)).toHaveLength(2);
  });

  it("a coach's edit since the import is kept, and reported as a conflict", async () => {
    const id = (await rows(PROGRAM)).find((p) => String(p.title).startsWith("Handstand"))
      ?.id as string;
    await invoke("record.update", { object: PROGRAM, id, values: { title: "The coach's" } }, staff());
    const report = await run(
      readProgramsFolder(
        folder((f) => {
          const name = `class-${tag}.txt`;
          f.programs.set(name, `${f.programs.get(name)}\nA3: Pull up ${tag} x 3`);
        }),
      ),
    );
    expect(report.records.find((r) => r.id === id)).toMatchObject({
      outcome: "conflict",
      fields: ["title"],
    });
    const kept = await invoke("record.get", { object: PROGRAM, id }, staff());
    expect(kept.values.title).toBe("The coach's");
  });

  it("what it brings in starts no automation and sends no message", async () => {
    const events = memoryEventSink();
    const session = (await rows(SESSION))[0] as Record<string, unknown>;
    const exercise = (await rows(EXERCISE))[0] as Record<string, unknown>;
    const values = {
      label: "A1 set 9",
      person: session.person,
      session: session.id,
      exercise: exercise.id,
      setNumber: 9,
      date: session.date,
      actualReps: 3,
      source: "import",
    };
    await invoke(
      "record.import",
      { object: LOG, records: [{ key: `one-${tag}`, values }] },
      staff({ events }),
    );
    const imported = events.messages.filter((m): m is RecordEventMessage => m.kind === "record");
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.every((m) => m.origin.imported === true && m.origin.bulk)).toBe(true);
    // Even an automation that takes bulk changes, and a notification route, are not started.
    const onLog = {
      id: "gym.onSet",
      extensionId: "gym",
      key: "onSet",
      commit: "c",
      spec: {
        label: "On a set",
        description: "x",
        steps: [{ name: "x" }],
        trigger: { type: "record", object: LOG, on: ["created"], includeBulk: true },
      },
    } as unknown as AutomationDefinition;
    const route = {
      id: "nrt_set",
      label: "A set",
      object: LOG,
      event: "created" as const,
      channel: "#gym",
      enabled: true,
    };
    expect(imported.flatMap((m) => recordTriggerSource.match(m, [onLog]))).toEqual([]);
    expect(imported.flatMap((m) => matchNotificationRoutes(m, [route]))).toEqual([]);
    // The same set written by a person in the admin starts both.
    const live = memoryEventSink();
    await invoke(
      "record.create",
      { object: LOG, values: { ...values, setNumber: 10, source: null } },
      staff({ events: live }),
    );
    const made = live.messages.filter((m): m is RecordEventMessage => m.kind === "record");
    expect(made.flatMap((m) => recordTriggerSource.match(m, [onLog]))).toHaveLength(1);
    expect(made.flatMap((m) => matchNotificationRoutes(m, [route]))).toHaveLength(1);
  });

  it("one call's batch of 25 sets stays far inside D1's statement and bound-value limits", async () => {
    const batches: { statements: number; maxBound: number }[] = [];
    const counting: CrmDb = {
      query: db.query,
      async batch(statements) {
        const bound = statements.map(
          (s) => ("compile" in s ? s.compile() : s).parameters.length,
        );
        batches.push({ statements: statements.length, maxBound: Math.max(0, ...bound) });
        return db.batch(statements);
      },
    };
    const session = (await rows(SESSION))[0] as Record<string, unknown>;
    const exercise = (await rows(EXERCISE))[0] as Record<string, unknown>;
    const records = Array.from({ length: 25 }, (_, i) => ({
      key: `many-${tag}-${i}`,
      values: {
        label: `A1 set ${i + 1}`,
        person: session.person,
        session: session.id,
        exercise: exercise.id,
        exerciseName: "Hollow hold",
        item: "A1",
        setNumber: i + 1,
        level: 1,
        date: session.date,
        targetReps: 5,
        targetLoad: 10,
        actualReps: 5,
        actualLoad: 10,
        rpe: 7,
        note: "a note on every set",
        source: "import",
      },
    }));
    const out = await invoke(
      "record.import",
      { object: LOG, records },
      staff({ db: counting, events: memoryEventSink() }),
    );
    expect(out.results.every((r: { outcome: string }) => r.outcome === "created")).toBe(true);
    const biggest = batches.reduce((a, b) => (b.statements > a.statements ? b : a));
    // D1 runs at most 1,000 statements an invocation, each with at most 100 bound values. One
    // call is one batch of about 4 statements a set (105 for 25 when this was written): the door's
    // 25 records a call keep it there whatever the folder's size.
    expect(batches).toHaveLength(1);
    expect(biggest.statements).toBeLessThanOrEqual(5 * records.length);
    expect(Math.max(...batches.map((b) => b.maxBound))).toBeLessThanOrEqual(100);
  });
});
