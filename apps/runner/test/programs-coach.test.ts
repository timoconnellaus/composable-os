// Programs' coach role (ADR 0889) in the real host and sandbox: a staff account given
// `programs.coach` reaches its own clients' training only, the People an active assignment names
// it coach of. It lists and opens their sessions, reads them with the tools, logs and marks for
// them, and reads their history and progress; it reaches nobody else's sessions, sets or
// assignments (not by a list, a get, a tool, or a nested call of a tool), no class session, and
// no other operation in the registry. The reach ends with the assignment and follows its coach.
// The role's client (roles.json) backs the coach's client view and session screen, and nothing
// a coach must not call.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type AnyOperation,
  type CustomerPrincipal,
  checkManifest,
  coreRegistry,
  type LooksAfterLimit,
  loadExtensionOperations,
  loadStaffRights,
  looksAfterWhere,
  newId,
  roleLooksAfterFor,
} from "@composable-os/core";
import { toManifest, validateManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import roles from "../../../packages/core/api/v1/roles.json";
import programsPack from "../../../packs/programs/index.ts";
import { createAdmin, db } from "./helpers.ts";
import {
  ASSIGNMENT,
  CLASSTYPE,
  create,
  createCustomer,
  EXERCISE,
  installPrograms,
  LOG,
  PROGRAM,
  refusal,
  run,
  SESSION,
  staff,
  twoWeeks,
} from "./programs-fixture.ts";

const START = "2026-12-07"; // a Monday
let admin: ActingUser;
let kim: ActingUser; // the coach-role account
let plain: ActingUser; // a member of staff with no pack role
let ada: CustomerPrincipal; // Kim's client
let ben: CustomerPrincipal; // not Kim's
let bank: { pike: string; row: string };
let clientProgram: string;
let classProgram: string;
let classType: string;
let adaAssignment: string;
let benAssignment: string;
let classAssignment: string;

interface Page {
  items: { id: string; values: Record<string, unknown> }[];
  nextCursor: string | null;
}

async function staffAccount(name: string, role: "member" | "viewer" = "member") {
  const id = newId("user");
  const email = `${id}@example.com`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 1, ?, ?, ?)",
  )
    .bind(id, name, email, now, now, role)
    .run();
  return { id, email, name, role } as ActingUser;
}

const sessionsOf = async (assignment: string) =>
  (
    await run<Page>(
      "record.list",
      { object: SESSION, filter: { field: "assignment", op: "eq", value: assignment } },
      staff(admin),
    )
  ).items;

async function assign(input: Record<string, unknown>) {
  return (
    await run<{ assignmentId: string }>(
      "x.programs.assign",
      { startDate: START, ...input },
      staff(admin),
    )
  ).assignmentId;
}

beforeAll(async () => {
  admin = await createAdmin();
  await installPrograms(admin);
  kim = await staffAccount("Coach Kim");
  await run("user.setPackRole", { id: kim.id, role: "programs.coach" }, staff(admin));
  kim = { ...kim, role: "viewer" };
  plain = await staffAccount("Plain member");
  ada = await createCustomer(admin, "ada", "Ada");
  ben = await createCustomer(admin, "ben", "Ben");
  bank = {
    pike: await create(admin, EXERCISE, { name: "Pike press", measure: "reps" }),
    row: await create(admin, EXERCISE, { name: "Ring row", measure: "weight_reps" }),
  };
  clientProgram = await create(admin, PROGRAM, {
    title: "Coached",
    kind: "client",
    layout: twoWeeks(bank),
  });
  classProgram = await create(admin, PROGRAM, {
    title: "Class",
    kind: "class",
    layout: twoWeeks(bank),
  });
  for (const id of [clientProgram, classProgram]) {
    await run("record.publish", { object: PROGRAM, id }, staff(admin));
  }
  classType = await create(admin, CLASSTYPE, { name: "Handstands", order: 1 });
  adaAssignment = await assign({ programId: clientProgram, personId: ada.personId });
  benAssignment = await assign({ programId: clientProgram, personId: ben.personId });
  // A class's assignment naming Kim gives no one: it is about no Person.
  classAssignment = await assign({ programId: classProgram, classTypeId: classType });
  // A person names the coach on the assignment's page.
  for (const id of [adaAssignment, classAssignment]) await setCoach(id, kim.id);
}, 180_000);

