// Closing a month (stage 52, ADR 0790): one batch writes a version of the month `closing`, its book
// entries and their lines, its report rows and every source it counted, then `closed`. Before it,
// the close reads what its figures came from (`guards`: integer SQL) and guards each value in the
// batch (`core_finance_guard`): a write in between fails the close whole (`finance_changed`), so a
// closed version is exactly what it read. A month too big to close in one batch is refused, never
// cut short. The tables' triggers keep a closed version as it was, for every writer.
//
// What a month holds is `periodBook`'s: the reports each add their entries, rows, sources and
// guards there. Step 3 adds the day summaries, Sales, Tax and Refunds (`finance/book.ts`), step 4
// the payout entries and Payouts (`finance/payouts.ts`); steps 5, 6 and 8 add theirs.
import { CompiledQuery } from "kysely";
import { ConflictError } from "../errors.ts";
import type { HandlerContext } from "../operation.ts";
import { loadOrderCurrency } from "../orders/settings.ts";
import { moneyBook } from "./book.ts";
import type { LocalRange } from "./day.ts";
import { type BookEntry, type SealedEntry, sealEntry } from "./entries.ts";
import { mergeEntries, payoutBook } from "./payouts.ts";

/** The most lines, report rows or counted sources one version holds; more is refused. */
export const MAX_CLOSE_LINES = 100_000;
/** Rows per insert statement: one JSON parameter each, so a month of 100,000 lines is 200. */
export const CLOSE_CHUNK = 500;
/**
 * The most bytes one statement's JSON parameter carries (D1 caps a value at 2 MB; the local
 * runtime enforces nothing): a chunk ends at 500 rows or this many bytes, whichever comes first.
 */
export const CLOSE_CHUNK_BYTES = 1_000_000;
/** The most bytes one report row's figures take (its order ids included); more is refused. */
export const MAX_ROW_BYTES = 100_000;
/** The most guards one close reads and writes (one statement each, before and in the batch). */
export const MAX_CLOSE_GUARDS = 50;
/** The most statements one close's batch holds: D1 runs 1,000 an invocation, the rest is the pipeline's. */
export const MAX_CLOSE_STATEMENTS = 900;

export const REPORTS = [
  "sales",
  "tax",
  "refunds",
  "payouts",
  "owed",
  "held",
  "unearned",
  "members",
] as const;
export type Report = (typeof REPORTS)[number];

/** A report's row as a version keeps it: its figures in `data`, a person apart (for an erase). */
export interface ReportRow {
  report: Report;
  personId: string | null;
  name: string | null;
  email: string | null;
  /** Amounts, dates and order ids; never a name. */
  data: Record<string, unknown>;
}

/** A source the close counted (`payment`, `refund`, `payout`, …), so no other month counts it. */
export interface CountedSource {
  kind: string;
  id: string;
}

/** What a month holds: its entries, report rows, the sources counted, and what to guard. */
export interface PeriodBook {
  entries: BookEntry[];
  rows: ReportRow[];
  counted: CountedSource[];
  /** Integer SQL over what the figures came from, read before the batch and guarded in it. */
  guards: string[];
}

/**
 * The month's book as the host's figures stand now: its money (day summaries, Sales, Tax and
 * Refunds), and what arrived for the closed months before it that none of their versions counted.
 */
export async function periodBook(ctx: HandlerContext, range: LocalRange): Promise<PeriodBook> {
  const late = await closedBefore(ctx.db, range);
  const money = await moneyBook(ctx.db, range, late);
  // Payouts (step 4): a payout entry each, the Payouts rows, and late payouts in the late entry.
  const payouts = await payoutBook(
    ctx.db,
    range,
    late,
    money.currency ?? (await loadOrderCurrency(ctx.db)),
  );
  return {
    entries: mergeEntries(money.entries, payouts.entries),
    rows: [...money.rows, ...payouts.rows],
    counted: [...money.counted, ...payouts.counted],
    guards: [...money.guards, ...payouts.guards],
  };
}

/** The closed months before `range` (the months a late source can belong to). */
export async function closedBefore(db: HandlerContext["db"], range: LocalRange) {
  return db
    .selectFrom("core_finance_period")
    .select(["month", "starts", "ends", "start_date", "end_date"])
    .where("state", "=", "closed")
    .where("ends", "<=", range.starts)
    .orderBy("month")
    .execute();
}

