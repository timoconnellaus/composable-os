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
type QueryName = { [N in Name]: ProgramsOperations[N]["kind"] extends "query" ? N : never }[Name];
type MutationName = {
  [N in Name]: ProgramsOperations[N]["kind"] extends "mutation" ? N : never;
}[Name];
type In<N extends Name> = ProgramsOperations[N]["input"];
type Out<N extends Name> = ProgramsOperations[N]["output"];

export type TodayOut = Out<"x.programs.today">;
export type PlannedSession = TodayOut["sessions"][number];
export type SessionDetail = Out<"x.programs.sessionGet">;
export type LoggedSet = SessionDetail["logged"][number];
export type SessionExercise = SessionDetail["exercises"][number];
export type HistoryOut = Out<"x.programs.history">;
export type ProgressOut = Out<"x.programs.progress">;

/** The part of a generated client this entry needs. A product's client fits it. */
export interface ProgramsClient {
  query<N extends QueryName>(
    name: N,
    input: In<N>,
  ): { queryKey: readonly unknown[]; queryFn: () => Promise<Out<N>> };
  mutation<N extends MutationName>(
    name: N,
  ): { mutationKey: readonly unknown[]; mutationFn: (input: In<N>) => Promise<Out<N>> };
}

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
  if (set.load) parts.push(`@ ${set.load} kg`);
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

/** The prescription at `at`: an "all" item's `exercise`, or a level's. */
export function prescriptionAt(layout: Layout, at: At): Prescription {
  const item = itemAt(layout, at);
  if (item.kind === "all") {
    const p = item.exercises[at.exercise ?? 0];
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
        const first = item.levels[0];
        b.items[index] = {
          kind: "all",
          label: item.label,
          exercises: first ? levelExercises(first) : [],
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
  /** Another exercise beside the ones at `at` (an "all" item's, or a level's). */
  addExercise: (layout: Layout, at: At, exercise: string, measure?: string | null) =>
    edit(layout, (l) => {
      const item = itemAt(l, at);
      const p = newPrescription(exercise, measure);
      if (item.kind === "all") {
        item.exercises.push(p);
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
          const all = i.kind === "all" ? i.exercises : i.levels.flatMap(levelExercises);
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
 * Hooks for a React or React Native app:
 * `const programs = createProgramsHooks({ useQuery, useMutation, useState, useEffect }, api)`.
 */
export function createProgramsHooks(
  react: {
    useQuery: UseQuery;
    useMutation: UseMutation;
    useState: UseState;
    useEffect?: UseEffect;
  },
  api: ProgramsClient,
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
    /** The class types, for a member choosing their class. */
    useClassTypes() {
      return useQuery(
        api.query("record.list", {
          object: "programs.classtype",
          sort: { field: "order", direction: "asc" },
        }),
      );
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
     * decides when it is asked (`records:publish`, and a person, never an AI actor).
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

export type ProgramsHooks = ReturnType<typeof createProgramsHooks>;
