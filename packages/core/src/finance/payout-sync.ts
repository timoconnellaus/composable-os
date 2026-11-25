// Reading the provider's payouts (stage 52 step 4, ADR 0793): once a business day, through the
// payments gatekeeper (`listPayouts`, `payoutLines`: the host's own read, `callAsHost` purpose
// `orders`), the host copies each payout that has arrived and every line it settled into
// `core_payout` and `core_payout_line` (migration 1151), as the provider reported them.
//
// - **Once, by the provider's ids.** A payout is recorded when it has arrived (`paid`) and all its
//   lines are read; its lines are written as they are read, each once. Reading the same payouts
//   again, a retried run or two runs at once, records nothing again (every insert is conditional
//   on the provider's id, and the tables refuse a replacement).
// - **Never rewritten.** A recorded payout the provider later reports failed is a correction of its
//   own (`core_payout_failure`), counted on the day the host saw it; the payout stays as it was.
// - **Bounded.** A run makes at most `PAYOUT_CALLS_PER_RUN` provider calls and a few statements per
//   call. A pass reads payouts arriving from `PAYOUT_LOOKBACK_DAYS` before the last pass's day (a
//   new connection: from the first month finance counts, less the same), a page at a time; what a
//   run leaves (a year of payouts, a payout of thousands of lines) the next minute carries on from
//   the row's marker. A quiet minute reads the marker by its key and nothing else.
// - **Fails soft.** A connection whose key may not read payouts is marked `unavailable` (the
//   Payouts report says so) and tried again the next day; a provider failure is retried later
//   (15 minutes, an hour, six hours, then daily), keeping its place, and never stops the cron's
//   other steps.
// - **Told once.** A payout whose lines do not sum to it tells whoever may close the books
//   (`finance:close` holders), once per payout.
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
/** How far before the last pass's day a pass reads again (late arrivals, failures after arrival). */
export const PAYOUT_LOOKBACK_DAYS = 14;
/** The business's hour from which a day's pass runs. */
export const PAYOUT_READ_HOUR = 6;
/** Minutes before a failed read is tried again, by how many failed in a row (then daily). */
export const PAYOUT_RETRY_MINUTES = [15, 60, 360, 1440] as const;

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
  kind: "payment" | "refund" | "dispute" | "adjustment" | "fee";
  amount: number;
  fee: number;
  currency: string;
  paymentRef: string | null;
  refundRef: string | null;
  occurredAt: string;
}

type Unavailable = { unavailable: true; reason: string };
type PayoutPage = { unavailable?: undefined; payouts: ProviderPayout[]; next: string | null };
type LinePage = { unavailable?: undefined; lines: ProviderPayoutLine[]; next: string | null };

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
 * nothing. One read by key when the read has a marker; until it has, whether an account is bound.
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

const isDay = (value: unknown): value is string =>
  typeof value === "string" && parseLocalDate(value) !== null;
const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const isRef = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(value);
const isRefOrNull = (value: unknown): value is string | null => value === null || isRef(value);
const currencyOf = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;

const KINDS = new Set(["payment", "refund", "dispute", "adjustment", "fee"]);
const STATUSES = new Set(["paid", "pending", "in_transit", "failed", "canceled"]);

/** A payout page as the gatekeeper answered it, checked: what is not readable is left out. */
function payoutPage(value: unknown): PayoutPage | Unavailable {
  const v = (value ?? {}) as Record<string, unknown>;
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
 * A line page, checked. A line that is not readable fails the whole read: dropping it would
 * record a payout without one of its lines (money silently dropped).
 */
function linePage(value: unknown): LinePage | Unavailable {
  const v = (value ?? {}) as Record<string, unknown>;
  if (v.unavailable === true) {
    return { unavailable: true, reason: String(v.reason ?? "").slice(0, 200) };
  }
  const lines = (Array.isArray(v.lines) ? v.lines : []).map((raw): ProviderPayoutLine => {
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
      !isRefOrNull(l.refundRef ?? null)
    ) {
      throw new Error("The payments gatekeeper answered a payout line this host cannot read.");
    }
    return {
      ref: l.ref,
      kind: l.kind as ProviderPayoutLine["kind"],
      amount: l.amount,
      fee: l.fee,
      currency,
      paymentRef: (l.paymentRef ?? null) as string | null,
      refundRef: (l.refundRef ?? null) as string | null,
      occurredAt: typeof l.occurredAt === "string" ? l.occurredAt.slice(0, 40) : "",
    };
  });
  return { lines, next: isRef(v.next) ? v.next : null };
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
    o: l.occurredAt,
  }));
  return [
    CompiledQuery.raw(
      `INSERT INTO core_payout_line (provider, ref, payout_ref, kind, amount, fee, currency,
         payment_ref, refund_ref, occurred_at)
       SELECT ?1, json_extract(j.value, '$.r'), ?2, json_extract(j.value, '$.k'),
         json_extract(j.value, '$.a'), json_extract(j.value, '$.f'), json_extract(j.value, '$.c'),
         json_extract(j.value, '$.pr'), json_extract(j.value, '$.rr'), json_extract(j.value, '$.o')
       FROM json_each(?3) j
       WHERE NOT EXISTS (SELECT 1 FROM core_payout_line l
           WHERE l.provider = ?1 AND l.ref = json_extract(j.value, '$.r'))
         AND NOT EXISTS (SELECT 1 FROM core_payout p WHERE p.provider = ?1 AND p.ref = ?2)`,
      [provider, payoutRef, JSON.stringify(rows)],
    ),
  ];
}

