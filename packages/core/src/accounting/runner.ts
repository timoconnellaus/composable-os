// The accounting outbox's runner (stage 61 step 4, ADR 0882): sends the entries host code queued
// (`outbox.ts`) to the books through the accounting connection, as the host (`callAsHost`,
// purpose `accounting`, ADR 0881). The minute cron calls `runAccountingDue`; a quiet minute is one
// indexed read.
//
// - **Never twice.** An entry is claimed (`sending`, with the exact call it sends) in a statement
//   that only one run can win, before anything reaches the books, and its outcome is recorded
//   after. The books keep its reference, and the gatekeeper writes nothing for a reference they
//   already hold (ADR 0880).
// - **An uncertain outcome is looked up, never resent blind.** An answer lost on the way back, an
//   error with no refusal code, or a claim left `sending` by a run that stopped (a crash between
//   the books' answer and the record) makes the entry `unknown`; the next run calls
//   `findByReference` first: found, it is `sent` with the books' ref; not found, it is `queued`
//   again, and only then sent.
// - **Never dropped.** Nothing leaves the outbox but by being sent or by a person skipping it.
//   A refusal holds the entry with its reason for a person (`held`); a transient one
//   (`rate_limited`, `unavailable`, an action the gatekeeper may try again) retries after 1, 5 and
//   30 minutes, 2 and 12 hours, then holds. While one waits to retry, nothing else is sent: the
//   books are struggling, and the entries keep their order. The books unreachable at the start of
//   a run (an outage of any length) touch no entry at all.
// - **In order, with dependencies.** Entries go by the day they belong to, then as queued. One
//   that depends on another (a payment on its invoice) waits until that is sent, and is held
//   ("waits for …") while that one is held or was skipped; it is released when that one is sent.
// - **The lock date and the start date.** The books' lock date is read at the start of every run:
//   an entry dated on or before it carries the first open day, its text saying its real date
//   (decision 7). An entry whose day is before the start date is never sent (decision 6).
// - **Approval** is the outbox's (`accounting.approveDay`): an entry waiting for its day's
//   approval is never picked here. Once approval is over the admins are told once.
// - **Bounded.** One run claims at most `SENDS_PER_RUN` entries and looks up at most
//   `LOOKUPS_PER_RUN`, a few statements each, whatever the backlog; the next minute carries on.
// - **Blocked, said once.** A connection that is not active, or books in another currency, block
//   every send: nothing is claimed, and the admins are told once when it starts.
import type { CoreDatabase } from "@composable-os/db";
import { CompiledQuery, type Kysely } from "kysely";
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
/** A claim left `sending` this long is a run that stopped: its outcome is unknown. */
export const STALE_MS = 10 * 60_000;
/** How long an entry waits before its dependency is checked again. */
export const DEPENDENCY_WAIT_MS = 10 * 60_000;
/** Minutes before each retry after a transient refusal; after the last, the entry is held. */
export const RETRY_MINUTES = [1, 5, 30, 120, 720] as const;
/** The business's hour from which the daily pass runs (decision 2: 02:00 in its zone). */
export const DAILY_HOUR = 2;

/** The refusal codes of the contract (ADR 0880), at the start of a message as `[accounting:<code>] `. */
const REFUSAL =
  /\[accounting:(unmapped|locked_period|invalid|duplicate_number|contact_archived|rate_limited|unavailable)\] /;
/** The codes retried with backoff; every other one holds the entry for a person. */
const TRANSIENT = new Set(["rate_limited", "unavailable"]);

/** The refusal code a message carries, or null: no code means it may have been written. */
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
  /**
   * Tests only: a fault injected at a point of the send. `sent` throws after the books answered
   * and before the outcome is recorded (a run that stops there leaves the claim `sending`).
   */
  fault?: (point: "claimed" | "sent", postId: string) => void | Promise<void>;
}

export interface RunResult {
  state: "off" | "blocked" | "unavailable" | "ran";
  blocked?: "connection" | "currency";
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
  blocked: "connection" | "currency" | null;
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
 * organisation's zone). Entries waiting for approval, held or skipped are not work.
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
         (EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.state = 'queued'
             AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= ?1))
          OR EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.state IN ('retrying', 'sending')
             AND p.next_attempt_at <= ?1)
          OR EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.state = 'unknown'
             AND (p.next_attempt_at IS NULL OR p.next_attempt_at <= ?1))) AS due
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
} as const;

