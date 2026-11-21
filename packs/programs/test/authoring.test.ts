// Step 6: the shorthand import and the draft, as pure functions over a bank and as tools on the
// SDK's test host. The real host (refs checked, never published) is apps/runner/test.
import { validateDocument } from "@composable-os/sdk";
import { createTestHost } from "@composable-os/sdk/testing";
import { describe, expect, it } from "vitest";
import {
  draftLayout,
  pickExercises,
  readBrief,
  readProgramText,
  readTarget,
} from "../authoring.ts";
import programs from "../index.ts";
import { LAYOUT_SCHEMA, type Layout } from "../layout.ts";
import { SHORTHAND, SHORTHAND_BANK } from "./shorthand.ts";

const bank = SHORTHAND_BANK.map((e, i) => ({ id: `rec_ex${i}`, ...e }));
const idOf = (name: string) => bank.find((e) => e.name === name)?.id;

describe("reading shorthand", () => {
  const read = readProgramText(SHORTHAND, bank);

  it("lays out sessions, blocks, items and levels with structured targets", () => {
    expect(read.title).toBe("Strength block");
    expect(read.guidance).toBe(
      "Reps and tempo are followed literally; rounds are a guide.\nHarder levels need longer rest.",
    );
    const [monday, thursday] = read.layout.weeks[0]?.sessions ?? [];
    expect([monday?.name, monday?.day, thursday?.day]).toEqual(["Monday", 1, 4]);
    expect(monday?.warmup).toEqual({
      text: "Wrists, shoulders and a light forward fold\n- Wrist circles",
      exercises: [{ exercise: idOf("Scap push ups"), sets: [{ kind: "reps", reps: 10 }] }],
    });
    const a = monday?.blocks[0];
    expect(a).toMatchObject({
      label: "A",
      rounds: 4,
      notes: [{ text: "Approx 4-7 rounds", members: true }],
    });
    const a1 = a?.items[0];
    expect(a1?.kind).toBe("levels");
    if (a1?.kind !== "levels") return;
    expect(a1.levels.map((l) => [l.level, l.mode])).toEqual([
      [1, "together"],
      [3, "alternatives"],
      [5, "one"],
    ]);
    const one = a1.levels[0];
    if (one?.mode !== "together") throw new Error("level 1 is two together");
    // Four rounds: four sets of each; the coach's words beside the numbers.
    expect(one.exercises[0]).toEqual({
      exercise: idOf("L sit"),
      sets: Array.from({ length: 4 }, () => ({ kind: "time", seconds: 8 })),
      note: "8-12 sec (legs as straight as possible)",
    });
    expect(one.exercises[1]?.sets[0]).toEqual({ kind: "reps", reps: 3 });
    expect(one.exercises[1]?.note).toBe("3 reps with a 5 sec hold each rep");
    const three = a1.levels[1];
    if (three?.mode !== "alternatives") throw new Error("level 3 is alternatives");
    expect(three.exercises[0]?.sets[0]).toEqual({ kind: "reps", reps: 3, tempo: "32X3" });
    expect(a1.notes).toEqual([
      { text: "L sit to planche", members: true },
      { text: "if this is too hard they can do L-sit walk ups" },
      { text: "level 3 needs hips at shoulder height" },
      { text: "Breathe out on the press", members: true },
    ]);
    expect(a?.items[1]).toEqual({
      kind: "all",
      label: "A2",
      exercises: [
        {
          exercise: idOf("Ring rows"),
          sets: Array.from({ length: 4 }, () => ({ kind: "reps", reps: 5, tempo: "5050" })),
        },
      ],
      notes: [{ text: "elevate the feet to make it harder" }],
    });
    // A hold read as seconds, three rounds.
    expect(monday?.blocks[1]?.items.map((i) => i.label)).toEqual(["B1", "B3"]);
    const b3 = monday?.blocks[1]?.items[1];
    expect(b3?.kind === "all" && b3.exercises[0]?.sets).toEqual(
      Array.from({ length: 3 }, () => ({ kind: "hold", seconds: 30 })),
    );
  });

  it("lists every line it could not read, with why", () => {
    expect(read.unread).toEqual([
      {
        line: 8,
        text: "- Wrist circles",
        reason: 'kept as warm-up text: no exercise in the bank is called "Wrist circles"',
      },
      {
        line: 23,
        text: "B2: Dragon flag x 5",
        reason: 'no exercise in the bank is called "Dragon flag"',
      },
      {
        line: 29,
        text: "A2: Muscle up x lots",
        reason: 'Muscle up: "lots" has no number of reps or seconds',
      },
      {
        line: 30,
        text: "Something nobody wrote a rule for",
        reason: "not a line the import knows",
      },
    ]);
  });

  it("is a layout the host accepts", () => {
    expect(validateDocument(LAYOUT_SCHEMA, read.layout)).toMatchObject({ ok: true });
  });

  it("reads targets in the coach's ways of writing them", () => {
    expect(readTarget("8-12", "reps", 1)).toEqual({
      sets: [{ kind: "reps", reps: 8, repsMax: 12 }],
    });
    expect(readTarget("2 min", "time", 2)).toEqual({
      sets: [
        { kind: "time", seconds: 120 },
        { kind: "time", seconds: 120 },
      ],
    });
    expect(readTarget("10/10/10", "reps", 1)).toEqual({
      sets: [{ kind: "reps", reps: 10 }],
      note: "10/10/10",
    });
    expect(readTarget(undefined, "hold", 1)).toBe("no time given");
  });
});

