// Logging a session on a phone (stage 41, fast logging): the queue and the carry-forward rules of
// the shared client logic, as pure functions and as the store that sends the saves.
import { describe, expect, it } from "vitest";
import {
  createSessionLog,
  emptyLog,
  exerciseDone,
  type LogAction,
  type LogExercise,
  type LogState,
  logExercisesOf,
  logReducer,
  notTicked,
  progressOf,
  restAfter,
  retryable,
  type SaveOp,
  saveFor,
  setKey,
  shownValues,
  unsaved,
} from "../client/logging.ts";
import type { Session } from "../layout.ts";

const squat: LogExercise = {
  item: "A1",
  exercise: "rec_squat",
  level: null,
  targets: [
    { kind: "reps", reps: 5, load: 100, rest: 120 },
    { kind: "reps", reps: 5, load: 100, rest: 120 },
    { kind: "reps", reps: 5, load: 100, rest: 120 },
  ],
  last: [],
};
const plank: LogExercise = {
  item: "B1",
  exercise: "rec_plank",
  level: null,
  targets: [
    { kind: "hold", seconds: 30 },
    { kind: "hold", seconds: 30 },
  ],
  last: [],
};

const loaded = (exercises: LogExercise[] = [squat, plank], logged = []): LogState =>
  logReducer(emptyLog(), { type: "load", exercises, logged });

const run = (state: LogState, ...actions: LogAction[]) => actions.reduce(logReducer, state);
const at = (setNumber: number, e: LogExercise = squat) => ({
  item: e.item,
  exercise: e.exercise,
  setNumber,
});
const tick = (setNumber: number, e: LogExercise = squat): LogAction => ({
  type: "tick",
  ...at(setNumber, e),
});
const edit = (
  setNumber: number,
  field: "reps" | "seconds" | "load",
  text: string,
  e: LogExercise = squat,
): LogAction => ({ type: "edit", ...at(setNumber, e), field, text });
const shown = (state: LogState, setNumber: number, e: LogExercise = squat) =>
  shownValues(state, e.item, e.exercise, setNumber);

/** Sends every save the state has queued, answering each as `answer` says. */
function drain(state: LogState, answer: (op: SaveOp) => "ok" | "fail" = () => "ok") {
  const sent: SaveOp[] = [];
  let s = state;
  for (let i = 0; i < 50; i += 1) {
    s = logReducer(s, { type: "begin" });
    const op = saveFor(s);
    if (!op || !s.inFlight) break;
    sent.push(op);
    s =
      answer(op) === "ok"
        ? logReducer(s, { type: "saved", token: s.inFlight.token })
        : logReducer(s, { type: "failed", token: s.inFlight.token, message: "x", retry: true });
    if (s.blocked) break;
  }
  return { state: s, sent };
}

describe("carry forward", () => {
  it("the first set suggests its target when there is no last time", () => {
    expect(shown(loaded(), 1)).toEqual({ values: { reps: "5", load: "100" }, suggested: true });
  });

  it("the first set suggests last time's numbers", () => {
    const s = loaded([{ ...squat, last: [{ reps: 6, seconds: null, load: 97.5 }] }]);
    expect(shown(s, 1)).toEqual({ values: { reps: "6", load: "97.5" }, suggested: true });
    // A field last time did not have comes from the target.
    const partly = loaded([{ ...squat, last: [{ reps: 6, seconds: null, load: null }] }]);
    expect(shown(partly, 1).values).toEqual({ reps: "6", load: "100" });
  });

  it("a later set shows the set before's actual numbers once it is ticked", () => {
    const s = run(loaded(), edit(1, "load", "105"), tick(1));
    expect(shown(s, 2)).toEqual({ values: { reps: "5", load: "105" }, suggested: true });
    expect(shown(s, 3).values.load).toBe("105");
  });

  it("changing a set's numbers flows down to the later sets not done and not edited", () => {
    let s = run(loaded(), tick(1), edit(2, "load", "110"));
    expect(shown(s, 3).values.load).toBe("110");
    // Changing a done set flows down too.
    s = run(s, edit(1, "reps", "4"));
    expect(shown(s, 2).values).toEqual({ reps: "5", load: "110" });
    expect(shown(s, 3).values).toEqual({ reps: "5", load: "110" });
  });

  it("an edited set is never overwritten", () => {
    let s = run(loaded(), edit(3, "reps", "3"));
    expect(shown(s, 3)).toEqual({ values: { reps: "3", load: "100" }, suggested: false });
    s = run(s, edit(1, "load", "120"));
    expect(shown(s, 2).values.load).toBe("120");
    expect(shown(s, 3).values).toEqual({ reps: "3", load: "100" });
  });

  it("a done set is never overwritten by a change above it", () => {
    const s = run(loaded(), tick(2), edit(1, "load", "90"));
    expect(shown(s, 2)).toEqual({ values: { reps: "5", load: "100" }, suggested: false });
  });

  it("ticking a suggested set accepts the suggestion", () => {
    const s = run(loaded(), edit(1, "load", "102.5"), tick(1), tick(2));
    expect(drain(s).sent.map((o) => o.kind === "log" && o.actual)).toEqual([
      { reps: 5, load: 102.5 },
      { reps: 5, load: 102.5 },
    ]);
  });

  it("a planned change of target is suggested as planned, not carried", () => {
    const pyramid: LogExercise = {
      ...squat,
      targets: [
        { kind: "reps", reps: 10, load: 60 },
        { kind: "reps", reps: 8, load: 70 },
        { kind: "reps", reps: 8, load: 70 },
      ],
    };
    const s = run(loaded([pyramid]), edit(1, "reps", "9", pyramid), tick(1, pyramid));
    expect(shown(s, 2, pyramid).values).toEqual({ reps: "8", load: "70" });
    const s2 = run(s, edit(2, "load", "72.5", pyramid));
    expect(shown(s2, 3, pyramid).values).toEqual({ reps: "8", load: "72.5" });
  });

  it("a timed exercise carries seconds", () => {
    const s = run(loaded(), edit(1, "seconds", "40", plank), tick(1, plank));
    expect(shown(s, 2, plank).values).toEqual({ seconds: "40" });
  });
});

