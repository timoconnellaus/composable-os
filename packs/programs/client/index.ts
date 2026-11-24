// The Programs pack's headless entry (stage 41, step 5; ADR 0418): functions and hooks over the
// typed client, no markup. A client app imports it as `@composable-os/pack-programs/client` and
// hands it its generated client; the Programs blocks render what it returns.
//
// As every pack's entry: the operations are typed from the pack's own tool schemas and the host's
// record operations, it takes the client and the app's `useQuery`, `useMutation`, `useState` and
// `useEffect` as arguments (no React or TanStack import), and it holds no rules. What a layout may
// hold is the host's document schema (a fault comes back with its path, which `faultsOf` maps to
// where the builder shows it); who may publish is the host's (`usePublish` is offered from what
// `user.me` says the account holds, and the host still decides); the dates, targets and last
// numbers are the tools'. The editing functions below only move parts of a layout around.
import { type ClientHolding, type PackClient, packHooks } from "@composable-os/client";
import type { z } from "@composable-os/sdk";
import type {
  Block,
  Item,
  Layout,
  Level,
  Note,
  Prescription,
  Session,
  SetTarget,
} from "../layout.ts";
import type {
  assign,
  classToday,
  draft,
  history,
  importText,
  logAdd,
  logUpdate,
  progress,
  sessionComplete,
  sessionGet,
  today,
} from "../tools.ts";

export type { Block, Item, Layout, Level, Note, Prescription, Session, SetTarget };

type Io<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.input<T["input"]>;
  output: z.output<T["output"]>;
};

/** A record as the record operations return it. */
export interface RecordOut {
  object: string;
  id: string;
  title?: string | null;
  values: Record<string, unknown>;
}
interface Page {
  items: RecordOut[];
  nextCursor: string | null;
}
type ListInput = {
  object: string;
  filter?: unknown;
  sort?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  cursor?: string;
};
export interface VersionSummary {
  version: number;
  current: boolean;
  publishedAt: string;
  publishedBy: string | null;
  note: string | null;
  bytes: number;
}

/** The operations this entry calls, as the generated client types them. */
export type ProgramsOperations = {
  "x.programs.assign": { kind: "mutation" } & Io<typeof assign>;
  "x.programs.today": { kind: "query" } & Io<typeof today>;
  "x.programs.sessionGet": { kind: "query" } & Io<typeof sessionGet>;
  "x.programs.classToday": { kind: "query" } & Io<typeof classToday>;
  "x.programs.logAdd": { kind: "mutation" } & Io<typeof logAdd>;
  "x.programs.logUpdate": { kind: "mutation" } & Io<typeof logUpdate>;
  "x.programs.sessionComplete": { kind: "mutation" } & Io<typeof sessionComplete>;
  "x.programs.history": { kind: "query" } & Io<typeof history>;
  "x.programs.progress": { kind: "query" } & Io<typeof progress>;
  "x.programs.draft": { kind: "mutation" } & Io<typeof draft>;
  "x.programs.importText": { kind: "mutation" } & Io<typeof importText>;
  "record.get": { kind: "query"; input: { object: string; id: string }; output: RecordOut };
  "record.list": { kind: "query"; input: ListInput; output: Page };
  /** A customer's read of what they may see (the class types, ADR 0447). */
  "my.list": { kind: "query"; input: ListInput; output: Page };
  "record.create": {
    kind: "mutation";
    input: { object: string; values: Record<string, unknown> };
    output: RecordOut;
  };
  "record.update": {
    kind: "mutation";
    input: { object: string; id: string; values: Record<string, unknown> };
    output: RecordOut;
  };
  "record.versions": {
    kind: "query";
    input: { object: string; id: string; limit?: number };
    output: { items: VersionSummary[] };
  };
  "record.publish": {
    kind: "mutation";
    input: { object: string; id: string; note?: string };
    output: VersionSummary;
  };
  "record.restoreVersion": {
    kind: "mutation";
    input: { object: string; id: string; version: number };
    output: { record: RecordOut; skipped: string[] };
  };
  "person.list": {
    kind: "query";
    input: {
      filter?: unknown;
      limit?: number;
      sort?: { field: string; direction?: "asc" | "desc" };
    };
    output: { items: { id: string; displayName?: string | null }[]; nextCursor: string | null };
  };
  "user.me": {
    kind: "query";
    input: Record<string, never>;
    output: { id: string; name: string; role: string; granted: string[]; permissions: string[] };
  };
};

type Name = keyof ProgramsOperations & string;
type In<N extends Name> = ProgramsOperations[N]["input"];
type Out<N extends Name> = ProgramsOperations[N]["output"];

export type TodayOut = Out<"x.programs.today">;
export type PlannedSession = TodayOut["sessions"][number];
export type SessionDetail = Out<"x.programs.sessionGet">;
export type LoggedSet = SessionDetail["logged"][number];
export type SessionExercise = SessionDetail["exercises"][number];
export type HistoryOut = Out<"x.programs.history">;
export type ProgressOut = Out<"x.programs.progress">;

/**
 * The client of every operation this entry calls. The hooks are written against it; the client an
 * app passes may hold fewer (a member's customer client holds no staff operation), and then gets
 * only the hooks it can back (ADR 0453).
 */
export type ProgramsClient = PackClient<ProgramsOperations>;

export const PROGRAM = "programs.program";
export const EXERCISE = "programs.exercise";
export const SESSION = "programs.session";
export const LOG = "programs.log";

// --- Reading a session ---------------------------------------------------------------------------

/** "3 × 8–12 @ 20 kg, 32X1, rest 90 s": a set target as a person reads it. */
export function describeSet(set: SetTarget): string {
  const parts: string[] = [];
  if (set.kind === "reps")
    parts.push(set.repsMax ? `${set.reps}–${set.repsMax} reps` : `${set.reps} reps`);
  else if (set.kind === "time") parts.push(`${set.seconds} s`);
  else parts.push(set.holds ? `${set.holds} × ${set.seconds} s hold` : `${set.seconds} s hold`);
  if (set.load) parts[0] = `${parts[0]} @ ${set.load} kg`;
  if (set.kind === "reps" && set.tempo) parts.push(set.tempo);
  if (set.rest) parts.push(`rest ${set.rest} s`);
  return parts.join(", ");
}

