// The accounting outbox's runner (stage 61 step 4, ADR 0882): sends the entries host code queued
// (`outbox.ts`) to the books through the accounting connection, as the host (`callAsHost`,
// purpose `accounting`, ADR 0881). The minute cron calls `runAccountingDue`; a quiet minute is one
// indexed read.
//
// - **Never twice.** An entry is claimed (`sending`, with the exact call, `attempts` counted) in a
//   statement only one run can win, before anything reaches the books; its outcome is recorded
//   only onto that same claim (the attempt it counted). Every call has a deadline well inside the
//   window after which a claim is taken for a run that stopped.
// - **A write the host knows was applied is never sent again.** Its books ref comes with the
//   applied action; when it does not, the entry waits (`unknown`, applied) and is looked up by its
//   reference after 1, 5, 30, 120 and 720 minutes, then held for a person: "in the books, its
//   reference not found".
// - **An uncertain outcome is looked up before anything is sent again**, after 1, 5 and 30 minutes
//   (36 in all); only then is it queued again, at most three times, then held. An error with no
//   refusal code is looked up the same way and then held, never sent again by itself.
// - **Never dropped.** Nothing leaves the outbox but by being sent or by a person skipping it.
//   A refusal holds the entry with its reason for a person; a transient one retries after 1, 5 and
//   30 minutes, 2 and 12 hours, then holds. For its first two tries (six minutes) nothing else is
//   sent; after that the rest go past it, but for its own day's entries, which keep their order
//   behind it. The bookkeepers are told when an entry is held (once a day) and when one has been
//   refused for over half an hour. The books unreachable at the start of a run touch no entry.
// - **In order, with dependencies.** By the day an entry belongs to, then as queued. One that
//   depends on another waits until that is sent, is held ("waits for …") while that one is held or
//   was skipped, and is released when it is sent.
// - **The lock date and the start date.** The books' lock date, read every run, moves an entry
//   dated on or before it to the first open day, its text saying its real date (decision 7); a
//   lock date that is not a date blocks every send. An entry whose day is before the start date is
//   never sent (decision 6).
// - **Approval** is the outbox's (`accounting.approveDay`); once it is over the admins are told.
// - **One set of books.** Only the chosen connection's entries are due or sent (ADR 0882: a change
//   of books skips the old books' unsent entries).
// - **Bounded.** At most `SENDS_PER_RUN` entries claimed and `LOOKUPS_PER_RUN` looked up a run,
//   a few statements each, whatever the backlog; the next minute carries on.
// - **Audited.** The integration host audits each write as the system's; the runner audits what it
//   decides alone: an entry found by its reference, held, or whose outcome is not known.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely } from "kysely";
import { newId } from "../ids.ts";
import type { IntegrationCallResult, IntegrationRuntime } from "../integrations/runtime.ts";
import { notifyStatements } from "../notifications/send.ts";
import { loadOrderCurrency } from "../orders/settings.ts";
import { loadGeneralSettings } from "../settings.ts";
import { addLocalDays, localParts, parseLocalDate } from "../time/local.ts";
import { dateField, KIND_METHOD, SENDABLE_KINDS, type SendableKind } from "./outbox.ts";
import {
  type AccountingMapKind,
  type AccountingSettings,
  loadAccountingSettings,
  loadMapping,
} from "./settings.ts";

type Db = Kysely<CoreDatabase>;

/** The most entries one run claims and sends. */
export const SENDS_PER_RUN = 25;
/** The most entries of unknown outcome one run looks up in the books. */
export const LOOKUPS_PER_RUN = 25;
/** The most days one run's daily pass builds; a backlog of days is built over several runs. */
export const DAYS_PER_RUN = 7;
/**
 * A claim left `sending` this long is a run that stopped. Longer than a scheduled invocation can
 * last (15 minutes), and every call's deadline is far inside it.
 */
export const STALE_MS = 30 * 60_000;
/** The longest one call to the books may take before its outcome is taken as not known. */
export const CALL_DEADLINE_MS = 5 * 60_000;
/** How long an entry waits before its dependency is checked again. */
export const DEPENDENCY_WAIT_MS = 10 * 60_000;
/** Minutes before each retry after a transient refusal; after the last, the entry is held. */
export const RETRY_MINUTES = [1, 5, 30, 120, 720] as const;
/** The tries after which an entry refused as transient no longer holds up other days. */
export const PAUSE_TRIES = 2;
/** Refused this many times (over half an hour), the bookkeepers are told, once for the entry. */
export const RETRY_NOTICE_TRIES = 4;
/** Minutes between the look-ups of an uncertain outcome; when all miss it is queued again. */
export const UNCERTAIN_LOOKUP_MINUTES = [1, 5, 30] as const;
/** Minutes between the look-ups of a write the host knows was applied; then it is held. */
export const APPLIED_LOOKUP_MINUTES = [1, 5, 30, 120, 720] as const;
/** How often an entry's outcome may be unknown before it is held instead of sent again. */
export const MAX_UNKNOWNS = 3;
/** The business's hour from which the daily pass runs (decision 2: 02:00 in its zone). */
export const DAILY_HOUR = 2;

/**
 * The refusal code at the start of a message (after the queue's own outcome tag), as the contract
 * writes it (ADR 0880): `[accounting:<code>] `. Elsewhere in a message it is a quotation.
 */
const REFUSAL =
  /^(?:\[apply-outcome:[a-z]+\] )?\[accounting:(unmapped|locked_period|invalid|duplicate_number|contact_archived|rate_limited|unavailable)\] /;
