// The Programs pack against the SDK's test host: the manifest passes the contract, the layout
// schema refuses a broken layout with its path, and every tool does what it says for staff.
// The real host (the seam, customers, versions, the statement budget) is apps/runner/test/
// programs.test.ts.
import { validateDocument } from "@composable-os/sdk";
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import programs from "../index.ts";
import { LAYOUT_SCHEMA, type Layout, SESSION_PLAN_SCHEMA } from "../layout.ts";

const STAFF = { kind: "staff", userId: "usr_coach", name: "Coach Sam" } as const;

const pike = "rec_pike";
const row = "rec_row";
const hollow = "rec_hollow";

/** A class program with levels, and typed sets for a client, in one layout. */
function layout(): Layout {
  return {
    weeks: [
      {
        sessions: [
          {
            name: "Pike",
            day: 1,
            focus: "Depth",
            warmup: {
              text: "Wrists",
              exercises: [{ exercise: hollow, sets: [{ kind: "time", seconds: 30 }] }],
            },
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
                          exercise: pike,
                          sets: [{ kind: "reps", reps: 5, tempo: "5050" }],
                        },
                      },
                      {
                        mode: "alternatives",
                        level: 5,
                        exercises: [
                          {
                            exercise: pike,
                            sets: [{ kind: "reps", reps: 8, load: 10 }],
                            note: "legs as straight as possible",
                          },
                          { exercise: hollow, sets: [{ kind: "hold", seconds: 20, holds: 3 }] },
                        ],
                      },
                    ],
                    notes: [{ text: "Watch the knees" }, { text: "Breathe out", members: true }],
                  },
                  {
                    kind: "all",
                    label: "A2",
                    exercises: [
                      {
                        exercise: row,
                        sets: [
                          { kind: "reps", reps: 8, load: 20, rest: 90 },
                          { kind: "reps", reps: 8, load: 20, rest: 90 },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            name: "Pull",
            day: 4,
            blocks: [
              {
                label: "A",
                items: [
                  {
                    kind: "all",
                    label: "A1",
                    exercises: [{ exercise: row, sets: [{ kind: "reps", reps: 10 }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        sessions: [
          {
            name: "Pike again",
            day: 2,
            blocks: [
              {
                label: "A",
                items: [
                  {
                    kind: "all",
                    label: "A1",
                    exercises: [{ exercise: pike, sets: [{ kind: "reps", reps: 6 }] }],
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

function hostWith() {
  const host = createTestHost(programs, {
    records: {
      "programs.exercise": [
        { id: pike, name: "Pike compression", measure: "reps" },
        { id: row, name: "Ring row", measure: "weight_reps" },
        { id: hollow, name: "Hollow hold", measure: "hold" },
      ],
      "programs.program": [
        { id: "rec_prog", title: "Handstand basics", kind: "class", layout: layout() },
      ],
      "programs.classtype": [{ id: "rec_hand", name: "Handstands" }],
      person: [{ id: "per_ada", displayName: "Ada" }],
    },
    operations: {
      "person.get": (input) => ({ id: input.id, displayName: "Ada" }),
    },
  });
  return host;
}

describe("the pack", () => {
  it("passes the contract", () => {
    expect(createTestHost(programs).issues).toEqual([]);
  });

  it("has one layout schema for a class program with levels and a client program with sets", () => {
    expect(validateDocument(LAYOUT_SCHEMA, layout())).toMatchObject({ ok: true });
    const broken = layout() as unknown as {
      weeks: { sessions: { blocks: { items: Record<string, unknown>[] }[] }[] }[];
    };
    const item = broken.weeks[0]?.sessions[0]?.blocks[0]?.items[0] as {
      levels: Record<string, unknown>[];
    };
    (item.levels[1] as Record<string, unknown>).level = 1;
    const result = validateDocument(LAYOUT_SCHEMA, broken);
    expect(result.ok ? [] : result.issues).toEqual([
      {
        path: ["weeks", 0, "sessions", 0, "blocks", 0, "items", 0, "levels", 1, "level"],
        message: "1 is there twice (also entry 0)",
      },
    ]);
    // A generated session's plan is a session of the layout.
    expect(validateDocument(SESSION_PLAN_SCHEMA, layout().weeks[0]?.sessions[0])).toMatchObject({
      ok: true,
    });
  });
});

describe("assign", () => {
  it("pins the published version and makes the dated sessions, once", async () => {
    const host = hostWith();
    await expect(
      host.runTool(
        "assign",
        { programId: "rec_prog", personId: "per_ada", startDate: "2026-12-07" },
        { caller: STAFF },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(host.publish("programs.program", "rec_prog")).toBe(1);
    const out = await host.runTool<{ assignmentId: string; sessions: number; endDate: string }>(
      "assign",
      { programId: "rec_prog", personId: "per_ada", startDate: "2026-12-07" },
      { caller: STAFF },
    );
    expect(out).toMatchObject({
      programVersion: 1,
      sessions: 3,
      startDate: "2026-12-07",
      endDate: "2026-12-20",
    });
    const sessions = [...(host.records.get("programs.session")?.values() ?? [])];
    expect(sessions.map((s) => [s.name, s.date, s.week, s.day, s.kind, s.person])).toEqual([
      ["Pike", "2026-12-07", 1, 1, "personal", "per_ada"],
      ["Pull", "2026-12-10", 1, 4, "personal", "per_ada"],
      ["Pike again", "2026-12-15", 2, 2, "personal", "per_ada"],
    ]);
    const assignment = host.records.get("programs.assignment")?.get(out.assignmentId);
    expect(assignment).toMatchObject({
      state: "active",
      programVersion: 1,
      sessionCount: 3,
      title: "Handstand basics for Ada",
      assignedByName: "Coach Sam",
    });
    expect(host.calls.filter((c) => c.operation === "record.createMany")).toHaveLength(1);
  });
});

describe("logging and reading, as a coach", () => {
  async function assigned(target: { personId: string } | { classTypeId: string }) {
    const host = hostWith();
    host.publish("programs.program", "rec_prog");
    const out = await host.runTool<{ assignmentId: string }>(
      "assign",
      { programId: "rec_prog", startDate: "2026-12-07", ...target },
      { caller: STAFF },
    );
    const first = [...(host.records.get("programs.session")?.values() ?? [])][0] as { id: string };
    return { host, assignmentId: out.assignmentId, session: first.id };
  }

  it("logs a set against its target, says who recorded it, and reads it back", async () => {
    const { host, session } = await assigned({ personId: "per_ada" });
    const set = await host.runTool<Record<string, unknown>>(
      "logAdd",
      {
        sessionId: session,
        item: "A1",
        level: 5,
        exerciseId: pike,
        setNumber: 1,
        actual: { reps: 7, load: 10 },
        rpe: 8.5,
      },
      { caller: STAFF },
    );
    expect(set).toMatchObject({
      item: "A1",
      level: 5,
      exercise: pike,
      target: { reps: 8, load: 10, seconds: null },
      actual: { reps: 7, load: 10, seconds: null },
      rpe: 8.5,
      recordedAs: "staff",
      recordedByName: "Coach Sam",
    });
    const stored = [...(host.records.get("programs.log")?.values() ?? [])][0];
    expect(stored).toMatchObject({
      person: "per_ada",
      recordedBy: "usr_coach",
      date: "2026-12-07",
    });
    // The levels say which was taken; another person's name on this session is refused.
    await expect(
      host.runTool(
        "logAdd",
        { sessionId: session, item: "A1", setNumber: 1, actual: { reps: 1 } },
        { caller: STAFF },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      host.runTool(
        "logAdd",
        {
          sessionId: session,
          item: "A2",
          setNumber: 1,
          actual: { reps: 8 },
          personId: "per_other",
        },
        { caller: STAFF },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const updated = await host.runTool<Record<string, unknown>>(
      "logUpdate",
      { logId: stored?.id as string, actual: { reps: 8 }, note: "Felt good" },
      { caller: STAFF },
    );
    expect(updated).toMatchObject({
      actual: { reps: 8, load: 10 },
      note: "Felt good",
      target: { reps: 8 },
    });

    const read = await host.runTool<{
      logged: unknown[];
      exercises: { id: string; name: string }[];
    }>("sessionGet", { sessionId: session }, { caller: STAFF });
    expect(read.logged).toHaveLength(1);
    expect(read.exercises.map((e) => e.name).sort()).toEqual([
      "Hollow hold",
      "Pike compression",
      "Ring row",
    ]);

    const day = await host.runTool<{ sessions: { id: string }[] }>(
      "today",
      { date: "2026-12-07", personId: "per_ada" },
      { caller: STAFF },
    );
    expect(day.sessions.map((s) => s.id)).toEqual([session]);

    const done = await host.runTool<{ changed: boolean; session: { state: string } }>(
      "sessionComplete",
      { sessionId: session },
      { caller: STAFF },
    );
    expect(done).toMatchObject({ changed: true, session: { state: "done" } });
    expect(
      (
        await host.runTool<{ changed: boolean }>(
          "sessionComplete",
          { sessionId: session },
          { caller: STAFF },
        )
      ).changed,
    ).toBe(false);

    const history = await host.runTool<{ sets: unknown[]; best: Record<string, unknown> }>(
      "history",
      { exerciseId: pike, personId: "per_ada" },
      { caller: STAFF },
    );
    expect(history).toMatchObject({ best: { load: 10, reps: 8, seconds: null } });
    expect(history.sets).toHaveLength(1);

    const progress = await host.runTool<{
      exercises: unknown[];
      assignments: Record<string, unknown>[];
    }>("progress", { personId: "per_ada" }, { caller: STAFF });
    expect(progress.exercises).toEqual([
      {
        id: pike,
        name: "Pike compression",
        sets: 1,
        first: "2026-12-07",
        last: "2026-12-07",
        best: { load: 10, reps: 8, seconds: null },
      },
    ]);
    expect(progress.assignments[0]).toMatchObject({ sessions: 3, done: 1, planned: 2, skipped: 0 });
  });

  it("a class type's session: read with its levels, and logged for a named member", async () => {
    const { host, session } = await assigned({ classTypeId: "rec_hand" });
    const today = await host.runTool<{ sessions: { id: string; kind: string }[] }>(
      "classToday",
      { classTypeId: "rec_hand", date: "2026-12-07" },
      { caller: STAFF },
    );
    expect(today.sessions).toMatchObject([{ id: session, kind: "class" }]);
    await expect(
      host.runTool(
        "logAdd",
        { sessionId: session, item: "A2", setNumber: 1, actual: { reps: 8 } },
        { caller: STAFF },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const set = await host.runTool<Record<string, unknown>>(
      "logAdd",
      {
        sessionId: session,
        item: "A1",
        level: 1,
        setNumber: 1,
        actual: { reps: 5 },
        personId: "per_ada",
      },
      { caller: STAFF },
    );
    expect(set).toMatchObject({ level: 1, target: { reps: 5 } });
  });
});
