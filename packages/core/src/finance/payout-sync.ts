// Reading the provider's payouts (stage 52 step 4, ADR 0793): once a business day, through the
// payments gatekeeper (`listPayouts`, `payoutLines`: the host's own read, `callAsHost` purpose
// `orders`), the host copies each payout and every line it settled into `core_payout` and
// `core_payout_line` (migration 1151), as the provider reported them.
//
// - **Once, by the provider's ids.** A payout is recorded once all its lines are read; its lines
//   are written as they are read, each once. Reading the same payouts again, a retried run or two
//   runs at once, records nothing again (every insert is conditional on the provider's id, and the
//   tables refuse a replacement).
// - **Nothing lost to an outage.** A pass reads payouts arriving from `PAYOUT_LOOKBACK_DAYS` before
//   the day of the last pass that read everything (`last_ok_date`; a new account: the first month
//   finance counts), so a connection refused or failing for any length of time is read in full
//   once it works again, over as many runs as it takes.
// - **Never rewritten.** A payout the provider reports failed is a correction of its own
//   (`core_payout_failure`), counted on the day the host saw it. It is seen two ways: the payout's
//   own status while it is within the lookback, and, whenever it failed, the `payout_reversal`
//   line of the later payout that pays its money again. A payout that failed before it arrived is
//   recorded too (`failed`), with the lines it settled, so its payments are explained.
// - **Bounded.** A run makes at most `PAYOUT_CALLS_PER_RUN` provider calls and a few statements per
//   call; what it leaves, the next minute carries on from the row's marker. A page cursor that
//   does not move fails the run (no endless calling). A quiet minute reads the markers by their key
//   and nothing else.
// - **Fails soft.** A key that lacks the permission is `unavailable` (the Payouts report says so)
//   and tried again the next day; a provider failure (a 5xx, a refused key) is retried later (15
//   minutes, an hour, six hours, then daily), keeping its place; neither stops the cron's other
//   steps.
// - **One history per account.** The marker is per provider and account (the connection and the
//   resource it binds): another account starts from its own first month; the row of an account no
//   longer bound is retired, so it is not due every minute.
// - **Told once.** A payout whose lines do not sum to it, or with lines the gatekeeper could not
//   read, tells whoever may close the books (`finance:close` holders), once per payout.
import type { CoreDatabase } from "@composable-os/db";
import { type Compilable, CompiledQuery, type Kysely } from "kysely";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import { type PaymentsTarget, paymentsTarget } from "../orders/gateway.ts";
import { addLocalDays, parseLocalDate, wallClockToInstant } from "../time/local.ts";
import { localDateAt, monthDates } from "./day.ts";
import { financeClock } from "./periods.ts";

type Db = Kysely<CoreDatabase>;

/** The most provider calls (pages of payouts or of lines) one run makes. */
export const PAYOUT_CALLS_PER_RUN = 20;
/** How far before the last good pass's day a pass reads again (late arrivals, failures). */
export const PAYOUT_LOOKBACK_DAYS = 14;
/** The business's hour from which a day's pass runs. */
export const PAYOUT_READ_HOUR = 6;
/** Minutes before a failed read is tried again, by how many failed in a row (then daily). */
export const PAYOUT_RETRY_MINUTES = [15, 60, 360, 1440] as const;
/** The `next_at` of an account no longer bound: never due on its own. */
export const RETIRED_AT = "9999-12-31T00:00:00.000Z";
/** A pass's cursor once every page of payouts was listed (what is left is pending reads). */
const LISTED = "";

/** The providers the gatekeeper has (the sync row's key). */
const PROVIDERS = ["stripe", "fake"] as const;

/** A payout as the gatekeeper reads it (gatekeeper PaymentsPayout). */
export interface ProviderPayout {
  provider: string;
  ref: string;
  amount: number;
  currency: string;
  arrivalDate: string;
  status: "paid" | "pending" | "in_transit" | "failed" | "canceled";
  createdAt: string;
  itemised: boolean;
}

/** One line of a payout as the gatekeeper reads it (gatekeeper PaymentsPayoutLine). */
export interface ProviderPayoutLine {
  ref: string;
  kind: "payment" | "refund" | "dispute" | "adjustment" | "fee" | "payout_reversal";
  amount: number;
  fee: number;
  currency: string;
  paymentRef: string | null;
  refundRef: string | null;
  reversalOf: string | null;
  occurredAt: string;
}