/** The codes retried with backoff; every other one holds the entry for a person. */
const TRANSIENT = new Set(["rate_limited", "unavailable", "locked_period"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The refusal code a message starts with, or null: no code means it may have been written. */
export function accountingRefusal(message: string): string | null {
  return REFUSAL.exec(message)?.[1] ?? null;
}

/**
 * Builds one day's entries (step 5's summaries and payouts), queuing them with `queuePost`. It
 * must be safe to run twice for a day: entries are queued once by their reference.
 */
export type DayBuilder = (input: {
  db: Db;
  day: string;
  connectionId: string;
  settings: AccountingSettings;
  now: string;
}) => Promise<void>;

/** The day builders the daily pass runs. Step 5 adds the daily summary and the payouts. */
export const DAY_BUILDERS: readonly DayBuilder[] = [];

export interface RunnerDeps {
  db: Db;
  integrations?: IntegrationRuntime | undefined;
  clock?: (() => Date) | undefined;
  /** The day builders to run (default `DAY_BUILDERS`). */
  builders?: readonly DayBuilder[];
  /** A call's deadline (default `CALL_DEADLINE_MS`); tests shorten it. */
  callDeadlineMs?: number;
  /**
   * Tests only: a fault injected at a point of the send. `sent` throws after the books answered
   * and before the outcome is recorded (a run that stops there leaves the claim `sending`).
   */
  fault?: (point: "claimed" | "sent", postId: string) => void | Promise<void>;
}

export interface RunResult {
  state: "off" | "blocked" | "unavailable" | "ran";
  blocked?: "connection" | "currency" | "lock";
  sent: number;
  held: number;
  retrying: number;
  unknown: number;
  /** Entries of unknown outcome found in the books (sent) or not (queued again). */
  found: number;
  requeued: number;
  /** Days the daily pass built. */
  days: number;
  /** Sending stopped for a transient refusal, or an entry waits to retry. */
  paused: boolean;
  /** The run reached its bound: the next minute carries on. */
  more: boolean;
  /** A day builder failed: the day is built again next run, and the bookkeepers were told. */
  buildFailed?: string;
}

const EMPTY: Omit<RunResult, "state"> = {
  sent: 0,
  held: 0,
  retrying: 0,
  unknown: 0,
  found: 0,
  requeued: 0,
  days: 0,
  paused: false,
  more: false,
};

const addMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

function addDays(date: string, days: number): string {
  const d = parseLocalDate(date);
  if (!d) throw new Error(`${date} is not a date`);
  const n = addLocalDays(d, days);
  return `${n.year}-${String(n.month).padStart(2, "0")}-${String(n.day).padStart(2, "0")}`;
}

/** "12 March 2026". */
function longDate(date: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** The first day the daily pass would build next, and the last it may build today. */
function dailySpan(
  settings: AccountingSettings & { dailyDate: string | null },
  today: string,
): { from: string; to: string } | null {
  if (!settings.startDate) return null;
  const to = addDays(today, -settings.settleDays);
  const from = settings.dailyDate ? addDays(settings.dailyDate, 1) : settings.startDate;
  return from <= to ? { from, to } : null;
}

interface RunnerSettings extends AccountingSettings {
  dailyDate: string | null;
  blocked: "connection" | "currency" | "lock" | null;
  automaticToldAt: string | null;
}

async function loadRunnerSettings(db: Db): Promise<RunnerSettings> {
  const [settings, extra] = await Promise.all([
    loadAccountingSettings(db),
    db
      .selectFrom("core_accounting_settings")
      .select(["daily_date", "blocked", "automatic_told_at"])
      .where("id", "=", 1)
      .executeTakeFirst(),
  ]);
  return {
    ...settings,
    dailyDate: extra?.daily_date ?? null,
    blocked: extra?.blocked ?? null,
    automaticToldAt: extra?.automatic_told_at ?? null,
  };
}

/**
 * Whether a run has work, for the minute cron: one indexed read (and, when the sync is on, the
 * organisation's zone). Only the chosen books' entries count; entries waiting for approval, held
 * or skipped are not work.
 */
export async function accountingDue(db: Db, now: string): Promise<boolean> {
  const row = await db.executeQuery<{
    enabled: number;
    connection_id: string | null;
    start_date: string | null;
    settle_days: number;
    daily_date: string | null;
    told: number;
    due: number;
  }>(
    CompiledQuery.raw(
      `SELECT s.enabled, s.connection_id, s.start_date, s.settle_days, s.daily_date,
         (s.approved_days >= s.approve_until AND s.automatic_told_at IS NULL) AS told,
         (EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.connection_id = s.connection_id
             AND p.state = 'queued' AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= ?1))
          OR EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.connection_id = s.connection_id
             AND p.state IN ('retrying', 'sending') AND p.next_attempt_at <= ?1)
          OR EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.connection_id = s.connection_id
             AND p.state = 'unknown' AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= ?1))
          OR EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.connection_id = s.connection_id
             AND p.state = 'held' AND p.error_code = 'pending_review'
             AND p.pending_action_id IS NOT NULL)) AS due
       FROM core_accounting_settings s WHERE s.id = 1`,
      [now],
    ),
  );
  const s = row.rows[0];
  if (s?.enabled !== 1 || !s.connection_id) return false;
  if (s.due || s.told) return true;
  if (!s.start_date) return false;
  const { timezone } = await loadGeneralSettings(db);
  const local = localParts(now, timezone);
  if (local.hour < DAILY_HOUR) return false;
  const to = addDays(local.date, -s.settle_days);
  const from = s.daily_date ? addDays(s.daily_date, 1) : s.start_date;
  return from <= to;
}

/** The minute cron's accounting step: one run when there is work. */
export async function runAccountingDue(deps: RunnerDeps): Promise<RunResult | null> {
  const now = (deps.clock?.() ?? new Date()).toISOString();
  if (!(await accountingDue(deps.db, now))) return null;
  return runAccounting(deps);
}

/** Who looks after the books: human admins and the accounts granted `accounting:manage`. */
async function bookkeepers(db: Db): Promise<string[]> {
  const result = await db.executeQuery<{ id: string }>(
    CompiledQuery.raw(
      `SELECT id FROM core_user WHERE kind = 'human' AND deactivated_at IS NULL
         AND (role = 'admin' OR (pack_role IS NULL AND EXISTS (SELECT 1 FROM json_each(CASE
           WHEN json_valid(granted_permissions) THEN granted_permissions ELSE '[]' END) g
           WHERE g.value = 'accounting:manage')))
       ORDER BY id LIMIT 200`,
      [],
    ),
  );
  return result.rows.map((r) => r.id);
}

/** Tells the bookkeepers, once per `dedupeKey`. */
async function tell(
  db: Db,
  now: string,
  notice: { title: string; body: string; dedupeKey: string },
): Promise<void> {
  const to = await bookkeepers(db);
  if (!to.length) return;
  const plan = await notifyStatements(
    db,
    {
      to: to.map((userId) => ({ userId })),
      type: "system.message",
      title: notice.title,
      body: notice.body,
      link: null,
      dedupeKey: notice.dedupeKey,
      source: { actor: "system" },
    },
    now,
  );
  for (const statement of plan.statements) await db.executeQuery(statement.compile());
}

const BLOCKED_NOTICE = {
  connection: {
    title: "Nothing is going to the books: the accounting connection needs an admin",
    body:
      "The accounting connection is not active, so no entry is sent. Nothing is lost: every " +
      "entry waits and goes once an admin reconnects it in Settings → Integrations.",
  },
  currency: {
    title: "Nothing is going to the books: they keep another currency",
    body:
      "The books connected for accounting keep a different currency from this business's, so " +
      "no entry is sent. Nothing is lost: entries wait until the books are put right.",
  },
  lock: {
    title: "Nothing is going to the books: their lock date cannot be read",
    body:
      "The books answered a lock date that is not a date, so no entry is sent, in case it would " +
      "land inside a locked period. Nothing is lost: entries wait until the books answer one.",
  },
} as const;

/** Records what blocks every send now; tells the bookkeepers once when it starts. */
async function setBlocked(
  db: Db,
  now: string,
  settings: RunnerSettings,
  blocked: "connection" | "currency" | "lock" | null,
): Promise<void> {
  if (settings.blocked === blocked) return;
  const changed = await db.executeQuery<{ id: number }>(
    CompiledQuery.raw(
      `UPDATE core_accounting_settings SET blocked = ?1, blocked_at = ?2
       WHERE id = 1 AND blocked IS NOT ?1 RETURNING id`,
      [blocked, blocked ? now : null],
    ),
  );
  if (!blocked || !changed.rows.length) return;
  await tell(db, now, {
    ...BLOCKED_NOTICE[blocked],
    dedupeKey: `accounting:blocked:${blocked}:${now}`,
  });
}

/** Tells the bookkeepers once that approval is over (again after it is put back on). */
async function tellAutomatic(db: Db, now: string, settings: RunnerSettings): Promise<void> {
  if (!settings.automatic || settings.automaticToldAt) return;
  const changed = await db.executeQuery<{ id: number }>(
    CompiledQuery.raw(
      `UPDATE core_accounting_settings SET automatic_told_at = ?1
       WHERE id = 1 AND automatic_told_at IS NULL AND approved_days >= approve_until
       RETURNING id`,
      [now],
    ),
  );
  if (!changed.rows.length) return;
  await tell(db, now, {
    title: "Entries now go to the books without approval",
    body:
      `A person has approved ${settings.approveUntil} days of entries, so from now on each day's ` +
      "entries go to the books on their own. A human admin can put approval back on in " +
      "Accounting settings.",
    dedupeKey: `accounting:automatic:${now}`,
  });
}

type Call = NonNullable<IntegrationRuntime["callAsHost"]>;

/** What came of one write. */
type Outcome =
  | { kind: "sent"; ref: string }
  /** Applied (the host knows), but the books did not name its ref: looked up, never resent. */
  | { kind: "applied"; message: string }
  | { kind: "refused"; code: string; message: string }
  /** It may have gone through: `unknown` (lost, or past the deadline) or `error` (no code). */
  | { kind: "unknown"; code: "unknown" | "timeout" | "error"; message: string }
  | { kind: "denied" }
  | { kind: "pending"; actionId: string | null };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A gatekeeper's words, short and without the queue's own tag, for a person to read. */
function errorText(message: string): string {
  return message
    .replace(/\[apply-outcome:[a-z]+\] /g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

class Deadline extends Error {}

function readOutcome(result: IntegrationCallResult): Outcome {
  if (result.denied?.length) return { kind: "denied" };
  const failed = result.failed?.[0];
  if (failed) {
    if (failed.outcome === "unknown") {
      return { kind: "unknown", code: "unknown", message: failed.message };
    }
    if (failed.outcome === "retryable") {
      // Nothing was sent: the gatekeeper may try it again, so it is retried as transient.
      return { kind: "refused", code: "unavailable", message: failed.message };
    }
    const code = accountingRefusal(failed.message);
    // Refused, nothing written, but with no code of the contract's: a person reads why.
    return { kind: "refused", code: code ?? "invalid", message: failed.message };
  }
  if (result.pending.length) {
    return { kind: "pending", actionId: result.pending[0]?.actionId ?? null };
  }
  const applied = result.applied[0];
  if (applied) {
    if (typeof applied.ref === "string" && applied.ref) return { kind: "sent", ref: applied.ref };
    const receipt = result.value as { ref?: unknown } | null;
    if (receipt && typeof receipt.ref === "string") return { kind: "sent", ref: receipt.ref };
    return { kind: "applied", message: "Applied: its books ref is looked up by its reference" };
  }
  return { kind: "unknown", code: "error", message: "The books gave no answer" };
}

interface PostRow {
  id: string;
  kind: string;
  reference: string;
  carries_date: string;
  belongs_date: string;
  lines: string;
  body: string;
  detail: string | null;
  depends_on: string | null;
  state: string;
  attempts: number;
  created_at: string;
}

const POST_COLUMNS = [
  "id",
  "kind",
  "reference",
  "carries_date",
  "belongs_date",
  "lines",
  "body",
  "detail",
  "depends_on",
  "state",
  "attempts",
  "created_at",
] as const;

/** Words for a missing mapping, for the person who maps it. */
function unmappedText(kind: AccountingMapKind, key: string | undefined): string {
  switch (kind) {
    case "category":
      return `map ${key} to an account`;
    case "tax":
      return `map tax code ${key} to a tax rate`;
    case "method":
      return `map ${key} payments to an account`;
    case "fees":
      return "map the payment provider's fees to an account";
    case "clearing":
      return "map the clearing account";
    case "bank":
      return "map the bank account payouts land in";
    case "rounding":
      return "map the rounding account";
    case "refunds":
      return "map refunds to an account";
    case "invoice_default":
      return "map invoice lines with no category to an account";
  }
}

interface Resolving {
  mapping: Map<string, string>;
  dependency: string | null;
  /** The entry's `detail` (a person's details), or null when it is kept as markers. */
  detail: Record<string, unknown> | null;
  missing: string[];
}

/**
 * Replaces each `{ map }` and `{ dep }` with the books' ref, and each `{ detail: key }` with the
 * person's value when `detail` is given (the call sent), or leaves it as it is (the call kept).
 */
function resolve(value: unknown, r: Resolving): unknown {
  if (Array.isArray(value)) return value.map((v) => resolve(v, r));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (typeof object.map === "string") {
    const kind = object.map as AccountingMapKind;
    const key = typeof object.key === "string" ? object.key : undefined;
    const ref = r.mapping.get(`${kind}:${key ?? ""}`);
    if (ref === undefined) {
      const text = unmappedText(kind, key);
      if (!r.missing.includes(text)) r.missing.push(text);
      return null;
    }
    return ref;
  }
  if (object.dep === "books_ref") return r.dependency;
  if (typeof object.detail === "string" && Object.keys(object).length === 1) {
    if (!r.detail) return object;
    if (!(object.detail in r.detail)) {
      const text = "its person's details are no longer kept, so it is not sent";
      if (!r.missing.includes(text)) r.missing.push(text);
      return null;
    }
    return r.detail[object.detail];
  }
  return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, resolve(v, r)]));
}

/** The note an entry moved past the lock date carries (decision 7). */
function lockNote(date: string, lockDate: string): string {
  return `dated ${longDate(date)}, the books are locked to ${longDate(lockDate)}`;
}

function withNote(text: unknown, note: string): string {
  const base = typeof text === "string" ? text : "";
  const suffix = base ? ` (${note})` : note;
  return `${base.slice(0, 500 - suffix.length)}${suffix}`;
}

/**
 * The exact call for an entry: its lines and body resolved, its reference and currency, and its
 * date (moved to the first open day past the lock date, with a note in its text).
 */
function requestFor(
  post: PostRow,
  resolved: { lines: unknown[]; body: Record<string, unknown> },
  currency: string,
  lockDate: string | null,
): { request: Record<string, unknown>; carries: string } {
  const kind = post.kind as SendableKind;
  const field = dateField(kind);
  if (!field) {
    return { request: { ...resolved.body, reference: post.reference }, carries: post.carries_date };
  }
  // From its own day every time: a lock moved since an earlier try, or lifted, is read as it is.
  let carries = post.belongs_date;
  let note: string | null = null;
  if (lockDate && carries <= lockDate) {
    note = lockNote(post.belongs_date, lockDate);
    carries = addDays(lockDate, 1);
  }
  const request: Record<string, unknown> = {
    ...resolved.body,
    reference: post.reference,
    currency,
    lines: resolved.lines,
    [field]: carries,
  };
  if (note) {
    if (field === "issueDate") {
      // A document has no text of its own: its first line says it, and it falls due no earlier.
      const [first, ...rest] = resolved.lines as Record<string, unknown>[];
      if (first) request.lines = [{ ...first, text: withNote(first.text, note) }, ...rest];
      if (typeof request.dueDate === "string" && request.dueDate < carries) {
        request.dueDate = carries;
      }
    } else {
      request.text = withNote(request.text, note);
    }
  }
  if (kind === "payment" || kind === "refund") delete request.lines;
  return { request, carries };
}

class Run {
  readonly result: RunResult = { state: "ran", ...EMPTY };
  readonly #db: Db;
  readonly #call: Call;
  readonly #now: string;
  readonly #zone: string;
  readonly #settings: RunnerSettings;
  readonly #connectionId: string;
  readonly #resource: string;
  readonly #fault: RunnerDeps["fault"];
  readonly #deadline: number;
  /** Days whose entries wait behind one of theirs that waits to retry: kept in order. */
  readonly waitingDays = new Set<string>();
  /** Entries released by one sent in this run, for the run to send next. */
  readonly released: PostRow[] = [];

  constructor(deps: RunnerDeps, call: Call, now: string, zone: string, settings: RunnerSettings) {
    this.#db = deps.db;
    this.#call = call;
    this.#now = now;
    this.#zone = zone;
    this.#settings = settings;
    this.#connectionId = settings.connectionId as string;
    this.#resource = settings.resource as string;
    this.#fault = deps.fault;
    this.#deadline = deps.callDeadlineMs ?? CALL_DEADLINE_MS;
  }

  /** One call to the books, as the host, with its deadline. */
  async ask(method: string, args: unknown[]): Promise<IntegrationCallResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Deadline(`The books did not answer within ${this.#deadline} ms`)),
        this.#deadline,
      );
    });
    try {
      return await Promise.race([
        this.#call({
          connectionId: this.#connectionId,
          resource: this.#resource,
          method,
          args,
          purpose: "accounting",
        }),
        deadline,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #exec<R = unknown>(sql: string, params: unknown[]): Promise<R[]> {
    return (await this.#db.executeQuery<R>(CompiledQuery.raw(sql, params))).rows;
  }

  /** An audit row for what the runner decides alone (ADR 0882), as the system. */
  async audit(postId: string, reference: string, event: string, extra: Record<string, unknown>) {
    await this.#exec(
      `INSERT INTO core_audit (id, at, operation, risk, actor, user_id, origin, input, result,
         gate_decision, outcome, error)
       VALUES (?1, ?2, 'accounting.run', 'write', 'automation', NULL, ?3, ?4, NULL, 'auto', 'ok', NULL)`,
      [
        newId("audit"),
        this.#now,
        JSON.stringify({ surface: "system", automationId: "system.accounting" }),
        JSON.stringify({ post: postId, reference, event, ...extra }),
      ],
    );
  }

  /** Tells the bookkeepers that entries are held: once a day, however many. */
  async tellHeld(): Promise<void> {
    const day = localParts(this.#now, this.#zone).date;
    await tell(this.#db, this.#now, {
      title: "Entries are held back from the books",
      body:
        "Some entries could not be sent to the books and wait for a person: each says why " +
        "(an account to map, a refusal, a reference not found). Retry or skip them once it is " +
        "put right; the rest carry on.",
      dedupeKey: `accounting:held:${day}`,
    });
  }

  /** A claim left `sending` past the stale window: a run that stopped; its outcome is unknown. */
  async staleClaims(): Promise<void> {
    const rows = await this.#exec<{ id: string; reference: string }>(
      `UPDATE core_accounting_post SET state = 'unknown', next_attempt_at = ?3, lookups = 0,
         unknowns = unknowns + 1, error_code = 'unknown',
         error_text = 'The run sending it stopped before it recorded the answer', updated_at = ?3
       WHERE id IN (SELECT id FROM core_accounting_post WHERE connection_id = ?1
         AND state = 'sending' AND next_attempt_at <= ?2 ORDER BY next_attempt_at LIMIT ?4)
       RETURNING id, reference`,
      [this.#connectionId, this.#now, this.#now, LOOKUPS_PER_RUN],
    );
    for (const row of rows) await this.audit(row.id, row.reference, "unknown", { why: "stale" });
  }

  /**
   * Entries waiting in Approvals whose action a person decided: approved and applied, the entry
   * is in the books and is looked up; turned down, it is held saying so.
   */
  async decidedInApprovals(): Promise<void> {
    const rows = await this.#exec<{ id: string; reference: string; status: string }>(
      `SELECT p.id, p.reference, a.status FROM core_accounting_post p
         JOIN core_pending_action a ON a.id = p.pending_action_id
       WHERE p.connection_id = ?1 AND p.state = 'held' AND p.error_code = 'pending_review'
         AND p.pending_action_id IS NOT NULL AND a.status != 'pending'
       LIMIT 5`,
      [this.#connectionId],
    );
    for (const row of rows) {
      if (row.status === "applied") {
        await this.#exec(
          `UPDATE core_accounting_post SET state = 'unknown', applied_at = ?2, lookups = 0,
             next_attempt_at = ?2, error_code = 'applied', pending_action_id = NULL,
             error_text = 'Approved in Approvals: looked up by its reference', updated_at = ?2
           WHERE id = ?1 AND state = 'held' AND error_code = 'pending_review'`,
          [row.id, this.#now],
        );
      } else {
        await this.#exec(
          `UPDATE core_accounting_post SET error_code = 'pending_turned_down', pending_action_id = NULL,
             error_text = 'Turned down in Approvals: nothing was sent. Retry it or skip it.',
             updated_at = ?2
           WHERE id = ?1 AND state = 'held' AND error_code = 'pending_review'`,
          [row.id, this.#now],
        );
      }
    }
  }

  /**
   * Entries of unknown outcome, looked up by reference before anything is sent again. Returns
   * false when the books could not answer (the run stops).
   */
  async lookUps(): Promise<boolean> {
    const rows = await this.#exec<{
      id: string;
      reference: string;
      error_code: string | null;
      error_text: string | null;
      applied_at: string | null;
      lookups: number;
      unknowns: number;
    }>(
      `SELECT id, reference, error_code, error_text, applied_at, lookups, unknowns
       FROM core_accounting_post WHERE connection_id = ?1 AND state = 'unknown'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?2)
       ORDER BY belongs_date, created_at, id LIMIT ?3`,
      [this.#connectionId, this.#now, LOOKUPS_PER_RUN],
    );
    if (rows.length === LOOKUPS_PER_RUN) this.result.more = true;
    let held = false;
    for (const row of rows) {
      // One run looks it up: the lease is the next attempt's time.
      const leased = await this.#exec(
        `UPDATE core_accounting_post SET next_attempt_at = ?3, updated_at = ?2
         WHERE id = ?1 AND state = 'unknown' AND (next_attempt_at IS NULL OR next_attempt_at <= ?2)
         RETURNING id`,
        [row.id, this.#now, addMs(this.#now, STALE_MS)],
      );
      if (!leased.length) continue;
      let found: { ref?: unknown } | null;
      try {
        found = (await this.ask("findByReference", [row.reference])).value as {
          ref?: unknown;
        } | null;
      } catch {
        // The books cannot say now: it stays unknown, looked up again once the lease is over.
        return false;
      }
      if (found && typeof found.ref === "string") {
        await this.#sent(row.id, found.ref, "unknown", null);
        await this.audit(row.id, row.reference, "sent", { ref: found.ref, by: "reference" });
        this.result.found += 1;
        continue;
      }
      const applied = row.applied_at !== null;
      const schedule = applied ? APPLIED_LOOKUP_MINUTES : UNCERTAIN_LOOKUP_MINUTES;
      const missed = row.lookups + 1;
      const wait = schedule[missed];
      if (wait !== undefined) {
        // Missed: looked up again later, the wait growing, before anything else is decided.
        await this.#exec(
          `UPDATE core_accounting_post SET lookups = ?2, next_attempt_at = ?3, updated_at = ?4
           WHERE id = ?1 AND state = 'unknown'`,
          [row.id, missed, addMs(this.#now, wait * 60_000), this.#now],
        );
        continue;
      }
      // The look-ups ran out. In the books (applied), or uncertain too often, or an error with no
      // code: a person decides. Only an answer lost, a few times at most, is sent again.
      const hold = applied
        ? {
            code: "not_found",
            text: `In the books, but its reference was not found: check ${row.reference} in the books, then retry to look again`,
          }
        : row.error_code === "error"
          ? {
              code: "error",
              text: `The send failed without saying why, and ${row.reference} is not in the books: ${row.error_text ?? ""}`,
            }
          : row.unknowns >= MAX_UNKNOWNS
            ? {
                code: "unknown_outcome",
                text: `The books' answer was lost ${row.unknowns} times and ${row.reference} is not in the books: retry it once they are checked`,
              }
            : null;
      if (hold) {
        await this.#exec(
          `UPDATE core_accounting_post SET state = 'held', error_code = ?2, error_text = ?3,
             next_attempt_at = NULL, updated_at = ?4
           WHERE id = ?1 AND state = 'unknown'`,
          [row.id, hold.code, hold.text.slice(0, 1000), this.#now],
        );
        await this.audit(row.id, row.reference, "held", { code: hold.code });
        this.result.held += 1;
        held = true;
      } else {
        await this.#exec(
          `UPDATE core_accounting_post SET state = 'queued', next_attempt_at = NULL, lookups = 0,
             error_code = NULL, error_text = NULL, updated_at = ?2
           WHERE id = ?1 AND state = 'unknown'`,
          [row.id, this.#now],
        );
        this.result.requeued += 1;
      }
    }
    if (held) await this.tellHeld();
    return true;
  }

  /** Records an entry sent onto its own claim (or from unknown), and releases what waited. */
  async #sent(
    id: string,
    ref: string,
    from: "sending" | "unknown",
    attempts: number | null,
  ): Promise<boolean> {
    const changed = await this.#exec(
      `UPDATE core_accounting_post SET state = 'sent', books_ref = ?2, sent_at = ?3,
         applied_at = coalesce(applied_at, ?3), next_attempt_at = NULL, error_code = NULL,
         error_text = NULL, updated_at = ?3
       WHERE id = ?1 AND state = ?4 AND (?5 IS NULL OR attempts = ?5)
       RETURNING id`,
      [id, ref, this.#now, from, attempts],
    );
    if (!changed.length) return false;
    const released = await this.#exec<PostRow>(
      `UPDATE core_accounting_post SET state = 'queued', next_attempt_at = NULL, error_code = NULL,
         error_text = NULL, updated_at = ?2
       WHERE depends_on = ?1 AND ((state = 'held' AND error_code = 'waits_for')
         OR (state = 'queued' AND next_attempt_at IS NOT NULL))
       RETURNING ${POST_COLUMNS.join(", ")}`,
      [id, this.#now],
    );
    // Sent in this run when it has room: a payment goes right after its invoice.
    this.released.push(...released);
    return true;
  }

  /**
   * An entry refused as transient waits to retry. For its first tries nothing else is sent; after
   * them only its own day's later entries wait behind it.
   */
  async retryWaits(): Promise<boolean> {
    const rows = await this.#exec<{ belongs_date: string; attempts: number }>(
      `SELECT belongs_date, attempts FROM core_accounting_post WHERE connection_id = ?1
         AND state = 'retrying' AND next_attempt_at > ?2 LIMIT 50`,
      [this.#connectionId, this.#now],
    );
    for (const row of rows) this.waitingDays.add(row.belongs_date);
    return rows.some((row) => row.attempts <= PAUSE_TRIES);
  }

  /** The entries due to send, in order: by day, then as queued. */
  async candidates(): Promise<PostRow[]> {
    const columns = POST_COLUMNS.join(", ");
    const pick = (state: string) =>
      this.#exec<PostRow>(
        `SELECT ${columns} FROM core_accounting_post WHERE connection_id = ?1 AND state = ?2
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)
         ORDER BY belongs_date, created_at, id LIMIT ?4`,
        [this.#connectionId, state, this.#now, SENDS_PER_RUN],
      );
    const [retrying, queued] = await Promise.all([pick("retrying"), pick("queued")]);
    const all = [...retrying, ...queued].sort((a, b) =>
      a.belongs_date !== b.belongs_date
        ? a.belongs_date < b.belongs_date
          ? -1
          : 1
        : a.created_at !== b.created_at
          ? a.created_at < b.created_at
            ? -1
            : 1
          : a.id < b.id
            ? -1
            : 1,
    );
    // As many as a run sends: there may be more, and the next minute carries on.
    if (all.length >= SENDS_PER_RUN) this.result.more = true;
    return all.slice(0, SENDS_PER_RUN);
  }

  async #hold(post: PostRow, code: string, text: string): Promise<void> {
    const changed = await this.#exec(
      `UPDATE core_accounting_post SET state = 'held', error_code = ?2, error_text = ?3,
         next_attempt_at = NULL, updated_at = ?4
       WHERE id = ?1 AND state = ?5 RETURNING id`,
      [post.id, code, text.slice(0, 1000), this.#now, post.state],
    );
    if (!changed.length) return;
    // An entry waiting for another is told with that one; it is not a hold of its own.
    if (code !== "waits_for") {
      await this.audit(post.id, post.reference, "held", { code });
      await this.tellHeld();
    }
    this.result.held += 1;
  }

  /**
   * Sends one entry. Returns false when sending should stop for this run (a transient refusal on
   * an entry's first tries: the books are struggling).
   */
  async send(
    post: PostRow,
    mapping: Map<string, string>,
    currency: string,
    lockDate: string | null,
  ): Promise<boolean> {
    if (!SENDABLE_KINDS.includes(post.kind as SendableKind)) {
      await this.#hold(post, "invalid", `A ${post.kind} is not sent by the runner`);
      return true;
    }
    // Its own day's entries keep their order behind one that waits to retry.
    if (post.state === "queued" && this.waitingDays.has(post.belongs_date)) return true;
    const start = this.#settings.startDate;
    if (!start || post.belongs_date < start || post.carries_date < start) {
      await this.#hold(post, "before_start", "Its day is before the start date: it is never sent");
      return true;
    }
    let dependency: string | null = null;
    if (post.depends_on) {
      const [dep] = await this.#exec<{
        state: string;
        books_ref: string | null;
        reference: string;
      }>("SELECT state, books_ref, reference FROM core_accounting_post WHERE id = ?1", [
        post.depends_on,
      ]);
      if (!dep || dep.state === "held" || dep.state === "skipped") {
        const why = !dep
          ? "an entry that is not in the outbox"
          : dep.state === "skipped"
            ? `${dep.reference}, which a person skipped`
            : dep.reference;
        await this.#hold(post, "waits_for", `waits for ${why}`);
        return true;
      }
      if (dep.state !== "sent" || !dep.books_ref) {
        await this.#exec(
          `UPDATE core_accounting_post SET next_attempt_at = ?2, updated_at = ?3
           WHERE id = ?1 AND state = ?4`,
          [post.id, addMs(this.#now, DEPENDENCY_WAIT_MS), this.#now, post.state],
        );
        return true;
      }
      dependency = dep.books_ref;
    }
    let detail: Record<string, unknown> = {};
    try {
      const parsed = post.detail === null ? {} : JSON.parse(post.detail);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed;
    } catch {
      detail = {};
    }
    const sending: Resolving = { mapping, dependency, detail, missing: [] };
    const lines = resolve(JSON.parse(post.lines), sending) as unknown[];
    const body = resolve(JSON.parse(post.body), sending) as Record<string, unknown>;
    if (sending.missing.length) {
      const code = sending.missing.some((m) => m.startsWith("map ")) ? "unmapped" : "invalid";
      await this.#hold(post, code, sending.missing.join("; "));
      return true;
    }
    const { request, carries } = requestFor(post, { lines, body }, currency, lockDate);
    // What is kept: the same call with a person's details left as their keys, so an erase clears
    // `detail` alone and the figures sent stay as they were (ADR 0882).
    const keeping: Resolving = { mapping, dependency, detail: null, missing: [] };
    const kept = requestFor(
      post,
      {
        lines: resolve(JSON.parse(post.lines), keeping) as unknown[],
        body: resolve(JSON.parse(post.body), keeping) as Record<string, unknown>,
      },
      currency,
      lockDate,
    ).request;
    const claimed = await this.#exec<{ attempts: number }>(
      `UPDATE core_accounting_post SET state = 'sending', request = ?2, carries_date = ?3,
         attempts = attempts + 1, next_attempt_at = ?4, error_code = NULL, error_text = NULL,
         updated_at = ?5
       WHERE id = ?1 AND state = ?6 AND (next_attempt_at IS NULL OR next_attempt_at <= ?5)
       RETURNING attempts`,
      [post.id, JSON.stringify(kept), carries, addMs(this.#now, STALE_MS), this.#now, post.state],
    );
    const attempts = claimed[0]?.attempts;
    if (attempts === undefined) return true;
    await this.#fault?.("claimed", post.id);

    const outcome = await this.#write(post, request);
    await this.#fault?.("sent", post.id);
    return this.#record(post, attempts, outcome);
  }

  async #write(post: PostRow, request: Record<string, unknown>): Promise<Outcome> {
    let result: IntegrationCallResult;
    try {
      result = await this.ask(KIND_METHOD[post.kind as SendableKind], [request]);
    } catch (error) {
      if (error instanceof Deadline) {
        return { kind: "unknown", code: "timeout", message: error.message };
      }
      const message = messageOf(error);
      const code = accountingRefusal(message);
      // A refusal is nothing written; anything else may have been, and is never just sent again.
      return code
        ? { kind: "refused", code, message }
        : { kind: "unknown", code: "error", message };
    }
    return readOutcome(result);
  }

  /** Writes an outcome onto the entry's own claim; a later claim's state is never touched. */
  async #record(post: PostRow, attempts: number, outcome: Outcome): Promise<boolean> {
    const set = async (
      state: string,
      code: string | null,
      text: string | null,
      next: string | null,
      extra = "",
      params: unknown[] = [],
    ) =>
      (
        await this.#exec(
          `UPDATE core_accounting_post SET state = ?2, error_code = ?3, error_text = ?4,
             next_attempt_at = ?5, updated_at = ?6${extra}
           WHERE id = ?1 AND state = 'sending' AND attempts = ?7 RETURNING id`,
          [post.id, state, code, text, next, this.#now, attempts, ...params],
        )
      ).length > 0;
    switch (outcome.kind) {
      case "sent":
        if (await this.#sent(post.id, outcome.ref, "sending", attempts)) this.result.sent += 1;
        return true;
      case "applied":
      case "unknown": {
        const applied = outcome.kind === "applied";
        const code = applied ? "applied" : outcome.code;
        const recorded = await set(
          "unknown",
          code,
          errorText(outcome.message) || "The answer was lost",
          addMs(
            this.#now,
            (applied ? APPLIED_LOOKUP_MINUTES : UNCERTAIN_LOOKUP_MINUTES)[0] * 60_000,
          ),
          `, lookups = 0, unknowns = unknowns + 1${applied ? ", applied_at = ?8" : ""}`,
          applied ? [this.#now] : [],
        );
        if (recorded) {
          await this.audit(post.id, post.reference, "unknown", { code });
          this.result.unknown += 1;
        }
        return true;
      }
      case "denied":
        if (
          await set(
            "held",
            "denied",
            "The deploy-time approval floor denies entries to the books: nothing was sent",
            null,
          )
        ) {
          await this.audit(post.id, post.reference, "held", { code: "denied" });
          await this.tellHeld();
          this.result.held += 1;
        }
        return true;
      case "pending":
        if (
          await set(
            "held",
            "pending_review",
            "It waits in Approvals instead of going at once: once a person approves it there it " +
              "is recorded as sent; turned down, retry or skip it",
            null,
            ", pending_action_id = ?8",
            [outcome.actionId],
          )
        ) {
          await this.audit(post.id, post.reference, "held", { code: "pending_review" });
          await this.tellHeld();
          this.result.held += 1;
        }
        return true;
      case "refused": {
        const transient = TRANSIENT.has(outcome.code);
        const wait = RETRY_MINUTES[attempts - 1];
        if (transient && wait !== undefined) {
          if (
            await set(
              "retrying",
              outcome.code,
              errorText(outcome.message),
              addMs(this.#now, wait * 60_000),
            )
          ) {
            this.result.retrying += 1;
            if (attempts >= RETRY_NOTICE_TRIES) {
              // Refused for over half an hour: the bookkeepers hear of it, once for this entry.
              await tell(this.#db, this.#now, {
                title: "An entry has been refused by the books for over half an hour",
                body:
                  `The books keep refusing ${post.reference} for now (${outcome.code}). It is ` +
                  "tried again on its own; other days' entries still go. Check the books if it " +
                  "goes on.",
                dedupeKey: `accounting:retrying:${post.id}`,
              });
            }
          }
          this.waitingDays.add(post.belongs_date);
          if (attempts <= PAUSE_TRIES) {
            this.result.paused = true;
            return false;
          }
          return true;
        }
        if (await set("held", outcome.code, errorText(outcome.message), null)) {
          await this.audit(post.id, post.reference, "held", { code: outcome.code });
          await this.tellHeld();
          this.result.held += 1;
        }
        return true;
      }
    }
  }
}

