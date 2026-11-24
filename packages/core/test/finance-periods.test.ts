// Stage 52 step 1 (ADRs 0790, 0791 and 0794): the business's day, the months the business
// closes, closing and reopening them in order, versions, the triggers that keep a closed version
// as it was for every writer (raw SQL: UPDATE, DELETE, REPLACE, upsert and UPDATE OR REPLACE), the
// close's guard, book entries (balance, headings, keys, fingerprints), the finance permissions and
// what an AI may do. Every clock is injected.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { csvText } from "../src/csv.ts";
import { closePlan, MAX_CLOSE_LINES, type PeriodBook, readGuards } from "../src/finance/close.ts";
import {
  addMonths,
  dayRange,
  localDateAt,
  midnightOf,
  monthDates,
  monthRange,
} from "../src/finance/day.ts";
import { type BookEntry, checkEntry, lineFingerprint } from "../src/finance/entries.ts";
import {
  type ActingUser,
  type Actor,
  invokeByName,
  newId,
  toOperationError,
} from "../src/index.ts";
import { context, createUser, db } from "./helpers.ts";

const at = (iso: string) => () => new Date(iso);

async function call<T>(
  name: string,
  input: unknown,
  user: ActingUser,
  now: string,
  actor: Actor = "human",
): Promise<T> {
  const surface = actor === "assistant" ? "assistant" : actor === "mcp" ? "mcp" : "ui";
  return (await invokeByName(
    name,
    input,
    context(user, { actor, origin: { surface }, clock: at(now) }),
  )) as T;
}

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

describe("the business's day", () => {
  it("a payment at 00:30 local is on that local day, far from UTC", () => {
    // Auckland in April is UTC+12: 00:30 on 3 April is 12:30 on 2 April in UTC.
    const zone = "Pacific/Auckland";
    const paid = Date.parse("2026-04-02T12:30:00Z") / 1000;
    expect(localDateAt(paid, zone)).toBe("2026-04-03");
    const day = dayRange("2026-04-03", zone);
    expect(paid >= day.starts && paid < day.ends).toBe(true);
    // Kiritimati, UTC+14: the same instant is 02:30 on 3 April.
    expect(localDateAt(paid, "Pacific/Kiritimati")).toBe("2026-04-03");
    expect(localDateAt(paid, "UTC")).toBe("2026-04-02");
  });

  it("a day across a clock change is 23 or 25 hours, and a month's instants follow", () => {
    const zone = "Europe/London";
    const spring = dayRange("2026-03-29", zone);
    expect(spring.ends - spring.starts).toBe(23 * 3600);
    const autumn = dayRange("2026-10-25", zone);
    expect(autumn.ends - autumn.starts).toBe(25 * 3600);
    const march = monthRange("2026-03", zone);
    expect(march).toMatchObject({ start: "2026-03-01", end: "2026-03-31" });
    expect(march.ends - march.starts).toBe(31 * 86400 - 3600);
    const october = monthRange("2026-10", zone);
    expect(october.ends - october.starts).toBe(31 * 86400 + 3600);
    // Auckland's clocks go back on 5 April 2026 (a 25-hour day) and on in late September.
    const april = monthRange("2026-04", "Pacific/Auckland");
    expect(april.ends - april.starts).toBe(30 * 86400 + 3600);
    expect(midnightOf("2026-04-01", "Pacific/Auckland")).toBe(
      Date.parse("2026-03-31T11:00:00Z") / 1000,
    );
  });

  it("months add up across a year and know their last day", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-03", -14)).toBe("2025-01");
    expect(monthDates("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(monthDates("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });
});

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

describe("book entries", () => {
  it("balance to the minor unit, with known headings and a key that fits", () => {
    expect(checkEntry(day("2026-04-03", SALE)).lines).toHaveLength(3);
    const fails = (entry: BookEntry) => {
      try {
        checkEntry(entry);
      } catch (e) {
        return (e as { details?: { rule?: string } }).details?.rule;
      }
      return "passed";
    };
    // Off by one minor unit.
    expect(
      fails(day("2026-04-03", [...SALE.slice(0, 2), { ...SALE[2], amount: 999 } as never])),
    ).toBe("finance_entry");
    expect(
      fails(
        day("2026-04-03", [
          { heading: "revenue", side: "debit", amount: 1 },
          { heading: "bank", side: "credit", amount: 1 },
        ]),
      ),
    ).toBe("finance_entry");
    expect(
      fails(
        day("2026-04-03", [
          { heading: "bank", side: "debit", amount: 1.5 },
          { heading: "unmatched", side: "credit", amount: 1.5 },
        ]),
      ),
    ).toBe("finance_entry");
    expect(fails({ ...day("2026-04-03", SALE), key: "day:2026-04-04" })).toBe("finance_entry");
    expect(fails({ ...day("2026-04-03", SALE), belongsTo: "2026-03" })).toBe("finance_entry");
    expect(
      fails({
        key: "late:2026-03@2026-04-03",
        kind: "late",
        date: "2026-04-03",
        belongsTo: "2026-03",
        lines: SALE,
      }),
    ).toBe("passed");
    expect(
      fails({ key: "held:2026-04", kind: "held", date: "2026-04-30", belongsTo: null, lines: [] }),
    ).toBe("passed");
    // A line of nothing is dropped.
    expect(
      checkEntry(day("2026-04-03", [...SALE, { heading: "disputes", side: "debit", amount: 0 }]))
        .lines,
    ).toHaveLength(3);
  });

  it("have a fingerprint of their lines, whatever order they were made in", async () => {
    const a = await lineFingerprint(SALE);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await lineFingerprint([...SALE].reverse())).toBe(a);
    expect(
      await lineFingerprint([{ ...SALE[0], amount: 11_001 } as never, ...SALE.slice(1)]),
    ).not.toBe(a);
  });
});

