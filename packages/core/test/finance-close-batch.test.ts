// Stage 52 step 1 (ADRs 0790 and 0791): the close's batch itself. A closed version never changes
// for any writer (raw UPDATE, DELETE, REPLACE, upsert and UPDATE OR REPLACE), its one erase, a
// source counted in one month only, versions and fingerprints, the guard (finance_changed), and
// what one close may hold (lines, entries, rows and their bytes, guards, statements: the review
// of PR #337). Months here are closed in order, as the table holds every writer to.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CLOSE_CHUNK_BYTES,
  closePlan,
  MAX_CLOSE_GUARDS,
  MAX_CLOSE_LINES,
  MAX_ROW_BYTES,
  type PeriodBook,
  readGuards,
} from "../src/finance/close.ts";
import { monthRange } from "../src/finance/day.ts";
import { type BookEntry, checkEntry } from "../src/finance/entries.ts";
import { type ActingUser, newId, toOperationError } from "../src/index.ts";
import { createUser, db } from "./helpers.ts";

const ZONE = "Pacific/Auckland";

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

async function setSetting(key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

const day = (date: string, lines: BookEntry["lines"]): BookEntry => ({
  key: `day:${date}`,
  kind: "day",
  date,
  belongsTo: null,
  lines,
});

const SALE = [
  { heading: "money_in:provider", side: "debit" as const, amount: 11_000, method: "provider" },
  {
    heading: "sales:memberships",
    side: "credit" as const,
    amount: 10_000,
    category: "memberships",
  },
  {
    heading: "tax:txcd_10000000:NZ",
    side: "credit" as const,
    amount: 1_000,
    taxCode: "txcd_10000000",
    taxCountry: "NZ",
  },
];

describe("a closed version never changes", () => {
  // Months closed straight through the close's own batch, in order from January 2025.
  const MONTH = "2025-01";
  const range = monthRange(MONTH, ZONE);
  let periodId: string;
  let by: ActingUser;

  const book = (lines = SALE): PeriodBook => ({
    entries: [day("2025-01-03", lines), day("2025-01-04", SALE)],
    rows: [
      {
        report: "refunds",
        personId: "per_test",
        name: "A Person",
        email: "a@example.com",
        data: { amount: 500, order: "ord_1" },
      },
      { report: "sales", personId: null, name: null, email: null, data: { amount: 10_000 } },
    ],
    counted: [
      { kind: "payment", id: "pay_1" },
      { kind: "refund", id: "ref_1" },
    ],
    guards: [],
  });

  async function close(month: string, version: number, b: PeriodBook) {
    const id = newId("financePeriod");
    const plan = await closePlan(
      { db: db.query, now: "2026-11-24T00:00:00.000Z" },
      {
        id,
        month,
        range: monthRange(month, ZONE),
        version,
        by: by.id,
        book: b,
        guardValues: await readGuards(db.query, b.guards),
      },
    );
    await db.batch(plan.statements);
    return id;
  }

  const raw = (sql: string, ...binds: unknown[]) =>
    env.DB.prepare(sql)
      .bind(...binds)
      .run();
  const fixed = async (sql: string, ...binds: unknown[]) => {
    await expect(raw(sql, ...binds), sql).rejects.toThrow(
      /core_finance_(period_fixed|counted_twice|period_held)/,
    );
  };

  beforeAll(async () => {
    by = await createUser("admin");
    periodId = await close(MONTH, 1, book());
  });

  it("writes the version, its entries, lines, rows and counted sources in one batch", async () => {
    const p = await env.DB.prepare("SELECT * FROM core_finance_period WHERE id = ?")
      .bind(periodId)
      .first();
    expect(p).toMatchObject({
      state: "closed",
      version: 1,
      entry_count: 2,
      line_count: 6,
      row_count: 2,
      starts: range.starts,
    });
    const lines = await env.DB.prepare(
      "SELECT side, sum(amount) AS total FROM core_finance_entry_line WHERE period_id = ? GROUP BY side",
    )
      .bind(periodId)
      .all();
    expect(lines.results).toEqual([
      { side: "credit", total: 22_000 },
      { side: "debit", total: 22_000 },
    ]);
  });

  it("refuses UPDATE, DELETE, REPLACE, upsert and UPDATE OR REPLACE on every table", async () => {
    await fixed("UPDATE core_finance_entry SET fingerprint = 'x' WHERE period_id = ?", periodId);
    await fixed("DELETE FROM core_finance_entry WHERE period_id = ?", periodId);
    await fixed(
      "INSERT OR REPLACE INTO core_finance_entry (period_id, entry_key, n, kind, date, belongs_to, fingerprint) VALUES (?, 'day:2025-01-03', 1, 'day', '2025-01-03', NULL, 'x')",
      periodId,
    );
    await fixed(
      "INSERT INTO core_finance_entry (period_id, entry_key, n, kind, date, belongs_to, fingerprint) VALUES (?, 'day:2025-01-09', 9, 'day', '2025-01-09', NULL, 'x')",
      periodId,
    );
    await fixed(
      "UPDATE core_finance_entry_line SET amount = amount + 1 WHERE period_id = ?",
      periodId,
    );
    await fixed(
      "UPDATE OR REPLACE core_finance_entry_line SET n = 1 WHERE period_id = ? AND n = 2",
      periodId,
    );
    await fixed("DELETE FROM core_finance_entry_line WHERE period_id = ?", periodId);
    await fixed(
      "INSERT INTO core_finance_entry_line (period_id, entry_key, n, heading, side, amount) VALUES (?, 'day:2025-01-03', 1, 'bank', 'debit', 1) ON CONFLICT DO UPDATE SET amount = 2",
      periodId,
    );
    await fixed("UPDATE core_finance_row SET data = '{}' WHERE period_id = ?", periodId);
    await fixed(
      "UPDATE core_finance_row SET name = 'Someone else' WHERE period_id = ? AND person_id IS NOT NULL",
      periodId,
    );
    await fixed(
      "UPDATE core_finance_row SET name = 'Erased person' WHERE period_id = ? AND person_id IS NULL",
      periodId,
    );
    await fixed("DELETE FROM core_finance_row WHERE period_id = ?", periodId);
    await fixed(
      "INSERT OR REPLACE INTO core_finance_row (period_id, report, n, data) VALUES (?, 'sales', 1, '{}')",
      periodId,
    );
    await fixed("UPDATE core_finance_counted SET source_id = 'x' WHERE period_id = ?", periodId);
    await fixed("DELETE FROM core_finance_counted WHERE period_id = ?", periodId);
    await fixed(
      "INSERT OR REPLACE INTO core_finance_counted (source_kind, source_id, period_id, month) VALUES ('payment', 'pay_1', ?, ?)",
      periodId,
      MONTH,
    );
    await fixed("UPDATE core_finance_period SET ends = ends + 1 WHERE id = ?", periodId);
    await fixed("UPDATE core_finance_period SET state = 'closing' WHERE id = ?", periodId);
    await fixed("UPDATE OR REPLACE core_finance_period SET zone = 'UTC' WHERE id = ?", periodId);
    await fixed("DELETE FROM core_finance_period WHERE id = ?", periodId);
    await fixed(
      "INSERT OR REPLACE INTO core_finance_period (id, month, start_date, end_date, zone, starts, ends, version, state, closed_by, closed_at, entry_count, line_count, row_count) VALUES (?, ?, '2025-01-01', '2025-01-31', 'UTC', 1, 2, 1, 'closing', 'x', 'x', 0, 0, 0)",
      periodId,
      MONTH,
    );
    // A second version while one is closed, or a version born closed.
    await fixed(
      "INSERT INTO core_finance_period (id, month, start_date, end_date, zone, starts, ends, version, state, closed_by, closed_at, entry_count, line_count, row_count) VALUES ('fip_x', ?, '2025-01-01', '2025-01-31', 'UTC', 1, 2, 2, 'closing', 'x', 'x', 0, 0, 0)",
      MONTH,
    );
    await fixed(
      "INSERT INTO core_finance_period (id, month, start_date, end_date, zone, starts, ends, version, state, closed_by, closed_at, entry_count, line_count, row_count) VALUES ('fip_y', '2024-06', '2024-06-01', '2024-06-30', 'UTC', 1, 2, 1, 'closed', 'x', 'x', 0, 0, 0)",
    );
    const n = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM core_finance_entry WHERE period_id = ?1) AS e, (SELECT count(*) FROM core_finance_entry_line WHERE period_id = ?1) AS l, (SELECT count(*) FROM core_finance_row WHERE period_id = ?1) AS r, (SELECT count(*) FROM core_finance_counted WHERE period_id = ?1) AS c",
    )
      .bind(periodId)
      .first();
    expect(n).toEqual({ e: 2, l: 6, r: 2, c: 2 });
  });

  it("takes one change: an erase of a row's person, amounts kept", async () => {
    await raw(
      "UPDATE core_finance_row SET name = 'Erased person', email = NULL WHERE period_id = ? AND person_id = 'per_test'",
      periodId,
    );
    const row = await env.DB.prepare(
      "SELECT name, email, data FROM core_finance_row WHERE period_id = ? AND report = 'refunds'",
    )
      .bind(periodId)
      .first();
    expect(row).toEqual({
      name: "Erased person",
      email: null,
      data: JSON.stringify({ amount: 500, order: "ord_1" }),
    });
  });

  it("counts a source once across months: another month's close counting it fails whole", async () => {
    await expect(close("2025-02", 1, book())).rejects.toThrow(/core_finance_counted_twice/);
    const feb = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_finance_period WHERE month = '2025-02'",
    ).first();
    expect(feb).toEqual({ n: 0 });
    expect(toOperationError(new Error("core_finance_counted_twice")).details).toMatchObject({
      rule: "finance_period_fixed",
    });
  });

  it("moves only closing → closed → reopened; a new close is version 2, each key kept, fingerprints changed only where lines did", async () => {
    // Reopened without who, when and why: the table's check refuses it.
    await expect(
      raw("UPDATE core_finance_period SET state = 'reopened' WHERE id = ?", periodId),
    ).rejects.toThrow(/CHECK constraint failed/);
    await raw(
      "UPDATE core_finance_period SET state = 'reopened', reopened_by = ?, reopened_at = 'now', reopen_reason = 'test' WHERE id = ?",
      by.id,
      periodId,
    );
    await fixed("UPDATE core_finance_period SET state = 'closed' WHERE id = ?", periodId);
    const changed = [
      { ...SALE[0], amount: 12_000 },
      SALE[1],
      { ...SALE[2], amount: 2_000 },
    ] as typeof SALE;
    const v2 = await close(MONTH, 2, book(changed));
    const prints = await env.DB.prepare(
      "SELECT p.version, e.entry_key, e.fingerprint FROM core_finance_entry e JOIN core_finance_period p ON p.id = e.period_id WHERE p.month = ? ORDER BY e.entry_key, p.version",
    )
      .bind(MONTH)
      .all<{ version: number; entry_key: string; fingerprint: string }>();
    const [d3v1, d3v2, d4v1, d4v2] = prints.results;
    expect(prints.results.map((r) => [r.entry_key, r.version])).toEqual([
      ["day:2025-01-03", 1],
      ["day:2025-01-03", 2],
      ["day:2025-01-04", 1],
      ["day:2025-01-04", 2],
    ]);
    expect(d3v1?.fingerprint).not.toBe(d3v2?.fingerprint);
    expect(d4v1?.fingerprint).toBe(d4v2?.fingerprint);
    // Version 1 is as it was.
    const v1 = await env.DB.prepare(
      "SELECT sum(amount) AS total FROM core_finance_entry_line WHERE period_id = ?",
    )
      .bind(periodId)
      .first();
    expect(v1).toEqual({ total: 44_000 });
    expect(v2).not.toBe(periodId);
  });

  it("fails the close whole when what it read changed before its batch (finance_changed)", async () => {
    const guarded: PeriodBook = {
      ...book(),
      counted: [],
      guards: ["SELECT count(*) FROM core_settings WHERE key LIKE 'finance_test_%'"],
    };
    const id = newId("financePeriod");
    const values = await readGuards(db.query, guarded.guards);
    const plan = await closePlan(
      { db: db.query, now: "2026-11-24T00:00:00.000Z" },
      {
        id,
        month: "2025-02",
        range: monthRange("2025-02", ZONE),
        version: 1,
        by: by.id,
        book: guarded,
        guardValues: values,
      },
    );
    await setSetting("finance_test_payment", 1);
    let error: unknown;
    try {
      await db.batch(plan.statements);
    } catch (e) {
      error = e;
    }
    expect(String(error)).toMatch(/core_finance_changed/);
    expect(toOperationError(error).details).toMatchObject({ rule: "finance_changed" });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM core_finance_period WHERE month = '2025-02'",
      ).first(),
    ).toEqual({ n: 0 });
    // Read again, it closes.
    const again = await closePlan(
      { db: db.query, now: "2026-11-24T00:00:00.000Z" },
      {
        id,
        month: "2025-02",
        range: monthRange("2025-02", ZONE),
        version: 1,
        by: by.id,
        book: guarded,
        guardValues: await readGuards(db.query, guarded.guards),
      },
    );
    await db.batch(again.statements);
  });

  it("refuses a month over the most lines one close writes, never cut short", async () => {
    const many: BookEntry["lines"] = [];
    for (let i = 0; i < MAX_CLOSE_LINES / 2 + 1; i++) {
      many.push(
        { heading: "bank", side: "debit", amount: 1 },
        { heading: "unmatched", side: "credit", amount: 1 },
      );
    }
    const e = await refusal(
      closePlan(
        { db: db.query, now: "2026-11-24T00:00:00.000Z" },
        {
          id: newId("financePeriod"),
          month: "2024-04",
          range: monthRange("2024-04", ZONE),
          version: 1,
          by: by.id,
          book: { entries: [day("2024-04-01", many)], rows: [], counted: [], guards: [] },
          guardValues: [],
        },
      ),
    );
    expect(e.details?.rule).toBe("finance_too_large");
  });

  it("keeps the figures out of every rec_* view", async () => {
    const views = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'view' AND name LIKE 'rec_%'",
    ).all<{ sql: string }>();
    for (const v of views.results) expect(v.sql).not.toMatch(/core_finance_/);
  });
});