/** A payout being read: as the provider reported it, how it is recorded, lines not readable. */
interface Reading extends ProviderPayout {
  record: "paid" | "failed";
  unreadable: number;
}

type Unavailable = { unavailable: true; reason: string };
type PayoutPage = { unavailable?: undefined; payouts: ProviderPayout[]; next: string | null };
type LinePage = {
  unavailable?: undefined;
  lines: ProviderPayoutLine[];
  next: string | null;
  unreadable: number;
};

type SyncRow = Omit<CoreDatabase["core_payout_sync"], "failures"> & { failures: number };

/** What one run did. */
export interface PayoutSyncResult {
  provider: string | null;
  calls: number;
  recorded: number;
  lines: number;
  failed: number;
  state: "ok" | "unavailable" | "failing" | "not_connected" | "not_due";
  /** The pass is not finished: the next minute carries on. */
  more: boolean;
}

const NOTHING: Omit<PayoutSyncResult, "state" | "provider"> = {
  calls: 0,
  recorded: 0,
  lines: 0,
  failed: 0,
  more: false,
};

/**
 * Whether a run is due, for the minute cron: outside the pipeline, so a quiet minute writes
 * nothing. One read by key when the read has markers; until it has, whether an account is bound.
 */
export async function payoutsDue(db: Db, nowIso: string): Promise<boolean> {
  const rows = await db
    .selectFrom("core_payout_sync")
    .select("next_at")
    .where("provider", "in", [...PROVIDERS])
    .execute();
  if (rows.length) return rows.some((r) => r.next_at <= nowIso);
  try {
    await paymentsTarget(db);
    return true;
  } catch {
    return false;
  }
}

/** The account a connection's payouts belong to: the connection and the resource it binds. */
export const accountOf = (target: PaymentsTarget) => `${target.connectionId}:${target.resource}`;

const isDay = (value: unknown): value is string =>
  typeof value === "string" && parseLocalDate(value) !== null;
const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const isRef = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(value);
const isRefOrNull = (value: unknown): value is string | null => value === null || isRef(value);
const currencyOf = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;

const KINDS = new Set(["payment", "refund", "dispute", "adjustment", "fee", "payout_reversal"]);
const STATUSES = new Set(["paid", "pending", "in_transit", "failed", "canceled"]);

/** A payout page as the gatekeeper answered it, checked: what is not readable is left out. */
function payoutPage(value: unknown): PayoutPage | Unavailable {
  const v = (value ?? {}) as Record<string, unknown>;
  if (typeof v.failed === "string") throw new Error(v.failed);
  if (v.unavailable === true) {
    return { unavailable: true, reason: String(v.reason ?? "").slice(0, 200) };
  }
  const payouts = (Array.isArray(v.payouts) ? v.payouts : []).flatMap((raw): ProviderPayout[] => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const currency = currencyOf(p.currency);
    if (!isRef(p.ref) || !isInt(p.amount) || !currency || !isDay(p.arrivalDate)) return [];
    if (typeof p.status !== "string" || !STATUSES.has(p.status)) return [];
    return [
      {
        provider: String(p.provider ?? ""),
        ref: p.ref,
        amount: p.amount,
        currency,
        arrivalDate: p.arrivalDate,
        status: p.status as ProviderPayout["status"],
        createdAt: typeof p.createdAt === "string" ? p.createdAt.slice(0, 40) : "",
        itemised: p.itemised !== false,
      },
    ];
  });
  return { payouts, next: isRef(v.next) ? v.next : null };
}

/**
 * A line page, checked. A line this host cannot read is left out and counted (with those the
 * gatekeeper could not read): the payout records how many, and its lines then fall short of it.
 */