type AnyDb = { executeQuery: (q: CompiledQuery) => Promise<{ rows: unknown[] }> };

/** Reads the guards now: the values the close's batch expects. */
export async function readGuards(
  db: HandlerContext["db"],
  queries: readonly string[],
): Promise<number[]> {
  const out: number[] = [];
  for (const q of queries) {
    const row = (
      await (db as unknown as AnyDb).executeQuery(CompiledQuery.raw(`SELECT (${q}) AS v`, []))
    ).rows[0] as { v: number | null } | undefined;
    out.push(Number(row?.v ?? 0));
  }
  return out;
}

/** Each guard fails the batch when its value is no longer what was read. */
export function guardStatements(queries: readonly string[], values: readonly number[]) {
  return queries.map((q, i) =>
    CompiledQuery.raw(`INSERT INTO core_finance_guard (expected, actual) SELECT ?, (${q})`, [
      values[i] ?? 0,
    ]),
  );
}

/** Rows inserted from one JSON array parameter, `CLOSE_CHUNK` rows or `CLOSE_CHUNK_BYTES` to a statement. */
function jsonInserts(
  table: string,
  cols: readonly (readonly [column: string, key: string])[],
  rows: readonly Record<string, unknown>[],
): CompiledQuery[] {
  const statement =
    `INSERT INTO ${table} (${cols.map(([c]) => c).join(", ")}) SELECT ` +
    `${cols.map(([, k]) => `json_extract(value, '$.${k}')`).join(", ")} FROM json_each(?)`;
  const out: CompiledQuery[] = [];
  let part: string[] = [];
  let bytes = 2;
  const flush = () => {
    if (part.length) out.push(CompiledQuery.raw(statement, [`[${part.join(",")}]`]));
    part = [];
    bytes = 2;
  };
  for (const row of rows) {
    const json = JSON.stringify(row);
    const size = new TextEncoder().encode(json).length + 1;
    if (part.length >= CLOSE_CHUNK || (part.length && bytes + size > CLOSE_CHUNK_BYTES)) flush();
    part.push(json);
    bytes += size;
  }
  flush();
  return out;
}

/** A version's period row, entries, lines, rows and counted sources, in insert statements. */
export function closeInserts(
  periodId: string,
  month: string,
  entries: readonly SealedEntry[],
  rows: readonly ReportRow[],
  counted: readonly CountedSource[],
): CompiledQuery[] {
  const entryRows = entries.map((e, i) => ({
    p: periodId,
    k: e.key,
    n: i + 1,
    t: e.kind,
    d: e.date,
    b: e.belongsTo,
    f: e.fingerprint,
  }));
  const lineRows = entries.flatMap((e) =>
    e.lines.map((l, j) => ({
      p: periodId,
      k: e.key,
      n: j + 1,
      h: l.heading,
      s: l.side,
      a: l.amount,
      tc: l.taxCode ?? null,
      tx: l.taxCountry ?? null,
      m: l.method ?? null,
      c: l.category ?? null,
    })),
  );
  const reportN = new Map<string, number>();
  const rowRows = rows.map((r) => {
    const n = (reportN.get(r.report) ?? 0) + 1;
    reportN.set(r.report, n);
    return {
      p: periodId,
      r: r.report,
      n,
      pe: r.personId,
      nm: r.name,
      em: r.email,
      d: JSON.stringify(r.data),
    };
  });
  const countedRows = [...new Map(counted.map((c) => [`${c.kind}\u0000${c.id}`, c])).values()].map(
    (c) => ({ k: c.kind, i: c.id, p: periodId, m: month }),
  );
  return [
    ...jsonInserts(
      "core_finance_entry",
      [
        ["period_id", "p"],
        ["entry_key", "k"],
        ["n", "n"],
        ["kind", "t"],
        ["date", "d"],
        ["belongs_to", "b"],
        ["fingerprint", "f"],
      ],
      entryRows,
    ),
    ...jsonInserts(
      "core_finance_entry_line",
      [
        ["period_id", "p"],
        ["entry_key", "k"],
        ["n", "n"],
        ["heading", "h"],
        ["side", "s"],
        ["amount", "a"],
        ["tax_code", "tc"],
        ["tax_country", "tx"],
        ["method", "m"],
        ["category", "c"],
      ],
      lineRows,
    ),
    ...jsonInserts(
      "core_finance_row",
      [
        ["period_id", "p"],
        ["report", "r"],
        ["n", "n"],
        ["person_id", "pe"],
        ["name", "nm"],
        ["email", "em"],
        ["data", "d"],
      ],
      rowRows,
    ),
    ...jsonInserts(
      "core_finance_counted",
      [
        ["source_kind", "k"],
        ["source_id", "i"],
        ["period_id", "p"],
        ["month", "m"],
      ],
      countedRows,
    ),
  ];
}