/** One run: blocked, unavailable, or the look-ups, the sends and the daily pass. */
export async function runAccounting(deps: RunnerDeps): Promise<RunResult> {
  const db = deps.db;
  const now = (deps.clock?.() ?? new Date()).toISOString();
  const settings = await loadRunnerSettings(db);
  if (!settings.enabled || !settings.connectionId || !settings.resource) {
    return { state: "off", ...EMPTY };
  }
  await tellAutomatic(db, now, settings);
  const connection = await db
    .selectFrom("core_integration_connection")
    .select("status")
    .where("id", "=", settings.connectionId)
    .executeTakeFirst();
  const call = deps.integrations?.callAsHost?.bind(deps.integrations);
  if (connection?.status !== "active" || !call) {
    await setBlocked(db, now, settings, "connection");
    return { state: "blocked", blocked: "connection", ...EMPTY };
  }
  const { timezone, baseCurrency } = await loadGeneralSettings(db);
  const run = new Run(deps, call, now, timezone, settings);

  // The books first: their currency and lock date, read before every run. Unreachable, nothing
  // is touched: every entry keeps its place and its attempts for when they are back.
  let books: { baseCurrency?: unknown; lockDate?: unknown };
  try {
    books = ((await run.ask("describeBooks", [])).value ?? {}) as typeof books;
  } catch {
    return { state: "unavailable", ...EMPTY };
  }
  const currency = (await loadOrderCurrency(db)) ?? baseCurrency;
  if (books.baseCurrency !== currency) {
    await setBlocked(db, now, settings, "currency");
    return { state: "blocked", blocked: "currency", ...EMPTY };
  }
  const lockDate = books.lockDate ?? null;
  if (lockDate !== null && (typeof lockDate !== "string" || !DATE.test(lockDate))) {
    // Not a date: an entry could land inside a locked period, so none goes.
    await setBlocked(db, now, settings, "lock");
    return { state: "blocked", blocked: "lock", ...EMPTY };
  }
  await setBlocked(db, now, settings, null);

  await run.staleClaims();
  await run.decidedInApprovals();
  if (!(await run.lookUps())) return { ...run.result, state: "unavailable" };

  // The sends first, so a failing day builder never holds them up.
  if (await run.retryWaits()) {
    run.result.paused = true;
  } else {
    const candidates = await run.candidates();
    if (candidates.length) {
      const mapping = new Map(
        (await loadMapping(db, settings.connectionId)).map((m) => [
          `${m.kind}:${m.hostKey ?? ""}`,
          m.booksRef,
        ]),
      );
      // Each entry once, at most a run's worth, those released by a send right after it.
      const seen = new Set<string>();
      const list = [...candidates];
      for (let i = 0; i < list.length && seen.size < SENDS_PER_RUN; i++) {
        const post = list[i] as PostRow;
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        if (!(await run.send(post, mapping, currency, lockDate as string | null))) break;
        list.splice(i + 1, 0, ...run.released.splice(0));
      }
      if (list.some((p) => !seen.has(p.id))) run.result.more = true;
    }
  }

  // The daily pass, from 02:00 in the organisation's zone: the days now settled, a few a run.
  const local = localParts(now, timezone);
  const span = local.hour >= DAILY_HOUR ? dailySpan(settings, local.date) : null;
  if (span) {
    let day = span.from;
    for (let built = 0; day <= span.to && built < DAYS_PER_RUN; day = addDays(day, 1), built++) {
      try {
        for (const build of deps.builders ?? DAY_BUILDERS) {
          await build({ db, day, connectionId: settings.connectionId, settings, now });
        }
      } catch (error) {
        // Not marked: built again next run (nothing is queued twice). The bookkeepers hear once a
        // day; the sends above already went.
        run.result.buildFailed = day;
        console.error("accounting: a day builder failed", day, messageOf(error).slice(0, 300));
        await tell(db, now, {
          title: "A day's entries for the books could not be built",
          body:
            `Building the entries for ${longDate(day)} failed; it is tried again every minute and ` +
            "nothing after it is built until it works. Entries already built still go.",
          dedupeKey: `accounting:build:${day}:${local.date}`,
        });
        break;
      }
      // Marked once built: a run that stops before this builds the day again, which queues
      // nothing twice. Another run that marked it first leaves the marker where it is.
      await db.executeQuery(
        CompiledQuery.raw(
          `UPDATE core_accounting_settings SET daily_date = ?1
           WHERE id = 1 AND (daily_date IS NULL OR daily_date < ?1)`,
          [day],
        ),
      );
      run.result.days += 1;
    }
    if (!run.result.buildFailed && day <= span.to) run.result.more = true;
  }
  return run.result;
}