describe("the CSV guard (shared csv.ts)", () => {
  it("quotes every text cell and neutralises formulas", () => {
    const cases: [string, string][] = [
      ["Ten class pass", '"Ten class pass"'],
      ["=HYPERLINK(1)", `"'=HYPERLINK(1)"`],
      ["+1", `"'+1"`],
      ["-1", `"'-1"`],
      ["@SUM(A1)", `"'@SUM(A1)"`],
      ["＝1+1", `"'＝1+1"`],
      ["\tx", `"'\tx"`],
      ["a;=1+1", `"'a;=1+1"`],
      ['say "hi"', '"say ""hi"""'],
    ];
    for (const [value, cell] of cases) expect(csvText(value), value).toBe(cell);
  });
});

// The organisation runs in Auckland; finance was installed in March 2026 (local).
const ZONE = "Pacific/Auckland";
const INSTALLED = "2026-03-10T00:00:00.000Z";

describe("closing and reopening months", () => {
  let admin: ActingUser;
  let member: ActingUser;
  let viewer: ActingUser;

  beforeAll(async () => {
    admin = await createUser("admin");
    member = await createUser("member");
    viewer = await createUser("viewer");
    await setSetting("org_timezone", ZONE);
    await setSetting("finance_installed_at", INSTALLED);
    await env.DB.prepare("DELETE FROM core_settings WHERE key = 'finance_settings'").run();
  });

  type Periods = {
    firstMonth: string;
    currentMonth: string;
    periods: {
      month: string;
      start: string;
      end: string;
      zone: string;
      state: string;
      ended: boolean;
      closable: boolean;
      versions: {
        version: number;
        state: string;
        closedByName: string | null;
        reopenedBy: string | null;
      }[];
    }[];
  };

  it("lists the current month and those before it back to the first, in the business's zone", async () => {
    const out = await call<Periods>("finance.periods", {}, admin, "2026-04-20T00:00:00.000Z");
    expect(out.firstMonth).toBe("2026-03");
    expect(out.currentMonth).toBe("2026-04");
    expect(out.periods.map((p) => [p.month, p.state, p.ended, p.closable])).toEqual([
      ["2026-04", "open", false, false],
      ["2026-03", "open", true, true],
    ]);
    expect(out.periods[1]).toMatchObject({ start: "2026-03-01", end: "2026-03-31", zone: ZONE });
    // 30 April 23:30 in UTC is already 1 May in Auckland: the month is May.
    const may = await call<Periods>("finance.periods", {}, admin, "2026-04-30T13:30:00.000Z");
    expect(may.currentMonth).toBe("2026-05");
  });

  it("closes in order, only once a month has ended, never before the first month", async () => {
    const now = "2026-05-02T00:00:00.000Z";
    expect(
      (await refusal(call("finance.close", { month: "2026-02" }, admin, now))).details?.rule,
    ).toBe("finance_before_start");
    expect(
      (await refusal(call("finance.close", { month: "2026-05" }, admin, now))).details?.rule,
    ).toBe("finance_period_open");
    // April has ended (1 May local), but March is still open.
    expect(
      (await refusal(call("finance.close", { month: "2026-04" }, admin, now))).details?.rule,
    ).toBe("finance_previous_open");
    // Ending at local midnight, not UTC: on 30 April at 12:30 UTC (1 May 00:30 local) April has
    // ended; at 11:30 UTC (23:30 local) it has not.
    const march = await call<{ version: number; entries: number }>(
      "finance.close",
      { month: "2026-03" },
      admin,
      now,
    );
    expect(march).toMatchObject({ month: "2026-03", version: 1, entries: 0 });
    expect(
      (
        await refusal(
          call("finance.close", { month: "2026-04" }, admin, "2026-04-30T11:30:00.000Z"),
        )
      ).details?.rule,
    ).toBe("finance_period_open");
    expect(
      (await refusal(call("finance.close", { month: "2026-03" }, admin, now))).details?.rule,
    ).toBe("finance_period_closed");
    await call("finance.close", { month: "2026-04" }, admin, "2026-04-30T12:30:00.000Z");
    const out = await call<Periods>("finance.periods", {}, admin, now);
    expect(out.periods.map((p) => [p.month, p.state, p.versions.length])).toEqual([
      ["2026-05", "open", 0],
      ["2026-04", "closed", 1],
      ["2026-03", "closed", 1],
    ]);
    expect(out.periods[2]?.versions[0]).toMatchObject({
      version: 1,
      state: "closed",
      closedByName: "admin user",
    });
  });

  it("reopens only while no later month is closed, with why kept and out of the audit log", async () => {
    const now = "2026-05-03T00:00:00.000Z";
    const later = await refusal(
      call("finance.reopen", { month: "2026-03", reason: "A refund" }, admin, now),
    );
    expect(later.details).toMatchObject({ rule: "finance_later_closed", month: "2026-04" });
    expect(
      (await refusal(call("finance.reopen", { month: "2026-05", reason: "x" }, admin, now))).details
        ?.rule,
    ).toBe("finance_period_not_closed");
    await call(
      "finance.reopen",
      { month: "2026-04", reason: "Payout read late for member 7" },
      admin,
      now,
    );
    await call("finance.reopen", { month: "2026-03", reason: "Recheck" }, admin, now);
    const row = await env.DB.prepare(
      "SELECT reopen_reason FROM core_finance_period WHERE month = '2026-04' AND version = 1",
    ).first<{ reopen_reason: string }>();
    expect(row?.reopen_reason).toBe("Payout read late for member 7");
    const audit = await env.DB.prepare(
      "SELECT input, result FROM core_audit WHERE operation = 'finance.reopen' AND user_id = ?",
    )
      .bind(admin.id)
      .all<{ input: string; result: string }>();
    expect(audit.results.length).toBeGreaterThanOrEqual(2);
    for (const r of audit.results) expect(`${r.input}${r.result}`).not.toContain("member 7");
    // Closing again: April waits for March; March becomes version 2, then April.
    expect(
      (await refusal(call("finance.close", { month: "2026-04" }, admin, now))).details?.rule,
    ).toBe("finance_previous_open");
    expect(await call("finance.close", { month: "2026-03" }, admin, now)).toMatchObject({
      version: 2,
    });
    expect(await call("finance.close", { month: "2026-04" }, admin, now)).toMatchObject({
      version: 2,
    });
    const out = await call<Periods>("finance.periods", {}, admin, now);
    expect(
      out.periods.find((p) => p.month === "2026-03")?.versions.map((v) => [v.version, v.state]),
    ).toEqual([
      [1, "reopened"],
      [2, "closed"],
    ]);
  });

  it("a closed month keeps its zone after the organisation's changes; the next open month follows on", async () => {
    await setSetting("org_timezone", "Europe/London");
    try {
      const out = await call<Periods>("finance.periods", {}, admin, "2026-06-10T00:00:00.000Z");
      const april = out.periods.find((p) => p.month === "2026-04");
      const may = out.periods.find((p) => p.month === "2026-05");
      expect(april?.zone).toBe(ZONE);
      expect(may?.zone).toBe("Europe/London");
      const rows = await env.DB.prepare(
        "SELECT ends FROM core_finance_period WHERE month = '2026-04' AND state = 'closed'",
      ).first<{ ends: number }>();
      // May starts at the very instant April (closed in Auckland) ends, not at London's midnight.
      await call("finance.close", { month: "2026-05" }, admin, "2026-06-10T00:00:00.000Z");
      const stored = await env.DB.prepare(
        "SELECT zone, starts, ends FROM core_finance_period WHERE month = '2026-05' AND state = 'closed'",
      ).first<{ zone: string; starts: number; ends: number }>();
      expect(stored?.zone).toBe("Europe/London");
      expect(stored?.starts).toBe(rows?.ends);
      expect(stored?.ends).toBe(Date.parse("2026-05-31T23:00:00Z") / 1000);
    } finally {
      await setSetting("org_timezone", ZONE);
    }
  });

  it("is finance:read to read and finance:close to close, admins by default, grantable one by one", async () => {
    const now = "2026-07-02T00:00:00.000Z";
    for (const who of [member, viewer]) {
      for (const [name, input] of [
        ["finance.periods", {}],
        ["finance.settings.get", {}],
        ["finance.close", { month: "2026-06" }],
        ["finance.reopen", { month: "2026-05", reason: "x" }],
        ["finance.settings.update", { yearStartMonth: 7 }],
      ] as const) {
        expect((await refusal(call(name, input, who, now))).code, `${who.role} ${name}`).toBe(
          "forbidden",
        );
      }
    }
    await call("user.setPermissions", { id: member.id, permissions: ["finance:read"] }, admin, now);
    expect(
      (await call<Periods>("finance.periods", {}, member, now)).periods.length,
    ).toBeGreaterThan(0);
    await call("finance.settings.get", {}, member, now);
    expect((await refusal(call("finance.close", { month: "2026-06" }, member, now))).code).toBe(
      "forbidden",
    );
    await call(
      "user.setPermissions",
      { id: member.id, permissions: ["finance:read", "finance:close"] },
      admin,
      now,
    );
    expect(await call("finance.close", { month: "2026-06" }, member, now)).toMatchObject({
      version: 1,
    });
    // The settings stay a human admin's (settings:manage), whatever is granted.
    expect(
      (await refusal(call("finance.settings.update", { yearStartMonth: 7 }, member, now))).code,
    ).toBe("forbidden");
  });

  it("an assistant or MCP client reads months for an account that may, and never closes, reopens or changes settings", async () => {
    const now = "2026-08-02T00:00:00.000Z";
    for (const actor of ["assistant", "mcp"] as const) {
      expect(
        (await call<Periods>("finance.periods", {}, admin, now, actor)).periods.length,
      ).toBeGreaterThan(0);
      for (const [name, input] of [
        ["finance.close", { month: "2026-07" }],
        ["finance.reopen", { month: "2026-06", reason: "x" }],
        ["finance.settings.update", { yearStartMonth: 7 }],
      ] as const) {
        expect((await refusal(call(name, input, admin, now, actor))).code, `${actor} ${name}`).toBe(
          "forbidden",
        );
      }
    }
    // Still open: nothing an AI asked for happened.
    const july = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_finance_period WHERE month = '2026-07'",
    ).first();
    expect(july).toEqual({ n: 0 });
  });

  it("settings: the year's first month, an earlier first month only before anything is closed, category labels", async () => {
    const now = "2026-08-02T00:00:00.000Z";
    const out = await call<{ yearStartMonth: number; categoryLabels: Record<string, string> }>(
      "finance.settings.update",
      { yearStartMonth: 7, categoryLabels: { memberships: "Memberships", passes: "Class passes" } },
      admin,
      now,
    );
    expect(out).toMatchObject({
      yearStartMonth: 7,
      categoryLabels: { memberships: "Memberships", passes: "Class passes" },
    });
    const removed = await call<{ categoryLabels: Record<string, string> }>(
      "finance.settings.update",
      { categoryLabels: { passes: "" } },
      admin,
      now,
    );
    expect(removed.categoryLabels).toEqual({ memberships: "Memberships" });
    expect(
      (await refusal(call("finance.settings.update", { firstPeriod: "2026-01" }, admin, now)))
        .details?.rule,
    ).toBe("finance_started");
    expect(
      (await call<{ firstMonth: string }>("finance.settings.get", {}, admin, now)).firstMonth,
    ).toBe("2026-03");
  });
});

describe("a closed version never changes", () => {
  // Months before finance's first month here, closed straight through the close's own batch.
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
        month: "2024-03",
        range: monthRange("2024-03", ZONE),
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
        "SELECT count(*) AS n FROM core_finance_period WHERE month = '2024-03'",
      ).first(),
    ).toEqual({ n: 0 });
    // Read again, it closes.
    const again = await closePlan(
      { db: db.query, now: "2026-11-24T00:00:00.000Z" },
      {
        id,
        month: "2024-03",
        range: monthRange("2024-03", ZONE),
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
