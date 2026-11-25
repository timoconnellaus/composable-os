// Reading the reports and the book entries (stage 52 step 3, ADRs 0790, 0791 and 0796). A closed
// month's report is its version's rows exactly as they were closed; an open month's (or any span
// of days') is a preview worked out now by the same code the close runs (`moneyBook`), so a
// preview and the version a close then writes agree. The book entries are read only from closed
// versions: a preview's are never offered (Accounting sync's read, stage 61).
import { sql } from "kysely";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import type { HandlerContext } from "../operation.ts";
import { loadOrderCurrency } from "../orders/settings.ts";
import { COVERS_NOTE, moneyBook, TAX_NOTE } from "./book.ts";
import { closedBefore, type Report, type ReportRow } from "./close.ts";
import { type LocalRange, midnightOf, nextDate } from "./day.ts";
import { closedPayoutRows, PAYOUTS_NOTE, payoutBook } from "./payouts.ts";
import { financeClock, type PeriodRow, rangeOf, versionsOf } from "./periods.ts";

/** The reports built so far (steps 3 and 4); the others land with their steps (5, 6 and 8). */
export const BUILT_REPORTS = [
  "sales",
  "tax",
  "refunds",
  "payouts",
] as const satisfies readonly Report[];
export type BuiltReport = (typeof BUILT_REPORTS)[number];

/** The longest span of days a preview covers. */
export const MAX_PREVIEW_DAYS = 366;

/** What a report is asked for: a month (its closed version, or a preview), or a span of days. */
export interface ReportAsk {
  report: BuiltReport;
  month?: string | undefined;
  version?: number | undefined;
  start?: string | undefined;
  end?: string | undefined;
}

/** One report, ready for the screen, the assistant or a file. */
export interface ReportView {
  report: BuiltReport;
  month: string | null;
  start: string;
  end: string;
  zone: string;
  preview: boolean;
  version: number | null;
  /** A reopened version, read as it was closed. */
  reopened: boolean;
  closedAt: string | null;
  closedByName: string | null;
  currency: string | null;
  notes: string[];
  /** The rows: their figures, and a person's name and email on a refund. */
  rows: Record<string, unknown>[];
  totals: Record<string, number>;
}

const NOTES: Record<BuiltReport, string[]> = {
  sales: [COVERS_NOTE],
  tax: [TAX_NOTE, COVERS_NOTE],
  refunds: [TAX_NOTE, COVERS_NOTE],
  payouts: [PAYOUTS_NOTE, COVERS_NOTE],
};

