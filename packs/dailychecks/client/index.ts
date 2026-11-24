// The Daily checklists pack's headless entry (ADR 0651; ADR 0418): functions and hooks over the
// typed client, no markup. A client app imports it as `@composable-os/pack-dailychecks/client` and
// hands it its client; the blocks (web and native) render what it returns. Web and native share
// this logic, not their screens (ADR 0403).
//
// It holds no rules: which checklists are due today, who may do one, who may tick for whom, that
// the last tick finishes it and that a finished or missed day never changes are the host's. A block
// shows the host's answer (`canTick`, `mayDo`, `youManage`) and its refusals, never works one out.
// What someone writes on a step, why it was not done and why it was ticked for them are on screen
// only: read with `gcTime: 0`, sent through `forgetAfter`, never in a query's key.
import { type ClientHolding, forgetAfter, type PackClient, packHooks } from "@composable-os/client";
import type { z } from "@composable-os/sdk";
import type { checklistDay, done, history, tickStep, today } from "../tools.ts";

export { forgetAfter };

type Io<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.input<T["input"]>;
  output: z.output<T["output"]>;
};

/** The operations this entry calls, as the generated client types them. */
export type DailyChecksOperations = {
  "x.dailychecks.today": { kind: "query" } & Io<typeof today>;
  "x.dailychecks.day": { kind: "query" } & Io<typeof checklistDay>;
  "x.dailychecks.tick": { kind: "mutation" } & Io<typeof tickStep>;
  "x.dailychecks.done": { kind: "mutation" } & Io<typeof done>;
  "x.dailychecks.history": { kind: "query" } & Io<typeof history>;
};

type Name = keyof DailyChecksOperations & string;
type In<N extends Name> = DailyChecksOperations[N]["input"];
type Out<N extends Name> = DailyChecksOperations[N]["output"];

export type Today = Out<"x.dailychecks.today">;
export type DayItem = Today["items"][number];
export type DayRun = NonNullable<DayItem["run"]>;
export type DayStep = DayRun["steps"][number];
export type DayTick = NonNullable<DayStep["tick"]>;
export type DayDetail = Out<"x.dailychecks.day">;
export type TickInput = In<"x.dailychecks.tick">;
export type History = Out<"x.dailychecks.history">;
export type HistoryDay = History["days"][number];

/** The client of every operation this entry calls (ADR 0453). */
export type DailyChecksClient = PackClient<DailyChecksOperations>;

// --- Plain functions (display only) --------------------------------------------------------------

/** A day's state as a person reads it. */
export function dayStateLabel(state: DayItem["state"] | HistoryDay["state"]): string {
  switch (state) {
    case "not_started":
      return "Not started";
    case "open":
      return "In progress";
    case "done":
      return "Done";
    default:
      return "Missed";
  }
}

/** A step's tick as every screen shows it: what was ticked, by whom and for whom. */
export function tickLabel(tick: DayTick): string {
  if (tick.state === "cleared") return tick.label;
  return `${tick.done ? "Done" : "Not done"}: ${tick.label}`;
}