/** A person (an admin, in the admin) names the assignment's coach. */
const setCoach = (id: string, coach: string | null) =>
  run("record.update", { object: ASSIGNMENT, id, values: { coach } }, staff(admin));

describe("the coach role (ADR 0889)", () => {
  it("lists and opens its clients' sessions and assignments, and nobody else's", async () => {
    const ada1 = (await sessionsOf(adaAssignment)).map((s) => s.id).sort();
    const ben1 = await sessionsOf(benAssignment);
    const class1 = await sessionsOf(classAssignment);
    expect(ada1).toHaveLength(4);
    const listed = await run<Page>("record.list", { object: SESSION, limit: 100 }, staff(kim));
    expect(listed.items.map((s) => s.id).sort()).toEqual(ada1);
    // Naming someone else finds nothing; a page of one has no cursor to another's.
    expect(
      (
        await run<Page>(
          "record.list",
          { object: SESSION, filter: { field: "person", op: "eq", value: ben.personId } },
          staff(kim),
        )
      ).items,
    ).toEqual([]);
    const page = await run<Page>(
      "record.list",
      {
        object: SESSION,
        filter: {
          field: "assignment",
          op: "in",
          value: [adaAssignment, benAssignment, classAssignment],
        },
        sort: { field: "date", direction: "desc" },
        limit: 4,
      },
      staff(kim),
    );
    expect(page.items.map((s) => s.id).sort()).toEqual(ada1);
    expect(page.nextCursor).toBeNull();
    // A projection without the person still holds it.
    const projected = await run<Page>(
      "record.list",
      { object: SESSION, fields: ["name"], limit: 100 },
      staff(kim),
    );
    expect(projected.items.map((s) => s.id).sort()).toEqual(ada1);
    await run("record.get", { object: SESSION, id: ada1[0] }, staff(kim));
    for (const other of [ben1[0], class1[0]]) {
      expect(
        (await refusal(run("record.get", { object: SESSION, id: other?.id }, staff(kim)))).code,
      ).toBe("not_found");
    }
    const assignments = await run<Page>("record.list", { object: ASSIGNMENT }, staff(kim));
    expect(assignments.items.map((a) => a.id)).toEqual([adaAssignment]);
    expect(
      (await refusal(run("record.get", { object: ASSIGNMENT, id: benAssignment }, staff(kim))))
        .code,
    ).toBe("not_found");
    // Other staff are not limited.
    expect(
      (await run<Page>("record.list", { object: SESSION, limit: 200 }, staff(plain))).items.length,
    ).toBeGreaterThanOrEqual(12);
  });

  it("reads, logs and marks for its client with the tools; another's is not found", async () => {
    const [mon, , monWeek2] = (await sessionsOf(adaAssignment)).sort((x, y) =>
      String(x.values.date).localeCompare(String(y.values.date)),
    );
    const [benMon] = await sessionsOf(benAssignment);
    const [classMon] = await sessionsOf(classAssignment);
    const today = await run<{ sessions: { id: string }[] }>(
      "x.programs.today",
      { date: START, personId: ada.personId },
      staff(kim),
    );
    expect(today.sessions.map((s) => s.id)).toEqual([mon?.id]);
    expect(
      (
        await run<{ sessions: unknown[] }>(
          "x.programs.today",
          { date: START, personId: ben.personId },
          staff(kim),
        )
      ).sessions,
    ).toEqual([]);
    const got = await run<{ session: { id: string } }>(
      "x.programs.sessionGet",
      { sessionId: mon?.id },
      staff(kim),
    );
    expect(got.session.id).toBe(mon?.id);
    const set = await run<{ id: string; recordedAs: string; recordedByName: string }>(
      "x.programs.logAdd",
      { sessionId: mon?.id, item: "A1", setNumber: 1, actual: { reps: 8, load: 22.5 }, rpe: 7 },
      staff(kim),
    );
    expect(set).toMatchObject({ recordedAs: "staff", recordedByName: "Coach Kim" });
    const row = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: LOG, id: set.id },
      staff(admin),
    );
    expect(row.values).toMatchObject({ person: ada.personId, recordedBy: kim.id });
    expect(
      await run<{ rpe: number }>("x.programs.logUpdate", { logId: set.id, rpe: 8 }, staff(kim)),
    ).toMatchObject({ rpe: 8 });
    expect(
      await run<{ changed: boolean }>(
        "x.programs.sessionComplete",
        { sessionId: mon?.id },
        staff(kim),
      ),
    ).toMatchObject({ changed: true });
    // The last time shows on the next week's session; history and progress are hers.
    const next = await run<{ exercises: { id: string; last: { reps: number }[] }[] }>(
      "x.programs.sessionGet",
      { sessionId: monWeek2?.id },
      staff(kim),
    );
    expect(next.exercises.find((e) => e.id === bank.row)?.last).toEqual([
      expect.objectContaining({ reps: 8 }),
    ]);
    const history = await run<{ sets: unknown[] }>(
      "x.programs.history",
      { exerciseId: bank.row, personId: ada.personId },
      staff(kim),
    );
    expect(history.sets).toHaveLength(1);
    const progress = await run<{ assignments: { id: string; done: number }[] }>(
      "x.programs.progress",
      { personId: ada.personId },
      staff(kim),
    );
    expect(progress.assignments).toEqual([expect.objectContaining({ id: adaAssignment, done: 1 })]);

    // A set ticked by mistake is taken back (to the Trash; the approval policy may hold it).
    await run(
      "x.programs.logAdd",
      { sessionId: mon?.id, item: "A1", setNumber: 2, actual: { reps: 8 } },
      staff(kim),
    );
    const taken = await run<{ removed: number; waiting: number }>(
      "x.programs.logRemove",
      { sessionId: mon?.id, item: "A1", exerciseId: bank.row, setNumber: 2 },
      staff(kim),
    );
    expect(taken.removed + taken.waiting).toBe(1);

    // Ben's: his set (logged by the desk) and his sessions are out of reach, whatever the tool.
    const bens = await run<{ id: string }>(
      "x.programs.logAdd",
      { sessionId: benMon?.id, item: "A1", setNumber: 1, actual: { reps: 6 } },
      staff(plain),
    );
    for (const [name, input] of [
      ["x.programs.sessionGet", { sessionId: benMon?.id }],
      ["x.programs.logAdd", { sessionId: benMon?.id, item: "A1", setNumber: 2, actual: {} }],
      ["x.programs.sessionComplete", { sessionId: benMon?.id }],
      ["x.programs.logUpdate", { logId: bens.id, rpe: 9 }],
      [
        "x.programs.logRemove",
        { sessionId: benMon?.id, item: "A1", exerciseId: bank.row, setNumber: 1 },
      ],
      // A class session is about no one: not Kim's, even for her own client.
      ["x.programs.sessionGet", { sessionId: classMon?.id, personId: ada.personId }],
      [
        "x.programs.logAdd",
        { sessionId: classMon?.id, item: "A1", level: 1, setNumber: 1, actual: { reps: 5 } },
      ],
    ] as const) {
      expect([name, JSON.stringify(await refusal(run(name, input, staff(kim))))]).toEqual([
        name,
        expect.stringContaining("not_found"),
      ]);
    }
    // Nothing of Ben's comes back through a person-scoped read either.
    expect(
      (
        await run<{ sets: unknown[] }>(
          "x.programs.history",
          { exerciseId: bank.row, personId: ben.personId },
          staff(kim),
        )
      ).sets,
    ).toEqual([]);
    expect(
      await run<{ exercises: unknown[]; assignments: unknown[] }>(
        "x.programs.progress",
        { personId: ben.personId },
        staff(kim),
      ),
    ).toMatchObject({ exercises: [], assignments: [] });
    // Unchanged for anyone else.
    expect(
      (
        await run<{ sets: unknown[] }>(
          "x.programs.history",
          { exerciseId: bank.row, personId: ben.personId },
          staff(plain),
        )
      ).sets,
    ).toHaveLength(1);
  });

  it("is refused every other operation in the registry, whatever its input", async () => {
    const COACH_MAY = new Set(
      (roles.roles.find((r) => r.name === "programs.coach")?.operations ?? []) as string[],
    );
    expect([...COACH_MAY].sort()).toEqual(
      [
        "ack.confirm",
        "ack.mine",
        // Published versions every staff account reads (ADR 0701), on a staff-read object only.
        "content.search",
        "content.staffGet",
        "content.staffList",
        "record.get",
        "record.list",
        "screens.mine",
        // Daily checklists' tools open to every staff account (anyStaff, ADR 0652): their host
        // operations answer with only the checklists the account may do.
        "x.dailychecks.day",
        "x.dailychecks.done",
        "x.dailychecks.tick",
        "x.dailychecks.today",
        "x.programs.history",
        "x.programs.logAdd",
        "x.programs.logRemove",
        "x.programs.logUpdate",
        "x.programs.progress",
        "x.programs.sessionComplete",
        "x.programs.sessionGet",
        "x.programs.today",
      ].sort(),
    );
    const all: AnyOperation[] = [
      ...coreRegistry.list(),
      ...(await loadExtensionOperations(db.query)),
    ];
    expect(all.some((op) => op.name === "x.programs.logAdd")).toBe(true);
    const leaked: string[] = [];
    for (const op of all) {
      if (COACH_MAY.has(op.name)) continue;
      const outcome = await refusal(run(op.name, {}, staff(kim))).catch(() => ({ code: "ran" }));
      if (outcome.code !== "forbidden" && outcome.code !== "unknown_operation") {
        leaked.push(`${op.name}: ${outcome.code}`);
      }
    }
    expect(leaked).toEqual([]);
    // Its reads are its assignments and sessions only: not the bank, programs, class types or
    // sets as records, and nothing of the core's.
    for (const object of ["person", "organisation", "task", PROGRAM, EXERCISE, CLASSTYPE, LOG]) {
      for (const name of ["record.get", "record.list"]) {
        expect(
          await refusal(run(name, { object, id: "rec_x" }, staff(kim))),
          `${name} ${object}`,
        ).toMatchObject({ code: "forbidden" });
      }
    }
    // Not the builder's, the assigner's or a class's tools.
    for (const [name, input] of [
      ["x.programs.assign", { programId: clientProgram, personId: ada.personId, startDate: START }],
      ["x.programs.classToday", { classTypeId: classType }],
      ["x.programs.draft", { brief: "Four weeks of pressing" }],
      ["x.programs.importText", { text: "Week 1" }],
      ["person.get", { id: ada.personId }],
      ["person.list", {}],
      ["record.update", { object: SESSION, id: "rec_x", values: { state: "done" } }],
      ["record.publish", { object: PROGRAM, id: clientProgram }],
      ["query.sql", { sql: "SELECT 1" }],
    ] as const) {
      expect([name, (await refusal(run(name, input, staff(kim)))).code]).toEqual([
        name,
        "forbidden",
      ]);
    }
  }, 180_000);

  it("ends with the assignment and follows its coach, on the next call", async () => {
    const other = await staffAccount("Coach Lee");
    await run("user.setPackRole", { id: other.id, role: "programs.coach" }, staff(admin));
    const lee = { ...other, role: "viewer" as const };
    const list = async (who: ActingUser) =>
      (await run<Page>("record.list", { object: ASSIGNMENT }, staff(who))).items.map((a) => a.id);
    expect(await list(lee)).toEqual([]);
    // Ben gets a coach: Lee now reaches him, Kim still does not.
    await setCoach(benAssignment, lee.id);
    expect(await list(lee)).toEqual([benAssignment]);
    expect(await list(kim)).not.toContain(benAssignment);
    // His program ends: Lee reaches nothing of his again.
    await run(
      "record.update",
      { object: ASSIGNMENT, id: benAssignment, from: "active", values: { state: "ended" } },
      staff(admin),
    );
    expect(await list(lee)).toEqual([]);
    const [benMon] = await sessionsOf(benAssignment);
    expect(
      (await refusal(run("record.get", { object: SESSION, id: benMon?.id }, staff(lee)))).code,
    ).toBe("not_found");
  });

  it("follows a tool run into what it calls, and refuses what it cannot check", async () => {
    const limit: LooksAfterLimit = {
      userId: kim.id,
      teams: [
        {
          object: ASSIGNMENT,
          person: "person",
          staff: ["coach"],
          live: { field: "state", states: ["generating", "active"] },
        },
      ],
      reach: { [ASSIGNMENT]: "person", [SESSION]: "person", [LOG]: "person" },
    };
    const [benMon] = await sessionsOf(benAssignment);
    const [adaMon] = await sessionsOf(adaAssignment);
    // A member of staff whose call carries the limit (as a coach's tool run does) is held to it.
    expect(
      JSON.stringify(
        await refusal(
          run(
            "x.programs.sessionGet",
            { sessionId: benMon?.id },
            staff(plain, { roleLooksAfter: limit }),
          ),
        ),
      ),
    ).toContain("not_found");
    await run(
      "x.programs.sessionGet",
      { sessionId: adaMon?.id },
      staff(plain, { roleLooksAfter: limit }),
    );
    for (const [name, input] of [
      ["record.count", { object: SESSION }],
      ["record.createMany", { object: LOG, records: [{}] }],
    ] as const) {
      expect([
        name,
        (await refusal(run(name, input, staff(plain, { roleLooksAfter: limit })))).code,
      ]).toEqual([name, "forbidden"]);
    }
    // A delete is held as an update is: a set about someone else is not found.
    expect(
      (
        await refusal(
          run(
            "record.delete",
            { object: LOG, id: "rec_x" },
            staff(plain, { roleLooksAfter: limit }),
          ),
        )
      ).code,
    ).toBe("not_found");
    // A new set must be about one of the People; an update may not point a record at another.
    const values = {
      label: "A1 set 9",
      session: adaMon?.id,
      exercise: bank.row,
      date: START,
      person: ben.personId,
    };
    expect(
      (
        await refusal(
          run("record.create", { object: LOG, values }, staff(plain, { roleLooksAfter: limit })),
        )
      ).code,
    ).toBe("not_found");
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: SESSION, id: adaMon?.id, values: { person: ben.personId } },
            staff(plain, { roleLooksAfter: limit }),
          ),
        )
      ).code,
    ).toBe("not_found");
    // The list's limit is one subquery: its bound values are the account and the live states,
    // however many People it looks after (D1 allows 100 a statement).
    const where = looksAfterWhere(limit, SESSION, "s");
    expect(where?.compile(db.query).parameters).toEqual([kim.id, "generating", "active"]);
    expect(looksAfterWhere(limit, EXERCISE, "e")).toBeUndefined();
  });

  it("who a client's coach is, is a person's choice: anyone else's change waits for one", async () => {
    // Review of #392, finding 1: a member's assistant named Kim coach of Ben's program and Kim
    // reached his sessions at once. Now the write waits for a person, and nothing changes meanwhile.
    const nadia = await staffAccount("Nadia");
    const [eve] = [await createCustomer(admin, "eve", "Eve")];
    const eves = await assign({ programId: clientProgram, personId: eve.personId });
    const sessions = async () =>
      (
        await run<Page>(
          "record.list",
          { object: SESSION, filter: { field: "assignment", op: "eq", value: eves } },
          staff(kim),
        )
      ).items;
    expect(await sessions()).toEqual([]);
    for (const actor of [
      { actor: "assistant" as const, origin: { surface: "assistant" as const } },
      { actor: "mcp" as const, origin: { surface: "mcp" as const } },
    ]) {
      expect(
        await refusal(
          run(
            "record.update",
            { object: ASSIGNMENT, id: eves, values: { coach: kim.id } },
            staff(nadia, actor),
          ),
        ),
        actor.actor,
      ).toMatchObject({ code: "pending_approval" });
    }
    expect(await sessions()).toEqual([]);
    // Code cannot set it on its own either: an assignment created with a coach by an AI waits too.
    expect(
      await refusal(
        run(
          "record.create",
          {
            object: ASSIGNMENT,
            values: {
              title: "Sneaky",
              program: clientProgram,
              person: eve.personId,
              coach: kim.id,
              startDate: START,
            },
          },
          staff(nadia, { actor: "assistant", origin: { surface: "assistant" } }),
        ),
      ),
    ).toMatchObject({ code: "pending_approval" });
    // A person (any member of staff, in the admin) names the coach: Kim reaches Eve's sessions.
    await run(
      "record.update",
      { object: ASSIGNMENT, id: eves, values: { coach: kim.id } },
      staff(nadia),
    );
    expect(await sessions()).toHaveLength(4);
    await setCoach(eves, null);
    expect(await sessions()).toEqual([]);
  });

  it("fails closed: under the limit only the record operations it checks run (review finding 2)", async () => {
    const limit: LooksAfterLimit = {
      userId: kim.id,
      teams: [{ object: ASSIGNMENT, person: "person", staff: ["coach"] }],
      reach: { [SESSION]: "person" },
    };
    const [benMon] = await sessionsOf(benAssignment);
    const held = staff(plain, { roleLooksAfter: limit });
    // Operations that name records under another key than `object` are refused, not let through.
    for (const [name, input] of [
      ["task.create", { title: "Call Ben", links: [{ object: SESSION, id: benMon?.id }] }],
      ["task.create", { title: "No links at all" }],
      ["person.list", {}],
      ["record.count", { object: EXERCISE }],
    ] as const) {
      expect([name, (await refusal(run(name, input, held))).code]).toEqual([name, "forbidden"]);
    }
    // What it checks still runs: an object it does not limit, and the account's own screens.
    await run("record.list", { object: EXERCISE }, held);
    await run("screens.mine", {}, held);
    // The limit is the role's own pack's: another pack's tool the role reaches (Daily checklists'
    // anyStaff `today`, ADR 0652) runs without it, so its host operation (`checklist.today`) is not
    // refused; Programs' own tools carry it.
    const rights = await loadStaffRights(db.query, kim.id);
    const tool = (name: string) => ({ name }) as AnyOperation;
    expect(roleLooksAfterFor(rights, tool("x.dailychecks.today"), kim.id)).toBeUndefined();
    expect(roleLooksAfterFor(rights, tool("x.programs.sessionGet"), kim.id)).toMatchObject({
      userId: kim.id,
    });
    expect(roleLooksAfterFor(rights, tool("record.list"), kim.id)).toMatchObject({
      userId: kim.id,
    });
  });

  it("a team and a limit are a shipped pack's, and their mistakes are named", async () => {
    const manifest = toManifest(programsPack);
    expect(validateManifest(manifest).issues).toEqual([]);
    const broken = structuredClone(manifest);
    const assignment = broken.objects.assignment as { team?: Record<string, unknown> };
    assignment.team = { person: "classType", staff: ["assignedByName"], live: ["gone"] };
    (broken.roles.coach as { looksAfter?: Record<string, string> }).looksAfter = {
      "programs.session": "classType",
      "bookings.class": "person",
    };
    const messages = validateManifest(broken).issues.map((i) => `${i.path}: ${i.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^objects\.assignment\.team\.person: .*relation field .* to person/),
        expect.stringMatching(/^objects\.assignment\.team\.staff\.0: .*user field/),
        expect.stringMatching(/^objects\.assignment\.team\.live\.0: "gone" is not a state/),
        expect.stringMatching(/^roles\.coach\.looksAfter\.programs\.session: .*to person/),
        expect.stringMatching(/^roles\.coach\.looksAfter\.bookings\.class: .*not an object/),
      ]),
    );
    const loose = structuredClone(manifest);
    const coachField = (loose.objects.assignment as { fields: Record<string, unknown> }).fields
      .coach as { personApproves?: boolean };
    delete coachField.personApproves;
    expect(validateManifest(loose).issues.map((i) => `${i.path}: ${i.message}`)).toEqual([
      expect.stringMatching(/^objects\.assignment\.team\.staff\.0: .*a person approves/),
    ]);
    const noTeam = structuredClone(manifest);
    delete (noTeam.objects.assignment as { team?: unknown }).team;
    expect(validateManifest(noTeam).issues.map((i) => i.path)).toContain("roles.coach.looksAfter");
    // Code written in the app cannot say who looks after whom.
    const runtime = await checkManifest(
      db.query,
      "teamrun",
      { ...manifest, id: "teamrun", roles: {}, screens: {} },
      new Date().toISOString(),
      { source: "runtime" },
    );
    expect(runtime.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "outside_audience", path: "objects.assignment.team" }),
      ]),
    );
  });
});