function linePage(value: unknown): LinePage | Unavailable {
  const v = (value ?? {}) as Record<string, unknown>;
  // The gatekeeper answers a provider's failure, rather than throwing it over RPC.
  if (typeof v.failed === "string") throw new Error(v.failed);
  if (v.unavailable === true) {
    return { unavailable: true, reason: String(v.reason ?? "").slice(0, 200) };
  }
  let unreadable = isInt(v.unreadable) && v.unreadable > 0 ? v.unreadable : 0;
  const lines = (Array.isArray(v.lines) ? v.lines : []).flatMap((raw): ProviderPayoutLine[] => {
    const l = (raw ?? {}) as Record<string, unknown>;
    const currency = currencyOf(l.currency);
    if (
      !isRef(l.ref) ||
      typeof l.kind !== "string" ||
      !KINDS.has(l.kind) ||
      !isInt(l.amount) ||
      !isInt(l.fee) ||
      !currency ||
      !isRefOrNull(l.paymentRef ?? null) ||
      !isRefOrNull(l.refundRef ?? null) ||
      !isRefOrNull(l.reversalOf ?? null)
    ) {
      unreadable += 1;
      return [];
    }
    return [
      {
        ref: l.ref,
        kind: l.kind as ProviderPayoutLine["kind"],
        amount: l.amount,
        fee: l.fee,
        currency,
        paymentRef: (l.paymentRef ?? null) as string | null,
        refundRef: (l.refundRef ?? null) as string | null,
        reversalOf: (l.reversalOf ?? null) as string | null,
        occurredAt: typeof l.occurredAt === "string" ? l.occurredAt.slice(0, 40) : "",
      },
    ];
  });
  return { lines, next: isRef(v.next) ? v.next : null, unreadable };
}

/** The lines of one page, each written once, never onto a payout already recorded. */
export function lineInserts(
  provider: string,
  payoutRef: string,
  lines: readonly ProviderPayoutLine[],
): CompiledQuery[] {
  if (!lines.length) return [];
  const rows = lines.map((l) => ({
    r: l.ref,
    k: l.kind,
    a: l.amount,
    f: l.fee,
    c: l.currency,
    pr: l.paymentRef,
    rr: l.refundRef,
    rv: l.reversalOf,
    o: l.occurredAt,
  }));
  return [
    CompiledQuery.raw(
      `INSERT INTO core_payout_line (provider, ref, payout_ref, kind, amount, fee, currency,
         payment_ref, refund_ref, reversal_of, occurred_at)
       SELECT ?1, json_extract(j.value, '$.r'), ?2, json_extract(j.value, '$.k'),
         json_extract(j.value, '$.a'), json_extract(j.value, '$.f'), json_extract(j.value, '$.c'),
         json_extract(j.value, '$.pr'), json_extract(j.value, '$.rr'),
         json_extract(j.value, '$.rv'), json_extract(j.value, '$.o')
       FROM json_each(?3) j
       WHERE NOT EXISTS (SELECT 1 FROM core_payout_line l
           WHERE l.provider = ?1 AND l.ref = json_extract(j.value, '$.r'))
         AND NOT EXISTS (SELECT 1 FROM core_payout p WHERE p.provider = ?1 AND p.ref = ?2)`,
      [provider, payoutRef, JSON.stringify(rows)],
    ),
  ];
}

/** A payout recorded with the lines written for it, once. */
export function payoutInsert(provider: string, payout: Reading, now: string): CompiledQuery {
  return CompiledQuery.raw(
    `INSERT INTO core_payout (provider, ref, amount, currency, arrival_date, status, itemised,
       line_count, lines_net, unreadable_lines, created_at, read_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7,
       (SELECT count(*) FROM core_payout_line l WHERE l.provider = ?1 AND l.payout_ref = ?2),
       (SELECT coalesce(sum(l.amount - l.fee), 0) FROM core_payout_line l
         WHERE l.provider = ?1 AND l.payout_ref = ?2),
       ?8, ?9, ?10
     WHERE NOT EXISTS (SELECT 1 FROM core_payout p WHERE p.provider = ?1 AND p.ref = ?2)`,
    [
      provider,
      payout.ref,
      payout.amount,
      payout.currency,
      payout.arrivalDate,
      payout.record,
      payout.itemised ? 1 : 0,
      payout.unreadable,
      payout.createdAt || now,
      now,
    ],
  );
}

/** A recorded payout's failure, once, on the business's day it was seen. */
function failureInsert(provider: string, ref: string, date: string, now: string): CompiledQuery {
  return CompiledQuery.raw(
    `INSERT INTO core_payout_failure (provider, payout_ref, date, seen_at)
     SELECT ?1, ?2, ?3, ?4
     WHERE NOT EXISTS (SELECT 1 FROM core_payout_failure f WHERE f.provider = ?1 AND f.payout_ref = ?2)
       AND EXISTS (SELECT 1 FROM core_payout p WHERE p.provider = ?1 AND p.ref = ?2)`,
    [provider, ref, date, now],
  );
}