describe("the queue", () => {
  it("three ticks within one render are all saved, in order, one at a time", () => {
    // One render: the three taps are dispatched against the state of that render, functionally.
    const s = run(loaded(), tick(1), tick(2), tick(3));
    expect(s.queue).toEqual([
      setKey("A1", "rec_squat", 1),
      setKey("A1", "rec_squat", 2),
      setKey("A1", "rec_squat", 3),
    ]);
    const begun = logReducer(s, { type: "begin" });
    // One at a time: a second begin while one is out sends nothing more.
    expect(logReducer(begun, { type: "begin" })).toBe(begun);
    const { state, sent } = drain(s);
    expect(sent.map((o) => [o.kind, o.setNumber])).toEqual([
      ["log", 1],
      ["log", 2],
      ["log", 3],
    ]);
    expect(unsaved(state)).toBe(0);
    expect(progressOf(state)).toEqual({ done: 3, planned: 5 });
  });

  it("a number typed and ticked straight away (no blur) is logged with that number", () => {
    // Each key press is an edit; the tick comes before anything else happens.
    const s = run(
      loaded(),
      edit(1, "load", "1"),
      edit(1, "load", "11"),
      edit(1, "load", "110"),
      tick(1),
    );
    const { sent } = drain(s);
    expect(sent).toEqual([
      expect.objectContaining({ kind: "log", actual: { reps: 5, load: 110 } }),
    ]);
  });

  it("a set changed while its save is out is sent again with the latest numbers", () => {
    let s = run(loaded(), tick(1), { type: "begin" });
    const first = saveFor(s);
    s = run(s, edit(1, "reps", "4"), edit(1, "reps", "3"));
    s = logReducer(s, { type: "saved", token: s.inFlight?.token ?? 0 });
    // The answer for the first save does not undo the newer numbers.
    expect(shown(s, 1).values.reps).toBe("3");
    const { sent } = drain(s);
    expect(first).toMatchObject({ actual: { reps: 5 } });
    expect(sent).toEqual([expect.objectContaining({ actual: { reps: 3, load: 100 } })]);
  });

  it("a save failing in the middle keeps what was entered, says so, and is retried first", () => {
    let s = run(loaded(), tick(1), tick(2), tick(3));
    let calls = 0;
    const out = drain(s, () => (calls++ === 1 ? "fail" : "ok"));
    s = out.state;
    expect(out.sent.map((o) => o.setNumber)).toEqual([1, 2]);
    expect(s.blocked).toBe(true);
    expect(s.failure).toBe("x");
    expect(s.sets[setKey("A1", "rec_squat", 2)]).toMatchObject({ done: true, error: "x" });
    expect(s.queue[0]).toBe(setKey("A1", "rec_squat", 2));
    // Nothing more goes until it is retried, so the saves stay in order.
    expect(logReducer(s, { type: "begin" })).toBe(s);
    const again = drain(logReducer(s, { type: "retry" }));
    expect(again.sent.map((o) => o.setNumber)).toEqual([2, 3]);
    expect(again.state.failure).toBeNull();
    expect(unsaved(again.state)).toBe(0);
  });

  it("a refused save is kept with its reason and does not hold up the others", () => {
    let s = run(loaded(), edit(1, "reps", "4.5"), tick(1), tick(2), { type: "begin" });
    s = logReducer(s, {
      type: "failed",
      token: s.inFlight?.token ?? 0,
      message: "Reps must be a whole number",
      retry: false,
    });
    expect(s.blocked).toBe(false);
    const { state, sent } = drain(s);
    expect(sent.map((o) => o.setNumber)).toEqual([2]);
    expect(state.sets[setKey("A1", "rec_squat", 1)]).toMatchObject({
      refused: true,
      error: "Reps must be a whole number",
      ticked: { reps: "4.5", load: "100" },
    });
    // Fixing it sends it again.
    const fixed = drain(run(state, edit(1, "reps", "4")));
    expect(fixed.sent).toEqual([
      expect.objectContaining({ setNumber: 1, actual: { reps: 4, load: 100 } }),
    ]);
  });

  it("answers arriving out of order never undo a newer change", () => {
    // An answer for a save that is no longer out is ignored.
    let s = run(loaded(), tick(1), { type: "begin" });
    const stale = s.inFlight?.token ?? 0;
    s = logReducer(s, { type: "failed", token: stale, message: "timed out", retry: true });
    s = run(s, { type: "retry" }, { type: "begin" });
    const current = s.inFlight?.token ?? 0;
    expect(logReducer(s, { type: "saved", token: stale })).toBe(s);
    s = logReducer(s, { type: "saved", token: current });
    expect(unsaved(s)).toBe(0);
    // A read of the session from before the tick landed does not untick it.
    s = logReducer(s, { type: "load", exercises: [squat, plank], logged: [] });
    expect(s.sets[setKey("A1", "rec_squat", 1)]?.done).toBe(true);
    // Nor does one that says something else of a set this screen changed.
    s = run(s, edit(1, "reps", "6"));
    s = logReducer(s, {
      type: "load",
      exercises: [squat, plank],
      logged: [
        {
          item: "A1",
          exercise: "rec_squat",
          setNumber: 1,
          level: null,
          actual: { reps: 2, seconds: null, load: 50 },
          rpe: null,
        },
      ],
    });
    expect(shown(s, 1).values).toEqual({ reps: "6", load: "100" });
  });

  it("a tick of a done set takes it back; a tick and untick before the save lands are both sent", () => {
    let s = run(loaded(), tick(1), { type: "begin" });
    s = run(s, { type: "toggle", ...at(1) });
    expect(s.sets[setKey("A1", "rec_squat", 1)]?.done).toBe(false);
    s = logReducer(s, { type: "saved", token: s.inFlight?.token ?? 0 });
    const { sent, state } = drain(s);
    expect(sent.map((o) => o.kind)).toEqual(["remove"]);
    expect(state.sets[setKey("A1", "rec_squat", 1)]?.host).toBe("absent");
  });

  it("a set ticked and taken back before it was sent sends nothing", () => {
    const s = run(loaded(), tick(1), { type: "toggle", ...at(1) });
    expect(drain(s).sent).toEqual([]);
  });

  it("a set the host has logged loads as done, and editing it updates it", () => {
    let s = loaded([squat], [
      {
        item: "A1",
        exercise: "rec_squat",
        setNumber: 1,
        level: null,
        actual: { reps: 5, seconds: null, load: 100 },
        rpe: 8,
      },
    ] as never);
    expect(s.sets[setKey("A1", "rec_squat", 1)]).toMatchObject({
      done: true,
      host: "logged",
      rpe: 8,
    });
    s = run(s, edit(1, "load", "102.5"), { type: "rpe", ...at(1), rpe: 8.5 });
    const { sent } = drain(s);
    expect(sent).toEqual([
      expect.objectContaining({ kind: "log", actual: { reps: 5, load: 102.5 }, rpe: 8.5 }),
    ]);
    // Effort is never needed: a set ticks without it.
    expect(drain(run(loaded([squat]), tick(1))).sent[0]).toMatchObject({ rpe: null });
  });

  it("a timer's seconds fill the set and tick it", () => {
    const s = run(loaded(), { type: "tick", ...at(1, plank), values: { seconds: "34" } });
    expect(drain(s).sent).toEqual([expect.objectContaining({ actual: { seconds: 34 } })]);
  });
});

