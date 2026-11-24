// Logging a session set by set on a phone (stage 41, fast logging): what the session screens show
// and send when a person ticks, types and un-ticks sets. Pure functions over one state, and a
// small store that sends its saves to the host one at a time. No React, no markup.
//
// - **A tick logs the numbers shown in its row,** including one still being typed: every key
//   press is a change here, so a tick never waits for a field to lose focus.
// - **Every change shows at once and is saved in order through one queue.** A set's change bumps
//   its revision and queues it once; saves go one at a time, and a set changed while its save is
//   out is sent again after it, with what it holds then (coalesced: the latest wins). An answer
//   for an older revision never undoes a newer change, and a read of the session from the host
//   never overwrites a set this screen has changed. A save that fails keeps what was entered,
//   says so and is retried; one the host refuses is kept and shown with its reason, and sent
//   again when the set changes.
// - **Carry forward:** a set not done and not edited shows a suggestion: the first set last
//   time's numbers (else its target), a later set the numbers of the set before it, so a change
//   flows down to the later sets nobody edited. Ticking it accepts them. An edited set is never
//   overwritten.
//
// It holds no rules. What a set may hold, whose session it is and whether it may be logged are
// the host's: a save it refuses comes back with the host's message. A save is idempotent per set
// on the host (`x.programs.logAdd` changes a set already logged, `x.programs.logRemove` of a set
// not logged changes nothing), so a retry never logs a set twice.
import type { Session, SetTarget } from "../layout.ts";

// --- The state ------------------------------------------------------------------------------------

/** A set's fields as typed: text, so "7." or "" while someone types. */
export interface SetValues {
  reps?: string;
  seconds?: string;
  load?: string;
}
export type SetField = keyof SetValues;

/** One exercise of a session's plan, as the logger works with it. */
export interface LogExercise {
  item: string;
  exercise: string;
  /** The level it is at, for an item with levels. */
  level: number | null;
  targets: SetTarget[];
  /** The person's sets of it last time, in order. */
  last: { reps: number | null; seconds: number | null; load: number | null }[];
}

/** A set as the host has it logged (`x.programs.sessionGet`'s `logged`). */
export interface HostSet {
  item: string | null;
  exercise: string | null;
  setNumber: number | null;
  level: number | null;
  actual: { reps: number | null; seconds: number | null; load: number | null };
  rpe: number | null;
}

export interface LocalSet {
  done: boolean;
  /** What the person typed, every field of the row from their first edit; null: not edited. */
  entered: SetValues | null;
  /** The numbers it was ticked with, while done. */
  ticked: SetValues | null;
  rpe: number | null;
  /** Bumped by every change this screen makes that the host must hear of. */
  rev: number;
  /** The revision the host has. */
  saved: number;
  /** Whether the host has it logged: as last answered; "unknown" after a failed save. */
  host: "logged" | "absent" | "unknown";
  /** Why its last save failed, to say so beside it. */
  error: string | null;
  /** The host refused it: kept as entered, not sent again until it changes. */
  refused: boolean;
}

export interface LogState {
  /** By `exerciseKey`. */
  exercises: Record<string, LogExercise>;
  /** By `setKey`. */
  sets: Record<string, LocalSet>;
  /** The level chosen at each item with levels. */
  levels: Record<string, number>;
  /** Sets waiting to be saved, in order. */
  queue: string[];
  /** The save out now: one at a time, with what it sends. */
  inFlight: { key: string; rev: number; token: number; op: SaveOp } | null;
  /** The last token given to a save. */
  token: number;
  /** A save failed and waits to be retried; the queue waits with it, so saves stay in order. */
  blocked: boolean;
  /** The last failure, to say so: cleared when a save succeeds. */
  failure: string | null;
  /** The save that failed: sent again as it was (the same idempotency key) if its set is unchanged. */
  failedOp: SaveOp | null;
}

