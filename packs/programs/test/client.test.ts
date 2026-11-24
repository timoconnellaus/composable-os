// The headless entry's editing functions: a 12-week program built with them is a layout the
// host's schema accepts; a fault the host reports lands on the part it names.
import { validateDocument } from "@composable-os/sdk";
import { describe, expect, it } from "vitest";
import {
  correctionOf,
  describeDone,
  describeSets,
  layoutEdits as e,
  emptyLayout,
  exercisesIn,
  faultsOf,
  faultsUnder,
  LOG,
  type LoggedSet,
  layoutSummary,
  loadPastSessions,
  move,
  pastSessionsOf,
  pathOf,
  plannedSets,
  SESSION,
  sessionSets,
} from "../client/index.ts";
import { LAYOUT_SCHEMA, type Layout, type Session } from "../layout.ts";

const pike = "rec_pike";
const row = "rec_row";
const hollow = "rec_hollow";

describe("building a program with the editing functions", () => {
  it("a 12-week program of three sessions, levels, sets and notes, copied week to week", () => {
    let l: Layout = emptyLayout();
    for (let s = 0; s < 3; s += 1) l = e.addSession(l, 0);
    expect(l.weeks[0]?.sessions.map((s) => s.day)).toEqual([1, 3, 5]);
    const monday = { week: 0, session: 0 };
    l = e.setSession(l, monday, { name: "Press", focus: "Depth" });
    l = e.addBlock(l, monday);
    l = e.setBlock(l, { ...monday, block: 0 }, { rounds: 4 });
    l = e.addItem(l, { ...monday, block: 0 }, row, "weight_reps");
    l = e.addItem(l, { ...monday, block: 0 }, pike, "reps", "levels");
    const a2 = { ...monday, block: 0, item: 1 };
    l = e.addLevel(l, a2, pike, "reps", 5);
    l = e.addExercise(l, { ...a2, level: 1 }, hollow, "hold");
    l = e.setLevelMode(l, { ...a2, level: 1 }, "alternatives");
    l = e.setSet(
      l,
      { ...a2, level: 1, exercise: 1, set: 0 },
      { kind: "hold", seconds: 20, holds: 3 },
    );
    l = e.setSet(
      l,
      { ...monday, block: 0, item: 0, exercise: 0, set: 0 },
      { load: 20, tempo: "32X1", rest: 90 },
    );
    l = e.addNote(l, a2, "Watch the knees");
    l = e.addNote(l, a2, "Breathe out", true);
    // Every other session as Monday's, then eleven more weeks as the first.
    l = e.copySession(l, monday, 0);
    l = e.removeSession(l, { week: 0, session: 1 });
    for (let w = 1; w < 12; w += 1) l = e.copyWeek(l, w - 1);
    expect(layoutSummary(l)).toEqual({ weeks: 12, sessions: 36, items: 24 });
    expect(exercisesIn(l).sort()).toEqual([hollow, pike, row].sort());
    const item = l.weeks[11]?.sessions[0]?.blocks[0]?.items[1];
    expect(item?.kind === "levels" && item.levels.map((x) => [x.level, x.mode])).toEqual([
      [1, "one"],
      [5, "alternatives"],
    ]);
    expect(item?.notes).toEqual([
      { text: "Watch the knees" },
      { text: "Breathe out", members: true },
    ]);
    const first = l.weeks[0]?.sessions[0]?.blocks[0]?.items[0];
    expect(first?.kind === "all" && describeSets(first.exercises[0]?.sets ?? [])).toBe(
      "8 reps @ 20 kg, 32X1, rest 90 s, then 2 × 8 reps",
    );
    // Sessions with no block are not valid: the host would say so. Give them one.
    for (let w = 0; w < 12; w += 1) {
      for (const s of [1, 2]) {
        const at = { week: w, session: s };
        if (!l.weeks[w]?.sessions[s]?.blocks.length) {
          l = e.addBlock(l, at);
          l = e.addItem(l, { ...at, block: 0 }, row, "weight_reps");
        }
      }
    }
    expect(validateDocument(LAYOUT_SCHEMA, l, { maxBytes: 524_288 })).toMatchObject({ ok: true });
  });

  it("moves items between blocks, keeps a set's own fields when its kind changes", () => {
    let l: Layout = e.addSession(emptyLayout(), 0);
    const at = { week: 0, session: 0 };
    l = e.addBlock(e.addBlock(l, at), at);
    l = e.addItem(l, { ...at, block: 0 }, row);
    l = e.addItem(l, { ...at, block: 0 }, pike);
    l = e.moveItem(l, { ...at, block: 0, item: 1 }, { block: 1, item: 0 });
    expect(l.weeks[0]?.sessions[0]?.blocks.map((b) => b.items.map((i) => i.label))).toEqual([
      ["A1"],
      ["A2"],
    ]);
    l = e.setSet(
      l,
      { ...at, block: 0, item: 0, exercise: 0, set: 0 },
      { kind: "reps", reps: 5, load: 40, tempo: "2020" },
    );
    l = e.setSet(l, { ...at, block: 0, item: 0, exercise: 0, set: 0 }, { kind: "time" });
    const set = l.weeks[0]?.sessions[0]?.blocks[0]?.items[0];
    expect(set?.kind === "all" && set.exercises[0]?.sets[0]).toEqual({
      kind: "time",
      seconds: 30,
      load: 40,
    });
    expect(move(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
});

describe("faults from the host", () => {
  it("land on the part they name, and on what holds it", () => {
    const error = {
      code: "invalid_input",
      message:
        "Invalid value for programs.program.layout: layout.weeks.1.sessions.0.day: At most 7",
      details: {
        field: "layout",
        issues: [
          { path: ["weeks", 1, "sessions", 0, "day"], message: "At most 7" },
          {
            path: ["weeks", 1, "sessions", 0, "blocks", 0, "items", 2, "label"],
            message: "Required",
          },
        ],
      },
    };
    const faults = faultsOf(error);
    const item = pathOf({ week: 1, session: 0, block: 0, item: 2 });
    expect(faultsUnder(faults, item)).toEqual(["Required"]);
    expect(faultsUnder(faults, pathOf({ week: 1, session: 0 }))).toEqual(["At most 7", "Required"]);
    expect(faultsUnder(faults, pathOf({ week: 0 }))).toEqual([]);
    const ref = faultsOf({
      message:
        "layout.weeks.0.sessions.0.blocks.0.items.0.exercises.0.exercise: no live programs.exercise with id x",
      details: {
        field: "layout",
        path: ["weeks", 0, "sessions", 0, "blocks", 0, "items", 0, "exercises", 0, "exercise"],
      },
    });
    expect([...ref.values()]).toEqual(["no live programs.exercise with id x"]);
  });
});

describe("past sessions", () => {
  const plan: Session = {
    name: "Press",
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
                exercise: row,
                sets: [
                  { kind: "reps", reps: 8, load: 20 },
                  { kind: "reps", reps: 8 },
                ],
              },
            ],
          },
          {
            kind: "levels",
            label: "A2",
            levels: [
              {
                mode: "one",
                level: 1,
                exercise: { exercise: pike, sets: [{ kind: "reps", reps: 5 }] },
              },
              {
                mode: "alternatives",
                level: 5,
                exercises: [
                  {
                    exercise: pike,
                    sets: [
                      { kind: "reps", reps: 3 },
                      { kind: "reps", reps: 3 },
                    ],
                  },
                  {
                    exercise: hollow,
                    sets: [
                      { kind: "hold", seconds: 20 },
                      { kind: "hold", seconds: 20 },
                      { kind: "hold", seconds: 20 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const set = (values: Partial<LoggedSet>): LoggedSet => ({
    id: "log_1",
    item: "A1",
    exercise: row,
    setNumber: 1,
    level: null,
    target: { reps: 8, seconds: null, load: 20 },
    actual: { reps: 8, seconds: null, load: 20 },
    rpe: 7,
    note: null,
    recordedAs: "self",
    recordedByName: null,
    exerciseName: "Ring row",
    ...values,
  });

  it("lists every set of the plan with what was logged, the level and alternative taken", () => {
    // Nothing logged: the first level of A2, two sets of A1.
    expect(sessionSets(plan, []).map((s) => [s.item, s.exercise, s.setNumber, s.level])).toEqual([
      ["A1", row, 1, null],
      ["A1", row, 2, null],
      ["A2", pike, 1, 1],
    ]);
    expect(plannedSets(plan, [])).toBe(3);
    // Level 5 taken, the hollow hold chosen of the alternatives, and a fourth set beyond the plan.
    const logged = [
      set({}),
      set({ id: "log_2", item: "A2", exercise: hollow, level: 5, setNumber: 1 }),
      set({ id: "log_3", item: "A2", exercise: hollow, level: 5, setNumber: 4 }),
    ];
    const sets = sessionSets(plan, logged);
    expect(sets.map((s) => [s.item, s.exercise, s.setNumber, s.logged?.id ?? null])).toEqual([
      ["A1", row, 1, "log_1"],
      ["A1", row, 2, null],
      ["A2", hollow, 1, "log_2"],
      ["A2", hollow, 2, null],
      ["A2", hollow, 3, null],
      ["A2", hollow, 4, "log_3"],
    ]);
    expect(sets.at(-1)?.target).toBeNull();
    expect(plannedSets(plan, logged)).toBe(5);
  });

  it("an item with exercises for everyone and levels lists everyone's, then the level's", () => {
    const both: Session = {
      name: "Both",
      day: 1,
      blocks: [
        {
          label: "A",
          items: [
            {
              kind: "levels",
              label: "A1",
              exercises: [{ exercise: hollow, sets: [{ kind: "time", seconds: 30 }] }],
              levels: [
                {
                  mode: "one",
                  level: 2,
                  exercise: { exercise: pike, sets: [{ kind: "reps", reps: 5 }] },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(sessionSets(both, []).map((s) => [s.item, s.exercise, s.setNumber])).toEqual([
      ["A1", hollow, 1],
      ["A1", pike, 1],
    ]);
    expect(plannedSets(both, [])).toBe(2);
  });

  it("a session imported from before, with no plan, lists the sets logged on it", () => {
    const logged = [
      set({ id: "log_b", item: null, exercise: pike, setNumber: 2 }),
      set({ id: "log_a", item: null, exercise: pike, setNumber: 1 }),
    ];
    expect(sessionSets(null, logged).map((s) => [s.logged?.id, s.setNumber, s.target])).toEqual([
      ["log_a", 1, null],
      ["log_b", 2, null],
    ]);
    expect(plannedSets(null, logged)).toBe(0);
  });

  it("past sessions include imported ones: assigned to the person, or brought in from before", async () => {
    const asked: unknown[] = [];
    await loadPastSessions(
      async (input) => {
        asked.push(input.filter);
        return { items: [], nextCursor: null };
      },
      { until: "2027-01-08" },
    );
    expect(JSON.stringify(asked[0])).toContain('"source"');
    expect(JSON.stringify(asked[0])).toContain('"personal"');
  });

  it("summarises sessions with their sets done of planned", () => {
    const sessions = [
      {
        object: SESSION,
        id: "ses_2",
        values: { name: "Press", date: "2027-01-08", plan, state: "done" },
      },
      {
        object: SESSION,
        id: "ses_1",
        values: { name: "Pull", date: "2027-01-04", plan: null, state: "skipped" },
      },
    ];
    const logs = [
      {
        object: LOG,
        id: "log_1",
        values: { session: "ses_2", item: "A1", exercise: row, setNumber: 1 },
      },
      {
        object: LOG,
        id: "log_2",
        values: { session: "ses_2", item: "A1", exercise: row, setNumber: 2 },
      },
    ];
    expect(pastSessionsOf(sessions, logs)).toMatchObject([
      { id: "ses_2", date: "2027-01-08", setsDone: 2, setsPlanned: 3, state: "done" },
      { id: "ses_1", setsDone: 0, setsPlanned: 0, state: "skipped" },
    ]);
  });

  it("a correction carries only what changed, and nothing when nothing did", () => {
    const done = set({ note: "Easy" });
    expect(
      correctionOf(done, { count: "8", load: "20", rpe: "7", note: "Easy" }, false),
    ).toBeNull();
    expect(correctionOf(done, { count: "6", load: "22,5", rpe: "8.5", note: "" }, false)).toEqual({
      logId: "log_1",
      actual: { reps: 6, load: 22.5 },
      rpe: 8.5,
      note: null,
    });
    expect(
      correctionOf(
        set({ actual: { reps: null, seconds: 20, load: null } }),
        { count: "25", load: "", rpe: "7", note: "" },
        true,
      ),
    ).toEqual({
      logId: "log_1",
      actual: { seconds: 25 },
    });
    expect(describeDone(done)).toBe("8 reps @ 20 kg · RPE 7");
  });
});