/** What a close writes, with its counts. */
export interface ClosePlan {
  entries: SealedEntry[];
  lines: number;
  statements: CompiledQuery[];
}

/**
 * The close's batch for a month's book, after its guards were read: the guards, the version
 * `closing`, everything it holds, then `closed` (the trigger checks the counts). Refused over
 * `MAX_CLOSE_LINES` lines, rows or sources: never cut short.
 */
export async function closePlan(
  ctx: Pick<HandlerContext, "db" | "now">,
  args: {
    id: string;
    month: string;
    range: LocalRange;
    version: number;
    by: string;
    book: PeriodBook;
    guardValues: readonly number[];
  },
): Promise<ClosePlan> {
  const { book } = args;
  const lines = book.entries.reduce((n, e) => n + e.lines.length, 0);
  const tooLarge = () =>
    new ConflictError(
      `This month holds more than one close writes (${MAX_CLOSE_LINES.toLocaleString("en")} lines, rows, payments or entries), so it was not closed.`,
      { rule: "finance_too_large" },
    );
  if (book.guards.length > MAX_CLOSE_GUARDS) throw tooLarge();
  if (
    book.rows.some((r) => new TextEncoder().encode(JSON.stringify(r.data)).length > MAX_ROW_BYTES)
  ) {
    throw tooLarge();
  }
  if (
    lines > MAX_CLOSE_LINES ||
    book.entries.length > MAX_CLOSE_LINES ||
    book.rows.length > MAX_CLOSE_LINES ||
    book.counted.length > MAX_CLOSE_LINES
  ) {
    throw new ConflictError(
      `This month holds more than ${MAX_CLOSE_LINES.toLocaleString("en")} lines, rows or payments, the most one close writes, so it was not closed.`,
      { rule: "finance_too_large" },
    );
  }
  const entries: SealedEntry[] = [];
  for (const e of book.entries) entries.push(await sealEntry(e));
  const kept = entries.reduce((n, e) => n + e.lines.length, 0);
  const keys = new Set(entries.map((e) => e.key));
  if (keys.size !== entries.length) {
    throw new ConflictError("Two book entries of this month have one key, so it was not closed.", {
      rule: "finance_entry",
    });
  }
  const statements = [
    ...guardStatements(book.guards, args.guardValues),
    ctx.db
      .insertInto("core_finance_period")
      .values({
        id: args.id,
        month: args.month,
        start_date: args.range.start,
        end_date: args.range.end,
        zone: args.range.zone,
        starts: args.range.starts,
        ends: args.range.ends,
        version: args.version,
        state: "closing",
        closed_by: args.by,
        closed_at: ctx.now,
        entry_count: 0,
        line_count: 0,
        row_count: 0,
        reopened_by: null,
        reopened_at: null,
        reopen_reason: null,
      })
      .compile(),
    ...closeInserts(args.id, args.month, entries, book.rows, book.counted),
    ctx.db
      .updateTable("core_finance_period")
      .set({
        state: "closed",
        entry_count: entries.length,
        line_count: kept,
        row_count: book.rows.length,
      })
      .where("id", "=", args.id)
      .compile(),
  ];
  // Chunked by bytes too, so the count is checked once built: never more than D1 runs.
  if (statements.length > MAX_CLOSE_STATEMENTS) throw tooLarge();
  return { entries, lines: kept, statements };
}