export const exerciseKey = (item: string, exercise: string) => `${item}|${exercise}`;
export const setKey = (item: string, exercise: string, setNumber: number) =>
  `${item}|${exercise}|${setNumber}`;

export function emptyLog(): LogState {
  return {
    exercises: {},
    sets: {},
    levels: {},
    queue: [],
    inFlight: null,
    token: 0,
    blocked: false,
    failure: null,
    failedOp: null,
  };
}

const blank = (): LocalSet => ({
  done: false,
  entered: null,
  ticked: null,
  rpe: null,
  rev: 0,
  saved: 0,
  host: "absent",
  error: null,
  refused: false,
});

/** The exercises a session's plan asks to be logged: every block's items (not the warm-up). */
export function logExercisesOf(
  plan: Session | null,
  exercises: readonly { id: string; last: LogExercise["last"] }[],
): LogExercise[] {
  const last = new Map(exercises.map((e) => [e.id, e.last]));
  const out: LogExercise[] = [];
  for (const block of plan?.blocks ?? []) {
    for (const item of block.items) {
      const entries =
        item.kind === "all"
          ? item.exercises.map((p) => ({ p, level: null as number | null }))
          : [
              // Everyone's exercises beside the levels, then each level's.
              ...(item.exercises ?? []).map((p) => ({ p, level: null as number | null })),
              ...item.levels.flatMap((l) =>
                (l.mode === "one" ? [l.exercise] : l.exercises).map((p) => ({
                  p,
                  level: l.level as number | null,
                })),
              ),
            ];
      for (const { p, level } of entries) {
        out.push({
          item: item.label,
          exercise: p.exercise,
          level,
          targets: p.sets,
          last: last.get(p.exercise) ?? [],
        });
      }
    }
  }
  return out;
}

const toText = (n: number | null | undefined): string | undefined =>
  n === null || n === undefined ? undefined : String(n);