/** A payout recorded with the lines written for it, once. */
export function payoutInsert(provider: string, payout: ProviderPayout, now: string): CompiledQuery {
  return CompiledQuery.raw(
    `INSERT INTO core_payout (provider, ref, amount, currency, arrival_date, status, itemised,
       line_count, lines_net, created_at, read_at)
     SELECT ?1, ?2, ?3, ?4, ?5, 'paid', ?6,
       (SELECT count(*) FROM core_payout_line l WHERE l.provider = ?1 AND l.payout_ref = ?2),
       (SELECT coalesce(sum(l.amount - l.fee), 0) FROM core_payout_line l
         WHERE l.provider = ?1 AND l.payout_ref = ?2),
       ?7, ?8
     WHERE NOT EXISTS (SELECT 1 FROM core_payout p WHERE p.provider = ?1 AND p.ref = ?2)`,
    [
      provider,
      payout.ref,
      payout.amount,
      payout.currency,
      payout.arrivalDate,
      payout.itemised ? 1 : 0,
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

/**
 * One run of the daily read (the minute cron's `finance.payouts.sync`, as the host). Writes are
 * queued on `ctx`; nothing is written outside the operation's batch.
 */
export async function syncPayouts(ctx: HandlerContext): Promise<PayoutSyncResult> {
  let target: PaymentsTarget;
  try {
    target = await paymentsTarget(ctx.db);
  } catch {
    // No account to read: a marker left by one waits a day, so a quiet minute stays quiet.
    ctx.write(
      ctx.db
        .updateTable("core_payout_sync")
        .set({
          next_at: new Date(Date.parse(ctx.now) + 86_400_000).toISOString(),
          updated_at: ctx.now,
        })
        .where("next_at", "<=", ctx.now),
    );
    return { ...NOTHING, provider: null, state: "not_connected" };
  }
  const call = ctx.integrations?.callAsHost?.bind(ctx.integrations);
  if (!call) throw new Error("Payouts are read through the integration host, not reachable here");
  const provider = target.provider;
  const clock = await financeClock(ctx.db, ctx.now);
  const today = localDateAt(clock.now, clock.zone);
  const stored = (await ctx.db
    .selectFrom("core_payout_sync")
    .selectAll()
    .where("provider", "=", provider)
    .executeTakeFirst()) as SyncRow | undefined;
  if (stored && stored.next_at > ctx.now) {
    return { ...NOTHING, provider, state: "not_due" };
  }
  const row: SyncRow =
    !stored || stored.done
      ? {
          provider,
          pass_date: today,
          done: 0,
          since: daysBefore(
            stored ? stored.pass_date : monthDates(clock.firstMonth).start,
            PAYOUT_LOOKBACK_DAYS,
          ),
          cursor: null,
          reading: null,
          line_cursor: null,
          state: stored?.state === "failing" ? "failing" : "ok",
          reason: null,
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
  const out = { ...NOTHING };
  let unavailable: string | null = null;
  let finished = false;
  const tell: ProviderPayout[] = [];
  /** Each payout's lines read this run (not yet written): line ref → amount less fee. */
  const readNow = new Map<string, Map<string, number>>();

  /** Reads the rest of `row.reading`'s lines; true once all are read and the payout is staged. */
  const readLines = async (): Promise<boolean> => {
    const payout = JSON.parse(row.reading as string) as ProviderPayout;
    while (out.calls < PAYOUT_CALLS_PER_RUN) {
      const page = linePage(
        await ask("payoutLines", { payoutRef: payout.ref, after: row.line_cursor }),
      );
      out.calls += 1;
      if (page.unavailable) {
        unavailable = page.reason;
        return false;
      }
      const lines = page.lines;
      statements.push(...lineInserts(provider, payout.ref, lines));
      out.lines += lines.length;
      const read = readNow.get(payout.ref) ?? new Map<string, number>();
      for (const l of lines) read.set(l.ref, l.amount - l.fee);
      readNow.set(payout.ref, read);
      if (page.next) {
        row.line_cursor = page.next;
        continue;
      }
      statements.push(payoutInsert(provider, payout, ctx.now));
      recordedNow.add(payout.ref);
      out.recorded += 1;
      tell.push(payout);
      row.reading = null;
      row.line_cursor = null;
      return true;
    }
    return false;
  };

  try {
    pass: while (out.calls < PAYOUT_CALLS_PER_RUN) {
      if (row.reading && !(await readLines())) break;
      if (unavailable || out.calls >= PAYOUT_CALLS_PER_RUN) break;
      const page = payoutPage(await ask("listPayouts", { since: row.since, after: row.cursor }));
      out.calls += 1;
      if (page.unavailable) {
        unavailable = page.reason;
        break;
      }
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
      const isRecorded = new Set(recorded.rows.map((r) => r.ref));
      const isFailed = new Set(failed.rows.map((r) => r.ref));
      for (const payout of page.payouts) {
        if (isRecorded.has(payout.ref)) {
          // A correction, never an edit: the bank returned a payout recorded as arrived.
          if (
            (payout.status === "failed" || payout.status === "canceled") &&
            !isFailed.has(payout.ref)
          ) {
            statements.push(failureInsert(provider, payout.ref, today, ctx.now));
            isFailed.add(payout.ref);
            out.failed += 1;
          }
          continue;
        }
        if (payout.status !== "paid" || recordedNow.has(payout.ref)) continue;
        if (!payout.itemised) {
          statements.push(payoutInsert(provider, payout, ctx.now));
          recordedNow.add(payout.ref);
          out.recorded += 1;
          tell.push(payout);
          continue;
        }
        row.reading = JSON.stringify(payout);
        row.line_cursor = null;
        // Out of calls before its last line: the next run carries on, and lists this page again.
        if (!(await readLines())) break pass;
      }
      if (!page.next) {
        finished = true;
        break;
      }
      row.cursor = page.next;
    }
    if (unavailable) {
      Object.assign(row, {
        done: 1,
        cursor: null,
        reading: null,
        line_cursor: null,
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
        state: "ok",
        reason: null,
        failures: 0,
        next_at: nextPassAt(today, clock.zone),
      });
    } else {
      // More to read: the next minute carries on from the marker.
      Object.assign(row, {
        state: row.state === "unavailable" ? "ok" : row.state,
        next_at: ctx.now,
      });
    }
  } catch (error) {
    // The provider failed: keep the place and what was read, and try again later. A provider
    // that keeps failing is tried daily; the cron's other steps are not held up.
    const failures = row.failures + 1;
    const minutes =
      PAYOUT_RETRY_MINUTES[Math.min(failures - 1, PAYOUT_RETRY_MINUTES.length - 1)] ?? 1440;
    Object.assign(row, {
      state: "failing",
      reason: `The payment provider could not be read: ${
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
      if (lines === payout.amount) continue;
      const plan = await notifyStatements(
        ctx.db,
        {
          to: recipients.map((userId) => ({ userId })),
          type: "system.message",
          title: "A payout does not match its lines",
          body:
            `The payout ${payout.ref} arriving ${payout.arrivalDate} is ${payout.amount} minor units ` +
            `of ${payout.currency}, and the lines the provider listed for it come to ${lines}. ` +
            (payout.itemised
              ? "The difference shows in the Payouts report as matching nothing."
              : "It was made by hand at the provider, which lists no lines for it.") +
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
          .where("version", "=", stored.version)
      : ctx.db
          .insertInto("core_payout_sync")
          .values({ provider, ...values, version: 1 })
          .onConflict((oc) => oc.column("provider").doNothing()),
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