/** A prescription's sets, grouped when they repeat: "3 × 8 reps @ 20 kg". */
export function describeSets(sets: readonly SetTarget[]): string {
  const groups: { text: string; count: number }[] = [];
  for (const set of sets) {
    const text = describeSet(set);
    const last = groups.at(-1);
    if (last?.text === text) last.count += 1;
    else groups.push({ text, count: 1 });
  }
  return groups.map((g) => (g.count > 1 ? `${g.count} × ${g.text}` : g.text)).join(", then ");
}

/** The exercises of a level, whatever its mode. */
export function levelExercises(level: Level): Prescription[] {
  return level.mode === "one" ? [level.exercise] : level.exercises;
}

/** What a level is, in words: "Level 3: one of these". */
export function levelLabel(level: Level): string {
  return level.mode === "alternatives"
    ? `Level ${level.level}: one of these`
    : level.mode === "together"
      ? `Level ${level.level}: together`
      : `Level ${level.level}`;
}

/** The sets already logged of one prescription's set number in a session. */
export function loggedFor(
  logged: readonly LoggedSet[],
  item: string,
  exercise: string,
  setNumber: number,
): LoggedSet | undefined {
  return logged.find(
    (l) => l.item === item && l.exercise === exercise && l.setNumber === setNumber,
  );
}