/** Who may close the books: human admins and the accounts granted `finance:close`. */
async function closers(db: Db): Promise<string[]> {
  const rows = await CompiledQuery.raw(
    `SELECT id FROM core_user WHERE kind = 'human' AND (role = 'admin' OR (pack_role IS NULL
       AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(granted_permissions)
         THEN granted_permissions ELSE '[]' END) g WHERE g.value = 'finance:close')))
     ORDER BY id`,
    [],
  );
  const result = await db.executeQuery<{ id: string }>(rows);
  return result.rows.map((r) => r.id);
}

/** The instant of the business's `PAYOUT_READ_HOUR` on the day after `date`. */
function nextPassAt(date: string, zone: string): string {
  const d = parseLocalDate(date);
  if (!d) throw new Error(`${date} is not a date`);
  return new Date(
    wallClockToInstant({ ...addLocalDays(d, 1), hour: PAYOUT_READ_HOUR, minute: 0 }, zone),
  ).toISOString();
}

const daysBefore = (date: string, days: number) => {
  const d = parseLocalDate(date);
  if (!d) throw new Error(`${date} is not a date`);
  const b = addLocalDays(d, -days);
  return `${b.year}-${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`;
};

/** A provider whose page cursor did not move: answered as a failure, never called again and again. */
class StuckCursor extends Error {}

/**
 * One run of the daily read (the minute cron's `finance.payouts.sync`, as the host). Writes are
 * queued on `ctx`; nothing is written outside the operation's batch.
 */
