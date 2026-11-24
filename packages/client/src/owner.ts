// The owner's Today for a staff app (stage 60 step 6, ADR 0872): the headless entry the native
// block (`owner-today`, `owner-approvals`) and the web admin's Today share. Functions and hooks
// over the owner's client (`roles/owner.ts`) or the staff client, no markup and no platform API.
// Web and native share this logic, not their screens.
//
// It holds no rules. Which items a person sees, their numbers, whether one needs attention, the
// order they come in, who may approve what and when a second step is asked are the host's answers
// (`today.get`, `approval.*`): this reads them and puts them in words. It names no pack and no
// object: an item is whatever the host lists. Money is shown as the host gave it, in the
// currency's minor unit; nothing here adds up a figure.
//
// What is on screen only: money, the drill-in rows (they name members) and an approval's detail
// are read with `gcTime: 0`, and `forgetToday` drops them when the app goes to the background
// (ADR 0629's pattern).
import { ApiError, NetworkError } from "./errors.ts";
import type { ClientHolding, PackClient } from "./hooks.ts";
import { packHooks } from "./hooks.ts";

// --- What the host answers ------------------------------------------------------------------------

/** How an item's value reads. Money is only ever the host's own items (stage 52's figures). */
export type TodayFormat = "count" | "percent" | "money";

/** What tapping an item opens. */
export type TodayTarget =
  /** Its drill-in rows (`today.rows`). */
  | { kind: "rows" }
  /** The approvals waiting for this person. */
  | { kind: "approvals" }
  /** The notice inbox. */
  | { kind: "notices" }
  /** On the web, a pack's staff screen (stage 47); a phone opens the rows instead. */
  | { kind: "screen"; pack: string; screen: string };

/** One number on Today (`today.get`'s `items`). */
export interface TodayItem {
  /** `host.takings`, `bookings.cameToday`: stable, for keys and drill-in. */
  key: string;
  label: string;
  format: TodayFormat;
  /** A count; a percent as 0 to 100; money in the currency's minor unit. */
  value: number;
  /** A money item's currency; null otherwise. */
  currency: string | null;
  /** A second line the host words (`3 payments`), or null. */
  detail: string | null;
  /** The same figure at the same time yesterday or last week, when the item compares. */
  compare: { against: "yesterday" | "lastWeek"; value: number } | null;
  state: "ok" | "attention";
  target: TodayTarget;
}

/** Today for the signed-in person: the business's local day and its items, in the host's order. */
export interface TodayAnswer {
  /** The local date, `YYYY-MM-DD`. */
  day: string;
  /** The business's time zone (IANA). */
  zone: string;
  items: TodayItem[];
}

/** One row behind an item (`today.rows`): a name and a line, and the record it opens, if any. */
export interface TodayRow {
  label: string;
  detail: string | null;
  record: { object: string; id: string } | null;
}

/** One alert a person receives, and on which channels (`today.alerts`). */
export interface TodayAlertSetting {
  key: string;
  label: string;
  on: boolean;
  channels: string[];
}

/** A person's alerts and overnight hours (local `HH:MM`, the business's zone). */
export interface TodayAlerts {
  alerts: TodayAlertSetting[];
  overnight: { from: string; to: string };
}

export type ActionStatus = "pending" | "applied" | "failed" | "skipped" | "rejected" | "expired";

/** A change set in the queue (`approval.list`'s items), as far as Today reads it. */
export interface WaitingChangeSet {
  id: string;
  title: string | null;
  userName: string | null;
  actor: string;
  status: "awaiting_review" | "done" | "empty";
  counts: { pending: number; total: number };
  createdAt: string;
}

/** What the host asks before a high-risk approval (ADR 0345). */
export interface SecondStep {
  label: string;
  confirmLabel: string;
  phrase: string;
}