/** A number typed in a field, or undefined when it is empty or not one. */
export function numberIn(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  const value = Number(text.replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

// --- Carry forward --------------------------------------------------------------------------------

/** Whether a set counts seconds (time, hold) or reps. */
export const timed = (target: SetTarget | undefined) =>
  target !== undefined && target.kind !== "reps";

const countField = (target: SetTarget | undefined): "reps" | "seconds" =>
  timed(target) ? "seconds" : "reps";

const targetOf = (target: SetTarget | undefined, field: SetField): number | undefined => {
  if (!target) return undefined;
  if (field === "load") return target.load;
  if (field === "reps") return target.kind === "reps" ? target.reps : undefined;
  return target.kind === "reps" ? undefined : target.seconds;
};

/** What a set's row shows: its numbers, and whether they are a suggestion (greyed). */
export interface Shown {
  values: SetValues;
  suggested: boolean;
}

/**
 * The numbers set `setNumber` of an exercise shows. Done: what it was ticked with. Edited: what
 * was typed. Otherwise a suggestion: for the first set, last time's numbers, else the target; for
 * a later set, the numbers the set before it shows, so a change flows down. A field whose target
 * differs from the set before's (a planned drop, a heavier top set) suggests its own target.
 */
export function shownValues(
  state: LogState,
  item: string,
  exercise: string,
  setNumber: number,
): Shown {
  const set = state.sets[setKey(item, exercise, setNumber)];
  if (set?.done && set.ticked) return { values: set.ticked, suggested: false };
  if (set?.entered) return { values: set.entered, suggested: false };
  return { values: suggestion(state, item, exercise, setNumber), suggested: true };
}

function suggestion(state: LogState, item: string, exercise: string, setNumber: number): SetValues {
  const ex = state.exercises[exerciseKey(item, exercise)];
  const target = ex?.targets[setNumber - 1];
  const fields: SetField[] = [countField(target), "load"];
  const out: SetValues = {};
  if (setNumber <= 1) {
    const last = ex?.last[0];
    for (const field of fields) {
      const value = toText(last?.[field] ?? undefined) ?? toText(targetOf(target, field));
      if (value !== undefined) out[field] = value;
    }
    return out;
  }
  const before = ex?.targets[setNumber - 2];
  const previous = shownValues(state, item, exercise, setNumber - 1).values;
  for (const field of fields) {
    const own = targetOf(target, field);
    const changed = own !== undefined && own !== targetOf(before, field);
    const value = changed ? toText(own) : (previous[field] ?? toText(own));
    if (value !== undefined) out[field] = value;
  }
  return out;
}

// --- Changes --------------------------------------------------------------------------------------

export type LogAction =
  /** The host's read of the session: the plan's exercises and what it has logged. */
  | { type: "load"; exercises: LogExercise[]; logged: readonly HostSet[] }
  /** Tick (log) a set with the numbers shown, or with `values` over them (a timer's seconds). */
  | { type: "tick"; item: string; exercise: string; setNumber: number; values?: SetValues }
  /** Take a ticked set back. */
  | { type: "untick"; item: string; exercise: string; setNumber: number }
  /** A tick of a set's tick box: a done set is taken back, any other ticked. */
  | { type: "toggle"; item: string; exercise: string; setNumber: number }
  /** A key press in one of a set's fields. */
  | {
      type: "edit";
      item: string;
      exercise: string;
      setNumber: number;
      field: SetField;
      text: string;
    }
  /** How hard it felt; null clears it. Optional, never needed to tick. */
  | { type: "rpe"; item: string; exercise: string; setNumber: number; rpe: number | null }
  /** The level taken at an item with levels. */
  | { type: "level"; item: string; level: number }
  /** The store takes the next save off the queue. */
  | { type: "begin" }
  /** The save with this token was answered. */
  | { type: "saved"; token: number }
  /** The save with this token failed; `retry` when it is worth sending again. */
  | { type: "failed"; token: number; message: string; retry: boolean }
  /** Send the failed save again. */
  | { type: "retry" };

/** Whether a set has a change the host has not had. */
const dirty = (set: LocalSet) => set.rev > set.saved;

/** A set changed locally: a new revision, queued once (or sent again after the save out now). */
function changed(state: LogState, key: string, set: LocalSet): LogState {
  const next: LocalSet = { ...set, rev: set.rev + 1, refused: false };
  const sets = { ...state.sets, [key]: next };
  const queued = state.queue.includes(key) || state.inFlight?.key === key;
  return { ...state, sets, queue: queued ? state.queue : [...state.queue, key] };
}

/** A set changed only on this screen (a not-done set's numbers): nothing for the host yet. */
function kept(state: LogState, key: string, set: LocalSet): LogState {
  return { ...state, sets: { ...state.sets, [key]: set } };
}

const toValues = (actual: HostSet["actual"]): SetValues => {
  const out: SetValues = {};
  for (const field of ["reps", "seconds", "load"] as const) {
    const value = toText(actual[field]);
    if (value !== undefined) out[field] = value;
  }
  return out;
};

/** Applies one change. Pure: the state given is left as it was. */
export function logReducer(state: LogState, action: LogAction): LogState {
  switch (action.type) {
    case "load": {
      const exercises = { ...state.exercises };
      for (const e of action.exercises) {
        const key = exerciseKey(e.item, e.exercise);
        // The same exercise at two levels of one item is one set on the host: the first is kept.
        if (!exercises[key] || exercises[key] === state.exercises[key]) exercises[key] = e;
      }
      const sets = { ...state.sets };
      const levels = { ...state.levels };
      const onHost = new Set<string>();
      for (const l of action.logged) {
        if (!l.item || !l.exercise || !l.setNumber) continue;
        const key = setKey(l.item, l.exercise, l.setNumber);
        onHost.add(key);
        if (l.level !== null && levels[l.item] === undefined) levels[l.item] = l.level;
        const set = sets[key];
        // A set this screen has changed is this screen's: a read never undoes it.
        if (set && set.rev > 0) continue;
        sets[key] = {
          ...blank(),
          done: true,
          ticked: toValues(l.actual),
          rpe: l.rpe,
          host: "logged",
        };
      }
      for (const [key, set] of Object.entries(sets)) {
        if (set.rev === 0 && set.done && !onHost.has(key)) sets[key] = blank();
      }
      return { ...state, exercises, sets, levels };
    }
    case "tick": {
      const key = setKey(action.item, action.exercise, action.setNumber);
      const set = state.sets[key] ?? blank();
      const shown = shownValues(state, action.item, action.exercise, action.setNumber).values;
      const ticked = { ...shown, ...(action.values ?? {}) };
      if (set.done && !action.values) return state;
      return changed(state, key, {
        ...set,
        done: true,
        ticked,
        entered: action.values ? { ...(set.entered ?? shown), ...action.values } : set.entered,
      });
    }
    case "untick": {
      const key = setKey(action.item, action.exercise, action.setNumber);
      const set = state.sets[key];
      if (!set?.done) return state;
      return changed(state, key, { ...set, done: false, ticked: null });
    }
    case "toggle":
      return logReducer(state, {
        ...action,
        type: state.sets[setKey(action.item, action.exercise, action.setNumber)]?.done
          ? "untick"
          : "tick",
      });
    case "edit": {
      const key = setKey(action.item, action.exercise, action.setNumber);
      const set = state.sets[key] ?? blank();
      const shown = shownValues(state, action.item, action.exercise, action.setNumber).values;
      const entered = { ...(set.entered ?? shown), [action.field]: action.text };
      if (set.done) {
        return changed(state, key, {
          ...set,
          entered,
          ticked: { ...(set.ticked ?? shown), [action.field]: action.text },
        });
      }
      return kept(state, key, { ...set, entered });
    }
    case "rpe": {
      const key = setKey(action.item, action.exercise, action.setNumber);
      const set = state.sets[key] ?? blank();
      if (set.rpe === action.rpe) return state;
      const next = { ...set, rpe: action.rpe };
      return set.done ? changed(state, key, next) : kept(state, key, next);
    }
    case "level":
      return { ...state, levels: { ...state.levels, [action.item]: action.level } };
    case "begin": {
      if (state.inFlight || state.blocked) return state;
      let queue = state.queue;
      let sets = state.sets;
      while (queue.length) {
        const [key, ...rest] = queue as [string, ...string[]];
        queue = rest;
        const set = sets[key];
        if (!set || !dirty(set) || set.refused) continue;
        // Not done and not on the host: nothing to tell it.
        if (!set.done && set.host === "absent") {
          sets = { ...sets, [key]: { ...set, saved: set.rev, error: null } };
          continue;
        }
        const token = state.token + 1;
        const again = state.failedOp;
        const op =
          again?.key === key &&
          again.rev === set.rev &&
          again.kind === (set.done ? "log" : "remove")
            ? again
            : opFor({ ...state, sets }, key);
        return { ...state, sets, queue, token, inFlight: { key, rev: set.rev, token, op } };
      }
      return { ...state, sets, queue };
    }
    case "saved": {
      const out = state.inFlight;
      // An answer for a save that is no longer out (one given up on, then sent again): ignored.
      if (!out || out.token !== action.token) return state;
      const set = state.sets[out.key];
      if (!set) return { ...state, inFlight: null };
      const next: LocalSet = {
        ...set,
        saved: Math.max(set.saved, out.rev),
        host: out.op.kind === "log" ? "logged" : "absent",
        error: null,
      };
      // Changed while it was out: sent again, after what is waiting.
      const queue =
        dirty(next) && !state.queue.includes(out.key) ? [...state.queue, out.key] : state.queue;
      return {
        ...state,
        sets: { ...state.sets, [out.key]: next },
        queue,
        inFlight: null,
        failure: null,
        failedOp: null,
      };
    }
    case "failed": {
      const out = state.inFlight;
      if (!out || out.token !== action.token) return state;
      const set = state.sets[out.key];
      if (!set) return { ...state, inFlight: null };
      const next: LocalSet = {
        ...set,
        host: "unknown",
        error: action.message,
        refused: !action.retry,
      };
      const rest = state.queue.filter((k) => k !== out.key);
      return {
        ...state,
        sets: { ...state.sets, [out.key]: next },
        // Retried first, so saves stay in order; a refused one waits for its next change.
        queue: action.retry ? [out.key, ...rest] : rest,
        inFlight: null,
        blocked: action.retry,
        failure: action.message,
        failedOp: out.op,
      };
    }
    case "retry":
      return { ...state, blocked: false };
  }
}

// --- What a save sends ----------------------------------------------------------------------------

/** One save: log a set with its numbers, or take it back. */
export type SaveOp =
  | {
      kind: "log";
      key: string;
      rev: number;
      item: string;
      exercise: string;
      level: number | null;
      setNumber: number;
      actual: { reps?: number; seconds?: number; load?: number };
      rpe: number | null;
    }
  | { kind: "remove"; key: string; rev: number; item: string; exercise: string; setNumber: number };

/** What the save out now sends: its set as it was when it went (the latest change then). */
export function saveFor(state: LogState): SaveOp | null {
  return state.inFlight?.op ?? null;
}

function opFor(state: LogState, key: string): SaveOp {
  const [item, exercise, n] = key.split("|") as [string, string, string];
  const setNumber = Number(n);
  const set = state.sets[key] ?? blank();
  const rev = set.rev;
  if (!set.done) return { kind: "remove", key, rev, item, exercise, setNumber };
  const ex = state.exercises[exerciseKey(item, exercise)];
  const target = ex?.targets[setNumber - 1];
  const values = set.ticked ?? {};
  const count = countField(target);
  const actual: { reps?: number; seconds?: number; load?: number } = {};
  const counted = numberIn(values[count]);
  if (counted !== undefined) actual[count] = counted;
  const load = numberIn(values.load);
  if (load !== undefined) actual.load = load;
  return {
    kind: "log",
    key,
    rev,
    item,
    exercise,
    level: ex?.level ?? null,
    setNumber,
    actual,
    rpe: set.rpe,
  };
}

// --- Reading the state ----------------------------------------------------------------------------

/** The level an item is logged at: the one chosen, else its only one. Null: not chosen yet. */
export function levelOf(state: LogState, item: string): number | null {
  if (state.levels[item] !== undefined) return state.levels[item] as number;
  const levels = new Set(
    Object.values(state.exercises)
      .filter((e) => e.item === item && e.level !== null)
      .map((e) => e.level),
  );
  return levels.size === 1 ? ([...levels][0] as number) : null;
}

/** The exercises being done: everyone's, and at an item with levels the level taken (else its first). */
export function exercisesInPlay(state: LogState): LogExercise[] {
  const firstLevel = new Map<string, number>();
  for (const e of Object.values(state.exercises)) {
    if (e.level === null) continue;
    const seen = firstLevel.get(e.item);
    if (seen === undefined || e.level < seen) firstLevel.set(e.item, e.level);
  }
  return Object.values(state.exercises).filter(
    (e) => e.level === null || e.level === (levelOf(state, e.item) ?? firstLevel.get(e.item)),
  );
}

const isDone = (state: LogState, e: LogExercise, setNumber: number) =>
  Boolean(state.sets[setKey(e.item, e.exercise, setNumber)]?.done);

/** Sets done of the sets planned, over the exercises being done. */
export function progressOf(state: LogState): { done: number; planned: number } {
  let done = 0;
  let planned = 0;
  for (const e of exercisesInPlay(state)) {
    planned += e.targets.length;
    for (let n = 1; n <= e.targets.length; n += 1) if (isDone(state, e, n)) done += 1;
  }
  return { done, planned };
}

/** Whether every set of an exercise is ticked: it folds away. */
export function exerciseDone(state: LogState, item: string, exercise: string): boolean {
  const e = state.exercises[exerciseKey(item, exercise)];
  if (!e?.targets.length) return false;
  return e.targets.every((_, i) => isDone(state, e, i + 1));
}

/** The sets not ticked, by exercise, to say so when the session is finished. */
export function notTicked(
  state: LogState,
): { item: string; exercise: string; setNumbers: number[] }[] {
  const out: { item: string; exercise: string; setNumbers: number[] }[] = [];
  for (const e of exercisesInPlay(state)) {
    const setNumbers = e.targets.map((_, i) => i + 1).filter((n) => !isDone(state, e, n));
    if (setNumbers.length) out.push({ item: e.item, exercise: e.exercise, setNumbers });
  }
  return out;
}

/** How many sets have a change the host has not had yet. */
export function unsaved(state: LogState): number {
  return Object.values(state.sets).filter((s) => dirty(s) && !(!s.done && s.host === "absent"))
    .length;
}

/** The sets the host refused, with its reason. */
export function refusedSets(state: LogState): { key: string; message: string }[] {
  return Object.entries(state.sets)
    .filter(([, s]) => s.refused && dirty(s))
    .map(([key, s]) => ({ key, message: s.error ?? "Not saved" }));
}

/** The rest after a set: its own rest time, else the screen's. */
export function restAfter(target: SetTarget | undefined, fallback: number): number {
  return target?.rest ?? fallback;
}

/** Whole seconds from `from` to `to` (ms), never below zero. */
export function secondsBetween(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / 1000));
}