export async function syncPayouts(ctx: HandlerContext): Promise<PayoutSyncResult> {
  let target: PaymentsTarget;
  try {
    target = await paymentsTarget(ctx.db);
  } catch {
    // No account to read: markers left wait a day (checked daily), so a quiet minute stays quiet.
    ctx.write(
      ctx.db
        .updateTable("core_payout_sync")
        .set({
          next_at: new Date(Date.parse(ctx.now) + 86_400_000).toISOString(),
          updated_at: ctx.now,
        })
        .where("provider", "in", [...PROVIDERS])
        .where("next_at", "<=", ctx.now),
    );
    return { ...NOTHING, provider: null, state: "not_connected" };
  }
  const call = ctx.integrations?.callAsHost?.bind(ctx.integrations);
  if (!call) throw new Error("Payouts are read through the integration host, not reachable here");
  const provider = target.provider;
  const account = accountOf(target);
  const clock = await financeClock(ctx.db, ctx.now);
  const today = localDateAt(clock.now, clock.zone);
  const stored = (await ctx.db
    .selectFrom("core_payout_sync")
    .selectAll()
    .where("provider", "=", provider)
    .where("account", "=", account)
    .executeTakeFirst()) as SyncRow | undefined;
  // Another account's markers (a switch of account or provider) are retired, not left due.
  ctx.write(
    ctx.db
      .updateTable("core_payout_sync")
      .set({ next_at: RETIRED_AT, updated_at: ctx.now })
      .where("provider", "in", [...PROVIDERS])
      .where((eb) => eb.or([eb("provider", "!=", provider), eb("account", "!=", account)]))
      .where("next_at", "<=", ctx.now),
  );
  if (stored && stored.next_at > ctx.now && stored.next_at !== RETIRED_AT) {
    return { ...NOTHING, provider, state: "not_due" };
  }
  const firstDay = monthDates(clock.firstMonth).start;
  const row: SyncRow =
    !stored || stored.done
      ? {
          provider,
          account,
          pass_date: today,
          last_ok_date: stored?.last_ok_date ?? null,
          pending: stored?.pending ?? null,
          done: 0,
          // From before the last pass that read everything, however long ago that was.
          since: daysBefore(stored?.last_ok_date ?? firstDay, PAYOUT_LOOKBACK_DAYS),
          cursor: null,
          reading: stored?.reading ?? null,
          line_cursor: stored?.line_cursor ?? null,
          state: stored?.state === "failing" ? "failing" : "ok",
          reason: stored?.state === "failing" ? stored.reason : null,
          failures: stored?.failures ?? 0,
          next_at: ctx.now,
          version: stored?.version ?? 0,
          updated_at: ctx.now,
        }
      : { ...stored };

  const ask = async (method: "listPayouts" | "payoutLines", input: Record<string, unknown>) =>
    (
      await call({
        connectionId: target.connectionId,
        resource: target.resource,
        method,
        args: [input],
        purpose: "orders",
      })
    ).value;

  const statements: (Compilable | CompiledQuery)[] = [];
  const recordedNow = new Set<string>();
  const failedNow = new Set<string>();
  const out = { ...NOTHING };
  let unavailable: string | null = null;
  let finished = false;
  const tell: Reading[] = [];
  /** Each payout's lines read this run (not yet written): line ref → amount less fee. */
  const readNow = new Map<string, Map<string, number>>();
  const pending: Reading[] = row.pending ? (JSON.parse(row.pending) as Reading[]) : [];

  const isRecorded = async (ref: string) =>
    recordedNow.has(ref) ||
    !!(await ctx.db
      .selectFrom("core_payout")
      .select("ref")
      .where("provider", "=", provider)
      .where("ref", "=", ref)
      .executeTakeFirst());
  const isFailed = async (ref: string) =>
    failedNow.has(ref) ||
    !!(await ctx.db
      .selectFrom("core_payout_failure")
      .select("payout_ref")
      .where("provider", "=", provider)
      .where("payout_ref", "=", ref)
      .executeTakeFirst());
  const fail = (ref: string) => {
    statements.push(failureInsert(provider, ref, today, ctx.now));
    failedNow.add(ref);
    out.failed += 1;
  };
  const record = (payout: Reading) => {
    statements.push(payoutInsert(provider, payout, ctx.now));
    recordedNow.add(payout.ref);
    out.recorded += 1;
    if (payout.record === "failed") fail(payout.ref);
    tell.push(payout);
  };

  /**
   * A later payout pays a failed one's money again: the failed payout's failure is recorded
   * however long after it arrived; one never recorded (it failed before it arrived, or before it
   * was read) is read with its lines, so the payments it settled are explained.
   */
  const reversal = async (line: ProviderPayoutLine) => {
    const ref = line.reversalOf;
    if (!ref) return;
    if (await isRecorded(ref)) {
      if (!(await isFailed(ref))) fail(ref);
      return;
    }
    const reading = row.reading ? (JSON.parse(row.reading) as Reading).ref : null;
    if (ref === reading || pending.some((p) => p.ref === ref)) return;
    pending.push({
      provider,
      ref,
      amount: line.amount,
      currency: line.currency,
      arrivalDate: line.occurredAt.slice(0, 10) || today,
      status: "failed",
      createdAt: line.occurredAt,
      itemised: true,
      record: "failed",
      unreadable: 0,
    });
  };

  /** Reads the rest of `row.reading`'s lines; true once all are read and the payout is staged. */
  const readLines = async (): Promise<boolean> => {
    const payout = JSON.parse(row.reading as string) as Reading;
    if (!payout.itemised) {
      record(payout);
      row.reading = null;
      row.line_cursor = null;
      return true;
    }
    while (out.calls < PAYOUT_CALLS_PER_RUN) {
      const asked = row.line_cursor;
      let page: LinePage | Unavailable;
      try {
        page = linePage(await ask("payoutLines", { payoutRef: payout.ref, after: asked }));
      } catch (error) {
        // A failed payout named only by a reversal whose lines the provider will not list is
        // recorded with none: its whole amount shows as its difference, and it is told.
        if (payout.record === "failed" && !asked) {
          out.calls += 1;
          record({ ...payout, itemised: false });
          row.reading = null;
          row.line_cursor = null;
          return true;
        }
        throw error;
      }
      out.calls += 1;
      if (page.unavailable) {
        unavailable = page.reason;
        return false;
      }
      if (page.next && page.next === asked) throw new StuckCursor("lines");
      statements.push(...lineInserts(provider, payout.ref, page.lines));
      out.lines += page.lines.length;
      payout.unreadable += page.unreadable;
      const read = readNow.get(payout.ref) ?? new Map<string, number>();
      for (const l of page.lines) read.set(l.ref, l.amount - l.fee);
      readNow.set(payout.ref, read);
      for (const l of page.lines) if (l.kind === "payout_reversal") await reversal(l);
      row.reading = JSON.stringify(payout);
      if (page.next) {
        row.line_cursor = page.next;
        continue;
      }
      record(payout);
      row.reading = null;
      row.line_cursor = null;
      return true;
    }
    return false;
  };

  try {
    pass: while (out.calls < PAYOUT_CALLS_PER_RUN) {
      if (row.reading) {
        if (!(await readLines())) break;
        continue;
      }
      const next = pending.shift();
      if (next) {
        if (await isRecorded(next.ref)) {
          if (!(await isFailed(next.ref))) fail(next.ref);
          continue;
        }
        row.reading = JSON.stringify(next);
        row.line_cursor = null;
        continue;
      }
      if (row.cursor === LISTED) {
        finished = true;
        break;
      }
      const asked = row.cursor;
      const page = payoutPage(await ask("listPayouts", { since: row.since, after: asked }));
      out.calls += 1;
      if (page.unavailable) {
        unavailable = page.reason;
        break;
      }
      if (page.next && page.next === asked) throw new StuckCursor("payouts");
      const refs = page.payouts.map((p) => p.ref);
      const list = JSON.stringify(refs);
      const [recorded, failed] = refs.length
        ? await Promise.all([
            ctx.db.executeQuery<{ ref: string }>(
              CompiledQuery.raw(
                "SELECT ref FROM core_payout WHERE provider = ? AND ref IN (SELECT value FROM json_each(?))",
                [provider, list],
              ),
            ),
            ctx.db.executeQuery<{ ref: string }>(
              CompiledQuery.raw(
                "SELECT payout_ref AS ref FROM core_payout_failure WHERE provider = ? AND payout_ref IN (SELECT value FROM json_each(?))",
                [provider, list],
              ),
            ),
          ])
        : [{ rows: [] }, { rows: [] }];
      const known = new Set(recorded.rows.map((r) => r.ref));
      const knownFailed = new Set(failed.rows.map((r) => r.ref));
      const returned = (p: ProviderPayout) => p.status === "failed" || p.status === "canceled";
      for (const payout of page.payouts) {
        if (known.has(payout.ref) || recordedNow.has(payout.ref)) {
          // A correction, never an edit: the bank returned a payout recorded as arrived.
          if (returned(payout) && !knownFailed.has(payout.ref) && !failedNow.has(payout.ref)) {
            fail(payout.ref);
          }
          continue;
        }
        if (payout.status !== "paid" && !returned(payout)) continue;
        if (pending.some((p) => p.ref === payout.ref)) continue;
        row.reading = JSON.stringify({
          ...payout,
          record: returned(payout) ? "failed" : "paid",
          unreadable: 0,
        } satisfies Reading);
        row.line_cursor = null;
        // Out of calls before its last line: the next run carries on, and lists this page again.
        if (!(await readLines())) break pass;
      }
      // Everything listed: only what a reversal named may be left to read.
      row.cursor = page.next ?? LISTED;
    }
    if (unavailable) {
      // Done for today, the place kept: the next pass reads from before the last good one.
      Object.assign(row, {
        done: 1,
        cursor: null,
        state: "unavailable",
        reason: unavailable,
        failures: 0,
        next_at: nextPassAt(today, clock.zone),
      });
    } else if (finished) {
      Object.assign(row, {
        done: 1,
        cursor: null,
        reading: null,
        line_cursor: null,
        last_ok_date: row.pass_date,
        state: "ok",
        reason: null,
        failures: 0,
        next_at: nextPassAt(today, clock.zone),
      });
    } else {
      // More to read, and every call answered: the next minute carries on from the marker.
      Object.assign(row, { state: "ok", reason: null, failures: 0, next_at: ctx.now });
    }
  } catch (error) {
    // The provider failed, or refused the key: keep the place and what was read, and try again
    // later. A provider that keeps failing is tried daily; the cron's other steps are not held up.
    const failures = row.failures + 1;
    const minutes =
      PAYOUT_RETRY_MINUTES[Math.min(failures - 1, PAYOUT_RETRY_MINUTES.length - 1)] ?? 1440;
    Object.assign(row, {
      state: "failing",
      reason:
        error instanceof StuckCursor
          ? "The payment provider answered a page cursor that did not move, so the read stopped."
          : `The payment provider could not be read: ${
              error instanceof Error ? error.message.slice(0, 160) : "unknown error"
            }`,
      failures,
      next_at: new Date(Date.parse(ctx.now) + minutes * 60_000).toISOString(),
    });
  }

  // A payout that does not match its lines: told once to whoever may close the books.
  if (tell.length) {
    const recipients = await closers(ctx.db);
    for (const payout of tell) {
      const lines = await linesNetOf(ctx.db, provider, payout.ref, readNow.get(payout.ref));
      if (lines === payout.amount && payout.unreadable === 0) continue;
      const plan = await notifyStatements(
        ctx.db,
        {
          to: recipients.map((userId) => ({ userId })),
          type: "system.message",
          title: "A payout does not match its lines",
          body:
            `The payout ${payout.ref} arriving ${payout.arrivalDate} is ${payout.amount} minor units ` +
            `of ${payout.currency}, and the lines the provider listed for it come to ${lines}. ` +
            (payout.unreadable
              ? `${payout.unreadable} of its lines could not be read and are left out. `
              : "") +
            (payout.itemised
              ? "The difference shows in the Payouts report, on its own heading."
              : "The provider lists no lines for it (made by hand, or failed before it arrived).") +
            " Check it against the provider's own payout report.",
          dedupeKey: `finance.payout_mismatch:${provider}:${payout.ref}`,
          source: { actor: "system" },
        },
        ctx.now,
      );
      statements.push(...plan.statements);
    }
  }

  const values = {
    pass_date: row.pass_date,
    last_ok_date: row.last_ok_date,
    pending: pending.length ? JSON.stringify(pending) : null,
    done: row.done,
    since: row.since,
    cursor: row.cursor,
    reading: row.reading,
    line_cursor: row.line_cursor,
    state: row.state,
    reason: row.reason,
    failures: row.failures,
    next_at: row.next_at,
    updated_at: ctx.now,
  };
  statements.push(
    stored
      ? ctx.db
          .updateTable("core_payout_sync")
          .set({ ...values, version: stored.version + 1 })
          .where("provider", "=", provider)
          .where("account", "=", account)
          .where("version", "=", stored.version)
      : ctx.db
          .insertInto("core_payout_sync")
          .values({ provider, account, ...values, version: 1 })
          .onConflict((oc) => oc.columns(["provider", "account"]).doNothing()),
  );
  ctx.write(...statements);
  return {
    ...out,
    provider,
    state: row.state,
    more: !row.done && row.state !== "failing",
  };
}