/** Records what blocks every send now; tells the bookkeepers once when it starts. */
async function setBlocked(
  db: Db,
  now: string,
  settings: RunnerSettings,
  blocked: "connection" | "currency" | null,
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
  | { kind: "refused"; code: string; message: string }
  | { kind: "unknown"; message: string }
  | { kind: "denied" }
  | { kind: "pending" };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A gatekeeper's words, short and without the queue's own tag, for a person to read. */
function errorText(message: string): string {
  return message
    .replace(/\[apply-outcome:[a-z]+\] /g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function readOutcome(result: IntegrationCallResult): Outcome | "applied" {
  if (result.denied?.length) return { kind: "denied" };
  const failed = result.failed?.[0];
  if (failed) {
    if (failed.outcome === "unknown") return { kind: "unknown", message: failed.message };
    if (failed.outcome === "retryable") {
      // Nothing was sent: the gatekeeper may try it again, so it is retried as transient.
      return { kind: "refused", code: "unavailable", message: failed.message };
    }
    return {
      kind: "refused",
      code: accountingRefusal(failed.message) ?? "invalid",
      message: failed.message,
    };
  }
  if (result.pending.length) return { kind: "pending" };
  if (result.applied.length) return "applied";
  return { kind: "unknown", message: "The books gave no answer" };
}

interface PostRow {
  id: string;
  kind: string;
  reference: string;
  carries_date: string;
  belongs_date: string;
  lines: string;
  body: string;
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

/** Replaces each `{ map }` and `{ dep }` with the books' ref; lists what is not mapped. */
function resolve(
  value: unknown,
  mapping: Map<string, string>,
  dependency: string | null,
  missing: string[],
): unknown {
  if (Array.isArray(value)) return value.map((v) => resolve(v, mapping, dependency, missing));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (typeof object.map === "string") {
    const kind = object.map as AccountingMapKind;
    const key = typeof object.key === "string" ? object.key : undefined;
    const ref = mapping.get(`${kind}:${key ?? ""}`);
    if (ref === undefined) {
      const text = unmappedText(kind, key);
      if (!missing.includes(text)) missing.push(text);
      return null;
    }
    return ref;
  }
  if (object.dep === "books_ref") return dependency;
  return Object.fromEntries(
    Object.entries(object).map(([k, v]) => [k, resolve(v, mapping, dependency, missing)]),
  );
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
  readonly #settings: RunnerSettings;
  readonly #connectionId: string;
  readonly #resource: string;
  readonly #fault: RunnerDeps["fault"];

  constructor(deps: RunnerDeps, call: Call, now: string, settings: RunnerSettings) {
    this.#db = deps.db;
    this.#call = call;
    this.#now = now;
    this.#settings = settings;
    this.#connectionId = settings.connectionId as string;
    this.#resource = settings.resource as string;
    this.#fault = deps.fault;
  }

  ask(method: string, args: unknown[]): Promise<IntegrationCallResult> {
    return this.#call({
      connectionId: this.#connectionId,
      resource: this.#resource,
      method,
      args,
      purpose: "accounting",
    });
  }

  async #exec<R = unknown>(sql: string, params: unknown[]): Promise<R[]> {
    return (await this.#db.executeQuery<R>(CompiledQuery.raw(sql, params))).rows;
  }

  /** A claim left `sending` past the stale window: a run stopped; its outcome is unknown. */
  async staleClaims(): Promise<void> {
    await this.#exec(
      `UPDATE core_accounting_post SET state = 'unknown', next_attempt_at = NULL,
         error_code = 'unknown', error_text = 'The run sending it stopped before it recorded the answer',
         updated_at = ?3
       WHERE id IN (SELECT id FROM core_accounting_post WHERE connection_id = ?1
         AND state = 'sending' AND next_attempt_at <= ?2 ORDER BY next_attempt_at LIMIT ?4)`,
      [this.#connectionId, this.#now, this.#now, LOOKUPS_PER_RUN],
    );
  }

  /** Entries of unknown outcome, looked up by reference before anything is sent again. */
  async lookUps(): Promise<boolean> {
    const rows = await this.#exec<{ id: string; reference: string }>(
      `SELECT id, reference FROM core_accounting_post WHERE connection_id = ?1 AND state = 'unknown'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?2)
       ORDER BY belongs_date, created_at, id LIMIT ?3`,
      [this.#connectionId, this.#now, LOOKUPS_PER_RUN],
    );
    if (rows.length === LOOKUPS_PER_RUN) this.result.more = true;
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
        await this.#sent(row.id, found.ref, "unknown");
        this.result.found += 1;
      } else {
        await this.#exec(
          `UPDATE core_accounting_post SET state = 'queued', next_attempt_at = NULL,
             error_code = NULL, error_text = NULL, updated_at = ?2
           WHERE id = ?1 AND state = 'unknown'`,
          [row.id, this.#now],
        );
        this.result.requeued += 1;
      }
    }
    return true;
  }

  /** Records an entry sent, and releases what waited for it. */
  async #sent(id: string, ref: string, from: "sending" | "unknown"): Promise<void> {
    await this.#db.executeQuery(
      CompiledQuery.raw(
        `UPDATE core_accounting_post SET state = 'sent', books_ref = ?2, sent_at = ?3,
           next_attempt_at = NULL, error_code = NULL, error_text = NULL, updated_at = ?3
         WHERE id = ?1 AND state = ?4`,
        [id, ref, this.#now, from],
      ),
    );
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
  }

  /** Entries released by one sent in this run, for the run to send next. */
  readonly released: PostRow[] = [];

  /** An entry that waits to retry pauses sending: the books are refusing for a while. */
  async pausedForRetry(): Promise<boolean> {
    const rows = await this.#exec(
      `SELECT 1 FROM core_accounting_post WHERE connection_id = ?1 AND state = 'retrying'
         AND next_attempt_at > ?2 LIMIT 1`,
      [this.#connectionId, this.#now],
    );
    return rows.length > 0;
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
    await this.#exec(
      `UPDATE core_accounting_post SET state = 'held', error_code = ?2, error_text = ?3,
         next_attempt_at = NULL, updated_at = ?4
       WHERE id = ?1 AND state = ?5`,
      [post.id, code, text.slice(0, 1000), this.#now, post.state],
    );
    this.result.held += 1;
  }

  /**
   * Sends one entry. Returns false when sending should stop for this run (a transient refusal:
   * the books are struggling, and later entries keep their place behind it).
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
    const missing: string[] = [];
    const lines = resolve(JSON.parse(post.lines), mapping, dependency, missing) as unknown[];
    const body = resolve(JSON.parse(post.body), mapping, dependency, missing) as Record<
      string,
      unknown
    >;
    if (missing.length) {
      await this.#hold(post, "unmapped", missing.join("; "));
      return true;
    }
    const { request, carries } = requestFor(post, { lines, body }, currency, lockDate);
    const claimed = await this.#exec(
      `UPDATE core_accounting_post SET state = 'sending', request = ?2, carries_date = ?3,
         attempts = attempts + 1, next_attempt_at = ?4, error_code = NULL, error_text = NULL,
         updated_at = ?5
       WHERE id = ?1 AND state = ?6 AND (next_attempt_at IS NULL OR next_attempt_at <= ?5)
       RETURNING attempts`,
      [
        post.id,
        JSON.stringify(request),
        carries,
        addMs(this.#now, STALE_MS),
        this.#now,
        post.state,
      ],
    );
    const attempts = (claimed[0] as { attempts?: number } | undefined)?.attempts;
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
      const message = messageOf(error);
      const code = accountingRefusal(message);
      // A refusal is nothing written; anything else may have been.
      return code ? { kind: "refused", code, message } : { kind: "unknown", message };
    }
    const outcome = readOutcome(result);
    if (outcome !== "applied") return outcome;
    const receipt = result.value as { ref?: unknown } | null;
    if (receipt && typeof receipt.ref === "string") return { kind: "sent", ref: receipt.ref };
    // Applied once the call returned: the books' ref is read back by the reference.
    try {
      const found = (await this.ask("findByReference", [post.reference])).value as {
        ref?: unknown;
      } | null;
      if (found && typeof found.ref === "string") return { kind: "sent", ref: found.ref };
      return { kind: "unknown", message: "Applied, but the books do not find its reference yet" };
    } catch (error) {
      return { kind: "unknown", message: messageOf(error) };
    }
  }

  async #record(post: PostRow, attempts: number, outcome: Outcome): Promise<boolean> {
    const set = (state: string, code: string | null, text: string | null, next: string | null) =>
      this.#exec(
        `UPDATE core_accounting_post SET state = ?2, error_code = ?3, error_text = ?4,
           next_attempt_at = ?5, updated_at = ?6
         WHERE id = ?1 AND state = 'sending'`,
        [post.id, state, code, text, next, this.#now],
      );
    switch (outcome.kind) {
      case "sent":
        await this.#sent(post.id, outcome.ref, "sending");
        this.result.sent += 1;
        return true;
      case "unknown":
        await set("unknown", "unknown", errorText(outcome.message) || "The answer was lost", null);
        this.result.unknown += 1;
        return true;
      case "denied":
        await set(
          "held",
          "denied",
          "The deploy-time approval floor denies entries to the books: nothing was sent",
          null,
        );
        this.result.held += 1;
        return true;
      case "pending":
        await set(
          "held",
          "pending_review",
          "It waits in Approvals instead of going at once: once a person decides it there, retry it",
          null,
        );
        this.result.held += 1;
        return true;
      case "refused": {
        const transient = TRANSIENT.has(outcome.code) || outcome.code === "locked_period";
        const wait = RETRY_MINUTES[attempts - 1];
        if (transient && wait !== undefined) {
          await set(
            "retrying",
            outcome.code,
            errorText(outcome.message),
            addMs(this.#now, wait * 60_000),
          );
          this.result.retrying += 1;
          this.result.paused = true;
          return false;
        }
        await set("held", outcome.code, errorText(outcome.message), null);
        this.result.held += 1;
        // Retried to the end: the rest may go, but not in the same breath as the books' refusal.
        return !transient;
      }
    }
  }
}

/** One run: blocked, unavailable, or the look-ups, the daily pass and the sends. */
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
  const run = new Run(deps, call, now, settings);

  // The books first: their currency and lock date, read before every run. Unreachable, nothing
  // is touched: every entry keeps its place and its attempts for when they are back.
  let books: { baseCurrency?: unknown; lockDate?: unknown };
  try {
    books = ((await run.ask("describeBooks", [])).value ?? {}) as typeof books;
  } catch {
    return { state: "unavailable", ...EMPTY };
  }
  const currency = (await loadOrderCurrency(db)) ?? (await loadGeneralSettings(db)).baseCurrency;
  if (books.baseCurrency !== currency) {
    await setBlocked(db, now, settings, "currency");
    return { state: "blocked", blocked: "currency", ...EMPTY };
  }
  await setBlocked(db, now, settings, null);
  const lockDate = typeof books.lockDate === "string" ? books.lockDate : null;

  await run.staleClaims();
  if (!(await run.lookUps())) return { ...run.result, state: "unavailable" };

  // The daily pass, from 02:00 in the organisation's zone: the days now settled, a few a run.
  const { timezone } = await loadGeneralSettings(db);
  const local = localParts(now, timezone);
  const span = local.hour >= DAILY_HOUR ? dailySpan(settings, local.date) : null;
  if (span) {
    let day = span.from;
    let built = 0;
    let last: string | null = settings.dailyDate;
    for (; day <= span.to && built < DAYS_PER_RUN; day = addDays(day, 1), built++) {
      for (const build of deps.builders ?? DAY_BUILDERS) {
        await build({ db, day, connectionId: settings.connectionId, settings, now });
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
      last = day;
      run.result.days += 1;
    }
    if (last !== null && last < span.to) run.result.more = true;
  }

  if (await run.pausedForRetry()) return { ...run.result, paused: true };
  const candidates = await run.candidates();
  if (!candidates.length) return run.result;
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
    if (!(await run.send(post, mapping, currency, lockDate))) break;
    list.splice(i + 1, 0, ...run.released.splice(0));
  }
  if (list.some((p) => !seen.has(p.id))) run.result.more = true;
  return run.result;
}