/** One pending action of a change set (`approval.get`'s actions), as far as Today reads it. */
export interface WaitingAction {
  id: string;
  changeSetId: string;
  operation: string;
  risk: string;
  reason: string;
  status: ActionStatus;
  preview: { object: string; id: string; action: string; diff: Record<string, unknown> }[];
  secondStep: SecondStep | null;
}

/** A change set with its actions (`approval.get`). */
export interface ChangeSetDetail extends WaitingChangeSet {
  actions: WaitingAction[];
}

/** What a decision answers. */
export interface DecisionResult {
  results: { actionId: string; operation: string; status: ActionStatus }[];
  counts: { pending: number; total: number };
}

/** One notice in the inbox (`notification.list`), as far as Today reads it. */
export interface Notice {
  id: string;
  type: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
}

/** The operations this entry calls, as the generated client types them. */
export type OwnerOperations = {
  "today.get": { kind: "query"; input: Record<string, never>; output: TodayAnswer };
  "today.rows": { kind: "query"; input: { key: string }; output: { items: TodayRow[] } };
  "today.alerts": { kind: "query"; input: Record<string, never>; output: TodayAlerts };
  "today.setAlerts": {
    kind: "mutation";
    input: { key?: string; on?: boolean; overnight?: { from: string; to: string } };
    output: TodayAlerts;
  };
  "approval.list": {
    kind: "query";
    input: { status?: "awaiting_review" | "all"; limit?: number };
    output: { items: WaitingChangeSet[]; pendingCount: number };
  };
  "approval.get": { kind: "query"; input: { changeSetId: string }; output: ChangeSetDetail };
  "approval.approve": {
    kind: "mutation";
    input: { actionIds?: string[]; changeSetId?: string; note?: string; confirm?: string };
    output: DecisionResult;
  };
  "approval.reject": {
    kind: "mutation";
    input: { actionIds?: string[]; changeSetId?: string; note?: string };
    output: DecisionResult;
  };
  "notification.list": {
    kind: "query";
    input: { unreadOnly?: boolean; limit?: number; cursor?: string };
    output: { items: Notice[]; unread: number; nextCursor: string | null };
  };
  "notification.unreadCount": {
    kind: "query";
    input: Record<string, never>;
    output: { unread: number };
  };
  "notification.markRead": {
    kind: "mutation";
    input: { ids?: string[]; all?: boolean };
    output: { updated: number };
  };
  "user.me": {
    kind: "query";
    input: Record<string, never>;
    output: { id: string; name: string; role: string; permissions: string[] };
  };
};

export type OwnerClient = PackClient<OwnerOperations>;

// --- Words -----------------------------------------------------------------------------------------

/** An item's value as it reads: `12`, `85%`, or money in the host's currency. */
export function todayValueWords(item: TodayItem, locale?: string): string {
  if (item.format === "percent") {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
      item.value / 100,
    );
  }
  if (item.format === "money" && item.currency)
    return moneyWords(item.value, item.currency, locale);
  return new Intl.NumberFormat(locale).format(item.value);
}

/** An amount in a currency's minor unit, in words: `$1,234.50`. */
function moneyWords(minor: number, currency: string, locale?: string): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** digits);
}

/** The comparison under a value: `5 yesterday`, `$90.00 last week`, or null when there is none. */
export function todayCompareWords(item: TodayItem, locale?: string): string | null {
  if (!item.compare) return null;
  const value = todayValueWords({ ...item, value: item.compare.value }, locale);
  return `${value} ${item.compare.against === "yesterday" ? "yesterday" : "last week"}`;
}