/** A number typed in a field, or undefined when it is empty or not one. */
export function numberFrom(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const value = Number(text.replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

// --- Past sessions ---------------------------------------------------------------------------------

/** One past session as the history lists it: when, what, and how many of its sets were logged. */
export interface PastSession {
  id: string;
  date: string | null;
  name: string | null;
  programTitle: string | null;
  focus: string | null;
  state: string | null;
  /** Sets logged on it. */
  setsDone: number;
  /** Sets its plan asks of this person (for an item with levels, the level they took). */
  setsPlanned: number;
}

/** A page of past sessions, newest first: pass `nextCursor` back for older ones. */
export interface PastSessionsPage {
  sessions: PastSession[];
  nextCursor: string | null;
}

/** Sessions a page of the history lists. Their ids go in one `in` filter on the sets. */
export const PAST_SESSIONS_PAGE = 20;
/** The most pages of sets read for one page of sessions (200 a page). */
const PAST_SETS_CALLS = 5;

/** What a set logged on a session says about where it was, as `sessionSets` reads it. */
export interface SetPlace {
  item: string | null;
  exercise: string | null;
  level: number | null;
  setNumber?: number | null;
}

/** One set of a session as its history shows it: the plan's target and what was logged. */
export interface SessionSet<L extends SetPlace> {
  block: string;
  item: string;
  exercise: string;
  level: number | null;
  setNumber: number;
  /** The plan's target, or null for a set logged beyond the plan's. */
  target: SetTarget | null;
  logged: L | undefined;
}

/**
 * The sets of a session for one person, in the plan's order, each with what they logged. An item
 * for everyone has every exercise's sets; an item with levels the level they logged at (or its
 * first level when they logged none of it); alternatives the one they did (or the first, when
 * they did none). A set logged beyond the plan's sets follows its exercise's, with no target.
 * Warm-ups are not logged and not listed. An item with levels and exercises for everyone has
 * everyone's first, then the level's. A session with no plan (one imported from before) has the
 * sets logged on it, as they were, with no targets.
 */
export function sessionSets<L extends SetPlace>(
  plan: Session | null | undefined,
  logged: readonly L[],
): SessionSet<L>[] {
  const out: SessionSet<L>[] = [];
  if (!plan) {
    for (const l of logged) {
      out.push({
        block: "",
        item: l.item ?? "",
        exercise: l.exercise ?? "",
        level: l.level,
        setNumber: l.setNumber ?? 1,
        target: null,
        logged: l,
      });
    }
    return out.sort(
      (a, b) =>
        a.item.localeCompare(b.item) ||
        a.exercise.localeCompare(b.exercise) ||
        a.setNumber - b.setNumber,
    );
  }
  for (const block of plan.blocks) {
    for (const item of block.items) {
      const mine = logged.filter((l) => l.item === item.label);
      let level: number | null = null;
      let list: Prescription[];
      if (item.kind === "all") list = item.exercises;
      else {
        const takenLevel = mine.find((l) => l.level !== null)?.level;
        const chosen = item.levels.find((l) => l.level === takenLevel) ?? item.levels[0];
        if (!chosen) continue;
        level = chosen.level;
        list = levelExercises(chosen);
        if (chosen.mode === "alternatives") {
          const did = list.filter((p) => mine.some((l) => l.exercise === p.exercise));
          list = did.length ? did : list.slice(0, 1);
        }
        list = [...(item.exercises ?? []), ...list];
      }
      for (const p of list) {
        const sets = mine.filter((l) => l.exercise === p.exercise);
        const most = Math.max(p.sets.length, ...sets.map((l) => l.setNumber ?? 0));
        for (let n = 1; n <= most; n += 1) {
          out.push({
            block: block.label,
            item: item.label,
            exercise: p.exercise,
            level,
            setNumber: n,
            target: p.sets[n - 1] ?? null,
            logged: sets.find((l) => l.setNumber === n),
          });
        }
      }
    }
  }
  return out;
}

/** How many sets a session's plan asks of one person, given what they logged (`sessionSets`). */
export function plannedSets(plan: Session | null | undefined, logged: readonly SetPlace[]): number {
  return sessionSets(plan, logged).filter((s) => s.target !== null).length;
}

/** Past sessions from their records and the sets logged on them (any order). */
export function pastSessionsOf(
  sessions: readonly RecordOut[],
  sets: readonly RecordOut[],
): PastSession[] {
  const bySession = new Map<string, SetPlace[]>();
  for (const set of sets) {
    const session = str(set.values.session);
    if (!session) continue;
    const list = bySession.get(session) ?? [];
    list.push({
      item: str(set.values.item),
      exercise: str(set.values.exercise),
      level: typeof set.values.level === "number" ? set.values.level : null,
      setNumber: typeof set.values.setNumber === "number" ? set.values.setNumber : null,
    });
    bySession.set(session, list);
  }
  return sessions.map((s) => {
    const logged = bySession.get(s.id) ?? [];
    return {
      id: s.id,
      date: str(s.values.date),
      name: str(s.values.name),
      programTitle: str(s.values.programTitle),
      focus: str(s.values.focus),
      state: str(s.values.state),
      setsDone: logged.length,
      setsPlanned: plannedSets(s.values.plan as Session | null, logged),
    };
  });
}

const str = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * One page of a person's past sessions (their own, dated `until` or before), newest first, each
 * with its sets logged and planned. A member reads their own through the seam (`my.list`: never a
 * class's sessions, never another person's sets); a coach names the client (`record.list`). Two
 * reads for a page of sessions, and a few more only for a page with very many sets.
 */
export async function loadPastSessions(
  read: (input: ListInput) => Promise<Page>,
  options: { personId?: string; until: string; cursor?: string },
): Promise<PastSessionsPage> {
  const person = options.personId ? [{ field: "person", op: "eq", value: options.personId }] : [];
  const page = await read({
    object: SESSION,
    filter: {
      and: [
        // Their own: assigned to them, or imported from before (no kind: it was never planned).
        {
          or: [
            { field: "kind", op: "eq", value: "personal" },
            { field: "source", op: "eq", value: "import" },
          ],
        },
        { field: "date", op: "lte", value: options.until },
        ...person,
      ],
    },
    sort: { field: "date", direction: "desc" },
    limit: PAST_SESSIONS_PAGE,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  const ids = page.items.map((s) => s.id);
  const sets: RecordOut[] = [];
  let next: string | null = null;
  for (let calls = 0; ids.length && calls < PAST_SETS_CALLS; calls += 1) {
    const found: Page = await read({
      object: LOG,
      filter: {
        and: [{ field: "session", op: "in", value: ids }, ...person],
      },
      sort: { field: "date", direction: "desc" },
      limit: 200,
      ...(next ? { cursor: next } : {}),
    });
    sets.push(...found.items);
    next = found.nextCursor;
    if (!next) break;
  }
  return { sessions: pastSessionsOf(page.items, sets), nextCursor: page.nextCursor };
}

/** What was done in a logged set, in words: "8 reps @ 20 kg · RPE 7". */
export function describeDone(set: LoggedSet): string {
  const parts: string[] = [];
  if (set.actual.reps !== null) parts.push(`${set.actual.reps} reps`);
  if (set.actual.seconds !== null) parts.push(`${set.actual.seconds} s`);
  if (set.actual.load !== null) {
    parts[0] = parts[0] ? `${parts[0]} @ ${set.actual.load} kg` : `${set.actual.load} kg`;
  }
  if (set.rpe !== null) parts.push(`RPE ${set.rpe}`);
  return parts.join(" · ") || "Logged";
}

/**
 * A correction to a logged set from what was typed: only what changed, as `x.programs.logUpdate`
 * takes it (the numbers done, effort, the note), or null when nothing did. An emptied note clears
 * it; an emptied number is left as it was. The target, the exercise and who recorded it are not
 * the person's to change; the host keeps them and bounds the numbers.
 */
export function correctionOf(
  set: LoggedSet,
  typed: { count: string; load: string; rpe: string; note: string },
  timed: boolean,
): {
  logId: string;
  actual?: { reps?: number; seconds?: number; load?: number };
  rpe?: number;
  note?: string | null;
} | null {
  const count = numberFrom(typed.count);
  const load = numberFrom(typed.load);
  const rpe = numberFrom(typed.rpe);
  const note = typed.note.trim() ? typed.note.trim() : null;
  const actual: { reps?: number; seconds?: number; load?: number } = {};
  if (count !== undefined && count !== (timed ? set.actual.seconds : set.actual.reps)) {
    if (timed) actual.seconds = count;
    else actual.reps = count;
  }
  if (load !== undefined && load !== set.actual.load) actual.load = load;
  const out = {
    logId: set.id,
    ...(Object.keys(actual).length ? { actual } : {}),
    ...(rpe !== undefined && rpe !== set.rpe ? { rpe } : {}),
    ...(note !== (set.note ?? null) ? { note } : {}),
  };
  return Object.keys(out).length > 1 ? out : null;
}

/** The hooks a history block may be given: a member's (`usePastSessions`) or a coach's. */
export type PastSessionsHooks = Partial<
  Pick<ProgramsHooks, "usePastSessions" | "useClientPastSessions">
>;

/**
 * The hook a history block lists past sessions with: a coach's client's when `personId` is given
 * (the staff client's `useClientPastSessions`), else the member's own (`usePastSessions`). A
 * block's hooks and person are fixed for its life, so the hook it calls never changes between
 * renders: `const usePage = pastSessionsHook(programs, personId); const page = usePage({})`.
 */
export function pastSessionsHook(
  programs: PastSessionsHooks,
  personId: string | undefined,
): (options: { until?: string; cursor?: string }) => ReturnType<ProgramsHooks["usePastSessions"]> {
  if (personId) {
    const hook = programs.useClientPastSessions;
    if (!hook) throw new Error("A client's history needs the staff client's useClientPastSessions");
    return (options) => hook(personId, options);
  }
  const hook = programs.usePastSessions;
  if (!hook) throw new Error("A member's history needs the customer client's usePastSessions");
  return hook;
}

// --- Faults from the host, where they are ---------------------------------------------------------

/**
 * The faults the host reported for a layout, by path: `weeks.0.sessions.1.day` → "At most 7". The
 * builder shows each beside the part it names, and a part's own faults and those inside it
 * (`faultsUnder`). The host's document check reports every fault with its path (ADR 0445); a ref
 * to a missing exercise reports its path in `details.path`.
 */
export function faultsOf(error: unknown, field = "layout"): Map<string, string> {
  const out = new Map<string, string>();
  const details = (error as { details?: unknown } | null)?.details as
    | {
        field?: string;
        issues?: { path?: (string | number)[]; message?: string }[];
        path?: (string | number)[];
      }
    | undefined;
  if (!details || (details.field && details.field !== field)) return out;
  for (const issue of details.issues ?? []) {
    out.set((issue.path ?? []).join("."), issue.message ?? "Not allowed here");
  }
  if (details.path) {
    const message = (error as { message?: string }).message ?? "Not found";
    out.set(details.path.join("."), message.replace(/^[^:]*:\s*/, ""));
  }
  return out;
}

/** The faults at `path` and inside it. */
export function faultsUnder(faults: ReadonlyMap<string, string>, path: string): string[] {
  return [...faults].filter(([p]) => p === path || p.startsWith(`${path}.`)).map(([, m]) => m);
}

// --- Editing a layout ------------------------------------------------------------------------------
//
// Each returns a new layout and leaves the one given unchanged. None checks what the host checks:
// a layout these produce may break the schema (a block with no items) and the host says where.

/** Where a part of the layout is: indexes from the week down. */
export interface At {
  week: number;
  session?: number;
  block?: number;
  item?: number;
  level?: number;
  /** An item with levels: its exercises for everyone, beside the levels. */
  everyone?: boolean;
  exercise?: number;
  set?: number;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The path the host names a part with (`weeks.0.sessions.1.blocks.0.items.2`). */
export function pathOf(at: At): string {
  const parts = [`weeks.${at.week}`];
  if (at.session !== undefined) parts.push(`sessions.${at.session}`);
  if (at.block !== undefined) parts.push(`blocks.${at.block}`);
  if (at.item !== undefined) parts.push(`items.${at.item}`);
  return parts.join(".");
}

export function emptyLayout(): Layout {
  return { weeks: [{ sessions: [] }] };
}

/** A set as a new one starts: 8 reps, or 30 seconds for time, 20 for a hold. */
export function newSet(measure?: string | null): SetTarget {
  if (measure === "time") return { kind: "time", seconds: 30 };
  if (measure === "hold") return { kind: "hold", seconds: 20 };
  return { kind: "reps", reps: 8 };
}

export function newPrescription(exercise: string, measure?: string | null, sets = 3): Prescription {
  return { exercise, sets: Array.from({ length: sets }, () => newSet(measure)) };
}

/** The next free label in a list: A, B, C… for blocks; A1, A2… for a block's items. */
export function nextLabel(taken: readonly string[], prefix = ""): string {
  if (!prefix) {
    for (let c = 65; c < 91; c += 1) {
      const label = String.fromCharCode(c);
      if (!taken.includes(label)) return label;
    }
    return `Z${taken.length}`;
  }
  for (let n = 1; n < 100; n += 1) {
    if (!taken.includes(`${prefix}${n}`)) return `${prefix}${n}`;
  }
  return `${prefix}${taken.length + 1}`;
}

function sessionAt(layout: Layout, at: At): Session {
  const session = layout.weeks[at.week]?.sessions[at.session ?? -1];
  if (!session) throw new Error("No session there");
  return session;
}
function blockAt(layout: Layout, at: At): Block {
  const block = sessionAt(layout, at).blocks[at.block ?? -1];
  if (!block) throw new Error("No block there");
  return block;
}
function itemAt(layout: Layout, at: At): Item {
  const item = blockAt(layout, at).items[at.item ?? -1];
  if (!item) throw new Error("No item there");
  return item;
}

/** The prescription at `at`: an "all" item's `exercise`, everyone's beside levels, or a level's. */
export function prescriptionAt(layout: Layout, at: At): Prescription {
  const item = itemAt(layout, at);
  if (item.kind === "all" || at.everyone) {
    const p = (item.kind === "all" ? item.exercises : (item.exercises ?? []))[at.exercise ?? 0];
    if (!p) throw new Error("No exercise there");
    return p;
  }
  const level = item.levels[at.level ?? 0];
  if (!level) throw new Error("No level there");
  const p = levelExercises(level)[at.exercise ?? 0];
  if (!p) throw new Error("No exercise there");
  return p;
}

const edit = (layout: Layout, change: (copy: Layout) => void): Layout => {
  const copy = clone(layout);
  change(copy);
  return copy;
};

/** Moves an entry of a list from one place to another (drag and drop, or a key). */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [entry] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, entry as T);
  return out;
}

export const layoutEdits = {
  addWeek: (layout: Layout) =>
    edit(layout, (l) => {
      l.weeks.push({ sessions: [] });
    }),
  /** A copy of week `week`, right after it. */
  copyWeek: (layout: Layout, week: number) =>
    edit(layout, (l) => {
      const copy = clone(l.weeks[week]);
      if (copy) {
        delete copy.label;
        l.weeks.splice(week + 1, 0, copy);
      }
    }),
  removeWeek: (layout: Layout, week: number) =>
    edit(layout, (l) => {
      l.weeks.splice(week, 1);
      if (!l.weeks.length) l.weeks.push({ sessions: [] });
    }),
  setWeekLabel: (layout: Layout, week: number, label: string) =>
    edit(layout, (l) => {
      const w = l.weeks[week];
      if (!w) return;
      if (label.trim()) w.label = label;
      else delete w.label;
    }),
  addSession: (layout: Layout, week: number) =>
    edit(layout, (l) => {
      const w = l.weeks[week];
      if (!w) return;
      const used = new Set(w.sessions.map((s) => s.day));
      const day = [1, 3, 5, 2, 4, 6, 7].find((d) => !used.has(d)) ?? 1;
      w.sessions.push({
        name: `Session ${String.fromCharCode(65 + w.sessions.length)}`,
        day,
        blocks: [],
      });
      w.sessions.sort((a, b) => a.day - b.day);
    }),
  /** A copy of a session: in its own week, or into every later week (`toEveryWeek`). */
  copySession: (layout: Layout, at: At, toWeek?: number) =>
    edit(layout, (l) => {
      const session = clone(sessionAt(l, at));
      const week = l.weeks[toWeek ?? at.week];
      if (!week) return;
      if (toWeek === undefined) session.name = `${session.name} (copy)`;
      week.sessions.push(session);
      week.sessions.sort((a, b) => a.day - b.day);
    }),
  removeSession: (layout: Layout, at: At) =>
    edit(layout, (l) => {
      l.weeks[at.week]?.sessions.splice(at.session ?? -1, 1);
    }),
  moveSession: (layout: Layout, week: number, from: number, to: number) =>
    edit(layout, (l) => {
      const w = l.weeks[week];
      if (w) w.sessions = move(w.sessions, from, to);
    }),
  setSession: (layout: Layout, at: At, values: Partial<Pick<Session, "name" | "focus" | "day">>) =>
    edit(layout, (l) => {
      const s = sessionAt(l, at);
      if (values.name !== undefined) s.name = values.name;
      if (values.day !== undefined) s.day = values.day;
      if (values.focus !== undefined) {
        if (values.focus.trim()) s.focus = values.focus;
        else delete s.focus;
      }
    }),
  setWarmup: (layout: Layout, at: At, text: string) =>
    edit(layout, (l) => {
      const s = sessionAt(l, at);
      const warmup = { ...(s.warmup ?? {}) };
      if (text.trim()) warmup.text = text;
      else delete warmup.text;
      if (warmup.text || warmup.exercises?.length) s.warmup = warmup;
      else delete s.warmup;
    }),
  addBlock: (layout: Layout, at: At) =>
    edit(layout, (l) => {
      const s = sessionAt(l, at);
      s.blocks.push({ label: nextLabel(s.blocks.map((b) => b.label)), items: [] });
    }),
  removeBlock: (layout: Layout, at: At) =>
    edit(layout, (l) => {
      sessionAt(l, at).blocks.splice(at.block ?? -1, 1);
    }),
  moveBlock: (layout: Layout, at: At, from: number, to: number) =>
    edit(layout, (l) => {
      const s = sessionAt(l, at);
      s.blocks = move(s.blocks, from, to);
    }),
  setBlock: (layout: Layout, at: At, values: { label?: string; rounds?: number | null }) =>
    edit(layout, (l) => {
      const b = blockAt(l, at);
      if (values.label !== undefined) b.label = values.label;
      if (values.rounds !== undefined) {
        if (values.rounds === null) delete b.rounds;
        else b.rounds = values.rounds;
      }
    }),
  /** An item for everyone with one exercise, or with levels (level 1 of the exercise). */
  addItem: (
    layout: Layout,
    at: At,
    exercise: string,
    measure?: string | null,
    kind: Item["kind"] = "all",
  ) =>
    edit(layout, (l) => {
      const b = blockAt(l, at);
      const label = nextLabel(
        b.items.map((i) => i.label),
        b.label,
      );
      const p = newPrescription(exercise, measure);
      b.items.push(
        kind === "all"
          ? { kind: "all", label, exercises: [p] }
          : { kind: "levels", label, levels: [{ mode: "one", level: 1, exercise: p }] },
      );
    }),
  removeItem: (layout: Layout, at: At) =>
    edit(layout, (l) => {
      blockAt(l, at).items.splice(at.item ?? -1, 1);
    }),
  /** Moves an item within its block, or into another block of the same session. */
  moveItem: (layout: Layout, at: At, to: { block: number; item: number }) =>
    edit(layout, (l) => {
      const s = sessionAt(l, at);
      const [item] = s.blocks[at.block ?? -1]?.items.splice(at.item ?? -1, 1) ?? [];
      const target = s.blocks[to.block];
      if (!item || !target) return;
      target.items.splice(Math.max(0, Math.min(to.item, target.items.length)), 0, item);
    }),
  setItemLabel: (layout: Layout, at: At, label: string) =>
    edit(layout, (l) => {
      itemAt(l, at).label = label;
    }),
  /** Everyone, or levels: an item's exercises become level 1, or level 1 becomes everyone's. */
  setItemKind: (layout: Layout, at: At, kind: Item["kind"]) =>
    edit(layout, (l) => {
      const b = blockAt(l, at);
      const index = at.item ?? -1;
      const item = b.items[index];
      if (!item || item.kind === kind) return;
      if (kind === "levels" && item.kind === "all") {
        const [first, ...rest] = item.exercises;
        const level: Level =
          rest.length && first
            ? { mode: "together", level: 1, exercises: item.exercises }
            : { mode: "one", level: 1, exercise: first as Prescription };
        b.items[index] = {
          kind: "levels",
          label: item.label,
          levels: [level],
          ...(item.notes ? { notes: item.notes } : {}),
        };
      } else if (kind === "all" && item.kind === "levels") {
        // Everyone's exercises stay everyone's; with none, level 1's become everyone's.
        const first = item.levels[0];
        b.items[index] = {
          kind: "all",
          label: item.label,
          exercises: item.exercises?.length ? item.exercises : first ? levelExercises(first) : [],
          ...(item.notes ? { notes: item.notes } : {}),
        };
      }
    }),
  /** A new level (the lowest free number) with one exercise. */
  addLevel: (layout: Layout, at: At, exercise: string, measure?: string | null, level?: number) =>
    edit(layout, (l) => {
      const item = itemAt(l, at);
      if (item.kind !== "levels") return;
      const used = new Set(item.levels.map((x) => x.level));
      const number = level ?? [1, 2, 3, 4, 5].find((n) => !used.has(n)) ?? 5;
      item.levels.push({
        mode: "one",
        level: number,
        exercise: newPrescription(exercise, measure),
      });
      item.levels.sort((a, b) => a.level - b.level);
    }),
  removeLevel: (layout: Layout, at: At) =>
    edit(layout, (l) => {
      const item = itemAt(l, at);
      if (item.kind === "levels") item.levels.splice(at.level ?? -1, 1);
    }),
  setLevelNumber: (layout: Layout, at: At, number: number) =>
    edit(layout, (l) => {
      const item = itemAt(l, at);
      if (item.kind !== "levels") return;
      const level = item.levels[at.level ?? -1];
      if (level) level.level = number;
      item.levels.sort((a, b) => a.level - b.level);
    }),
  /** One, together or alternatives: a level's exercises kept, its shape changed. */
  setLevelMode: (layout: Layout, at: At, mode: Level["mode"]) =>
    edit(layout, (l) => {
      const item = itemAt(l, at);
      if (item.kind !== "levels") return;
      const index = at.level ?? -1;
      const level = item.levels[index];
      if (!level || level.mode === mode) return;
      const exercises = levelExercises(level);
      item.levels[index] =
        mode === "one"
          ? { mode, level: level.level, exercise: exercises[0] as Prescription }
          : { mode, level: level.level, exercises };
    }),
  /** Another exercise beside the ones at `at` (an "all" item's, everyone's, or a level's). */
  addExercise: (layout: Layout, at: At, exercise: string, measure?: string | null) =>
    edit(layout, (l) => {
      const item = itemAt(l, at);
      const p = newPrescription(exercise, measure);
      if (item.kind === "all") {
        item.exercises.push(p);
        return;
      }
      if (at.everyone) {
        item.exercises = [...(item.exercises ?? []), p];
        return;
      }
      const index = at.level ?? -1;
      const level = item.levels[index];
      if (!level) return;
      item.levels[index] =
        level.mode === "one"
          ? { mode: "together", level: level.level, exercises: [level.exercise, p] }
          : { ...level, exercises: [...level.exercises, p] };
    }),
  removeExercise: (layout: Layout, at: At) =>
    edit(layout, (l) => {
      const item = itemAt(l, at);
      const index = at.exercise ?? -1;
      if (item.kind === "all") {
        item.exercises.splice(index, 1);
        return;
      }
      if (at.everyone) {
        const rest = (item.exercises ?? []).filter((_, i) => i !== index);
        if (rest.length) item.exercises = rest;
        else delete item.exercises;
        return;
      }
      const li = at.level ?? -1;
      const level = item.levels[li];
      if (!level || level.mode === "one") return;
      const rest = level.exercises.filter((_, i) => i !== index);
      item.levels[li] =
        rest.length === 1
          ? { mode: "one", level: level.level, exercise: rest[0] as Prescription }
          : { ...level, exercises: rest };
    }),
  /** The exercise at `at` replaced by another of the bank, keeping its sets and note. */
  swapExercise: (layout: Layout, at: At, exercise: string) =>
    edit(layout, (l) => {
      prescriptionAt(l, at).exercise = exercise;
    }),
  setSets: (layout: Layout, at: At, sets: SetTarget[]) =>
    edit(layout, (l) => {
      prescriptionAt(l, at).sets = sets;
    }),
  /** One more set, like the last. */
  addSet: (layout: Layout, at: At) =>
    edit(layout, (l) => {
      const p = prescriptionAt(l, at);
      const last = p.sets.at(-1);
      p.sets.push(last ? clone(last) : newSet());
    }),
  removeSet: (layout: Layout, at: At) =>
    edit(layout, (l) => {
      prescriptionAt(l, at).sets.splice(at.set ?? -1, 1);
    }),
  /** One set's values: switching its kind keeps what the new kind has (load, rest). */
  setSet: (layout: Layout, at: At, values: Partial<SetTarget> & { kind?: SetTarget["kind"] }) =>
    edit(layout, (l) => {
      const p = prescriptionAt(l, at);
      const index = at.set ?? -1;
      const old = p.sets[index];
      if (!old) return;
      const kind = values.kind ?? old.kind;
      const merged = { ...old, ...values, kind } as Record<string, unknown>;
      const keep: Record<SetTarget["kind"], string[]> = {
        reps: ["kind", "reps", "repsMax", "load", "tempo", "rest"],
        time: ["kind", "seconds", "load", "rest"],
        hold: ["kind", "seconds", "holds", "load", "rest"],
      };
      const next: Record<string, unknown> = {};
      for (const key of keep[kind]) {
        if (merged[key] !== undefined && merged[key] !== null && merged[key] !== "")
          next[key] = merged[key];
      }
      if (kind === "reps" && next.reps === undefined) next.reps = 8;
      if (kind !== "reps" && next.seconds === undefined) next.seconds = 30;
      p.sets[index] = next as unknown as SetTarget;
    }),
  setPrescriptionNote: (layout: Layout, at: At, note: string) =>
    edit(layout, (l) => {
      const p = prescriptionAt(l, at);
      if (note.trim()) p.note = note;
      else delete p.note;
    }),
  /** A note on a session, a block or an item (whichever `at` reaches deepest). */
  addNote: (layout: Layout, at: At, text: string, members = false) =>
    edit(layout, (l) => {
      const target: { notes?: Note[] } =
        at.item !== undefined
          ? itemAt(l, at)
          : at.block !== undefined
            ? blockAt(l, at)
            : sessionAt(l, at);
      target.notes = [...(target.notes ?? []), { text, ...(members ? { members: true } : {}) }];
    }),
  setNote: (layout: Layout, at: At, index: number, note: Note | null) =>
    edit(layout, (l) => {
      const target: { notes?: Note[] } =
        at.item !== undefined
          ? itemAt(l, at)
          : at.block !== undefined
            ? blockAt(l, at)
            : sessionAt(l, at);
      const notes = [...(target.notes ?? [])];
      if (note) notes[index] = { text: note.text, ...(note.members ? { members: true } : {}) };
      else notes.splice(index, 1);
      if (notes.length) target.notes = notes;
      else delete target.notes;
    }),
};

/** How many sessions, items and exercises a layout has, for the builder's summary. */
export function layoutSummary(layout: Layout): { weeks: number; sessions: number; items: number } {
  let sessions = 0;
  let items = 0;
  for (const w of layout.weeks) {
    sessions += w.sessions.length;
    for (const s of w.sessions) for (const b of s.blocks) items += b.items.length;
  }
  return { weeks: layout.weeks.length, sessions, items };
}

/** The ids of every exercise a layout names. */
export function exercisesIn(layout: Layout): string[] {
  const ids = new Set<string>();
  for (const w of layout.weeks) {
    for (const s of w.sessions) {
      for (const p of s.warmup?.exercises ?? []) ids.add(p.exercise);
      for (const b of s.blocks) {
        for (const i of b.items) {
          const all =
            i.kind === "all"
              ? i.exercises
              : [...(i.exercises ?? []), ...i.levels.flatMap(levelExercises)];
          for (const p of all) ids.add(p.exercise);
        }
      }
    }
  }
  return [...ids];
}

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery`, as far as these hooks use it. */
export type UseQuery = <T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  enabled?: boolean;
}) => { data: T | undefined; isPending: boolean; error: unknown; refetch?: () => unknown };

/** The app's `useMutation`, as far as these hooks use it. */
export type UseMutation = <I, O>(options: {
  mutationKey: readonly unknown[];
  mutationFn: (input: I) => Promise<O>;
  onSuccess?: (data: O) => void;
}) => {
  mutate(input: I): void;
  mutateAsync(input: I): Promise<O>;
  data: O | undefined;
  isPending: boolean;
  error: unknown;
};

/** The app's `useState`. */
export type UseState = <T>(initial: T) => [T, (next: T | ((previous: T) => T)) => void];

/** The app's `useEffect`. */
export type UseEffect = (effect: () => undefined | (() => void), deps: readonly unknown[]) => void;

/** How long the builder waits after the last edit before it saves the working copy. */
export const SAVE_AFTER_MS = 800;

export type SaveState = "saved" | "saving" | "unsaved" | "refused";

/**
 * The operations each hook calls (ADR 0453). A member's customer client gets the training hooks
 * (today, a session, logging, history, progress, the class view), the staff client all of them.
 * Who may do what is still the host's: a coach whose grants (ADR 0449) do not cover an operation
 * is refused it there; `usePublishOffered` asks the host what the account holds.
 */
export const PROGRAMS_HOOKS_CALL = {
  useToday: ["x.programs.today"],
  useSession: ["x.programs.sessionGet"],
  useClassToday: ["x.programs.classToday"],
  useLogSet: ["x.programs.logAdd"],
  useUpdateSet: ["x.programs.logUpdate"],
  useMarkSession: ["x.programs.sessionComplete"],
  useHistory: ["x.programs.history"],
  useProgress: ["x.programs.progress"],
  useClientSessions: ["record.list"],
  usePastSessions: ["my.list"],
  useClientPastSessions: ["record.list"],
  usePeople: ["person.list"],
  // Staff read them with record.list, a member with my.list (every signed-in member reads them).
  useClassTypes: { anyOf: [["record.list"], ["my.list"]] },
  useBank: ["record.list"],
  useExercises: ["record.list"],
  useCreateExercise: ["record.create"],
  useUpdateExercise: ["record.update"],
  usePrograms: ["record.list"],
  useCreateProgram: ["record.create"],
  useDraft: ["x.programs.draft"],
  useImportText: ["x.programs.importText"],
  useAssign: ["x.programs.assign"],
  useVersions: ["record.versions"],
  usePublishOffered: ["user.me"],
  usePublish: ["record.publish"],
  useRestoreVersion: ["record.restoreVersion"],
  useWorkingCopy: ["record.get", "record.update"],
} as const;

type ProgramsReact = {
  useQuery: UseQuery;
  useMutation: UseMutation;
  useState: UseState;
  useEffect?: UseEffect;
};

/**
 * Hooks for a React or React Native app:
 * `const programs = createProgramsHooks({ useQuery, useMutation, useState, useEffect }, api)`.
 * `api` is any generated client; the hooks it cannot back are not there, and calling one does
 * not compile.
 */
export function createProgramsHooks<C extends ClientHolding>(react: ProgramsReact, client: C) {
  return packHooks(client, PROGRAMS_HOOKS_CALL, (api: ProgramsClient, holds) =>
    allProgramsHooks(react, api, holds),
  );
}

function allProgramsHooks(
  react: ProgramsReact,
  api: ProgramsClient,
  holds: (operation: Name) => boolean = () => true,
) {
  const { useQuery, useMutation, useState } = react;
  const useEffect: UseEffect = react.useEffect ?? (() => undefined);
  return {
    // A member's (or, for staff, a named client's) training.
    useToday(input: In<"x.programs.today"> = {}) {
      return useQuery(api.query("x.programs.today", input));
    },
    useSession(input: In<"x.programs.sessionGet">) {
      return useQuery(api.query("x.programs.sessionGet", input));
    },
    useClassToday(input: In<"x.programs.classToday">) {
      return useQuery(api.query("x.programs.classToday", input));
    },
    useLogSet() {
      return useMutation(api.mutation("x.programs.logAdd"));
    },
    useUpdateSet() {
      return useMutation(api.mutation("x.programs.logUpdate"));
    },
    useMarkSession() {
      return useMutation(api.mutation("x.programs.sessionComplete"));
    },
    useHistory(input: In<"x.programs.history">) {
      return useQuery(api.query("x.programs.history", input));
    },
    useProgress(input: In<"x.programs.progress"> = {}) {
      return useQuery(api.query("x.programs.progress", input));
    },
    /** A client's sessions, newest first (staff): the coach's client view. */
    useClientSessions(personId: string) {
      return useQuery(
        api.query("record.list", {
          object: SESSION,
          filter: { field: "person", op: "eq", value: personId },
          sort: { field: "date", direction: "desc" },
          limit: 100,
        }),
      );
    },
    /**
     * A member's own past sessions, newest first (`loadPastSessions`): dated `until` (the
     * person's local date; default today, UTC) or before. Pass a page's `nextCursor` for older.
     */
    usePastSessions(options: { until?: string; cursor?: string } = {}) {
      const until = options.until ?? new Date().toISOString().slice(0, 10);
      return useQuery({
        // The client's own key for the page of sessions (under my.list, and under a screen's
        // scope where the app gives one), so what makes those stale or forgets them does here too.
        queryKey: [
          ...api.query("my.list", { object: SESSION }).queryKey,
          { past: true, until, cursor: options.cursor ?? null },
        ],
        queryFn: () =>
          loadPastSessions((input) => api.query("my.list", input).queryFn(), {
            until,
            ...(options.cursor ? { cursor: options.cursor } : {}),
          }),
      });
    },
    /** A client's past sessions, newest first (staff): as `usePastSessions`, naming the client. */
    useClientPastSessions(personId: string, options: { until?: string; cursor?: string } = {}) {
      const until = options.until ?? new Date().toISOString().slice(0, 10);
      return useQuery({
        queryKey: [
          ...api.query("record.list", { object: SESSION }).queryKey,
          { past: true, personId, until, cursor: options.cursor ?? null },
        ],
        queryFn: () =>
          loadPastSessions((input) => api.query("record.list", input).queryFn(), {
            personId,
            until,
            ...(options.cursor ? { cursor: options.cursor } : {}),
          }),
      });
    },
    /** People whose name contains `search` (staff): whom to assign a program to. */
    usePeople(search: string) {
      return useQuery({
        ...api.query("person.list", {
          filter: { field: "displayName", op: "contains", value: search.trim() },
          limit: 20,
        }),
        enabled: search.trim().length > 1,
      });
    },
    /**
     * The class types, for a member choosing their class (`my.list`) or a coach assigning one
     * (`record.list`): whichever read the client holds, staff's first.
     */
    useClassTypes() {
      const input: ListInput = {
        object: "programs.classtype",
        sort: { field: "order", direction: "asc" },
      };
      return useQuery(api.query(holds("record.list") ? "record.list" : "my.list", input));
    },

    // The bank.
    useBank(search?: string) {
      return useQuery(
        api.query("record.list", {
          object: EXERCISE,
          ...(search?.trim()
            ? { filter: { field: "name", op: "contains", value: search.trim() } }
            : {}),
          sort: { field: "name", direction: "asc" },
          limit: 200,
        }),
      );
    },
    /** The bank's exercises with these ids (a program's own, whatever the size of the bank). */
    useExercises(ids: readonly string[]) {
      const sorted = [...new Set(ids)].sort();
      return useQuery({
        ...api.query("record.list", {
          object: EXERCISE,
          filter: { field: "id", op: "in", value: sorted },
          limit: 200,
        }),
        enabled: sorted.length > 0,
      });
    },
    useCreateExercise() {
      return useMutation(api.mutation("record.create"));
    },
    useUpdateExercise() {
      return useMutation(api.mutation("record.update"));
    },

    // Programs.
    usePrograms() {
      return useQuery(
        api.query("record.list", {
          object: PROGRAM,
          sort: { field: "updatedAt", direction: "desc" },
          limit: 100,
        }),
      );
    },
    useCreateProgram() {
      return useMutation(api.mutation("record.create"));
    },
    useDraft() {
      return useMutation(api.mutation("x.programs.draft"));
    },
    useImportText() {
      return useMutation(api.mutation("x.programs.importText"));
    },
    useAssign() {
      return useMutation(api.mutation("x.programs.assign"));
    },
    useVersions(programId: string) {
      return useQuery(api.query("record.versions", { object: PROGRAM, id: programId }));
    },
    /**
     * Whether to offer publishing: what `user.me` says the account holds. Only an offer: the host
     * decides when it is asked (`records:publish`; an AI actor's request waits for a person who
     * holds it, ADR 0480).
     */
    usePublishOffered() {
      const me = useQuery(api.query("user.me", {}));
      return Boolean(me.data?.permissions.some((p) => p === "records:publish"));
    },
    usePublish() {
      return useMutation(api.mutation("record.publish"));
    },
    useRestoreVersion() {
      return useMutation(api.mutation("record.restoreVersion"));
    },

    /**
     * The builder's working copy of one program: the layout as the coach edits it, saved to the
     * host `SAVE_AFTER_MS` after the last edit (and on `saveNow`). Faults the host reports come
     * back by path (`faults`); the edit stays on screen so the coach fixes it where it is.
     */
    useWorkingCopy(programId: string) {
      const program = useQuery(api.query("record.get", { object: PROGRAM, id: programId }));
      const save = useMutation(api.mutation("record.update"));
      const [draft, setDraft] = useState<{
        layout: Layout;
        title: string;
        guidance: string;
      } | null>(null);
      const [state, setState] = useState<SaveState>("saved");
      const [faults, setFaults] = useState<Map<string, string>>(new Map());
      const [message, setMessage] = useState<string | null>(null);
      const [pending, setPending] = useState(0);
      const loaded = program.data
        ? {
            layout: (program.data.values.layout as Layout | null) ?? emptyLayout(),
            title: String(program.data.values.title ?? ""),
            guidance: String(program.data.values.guidance ?? ""),
          }
        : null;
      const current = draft ?? loaded;
      const store = async (value: { layout: Layout; title: string; guidance: string }) => {
        setState("saving");
        try {
          await save.mutateAsync({
            object: PROGRAM,
            id: programId,
            values: { layout: value.layout, title: value.title, guidance: value.guidance || null },
          });
          setFaults(new Map());
          setMessage(null);
          setState("saved");
        } catch (error) {
          setFaults(faultsOf(error));
          setMessage((error as { message?: string }).message ?? "The host refused this change");
          setState("refused");
        }
      };
      useEffect(() => {
        if (!draft || pending === 0) return undefined;
        const timer = setTimeout(() => void store(draft), SAVE_AFTER_MS);
        return () => clearTimeout(timer);
      }, [pending]);
      return {
        program: program.data,
        isPending: program.isPending,
        error: program.error,
        layout: current?.layout ?? null,
        title: current?.title ?? "",
        guidance: current?.guidance ?? "",
        state,
        faults,
        message,
        /** Applies an edit (one of `layoutEdits`) and saves it shortly after. */
        change(next: Layout) {
          if (!current) return;
          setDraft({ ...current, layout: next });
          setState("unsaved");
          setPending((n) => n + 1);
        },
        rename(title: string, guidance?: string) {
          if (!current) return;
          setDraft({ ...current, title, guidance: guidance ?? current.guidance });
          setState("unsaved");
          setPending((n) => n + 1);
        },
        async saveNow() {
          if (current) await store(current);
        },
        /** The working copy as a version had it (after restoring one). */
        reset(layout: Layout, title?: string) {
          setDraft({
            layout,
            title: title ?? current?.title ?? "",
            guidance: current?.guidance ?? "",
          });
          setState("saved");
          setFaults(new Map());
        },
      };
    },
  };
}

/** Every hook of this entry, as a client of all its operations gets them. A block takes the ones it calls: `Pick<ProgramsHooks, "useToday">`. */
export type ProgramsHooks = ReturnType<typeof allProgramsHooks>;