/** A time of day in the business's zone. */
export function timeIn(iso: string, zone: string, locale = "en-AU"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** A `YYYY-MM-DD` date as a person reads it (a calendar date: no zone). */
export function dateLabel(date: string, locale = "en-AU"): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

/** A `YYYY-MM-DD` date `days` later (or earlier). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/** The steps a day shows: its run's, or its preview before the run is made. */
export function stepsOf(item: DayItem): {
  position: number;
  text: string;
  required: boolean;
  asksNote: boolean;
  tick: DayTick | null;
  history: DayStep["history"];
  missed: boolean;
}[] {
  return (
    item.run?.steps ??
    (item.preview ?? []).map((s, position) => ({
      ...s,
      position,
      tick: null,
      history: [],
      missed: false,
    }))
  );
}

/** How a finished day reads: who finished it, for whom, and when. */
export function finishedLabel(item: DayItem, locale = "en-AU", zone = "UTC"): string | null {
  const run = item.run;
  if (!run || run.state !== "done" || !run.closedAt) return null;
  const by = run.closedByName ?? "someone";
  const forWhom = run.account && run.closedBy !== run.account && run.name ? ` for ${run.name}` : "";
  return `Done by ${by}${forWhom} at ${timeIn(run.closedAt, zone, locale)}${item.late ? " (after it was due)" : ""}`;
}

// --- Refusals -----------------------------------------------------------------------------------

export type DayRefusalKind =
  | "checklist_window"
  | "checklist_closed"
  | "checklist_not_your_tick"
  | "checklist_nothing_to_clear"
  | "checklist_too_many_ticks"
  | "checklist_for_why"
  | "checklist_for_whom"
  | "checklist_for_someone"
  | "checklist_not_theirs"
  | "checklist_note_needed"
  | "checklist_why"
  | "checklist_incomplete"
  | "checklists_manage"
  | "human_only"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "network"
  | "other";

export interface DayRefusal {
  kind: DayRefusalKind;
  /** The host's words, or ours for a network failure or a refusal with none. */
  message: string;
}

const KNOWN: ReadonlySet<string> = new Set<DayRefusalKind>([
  "checklist_window",
  "checklist_closed",
  "checklist_not_your_tick",
  "checklist_nothing_to_clear",
  "checklist_too_many_ticks",
  "checklist_for_why",
  "checklist_for_whom",
  "checklist_for_someone",
  "checklist_not_theirs",
  "checklist_note_needed",
  "checklist_why",
  "checklist_incomplete",
  "checklists_manage",
  "human_only",
]);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

/** What the host's refusal was, for the screen's designed state. */
export function dayRefusal(error: unknown): DayRefusal {
  const e = record(error);
  if (e?.name === "NetworkError") {
    return {
      kind: "network",
      message: "We could not reach the business just now. Check your connection and try again.",
    };
  }
  const details = record(e?.details);
  const inner = record(details?.details);
  const rule =
    typeof details?.rule === "string"
      ? details.rule
      : typeof inner?.rule === "string"
        ? inner.rule
        : null;
  const message = typeof e?.message === "string" && e.message ? e.message : null;
  if (rule && KNOWN.has(rule)) {
    return { kind: rule as DayRefusalKind, message: message ?? "That did not work. Try again." };
  }
  const code =
    typeof details?.code === "string" ? details.code : typeof e?.code === "string" ? e.code : null;
  if (code === "forbidden") {
    return { kind: "forbidden", message: "You can't do that. Ask whoever manages checklists." };
  }
  if (code === "not_found") {
    return { kind: "not_found", message: "That checklist is not there for you. Refresh the page." };
  }
  if (code === "invalid_input" || code === "validation") {
    return { kind: "invalid", message: message ?? "Something entered is not right." };
  }
  return { kind: "other", message: message ?? "That did not work. Try again." };
}

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery`, as far as these hooks use it. */
export type UseQuery = <T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  enabled?: boolean;
  gcTime?: number;
}) => { data: T | undefined; isPending: boolean; error: unknown; refetch?: () => unknown };

/** The app's `useMutation`, as far as these hooks use it. */
export type UseMutation = <I, O>(options: {
  mutationKey: readonly unknown[];
  mutationFn: (input: I) => Promise<O>;
  gcTime?: number;
}) => {
  mutate(input: I): void;
  mutateAsync(input: I): Promise<O>;
  data: O | undefined;
  isPending: boolean;
  error: unknown;
  /** Forgets the call: its variables and its answer (TanStack Query's `reset`). */
  reset?: () => void;
};

/**
 * The operations each hook calls (ADR 0453). Every staff client and every role client holds the
 * first four (the tools are every staff account's, ADR 0652); `useHistory` is for those who
 * manage checklists (the host refuses anyone else).
 */
export const DAILYCHECKS_HOOKS_CALL = {
  useToday: ["x.dailychecks.today"],
  useDay: ["x.dailychecks.day"],
  useTick: ["x.dailychecks.tick"],
  useDone: ["x.dailychecks.done"],
  useHistory: ["x.dailychecks.history"],
} as const;

/**
 * Hooks for a React or React Native app:
 * `const dailychecks = createDailyChecksHooks({ useQuery, useMutation }, api)`. `api` is the client
 * the screen's user holds: a role client (a cleaner's, a coach's) or the staff client. The hooks it
 * cannot back are not there.
 */
export function createDailyChecksHooks<C extends ClientHolding>(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  client: C,
) {
  return packHooks(client, DAILYCHECKS_HOOKS_CALL, (api: DailyChecksClient) =>
    allDailyChecksHooks(react, api),
  );
}

function allDailyChecksHooks(
  react: { useQuery: UseQuery; useMutation: UseMutation },
  api: DailyChecksClient,
) {
  const { useQuery, useMutation } = react;
  return {
    /** Today's checklists I may do (every one, if I manage checklists): on screen only. */
    useToday(enabled = true) {
      return useQuery({ ...api.query("x.dailychecks.today", {}), enabled, gcTime: 0 });
    },
    /** One checklist on one day (any day, for someone who manages checklists): on screen only. */
    useDay(input: In<"x.dailychecks.day"> | null) {
      return useQuery({
        ...api.query("x.dailychecks.day", input ?? { template: "", date: "" }),
        enabled: input !== null,
        gcTime: 0,
      });
    },
    /**
     * Tick a step (a person's own act). What is written on it is forgotten once the call is over:
     * call it through `forgetAfter`.
     */
    useTick() {
      return useMutation({ ...api.mutation("x.dailychecks.tick"), gcTime: 0 });
    },
    /** Finish it with optional steps left: final. */
    useDone() {
      return useMutation({ ...api.mutation("x.dailychecks.done"), gcTime: 0 });
    },
    /** How each day went (those who manage checklists): on screen only. */
    useHistory(input: In<"x.dailychecks.history"> | null) {
      return useQuery({
        ...api.query("x.dailychecks.history", input ?? { from: "", to: "" }),
        enabled: input !== null,
        gcTime: 0,
      });
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<DailyChecksHooks, "useToday">`. */
export type DailyChecksHooks = ReturnType<typeof allDailyChecksHooks>;