// --- The store: one queue per session and person --------------------------------------------------

/** Timers, as the platform has them (every one these run on has `setTimeout`). */
interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const globalTimers: Timers = {
  set: (fn, ms) =>
    (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(
      fn,
      ms,
    ),
  clear: (handle) =>
    (globalThis as unknown as { clearTimeout(handle: unknown): void }).clearTimeout(handle),
};

export interface SessionLogOptions {
  /** Sends one save to the host; throws when it fails. The same `op` object for a retry. */
  send(op: SaveOp): Promise<unknown>;
  /** How long to wait before the `attempt`th retry. Default 1 s, doubling, at most 30 s. */
  retryDelay?: (attempt: number) => number;
  timers?: Timers;
}

export interface SessionLog {
  getState(): LogState;
  /** A person's change: shown at once, and queued for the host when it must hear of it. */
  dispatch(action: LogAction): void;
  subscribe(listener: () => void): () => void;
  /**
   * Sends everything waiting now (leaving the screen, the app going to the background, finishing
   * the session), retrying a failed save at once. True when the host has it all; false when a
   * save failed or `timeoutMs` passed first. What is not saved is kept and still retried.
   */
  flush(timeoutMs?: number): Promise<boolean>;
}

/**
 * Whether a failed save is worth sending again: anything but the host's refusal (a 4xx that is
 * not a timeout, a conflict over its key in flight or too many calls). A refusal is kept on
 * screen with its message.
 */
export function retryable(error: unknown): boolean {
  const e = error as { status?: unknown; details?: { reason?: unknown } } | null;
  const status = typeof e?.status === "number" ? e.status : null;
  if (status === null || status >= 500) return true;
  if (status === 408 || status === 429) return true;
  if (status === 409 && e?.details?.reason === "idempotency_key_in_flight") return true;
  return status < 400;
}

const messageOf = (error: unknown, retry: boolean): string => {
  const said = (error as { message?: unknown } | null)?.message;
  if (!retry && typeof said === "string" && said) return said;
  return "No answer from the host: trying again.";
};

/** A session's queue: saves sent to the host one at a time, in order, retried until they land. */
export function createSessionLog(options: SessionLogOptions): SessionLog {
  const timers = options.timers ?? globalTimers;
  const delay = options.retryDelay ?? ((n: number) => Math.min(30_000, 1000 * 2 ** (n - 1)));
  let state = emptyLog();
  const listeners = new Set<() => void>();
  let attempts = 0;
  let retryTimer: unknown = null;

  const apply = (action: LogAction) => {
    const next = logReducer(state, action);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const pump = () => {
    if (state.inFlight || state.blocked) return;
    apply({ type: "begin" });
    const out = state.inFlight;
    if (!out) return;
    const { token, op } = out;
    options.send(op).then(
      () => {
        attempts = 0;
        apply({ type: "saved", token });
        pump();
      },
      (error: unknown) => {
        const retry = retryable(error);
        apply({ type: "failed", token, message: messageOf(error, retry), retry });
        if (retry) {
          attempts += 1;
          retryTimer = timers.set(() => {
            retryTimer = null;
            apply({ type: "retry" });
            pump();
          }, delay(attempts));
        } else {
          pump();
        }
      },
    );
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    getState: () => state,
    dispatch(action) {
      apply(action);
      pump();
    },
    subscribe,
    flush(timeoutMs = 10_000) {
      if (retryTimer !== null) {
        timers.clear(retryTimer);
        retryTimer = null;
      }
      apply({ type: "retry" });
      pump();
      return new Promise<boolean>((resolve) => {
        let finished = false;
        const finish = (ok: boolean) => {
          if (finished) return;
          finished = true;
          stop();
          timers.clear(timer);
          resolve(ok);
        };
        // Blocked again: a save failed while flushing (it is still retried, later).
        const check = () => {
          if (state.blocked) finish(false);
          else if (!state.inFlight && !state.queue.length) finish(unsaved(state) === 0);
        };
        const stop = subscribe(check);
        const timer = timers.set(() => finish(false), timeoutMs);
        check();
      });
    },
  };
}

// --- What a screen shows --------------------------------------------------------------------------

/** One set's row: its numbers (greyed when suggested), whether it is done, its effort and state. */
export interface SetRowView extends Shown {
  done: boolean;
  rpe: number | null;
  /** Changed here and not yet on the host. */
  saving: boolean;
  /** Why its save failed, when it did. */
  error: string | null;
}

export function setRow(
  state: LogState,
  item: string,
  exercise: string,
  setNumber: number,
): SetRowView {
  const set = state.sets[setKey(item, exercise, setNumber)];
  return {
    ...shownValues(state, item, exercise, setNumber),
    done: Boolean(set?.done),
    rpe: set?.rpe ?? null,
    saving: Boolean(set && dirty(set) && !(!set.done && set.host === "absent")),
    error: set?.error ?? null,
  };
}

/** Whether an exercise's sets have a load field: weighed, or a load planned or done last time. */
export function weighed(e: LogExercise | undefined, measure: string | null | undefined): boolean {
  if (!e) return measure === "weight_reps";
  return (
    measure === "weight_reps" ||
    e.targets.some((t) => t.load !== undefined) ||
    e.last.some((l) => l.load !== null)
  );
}

/** "A1 Back squat: sets 2 and 3; B1 Plank: set 2", to say plainly what was not ticked. */
export function notTickedText(
  state: LogState,
  nameOf: (exercise: string) => string | null | undefined,
): string | null {
  const parts = notTicked(state).map(({ item, exercise, setNumbers }) => {
    const numbers =
      setNumbers.length === 1
        ? `set ${setNumbers[0]}`
        : `sets ${setNumbers.slice(0, -1).join(", ")} and ${setNumbers.at(-1)}`;
    return `${item} ${nameOf(exercise) ?? "Exercise"}: ${numbers}`;
  });
  return parts.length ? parts.join("; ") : null;
}

/** The efforts a set offers to tap (RPE in halves, the hard end). */
export const EFFORTS = [6, 7, 7.5, 8, 8.5, 9, 9.5, 10] as const;