describe("what one close may hold (the review of PR #337)", () => {
  const plan = (book: PeriodBook) =>
    closePlan(
      { db: db.query, now: "2026-11-24T00:00:00.000Z" },
      {
        id: newId("financePeriod"),
        month: "2025-03",
        range: monthRange("2025-03", ZONE),
        version: 1,
        by: "usr_x",
        book,
        guardValues: book.guards.map(() => 0),
      },
    );
  const empty: PeriodBook = { entries: [], rows: [], counted: [], guards: [] };
  const row = (bytes: number): PeriodBook["rows"][number] => ({
    report: "sales",
    personId: null,
    name: null,
    email: null,
    data: { orders: "o".repeat(bytes) },
  });

  it("chunks rows by bytes as well as by count, so no parameter nears D1's 2 MB", async () => {
    // 500 rows of 10 KB: by count one statement, by bytes five or more.
    const out = await plan({ ...empty, rows: Array.from({ length: 500 }, () => row(10_000)) });
    const inserts = out.statements.filter((q) =>
      String((q as { sql?: string }).sql).includes("INSERT INTO core_finance_row"),
    );
    expect(inserts.length).toBeGreaterThanOrEqual(5);
    for (const q of inserts) {
      const [param] = (q as { parameters: readonly unknown[] }).parameters;
      expect(new TextEncoder().encode(String(param)).length).toBeLessThanOrEqual(CLOSE_CHUNK_BYTES);
    }
  });

  it("refuses a row over its size, too many guards or too many entries", async () => {
    expect((await refusal(plan({ ...empty, rows: [row(MAX_ROW_BYTES + 1)] }))).details?.rule).toBe(
      "finance_too_large",
    );
    const guards = Array.from({ length: MAX_CLOSE_GUARDS + 1 }, () => "SELECT 0");
    expect((await refusal(plan({ ...empty, guards }))).details?.rule).toBe("finance_too_large");
    const entries = Array.from({ length: MAX_CLOSE_LINES + 1 }, (_, i) => ({
      key: `payout:po_${i}`,
      kind: "payout" as const,
      date: "2025-03-01",
      belongsTo: null,
      lines: [],
    }));
    expect((await refusal(plan({ ...empty, entries }))).details?.rule).toBe("finance_too_large");
  });

  it("sums exactly: amounts near the safe-integer limit never round to a balance", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const entry: BookEntry = {
      key: "day:2025-03-01",
      kind: "day",
      date: "2025-03-01",
      belongsTo: null,
      lines: [
        { heading: "bank", side: "debit", amount: max },
        { heading: "bank", side: "debit", amount: 2 },
        { heading: "unmatched", side: "credit", amount: max },
        { heading: "unmatched", side: "credit", amount: 1 },
      ],
    };
    expect(() => checkEntry(entry)).toThrow(/debits do not equal its credits/);
  });
});