describe("drafting", () => {
  it("reads a brief, picks only bank exercises, and lays out every week", () => {
    const plan = readBrief("12 weeks of planche and pike work, 3 sessions a week");
    expect(plan).toMatchObject({ weeks: 12, sessionsPerWeek: 3 });
    const chosen = pickExercises(bank, plan.focus);
    expect(chosen.map((e) => e.name).slice(0, 3)).toEqual([
      "Pike push throughs",
      "Planche lean",
      "Tuck planche",
    ]);
    const layout = draftLayout(plan, chosen);
    expect(layout.weeks).toHaveLength(12);
    expect(layout.weeks[0]?.sessions.map((s) => s.day)).toEqual([1, 3, 5]);
    const refs = JSON.stringify(layout).match(/rec_ex\d+/g) ?? [];
    expect(refs.every((r) => bank.some((e) => e.id === r))).toBe(true);
    expect(validateDocument(LAYOUT_SCHEMA, layout, { maxBytes: 524_288 })).toMatchObject({
      ok: true,
    });
  });
});

describe("the tools on the test host", () => {
  const host = () =>
    createTestHost(programs, {
      records: { "programs.exercise": bank.map((e) => ({ ...e })) },
      ai: { extract: async () => ({ weeks: 6, sessionsPerWeek: 2, focus: "planche" }) },
    });

  it("draft makes an unpublished working copy from the bank, reading the brief with the model role", async () => {
    const h = host();
    const out = await h.runTool<{
      programId: string;
      weeks: number;
      sessions: number;
      published: boolean;
    }>("draft", { brief: "Something for planche" });
    expect(out).toMatchObject({ weeks: 6, sessions: 12, published: false });
    const program = h.records.get("programs.program")?.get(out.programId) as unknown as {
      layout: Layout;
      publishedVersion?: number;
    };
    expect(program.publishedVersion).toBeUndefined();
    expect(h.calls.map((c) => c.operation)).not.toContain("record.publish");
  });

  it("importText makes a working copy and lists the unread lines", async () => {
    const h = host();
    const out = await h.runTool<{
      title: string;
      unread: unknown[];
      sessions: number;
      items: number;
    }>("importText", { text: SHORTHAND });
    expect(out).toMatchObject({ title: "Strength block", sessions: 2, items: 5 });
    expect(out.unread).toHaveLength(4);
  });
});