/**
 * What a payout's lines come to: those written by earlier runs, and those read in this one whose
 * inserts have not run yet (each line once, by its ref, as the insert writes it once).
 */
async function linesNetOf(
  db: Db,
  provider: string,
  payoutRef: string,
  readNow: ReadonlyMap<string, number> | undefined,
): Promise<number> {
  const stored = await db
    .selectFrom("core_payout_line")
    .select(["ref", "amount", "fee"])
    .where("provider", "=", provider)
    .where("payout_ref", "=", payoutRef)
    .execute();
  const seen = new Set(stored.map((l) => l.ref));
  let net = stored.reduce((n, l) => n + l.amount - l.fee, 0);
  for (const [ref, amount] of readNow ?? []) if (!seen.has(ref)) net += amount;
  return net;
}

/** What the read says of itself, for a report: refused, failing, or behind. Null: all read. */
export async function payoutReadState(db: Db): Promise<string[]> {
  const rows = await db
    .selectFrom("core_payout_sync")
    .select(["provider", "state", "reason", "next_at", "done", "pending", "reading"])
    .where("provider", "in", [...PROVIDERS])
    .execute();
  return rows
    .filter((r) => r.next_at !== RETIRED_AT)
    .flatMap((r) => {
      if (r.state === "unavailable") {
        return [
          `Payouts are not available for this connection (${r.provider}): ${r.reason ?? "the provider refused the read"}. Payouts are read again once the key may read them, from before the last full read; until then the figures here hold only payouts read before.`,
        ];
      }
      if (r.state === "failing") {
        return [
          `The last read of payouts (${r.provider}) failed and the connection may need attention: ${r.reason ?? "the provider could not be read"}. It is tried again from ${r.next_at}; payouts since the last full read may be missing.`,
        ];
      }
      if (!r.done || r.pending || r.reading) {
        return [
          `The read of payouts (${r.provider}) is part-way through: payouts still to be read may be missing here.`,
        ];
      }
      return [];
    });
}