/** The day at the top of the screen, in the business's zone: `Tuesday 24 November`. */
export function todayDayWords(answer: Pick<TodayAnswer, "day" | "zone">, locale?: string): string {
  // Noon UTC on the local date is the same date in every zone the host may name.
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${answer.day}T12:00:00Z`));
}

/** What a setup change says on a phone: the host refuses it there (decision 8). */
export const REVIEW_ON_COMPUTER_WORDS = "Review on a computer";

/**
 * Whether an action changes how the system is set up (an extension, new fields): listed on the
 * phone with "Review on a computer", never offered Approve. The host refuses it from the app
 * whatever the screen shows.
 */
export function needsComputer(action: Pick<WaitingAction, "risk">): boolean {
  return action.risk === "extension" || action.risk === "schema";
}

/** The actions still waiting in a change set, in the host's order. */
export function waitingActions(detail: Pick<ChangeSetDetail, "actions">): WaitingAction[] {
  return detail.actions.filter((a) => a.status === "pending");
}

/**
 * The input that approves one action. `confirmed` is true once the person pressed the second
 * step's button: its words are sent as the host gave them (ADR 0345); the host decides whether
 * one was needed.
 */
export function approveInput(
  action: Pick<WaitingAction, "id" | "secondStep">,
  confirmed = false,
): OwnerOperations["approval.approve"]["input"] {
  return {
    actionIds: [action.id],
    ...(confirmed && action.secondStep ? { confirm: action.secondStep.confirmLabel } : {}),
  };
}

/** The input that rejects one action. */
export function rejectInput(
  action: Pick<WaitingAction, "id">,
  note?: string,
): OwnerOperations["approval.reject"]["input"] {
  return { actionIds: [action.id], ...(note?.trim() ? { note: note.trim() } : {}) };
}

/** What a failed call on Today means, for the screen. */
export type OwnerFailure =
  | { kind: "secondStep"; step: SecondStep; message: string }
  | { kind: "reviewOnComputer"; message: string }
  | { kind: "notAllowed"; message: string }
  | { kind: "signIn"; message: string }
  | { kind: "offline"; message: string }
  | { kind: "other"; message: string };

/** A failed call in the screen's words, keeping the host's message where it has one. */
export function ownerFailure(error: unknown): OwnerFailure {
  if (error instanceof NetworkError) {
    return { kind: "offline", message: "Could not reach the business. Check the connection." };
  }
  if (!(error instanceof ApiError)) {
    return { kind: "other", message: "That did not work. Try again." };
  }
  const details = (error.details ?? {}) as Record<string, unknown>;
  if (error.code === "second_step_required" && typeof details.confirmLabel === "string") {
    return { kind: "secondStep", step: details as unknown as SecondStep, message: error.message };
  }
  if (details.reason === "review_on_computer") {
    return { kind: "reviewOnComputer", message: REVIEW_ON_COMPUTER_WORDS };
  }
  if (error.status === 401) return { kind: "signIn", message: "Sign in again." };
  if (error.code === "forbidden") return { kind: "notAllowed", message: error.message };
  return { kind: "other", message: error.message };
}

// --- On screen only ---------------------------------------------------------------------------------

/** The reads that carry money, names or an approval's detail: never kept off screen. */
export const TODAY_PRIVATE_QUERIES = ["today.get", "today.rows", "approval.get"] as const;

/**
 * Drops Today's private reads from the app's query cache: call it when the app goes to the
 * background (`AppState` on a phone) and on sign-out.
 */
export function forgetToday(queryClient: {
  removeQueries(filters: { queryKey: readonly unknown[] }): unknown;
}): void {
  for (const name of TODAY_PRIVATE_QUERIES) queryClient.removeQueries({ queryKey: [name] });
}

// --- Hooks ---------------------------------------------------------------------------------------

/** The app's `useQuery`, as far as these hooks use it. */
export type OwnerUseQuery = <T>(options: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  enabled?: boolean;
  gcTime?: number;
}) => { data: T | undefined; isPending: boolean; error: unknown; refetch?: () => unknown };

/** The app's `useMutation`, as far as these hooks use it. */
export type OwnerUseMutation = <I, O>(options: {
  mutationKey: readonly unknown[];
  mutationFn: (input: I) => Promise<O>;
  gcTime?: number;
}) => {
  mutate(input: I): void;
  mutateAsync(input: I): Promise<O>;
  data: O | undefined;
  isPending: boolean;
  error: unknown;
  reset?: () => void;
};

/**
 * The operations each hook calls (ADR 0453). The owner's client holds them all once its release
 * serves them; a release without Today's own operations yet offers the approvals and the inbox.
 */
export const OWNER_HOOKS_CALL = {
  useToday: ["today.get"],
  useTodayRows: ["today.rows"],
  useAlerts: ["today.alerts"],
  useSetAlerts: ["today.setAlerts"],
  useWaiting: ["approval.list"],
  useChangeSet: ["approval.get"],
  useApprove: ["approval.approve"],
  useReject: ["approval.reject"],
  useNotices: ["notification.list"],
  useUnreadCount: ["notification.unreadCount"],
  useMarkRead: ["notification.markRead"],
  useMe: ["user.me"],
} as const;

/**
 * Hooks for a React or React Native app:
 * `const today = createOwnerHooks({ useQuery, useMutation }, api)`, with the owner's client (or
 * the staff client, on the web). The hooks it cannot back are not there.
 */
export function createOwnerHooks<C extends ClientHolding>(
  react: { useQuery: OwnerUseQuery; useMutation: OwnerUseMutation },
  client: C,
) {
  return packHooks(client, OWNER_HOOKS_CALL, (api: OwnerClient) => allOwnerHooks(react, api));
}

function allOwnerHooks(
  react: { useQuery: OwnerUseQuery; useMutation: OwnerUseMutation },
  api: OwnerClient,
) {
  const { useQuery, useMutation } = react;
  return {
    /** Today's items for the signed-in person: money among them, so on screen only. */
    useToday() {
      return useQuery({ ...api.query("today.get", {}), gcTime: 0 });
    },
    /** One item's rows (they name people): on screen only. `null` reads nothing. */
    useTodayRows(key: string | null) {
      return useQuery({
        ...api.query("today.rows", { key: key ?? "" }),
        enabled: key !== null,
        gcTime: 0,
      });
    },
    /** The alerts this person receives and their overnight hours. */
    useAlerts() {
      return useQuery(api.query("today.alerts", {}));
    },
    /** Turn one of their own alerts on or off, or set their overnight hours. */
    useSetAlerts() {
      return useMutation(api.mutation("today.setAlerts"));
    },
    /** The change sets waiting for review that this person sees. */
    useWaiting() {
      return useQuery(api.query("approval.list", { status: "awaiting_review", limit: 50 }));
    },
    /** One change set with its actions, previews and second steps: on screen only. */
    useChangeSet(changeSetId: string | null) {
      return useQuery({
        ...api.query("approval.get", { changeSetId: changeSetId ?? "" }),
        enabled: changeSetId !== null,
        gcTime: 0,
      });
    },
    /** Approve one action (`approveInput`); the host may answer with its second step. */
    useApprove() {
      return useMutation(api.mutation("approval.approve"));
    },
    /** Reject one action (`rejectInput`). */
    useReject() {
      return useMutation(api.mutation("approval.reject"));
    },
    /** The notice inbox, newest first. */
    useNotices(unreadOnly = false) {
      return useQuery(api.query("notification.list", { unreadOnly, limit: 30 }));
    },
    /** How many notices are unread. */
    useUnreadCount() {
      return useQuery(api.query("notification.unreadCount", {}));
    },
    /** Mark notices read: some by id, or all. */
    useMarkRead() {
      return useMutation(api.mutation("notification.markRead"));
    },
    /** Who is signed in. */
    useMe() {
      return useQuery(api.query("user.me", {}));
    },
  };
}

/** Every hook of this entry. A block takes the ones it calls: `Pick<OwnerHooks, "useToday">`. */
export type OwnerHooks = ReturnType<typeof allOwnerHooks>;
