// The headless entry's editing functions: a 12-week program built with them is a layout the
// host's schema accepts; a fault the host reports lands on the part it names.
import { validateDocument } from "@composable-os/sdk";
import { describe, expect, it } from "vitest";
import {
  describeSets,
  emptyLayout,
  exercisesIn,
  faultsOf,
  faultsUnder,
  layoutEdits as e,
  layoutSummary,
  move,
  pathOf,
} from "../client/index.ts";
import { LAYOUT_SCHEMA, type Layout } from "../layout.ts";

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
    l = e.setSet(l, { ...a2, level: 1, exercise: 1, set: 0 }, { kind: "hold", seconds: 20, holds: 3 });
    l = e.setSet(l, { ...monday, block: 0, item: 0, exercise: 0, set: 0 }, { load: 20, tempo: "32X1", rest: 90 });
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
    expect(item?.notes).toEqual([{ text: "Watch the knees" }, { text: "Breathe out", members: true }]);
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
    expect(l.weeks[0]?.sessions[0]?.blocks.map((b) => b.items.map((i) => i.label))).toEqual([["A1"], ["A2"]]);
    l = e.setSet(l, { ...at, block: 0, item: 0, exercise: 0, set: 0 }, { kind: "reps", reps: 5, load: 40, tempo: "2020" });
    l = e.setSet(l, { ...at, block: 0, item: 0, exercise: 0, set: 0 }, { kind: "time" });
    const set = l.weeks[0]?.sessions[0]?.blocks[0]?.items[0];
    expect(set?.kind === "all" && set.exercises[0]?.sets[0]).toEqual({ kind: "time", seconds: 30, load: 40 });
    expect(move(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
});

describe("faults from the host", () => {
  it("land on the part they name, and on what holds it", () => {
    const error = {
      code: "invalid_input",
      message: "Invalid value for programs.program.layout: layout.weeks.1.sessions.0.day: At most 7",
      details: {
        field: "layout",
        issues: [
          { path: ["weeks", 1, "sessions", 0, "day"], message: "At most 7" },
          { path: ["weeks", 1, "sessions", 0, "blocks", 0, "items", 2, "label"], message: "Required" },
        ],
      },
    };
    const faults = faultsOf(error);
    const item = pathOf({ week: 1, session: 0, block: 0, item: 2 });
    expect(faultsUnder(faults, item)).toEqual(["Required"]);
    expect(faultsUnder(faults, pathOf({ week: 1, session: 0 }))).toEqual(["At most 7", "Required"]);
    expect(faultsUnder(faults, pathOf({ week: 0 }))).toEqual([]);
    const ref = faultsOf({
      message: "layout.weeks.0.sessions.0.blocks.0.items.0.exercises.0.exercise: no live programs.exercise with id x",
      details: { field: "layout", path: ["weeks", 0, "sessions", 0, "blocks", 0, "items", 0, "exercises", 0, "exercise"] },
    });
    expect([...ref.values()]).toEqual(["no live programs.exercise with id x"]);
  });
});
