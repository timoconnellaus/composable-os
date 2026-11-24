// Stage 41, fast logging: what a phone's logger relies on in the host, with real D1. A set is
// logged once per person however many saves of it arrive (one after another, or at once); a set
// ticked by mistake is taken back by its own person (`my.delete`, ADR 0414 amended) or their
// coach, and by nobody else; and the pack's session log, driven as the session screens drive it
// (three ticks at once, an answer lost after the host committed, an un-tick), leaves each set on
// the host exactly once with the numbers last shown.
import { env } from "cloudflare:workers";
import type { ActingUser, CustomerPrincipal } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createProgramsHooks,
  PROGRAMS_HOOKS_CALL as HOOKS_CALL,
  logExercisesOf,
  type ProgramsClient,
  type Session,
} from "../../../packs/programs/client/index.ts";
import type { Layout } from "../../../packs/programs/layout.ts";
import { createAdmin } from "./helpers.ts";
import {
  as,
  create,
  createCustomer,
  EXERCISE,
  installPrograms,
  LOG,
  PROGRAM,
  refusal,
  run,
  staff,
} from "./programs-fixture.ts";

let admin: ActingUser;
let a: CustomerPrincipal;
let b: CustomerPrincipal;
let squat: string;
let plank: string;

function layout(): Layout {
  return {
    weeks: [
      {
        sessions: [
          {
            name: "Legs",
            day: 1,
            blocks: [
              {
                label: "A",
                items: [
                  {
                    kind: "all",
                    label: "A1",
                    exercises: [
                      {
                        exercise: squat,
                        sets: [
                          { kind: "reps", reps: 5, load: 100, rest: 120 },
                          { kind: "reps", reps: 5, load: 100, rest: 120 },
                          { kind: "reps", reps: 5, load: 100, rest: 120 },
                        ],
                      },
                    ],
                  },
                  {
                    kind: "all",
                    label: "A2",
                    exercises: [{ exercise: plank, sets: [{ kind: "hold", seconds: 30 }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** A session of `layout()` for `who`, on `date`. */
async function sessionFor(who: CustomerPrincipal, date: string): Promise<string> {
  const program = await create(admin, PROGRAM, {
    title: `Legs ${date}`,
    kind: "client",
    layout: layout(),
  });
  await run("record.publish", { object: PROGRAM, id: program }, staff(admin));
  await run(
    "x.programs.assign",
    { programId: program, personId: who.personId, startDate: date },
    staff(admin),
  );
  const today = await run<{ sessions: { id: string }[] }>("x.programs.today", { date }, as(who));
  return today.sessions[0]?.id as string;
}

/** The live rows of a session's sets for a person, by item and set number. */
async function rows(sessionId: string, personId: string) {
  const page = await run<{ items: { values: Record<string, unknown> }[] }>(
    "record.list",
    {
      object: LOG,
      filter: {
        and: [
          { field: "session", op: "eq", value: sessionId },
          { field: "person", op: "eq", value: personId },
        ],
      },
      limit: 100,
    },
    staff(admin),
  );
  return page.items
    .map((r) => r.values)
    .sort(
      (x, y) =>
        String(x.item).localeCompare(String(y.item)) || Number(x.setNumber) - Number(y.setNumber),
    )
    .map((v) => ({
      setNumber: v.setNumber,
      reps: v.actualReps ?? null,
      load: v.actualLoad ?? null,
      rpe: v.rpe ?? null,
      ...(v.actualSeconds !== null && v.actualSeconds !== undefined
        ? { seconds: v.actualSeconds }
        : {}),
    }));
}

const trashed = async () =>
  (
    await env.DB.prepare(
      "SELECT count(*) AS n FROM x_programs_log WHERE deleted_at IS NOT NULL",
    ).first<{ n: number }>()
  )?.n ?? 0;

beforeAll(async () => {
  admin = await createAdmin();
  await installPrograms(admin);
  squat = await create(admin, EXERCISE, { name: "Back squat", measure: "weight_reps" });
  plank = await create(admin, EXERCISE, { name: "Plank", measure: "hold" });
  a = await createCustomer(admin, "fast-a", "Ada");
  b = await createCustomer(admin, "fast-b", "Bo");
}, 120_000);

describe("a set is logged once per person", () => {
  it("the same set saved again changes it instead of logging it twice", async () => {
    const sessionId = await sessionFor(a, "2027-10-04");
    const set = { sessionId, item: "A1", setNumber: 1 };
    const first = await run<{ id: string }>(
      "x.programs.logAdd",
      { ...set, actual: { reps: 5, load: 100 }, rpe: 8 },
      as(a),
    );
    const again = await run<{ id: string; actual: unknown; rpe: number | null }>(
      "x.programs.logAdd",
      { ...set, actual: { reps: 4, load: 102.5 } },
      as(a),
    );
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ actual: { reps: 4, load: 102.5, seconds: null }, rpe: null });
    expect(await rows(sessionId, a.personId)).toEqual([
      { setNumber: 1, reps: 4, load: 102.5, rpe: null },
    ]);
  });

  it("two saves of one set at once leave one row", async () => {
    const sessionId = await sessionFor(a, "2027-10-05");
    const save = (reps: number) =>
      run("x.programs.logAdd", { sessionId, item: "A1", setNumber: 2, actual: { reps } }, as(a));
    const results = await Promise.allSettled([save(5), save(5), save(5)]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThan(0);
    expect(await rows(sessionId, a.personId)).toHaveLength(1);
  });

  it("a coach saving a client's set twice leaves one row too", async () => {
    const sessionId = await sessionFor(a, "2027-10-06");
    const set = { sessionId, item: "A1", setNumber: 1, personId: a.personId };
    await run("x.programs.logAdd", { ...set, actual: { reps: 5 } }, staff(admin));
    await run("x.programs.logAdd", { ...set, actual: { reps: 6 } }, staff(admin));
    expect(await rows(sessionId, a.personId)).toEqual([
      { setNumber: 1, reps: 6, load: null, rpe: null },
    ]);
  });
});

describe("taking a set back", () => {
  it("its person takes it back, a retry changes nothing, and nobody else can", async () => {
    const sessionId = await sessionFor(a, "2027-10-11");
    const set = { sessionId, item: "A1", exerciseId: squat, setNumber: 1 };
    await run("x.programs.logAdd", { ...set, actual: { reps: 5 } }, as(a));
    // B cannot reach A's session at all.
    expect(await refusal(run("x.programs.logRemove", set, as(b)))).toMatchObject({
      inner: "not_found",
    });
    expect(await rows(sessionId, a.personId)).toHaveLength(1);
    // A customer never calls my.delete themselves: only a pack tool does.
    const id = (await run<{ items: { id: string }[] }>("my.list", { object: LOG }, as(a))).items[0]
      ?.id;
    expect(await refusal(run("my.delete", { object: LOG, id }, as(a)))).toMatchObject({
      code: "unknown_operation",
    });
    const inTrash = await trashed();
    expect(await run("x.programs.logRemove", set, as(a))).toEqual({ removed: 1, waiting: 0 });
    expect(await run("x.programs.logRemove", set, as(a))).toEqual({ removed: 0, waiting: 0 });
    expect(await rows(sessionId, a.personId)).toEqual([]);
    // In the Trash, where staff can restore it.
    expect(await trashed()).toBe(inTrash + 1);
    // Logged again after it was taken back: a new row, so the set is there once.
    await run("x.programs.logAdd", { ...set, actual: { reps: 3 } }, as(a));
    expect(await rows(sessionId, a.personId)).toEqual([
      { setNumber: 1, reps: 3, load: null, rpe: null },
    ]);
  });

  it("a coach takes back a client's set, as the org's approval policy says", async () => {
    const sessionId = await sessionFor(a, "2027-10-12");
    const set = { sessionId, item: "A1", exerciseId: squat, setNumber: 1 };
    const coach = { ...set, personId: a.personId };
    await run("x.programs.logAdd", { ...set, actual: { reps: 5 } }, as(a));
    // Balanced: an extension's delete waits for a person; it is queued, and the set is still there.
    await run("policy.update", { preset: "balanced" }, staff(admin));
    expect(await run("x.programs.logRemove", coach, staff(admin))).toEqual({
      removed: 0,
      waiting: 1,
    });
    expect(await rows(sessionId, a.personId)).toHaveLength(1);
    // Autonomous: it is taken back at once.
    await run("policy.update", { preset: "autonomous" }, staff(admin));
    try {
      expect(await run("x.programs.logRemove", coach, staff(admin))).toEqual({
        removed: 1,
        waiting: 0,
      });
    } finally {
      await run("policy.update", { preset: "balanced" }, staff(admin));
    }
    expect(await rows(sessionId, a.personId)).toEqual([]);
  });

  it("my.delete from a tool: only an object that allows it, and only the caller's own", async () => {
    const sessionId = await sessionFor(a, "2027-10-13");
    const mine = await run<{ id: string }>(
      "x.programs.logAdd",
      { sessionId, item: "A1", setNumber: 1, actual: { reps: 5 } },
      as(a),
    );
    // As the runner calls it for a pack's tool run by a customer.
    const fromTool = (who: CustomerPrincipal) => ({
      ...as(who),
      tool: { extension: "programs", tool: "logRemove" },
    });
    // A session's object does not let its customer delete: refused whoever owns it.
    expect(
      await refusal(run("my.delete", { object: "programs.session", id: sessionId }, fromTool(a))),
    ).toMatchObject({ code: "forbidden" });
    // Another member's set is not there for B.
    expect(
      await refusal(run("my.delete", { object: LOG, id: mine.id }, fromTool(b))),
    ).toMatchObject({ code: "not_found" });
    expect(await rows(sessionId, a.personId)).toHaveLength(1);
    expect(await run("my.delete", { object: LOG, id: mine.id }, fromTool(a))).toEqual({
      id: mine.id,
    });
    expect(await rows(sessionId, a.personId)).toEqual([]);
  });
});

describe("the session log against the host", () => {
  /** The member's hooks over the host, with a logAdd whose answer can be lost after it committed. */
  function hooks(who: CustomerPrincipal, lose: Set<number>) {
    let adds = 0;
    const ctx = as(who);
    const client: ProgramsClient & { operations: Record<string, unknown> } = {
      operations: Object.fromEntries(
        Object.values(HOOKS_CALL)
          .flat()
          .map((n) => [n, true]),
      ),
      query: ((name: string, input: unknown) => ({
        queryKey: [name, input],
        queryFn: () => run(name, input, ctx),
      })) as ProgramsClient["query"],
      mutation: ((name: string) => ({
        mutationKey: [name],
        mutationFn: async (input: unknown) => {
          const out = await run(name, input, ctx);
          if (name === "x.programs.logAdd") {
            adds += 1;
            if (lose.has(adds)) throw new TypeError("Network request failed");
          }
          return out;
        },
      })) as ProgramsClient["mutation"],
    };
    return createProgramsHooks(
      {
        useQuery: () => ({ data: undefined, isPending: true, error: null }),
        useMutation: (options) => ({
          mutate: (input) => void options.mutationFn(input),
          mutateAsync: options.mutationFn,
          data: undefined,
          isPending: false,
          error: null,
        }),
        useState: <T>(initial: T) => [initial, () => undefined],
        useEffect: () => undefined,
      },
      client,
    );
  }

  it("three ticks at once, a number typed then ticked, a lost answer and an un-tick: each set once", async () => {
    const sessionId = await sessionFor(b, "2027-10-18");
    const { log } = hooks(b, new Set([2])).useSessionLog({ sessionId });
    const detail = await run<{
      session: { plan: unknown };
      exercises: { id: string; last: [] }[];
      logged: [];
    }>("x.programs.sessionGet", { sessionId }, as(b));
    log.dispatch({
      type: "load",
      exercises: logExercisesOf(detail.session.plan as Session, detail.exercises),
      logged: detail.logged,
    });
    const at = (setNumber: number) => ({ item: "A1", exercise: squat, setNumber });
    // A weight typed key by key and ticked at once; then two more ticks, all before any answer.
    for (const text of ["1", "10", "105"]) {
      log.dispatch({ type: "edit", ...at(1), field: "load", text });
    }
    log.dispatch({ type: "toggle", ...at(1) });
    log.dispatch({ type: "toggle", ...at(2) });
    log.dispatch({ type: "toggle", ...at(3) });
    log.dispatch({ type: "rpe", ...at(3), rpe: 9 });
    // The plank, timed: its timer's seconds tick it.
    log.dispatch({
      type: "tick",
      item: "A2",
      exercise: plank,
      setNumber: 1,
      values: { seconds: "41" },
    });
    // The second save's answer is lost after the host committed it: the flush says so.
    expect(await log.flush()).toBe(false);
    expect(log.getState().failure).toBeTruthy();
    // Set 2 ticked by mistake: taken back.
    log.dispatch({ type: "toggle", ...at(2) });
    expect(await log.flush()).toBe(true);
    expect(await rows(sessionId, b.personId)).toEqual([
      { setNumber: 1, reps: 5, load: 105, rpe: null },
      { setNumber: 3, reps: 5, load: 105, rpe: 9 },
      { setNumber: 1, reps: null, load: null, rpe: null, seconds: 41 },
    ]);
  });
});
