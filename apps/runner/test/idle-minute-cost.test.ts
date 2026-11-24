// What an idle host costs a minute (docs/cloudflare-costs.md): cos-runner's `* * * * *` tick on a
// host with the shipped packs and nothing to do. It writes nothing (no audit row, no heartbeat,
// no state saved unchanged): a step that has work reads whether it has, outside the pipeline,
// before it calls its operation (ADR 0130, amended 2026-11-24). Off the hour no statement reads a
// table whole, and with 500 checklist day runs on file each statement still reads a few rows. In
// an hour's first minute two reads no index holds run as well (the subscription sweep's events
// not arriving, and a visitor's unconfirmed acceptances); they are listed in the doc's "left".
import { env } from "cloudflare:workers";
import { installShippedExtensions } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { minuteTick } from "../src/index.ts";
import { runOrdersTick } from "../src/integrations/payments.ts";
import { db, host } from "./helpers.ts";
import { fullScans, meterStatements } from "./statement-meter.ts";

/** The schema registry's stamp (refreshSchemaRegistry): counts over the extension schema tables. */
const STAMP = /FROM core_extension_fields\)/;
/**
 * Tables a quiet minute may read whole: the stamp's (a row per field, object and edited option,
 * not per record), and the company's agreement documents (a handful, never one per person).
 */
const SMALL_TABLES = [
  "core_extension_fields",
  "core_extension_objects",
  "core_field_options",
  "core_agreement_document",
];
/** What one statement of a quiet minute reads at most (the stamp aside): a few index rows. */
const ROWS_PER_STATEMENT = 10;

const meter = meterStatements(env.DB);
const metered = { ...env, DB: meter.db } as typeof env;

/** Day checklist runs still open and closing a week on: on file, not due. */
async function seedChecklistRuns(n: number, closes: number): Promise<void> {
  const insert = env.DB.prepare(
    `INSERT INTO core_checklist_run (id, object_type, record_id, checklist_id, version, name, steps,
       opens, closes, state, made_at, doers_kind)
     VALUES (?, 'checklist.day', ?, 'chk_idle_cost', 1, 'Opening', '[{"text":"Lights","required":true}]',
       ?, ?, 'open', '2026-11-24T00:00:00.000Z', 'staff')`,
  );
  for (let at = 0; at < n; at += 100) {
    await env.DB.batch(
      Array.from({ length: Math.min(100, n - at) }, (_, i) =>
        insert.bind(`ckr_idle_cost_${at + i}`, `day_idle_cost_${at + i}`, closes - 3600, closes),
      ),
    );
  }
}

describe("an idle minute", () => {
  // From five past the hour: the hourly date-relative scan (ADR 0460) has marked its hour by then.
  const start = Date.parse("2026-11-24T10:05:00.000Z");
  beforeAll(async () => {
    await installShippedExtensions({ db, host });
    await seedChecklistRuns(500, Math.floor(start / 1000) + 7 * 86_400);
    // The first ticks of a new host do one-off work (the duplicate scan's backfill and its first
    // nightly pass): past them, a minute with nothing to do is what every later minute costs.
    for (let i = 0; i < 4; i++) await minuteTick(metered, new Date(start + i * 60_000));
  });

  it("writes nothing and reads a few rows through indexes", async () => {
    meter.reset();
    const result = await minuteTick(metered, new Date(start + 10 * 60_000));
    expect(result.paused).toBe(false);

    const writes = meter.statements.filter((s) => !/^\s*(SELECT|WITH)/i.test(s.sql));
    expect(writes.map((s) => s.sql.slice(0, 80))).toEqual([]);
    expect(meter.rowsWritten).toBe(0);

    // 41 statements and 82 rows on 2026-11-24, from about 20 steps of one to three indexed
    // reads each. The bounds leave room for a new step's few reads; a step that reads a table
    // whole fails the plan check below, whatever the counts. The rows read leave the stamp out
    // (it reads a row per extension field), and bound how often it runs instead.
    expect(meter.statements.length).toBeLessThanOrEqual(60);
    const stamps = meter.statements.filter((s) => STAMP.test(s.sql));
    expect(stamps.length).toBeLessThanOrEqual(2);
    const ownRows = meter.statements
      .filter((s) => !STAMP.test(s.sql))
      .reduce((n, s) => n + s.rowsRead, 0);
    expect(ownRows).toBeLessThanOrEqual(120);

    expect(await fullScans(meter.statements, SMALL_TABLES)).toEqual([]);
    // Rows on file that are not due cost nothing: no statement reads the 500 day runs.
    const heavy = meter.statements
      .filter((s) => !STAMP.test(s.sql) && s.rowsRead > ROWS_PER_STATEMENT)
      .map((s) => `${s.rowsRead} ${s.sql.replace(/\s+/g, " ").slice(0, 100)}`);
    expect(heavy).toEqual([]);
  });

  it("an hour's first minute writes nothing; its whole-table reads are the hourly two", async () => {
    meter.reset();
    await minuteTick(metered, new Date(Date.parse("2026-11-24T12:00:00.000Z")));
    expect(meter.rowsWritten).toBe(0);
    const scans = await fullScans(meter.statements, SMALL_TABLES);
    expect(scans.every((s) => /^SCAN core_subscription /.test(s))).toBe(true);
  });

  it("a day of idle minutes is under 90,000 statements and writes no row", async () => {
    meter.reset();
    for (let i = 0; i < 5; i++) await minuteTick(metered, new Date(start + (15 + i) * 60_000));
    expect(meter.rowsWritten).toBe(0);
    expect((meter.statements.length / 5) * 1440).toBeLessThan(90_000);
  });

  it("a step with work still runs it: an order past its time is expired, and audited", async () => {
    const at = new Date(start + 30 * 60_000);
    const past = new Date(at.getTime() - 60_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO core_order (id, email, currency, total, state, expires_at, placed_as, created_at, updated_at) VALUES ('ord_idle_cost_due', 'buyer@example.com', 'AUD', 100, 'pending', ?, 'public', ?, ?)",
    )
      .bind(past, past, past)
      .run();
    const result = await runOrdersTick(env, at);
    expect(result.expired).toBe(1);
    const order = await env.DB.prepare(
      "SELECT state FROM core_order WHERE id = 'ord_idle_cost_due'",
    ).first<{ state: string }>();
    expect(order?.state).toBe("expired");
    const audit = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit WHERE operation = 'order.expireDue' AND at = ?",
    )
      .bind(at.toISOString())
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("the subscription sweep's unindexed reads run in an hour's first minute only", async () => {
    const minute = await runOrdersTick(env, new Date(start + 40 * 60_000));
    expect(minute.subscriptions).toEqual({ pastDueLapsed: 0, eventsMissing: 0, offerPlansGone: 0 });
    meter.reset();
    await runOrdersTick(metered, new Date(start + 41 * 60_000));
    expect(meter.statements.some((s) => /current_period_end/.test(s.sql))).toBe(false);
    meter.reset();
    await runOrdersTick(metered, new Date(Date.parse("2026-11-24T13:00:00.000Z")));
    expect(meter.statements.some((s) => /current_period_end/.test(s.sql))).toBe(true);
  });
});