describe("the store", () => {
  /** A host that answers when told to. */
  function host() {
    const calls: { op: SaveOp; resolve: () => void; reject: (e: unknown) => void }[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const log = createSessionLog({
      send: (op) =>
        new Promise<void>((resolve, reject) => {
          calls.push({ op, resolve, reject });
        }),
      timers: {
        set: (fn, ms) => {
          const t = { fn, ms };
          timers.push(t);
          return t;
        },
        clear: (t) => {
          const i = timers.indexOf(t as never);
          if (i >= 0) timers.splice(i, 1);
        },
      },
    });
    log.dispatch({ type: "load", exercises: [squat, plank], logged: [] });
    return { log, calls, timers };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("sends one save at a time and the next when it is answered", async () => {
    const { log, calls } = host();
    log.dispatch(tick(1));
    log.dispatch(tick(2));
    log.dispatch(tick(3));
    expect(calls.map((c) => c.op.setNumber)).toEqual([1]);
    calls[0]?.resolve();
    await settle();
    expect(calls.map((c) => c.op.setNumber)).toEqual([1, 2]);
    calls[1]?.resolve();
    await settle();
    calls[2]?.resolve();
    await settle();
    expect(calls.map((c) => c.op.setNumber)).toEqual([1, 2, 3]);
    expect(unsaved(log.getState())).toBe(0);
  });

  it("retries a failed save with the same save object, later, and flushes at once when asked", async () => {
    const { log, calls, timers } = host();
    log.dispatch(tick(1));
    calls[0]?.reject(new TypeError("Network request failed"));
    await settle();
    expect(log.getState().failure).toBe("No answer from the host: trying again.");
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    log.dispatch(tick(2));
    // Waiting for the retry: nothing else is sent before set 1.
    expect(calls).toHaveLength(1);
    const flushed = log.flush();
    expect(timers.filter((t) => t.ms === 1000)).toHaveLength(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.op).toBe(calls[0]?.op);
    calls[1]?.resolve();
    await settle();
    calls[2]?.resolve();
    expect(await flushed).toBe(true);
  });

  it("says when a flush could not save", async () => {
    const { log, calls } = host();
    log.dispatch(tick(1));
    const flushed = log.flush();
    calls[0]?.reject(Object.assign(new Error("down"), { status: 503 }));
    expect(await flushed).toBe(false);
    expect(unsaved(log.getState())).toBe(1);
    expect(log.getState().sets[setKey("A1", "rec_squat", 1)]?.done).toBe(true);
  });

  it("a refusal is not retried", () => {
    expect(retryable(Object.assign(new Error("no"), { status: 422 }))).toBe(false);
    expect(retryable(Object.assign(new Error("busy"), { status: 429 }))).toBe(true);
    expect(retryable(new TypeError("offline"))).toBe(true);
  });
});

describe("reading a session", () => {
  const plan: Session = {
    name: "Strength",
    day: 1,
    blocks: [
      {
        label: "A",
        items: [
          { kind: "all", label: "A1", exercises: [{ exercise: "rec_squat", sets: squat.targets }] },
          {
            kind: "levels",
            label: "A2",
            levels: [
              { mode: "one", level: 1, exercise: { exercise: "rec_kneel", sets: plank.targets } },
              { mode: "one", level: 3, exercise: { exercise: "rec_full", sets: squat.targets } },
            ],
          },
        ],
      },
    ],
  };

  it("the plan's exercises, the level taken, progress and what was not ticked", () => {
    const exercises = logExercisesOf(plan, [{ id: "rec_squat", last: [] }]);
    expect(exercises.map((e) => [e.item, e.exercise, e.level])).toEqual([
      ["A1", "rec_squat", null],
      ["A2", "rec_kneel", 1],
      ["A2", "rec_full", 3],
    ]);
    let s = loaded(exercises);
    // No level chosen: the first level counts.
    expect(progressOf(s)).toEqual({ done: 0, planned: 5 });
    s = run(s, { type: "level", item: "A2", level: 3 }, tick(1), tick(2), tick(3));
    expect(progressOf(s)).toEqual({ done: 3, planned: 6 });
    expect(exerciseDone(s, "A1", "rec_squat")).toBe(true);
    expect(notTicked(s)).toEqual([{ item: "A2", exercise: "rec_full", setNumbers: [1, 2, 3] }]);
    const sent = drain(run(s, { type: "tick", item: "A2", exercise: "rec_full", setNumber: 1 }));
    expect(sent.sent.at(-1)).toMatchObject({ item: "A2", exercise: "rec_full", level: 3 });
  });

  it("the rest after a set is its own, else the screen's", () => {
    expect(restAfter(squat.targets[0], 90)).toBe(120);
    expect(restAfter(plank.targets[0], 90)).toBe(90);
  });
});

describe("what a screen shows", () => {
  it("says plainly what was not ticked", async () => {
    const { notTickedText } = await import("../client/logging.ts");
    const s = run(loaded(), tick(1), tick(1, plank));
    expect(notTickedText(s, (id) => (id === "rec_squat" ? "Back squat" : "Plank"))).toBe(
      "A1 Back squat: sets 2 and 3; B1 Plank: set 2",
    );
  });
});