async function userNames(ctx: HandlerContext, ids: readonly (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (!unique.length) return new Map<string, string>();
  // One JSON parameter, however many staff a year of refunds names (D1: 100 variables).
  const rows = (
    await sql<{ id: string; name: string }>`
      SELECT id, name FROM core_user WHERE id IN (SELECT value FROM json_each(${JSON.stringify(unique)}))
    `.execute(ctx.db)
  ).rows;
  return new Map(rows.map((r) => [r.id, r.name]));
}

const SUMMED: Record<BuiltReport, readonly string[]> = {
  sales: [
    "sold",
    "discounts",
    "refunded",
    "net",
    "taxOnSales",
    "taxRefunded",
    "taxRefundedEstimated",
    "tax",
    "netOfTax",
  ],
  tax: ["sold", "refunded", "taxOnSales", "taxRefunded", "taxRefundedEstimated", "tax", "netOfTax"],
  refunds: ["amount", "tax"],
  payouts: [
    "amount",
    "payments",
    "refunds",
    "disputes",
    "adjustments",
    "unmatched",
    "fees",
    "linesNet",
    "difference",
  ],
};

/**
 * A report's totals: its figures summed over its rows (Sales: over its items, not its days;
 * Payouts: over its payouts, with what failed after arriving and what is not yet paid out beside).
 */
function totalsOf(report: BuiltReport, rows: readonly Record<string, unknown>[]) {
  const counted =
    report === "sales"
      ? rows.filter((r) => r.type === "item")
      : report === "payouts"
        ? rows.filter((r) => r.type === "payout")
        : rows.filter((r) => r.type !== "exception");
  const totals: Record<string, number> = { rows: counted.length };
  for (const key of SUMMED[report]) {
    totals[key] = counted.reduce(
      (n, r) => n + (typeof r[key] === "number" ? (r[key] as number) : 0),
      0,
    );
  }
  if (report === "payouts") {
    totals.failed = rows
      .filter((r) => r.type === "failure")
      .reduce((n, r) => n + (typeof r.amount === "number" ? r.amount : 0), 0);
    const unpaid = rows.find((r) => r.type === "unpaid");
    totals.notPaidOut = typeof unpaid?.amount === "number" ? unpaid.amount : 0;
    totals.notPaidOutOlder = typeof unpaid?.olderAmount === "number" ? unpaid.olderAmount : 0;
    totals.notPaidOutOlderCount = typeof unpaid?.olderCount === "number" ? unpaid.olderCount : 0;
    totals.unreadableLines = counted.reduce(
      (n, r) => n + (typeof r.unreadableLines === "number" ? r.unreadableLines : 0),
      0,
    );
  }
  return totals;
}

/**
 * A report's rows and the notes among them: Payouts keeps what the read said of itself (refused,
 * failing, part-way through) as `note` rows, so a closed version says it as it was when closed.
 */
function withNotes(base: readonly string[], rows: Record<string, unknown>[]) {
  const notes = rows.filter((r) => r.type === "note").map((r) => String(r.text));
  return { notes: [...base, ...notes], rows: rows.filter((r) => r.type !== "note") };
}

/** Staff names for a refund row's ids, as the accounts have them now. */
async function withNames(
  ctx: HandlerContext,
  report: BuiltReport,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (report !== "refunds") return rows;
  const names = await userNames(
    ctx,
    rows.flatMap((r) => [r.requestedBy as string | null, r.approvedBy as string | null]),
  );
  return rows.map((r) => ({
    ...r,
    requestedByName: typeof r.requestedBy === "string" ? (names.get(r.requestedBy) ?? null) : null,
    approvedByName: typeof r.approvedBy === "string" ? (names.get(r.approvedBy) ?? null) : null,
  }));
}

function spanOf(start: string, end: string, zone: string): LocalRange {
  if (end < start) {
    throw new ValidationError("The span ends before it starts.", { field: "end" });
  }
  const starts = midnightOf(start, zone);
  const ends = midnightOf(nextDate(end), zone);
  if (ends - starts > MAX_PREVIEW_DAYS * 86_400 + 7_200) {
    throw new ValidationError(`A preview covers at most ${MAX_PREVIEW_DAYS} days.`, {
      field: "end",
    });
  }
  return { start, end, zone, starts, ends };
}

/** A closed or reopened version's rows of one report, in their stored order. */
async function storedRows(ctx: HandlerContext, version: PeriodRow, report: BuiltReport) {
  const rows = await ctx.db
    .selectFrom("core_finance_row")
    .select(["name", "email", "data"])
    .where("period_id", "=", version.id)
    .where("report", "=", report)
    .orderBy("n")
    .execute();
  return rows.map((r) => {
    const data = JSON.parse(r.data) as Record<string, unknown>;
    return report === "refunds" ? { ...data, name: r.name, email: r.email } : data;
  });
}

/** A month's version: the one asked for, else its latest when that is closed; null: open. */
async function versionAsked(ctx: HandlerContext, month: string, version: number | undefined) {
  const versions = await versionsOf(ctx.db, [month]);
  if (version !== undefined) {
    const found = versions.find((v) => v.version === version);
    if (!found) throw new NotFoundError("finance version", `${month} v${version}`);
    return found;
  }
  const latest = versions.at(-1);
  return latest?.state === "closed" ? latest : null;
}

export async function readReport(ctx: HandlerContext, ask: ReportAsk): Promise<ReportView> {
  const clock = await financeClock(ctx.db, ctx.now);
  const byMonth = ask.month !== undefined;
  if (byMonth === (ask.start !== undefined || ask.end !== undefined)) {
    throw new ValidationError("Ask for a month, or for a span of days (start and end).", {
      field: "month",
    });
  }
  if (!byMonth && (ask.start === undefined || ask.end === undefined || ask.version !== undefined)) {
    throw new ValidationError("A span of days has a start and an end, and no version.", {
      field: "start",
    });
  }
  const base = { report: ask.report, notes: NOTES[ask.report] };
  if (byMonth) {
    const month = ask.month as string;
    const version = await versionAsked(ctx, month, ask.version);
    if (version) {
      let stored = await storedRows(ctx, version, ask.report);
      if (ask.report === "payouts") stored = await closedPayoutRows(ctx.db, stored);
      const kept = withNotes(base.notes, stored);
      const rows = await withNames(ctx, ask.report, kept.rows);
      const names = await userNames(ctx, [version.closed_by]);
      return {
        ...base,
        notes: kept.notes,
        month,
        start: version.start_date,
        end: version.end_date,
        zone: version.zone,
        preview: false,
        version: version.version,
        reopened: version.state === "reopened",
        closedAt: version.closed_at,
        closedByName: names.get(version.closed_by) ?? null,
        currency:
          (rows.find((r) => typeof r.currency === "string")?.currency as string | undefined) ??
          (await loadOrderCurrency(ctx.db)),
        rows,
        totals: totalsOf(ask.report, rows),
      };
    }
    const range = await rangeOf(ctx.db, month, clock.zone);
    const book = await previewBook(ctx, ask.report, range, await closedBefore(ctx.db, range));
    const kept = withNotes(base.notes, rowsOf(book.rows, ask.report));
    const rows = await withNames(ctx, ask.report, kept.rows);
    return {
      ...base,
      notes: kept.notes,
      month,
      start: range.start,
      end: range.end,
      zone: range.zone,
      preview: true,
      version: null,
      reopened: false,
      closedAt: null,
      closedByName: null,
      currency: book.currency,
      rows,
      totals: totalsOf(ask.report, rows),
    };
  }
  const range = spanOf(ask.start as string, ask.end as string, clock.zone);
  const book = await previewBook(ctx, ask.report, range, []);
  const kept = withNotes(base.notes, rowsOf(book.rows, ask.report));
  const rows = await withNames(ctx, ask.report, kept.rows);
  return {
    ...base,
    notes: kept.notes,
    month: null,
    start: range.start,
    end: range.end,
    zone: range.zone,
    preview: true,
    version: null,
    reopened: false,
    closedAt: null,
    closedByName: null,
    currency: book.currency,
    rows,
    totals: totalsOf(ask.report, rows),
  };
}

/**
 * A preview's rows, worked out now by the code the close runs: Payouts from the payouts read
 * (`payoutBook`), the others from the money the host recorded (`moneyBook`).
 */
async function previewBook(
  ctx: HandlerContext,
  report: BuiltReport,
  range: LocalRange,
  late: Awaited<ReturnType<typeof closedBefore>>,
): Promise<{ currency: string | null; rows: ReportRow[] }> {
  if (report !== "payouts") {
    const book = await moneyBook(ctx.db, range, late);
    return { currency: book.currency, rows: book.rows };
  }
  const currency = await loadOrderCurrency(ctx.db);
  const book = await payoutBook(ctx.db, range, late, currency);
  return { currency, rows: book.rows };
}

function rowsOf(rows: readonly ReportRow[], report: BuiltReport) {
  return rows
    .filter((r) => r.report === report)
    .map((r) => (report === "refunds" ? { ...r.data, name: r.name, email: r.email } : r.data));
}

/** Sales over a span of instants, as `finance.report` totals it: what Today shows as takings. */
export interface SalesTotal {
  currency: string | null;
  /** Sold less refunded, tax inside, in the currency's minor unit (Sales' `net`). */
  net: number;
  /** The payments counted in the currency. */
  payments: number;
  /** Sales' item rows, largest net first: what was sold, and its figures. */
  items: Record<string, unknown>[];
}

/**
 * Sales' net over any span of instants (stage 60, ADR 0874: Today's takings, from the local
 * midnight to its end, or to the same time a week ago): the same book `finance.report` reads,
 * totalled the same way, so the two never differ (the spec's decision 11). Not a preview of a
 * month: nothing late is counted.
 */
export async function salesTotal(
  ctx: Pick<HandlerContext, "db">,
  span: { start: string; zone: string; starts: number; ends: number },
): Promise<SalesTotal> {
  const book = await moneyBook(ctx.db, span);
  const rows = rowsOf(book.rows, "sales");
  const elsewhere = rows.filter((r) => r.type === "exception" && r.kind === "payment").length;
  return {
    currency: book.currency,
    net: totalsOf("sales", rows).net ?? 0,
    payments: book.counted.filter((c) => c.kind === "payment").length - elsewhere,
    items: rows
      .filter((r) => r.type === "item")
      .sort((a, b) => Number(b.net ?? 0) - Number(a.net ?? 0)),
  };
}

/** The most entries one page of `finance.entries` holds. */
export const ENTRIES_PAGE = 200;

export interface EntriesPage {
  month: string;
  version: number;
  state: "closed" | "reopened";
  closedAt: string;
  entries: {
    n: number;
    key: string;
    kind: string;
    date: string;
    period: string;
    version: number;
    belongsTo: string | null;
    fingerprint: string;
    lines: {
      heading: string;
      side: string;
      amount: number;
      taxCode: string | null;
      taxCountry: string | null;
      method: string | null;
      category: string | null;
    }[];
  }[];
  /** Pass as `after` for the next page; null on the last. */
  next: number | null;
}

/**
 * A closed version's book entries and their lines, `limit` entries from after entry `after`. Only
 * a version that was closed (closed now, or closed and since reopened); never a preview.
 */
export async function readEntries(
  ctx: HandlerContext,
  ask: {
    month: string;
    version?: number | undefined;
    after?: number | undefined;
    limit?: number | undefined;
  },
): Promise<EntriesPage> {
  const version = await versionAsked(ctx, ask.month, ask.version);
  if (!version) {
    throw new ConflictError(
      `${ask.month} is not closed: its book entries exist once it is (a preview has none).`,
      { rule: "finance_period_not_closed" },
    );
  }
  const after = ask.after ?? 0;
  const limit = Math.min(ask.limit ?? ENTRIES_PAGE, ENTRIES_PAGE);
  const entries = await ctx.db
    .selectFrom("core_finance_entry")
    .selectAll()
    .where("period_id", "=", version.id)
    .where("n", ">", after)
    .orderBy("n")
    .limit(limit + 1)
    .execute();
  const page = entries.slice(0, limit);
  const last = page.at(-1)?.n ?? after;
  const lines = page.length
    ? (
        await sql<{
          entry_key: string;
          n: number;
          heading: string;
          side: string;
          amount: number;
          tax_code: string | null;
          tax_country: string | null;
          method: string | null;
          category: string | null;
        }>`
          SELECT l.entry_key, l.n, l.heading, l.side, l.amount, l.tax_code, l.tax_country,
            l.method, l.category
          FROM core_finance_entry_line l JOIN core_finance_entry e
            ON e.period_id = l.period_id AND e.entry_key = l.entry_key
          WHERE l.period_id = ${version.id} AND e.n > ${after} AND e.n <= ${last}
          ORDER BY e.n, l.n
        `.execute(ctx.db)
      ).rows
    : [];
  const byKey = new Map<string, EntriesPage["entries"][number]["lines"]>();
  for (const l of lines) {
    const list = byKey.get(l.entry_key) ?? [];
    list.push({
      heading: l.heading,
      side: l.side,
      amount: l.amount,
      taxCode: l.tax_code,
      taxCountry: l.tax_country,
      method: l.method,
      category: l.category,
    });
    byKey.set(l.entry_key, list);
  }
  return {
    month: version.month,
    version: version.version,
    state: version.state as "closed" | "reopened",
    closedAt: version.closed_at,
    entries: page.map((e) => ({
      n: e.n,
      key: e.entry_key,
      kind: e.kind,
      date: e.date,
      period: version.month,
      version: version.version,
      belongsTo: e.belongs_to,
      fingerprint: e.fingerprint,
      lines: byKey.get(e.entry_key) ?? [],
    })),
    next: entries.length > limit ? last : null,
  };
}
