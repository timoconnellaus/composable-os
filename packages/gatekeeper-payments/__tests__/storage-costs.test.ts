// What one verified delivery costs PaymentsEvents' SQLite (docs/cloudflare-costs.md): the dedupe
// and recent-event caps are kept without reading the tables they trim. The local runtime does not
// bill, so the counts come from each statement's cursor.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PaymentsEvent } from "../src/types.js";

/** Counts what the object's SQLite does while `run` runs: statements and rows read. */
async function metered<T>(
  sql: SqlStorage,
  run: () => Promise<T>,
): Promise<{ result: T; statements: number; rowsRead: number }> {
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const exec = sql.exec;
  sql.exec = ((query: string, ...bindings: unknown[]) => {
    const cursor = exec.call(sql, query, ...bindings);
    cursors.push(cursor);
    return cursor;
  }) as typeof sql.exec;
  try {
    const result = await run();
    return {
      result,
      statements: cursors.length,
      rowsRead: cursors.reduce((sum, c) => sum + c.rowsRead, 0),
    };
  } finally {
    sql.exec = exec;
  }
}

const DAY = 86_400_000;

describe("a delivery's storage cost", () => {
  it("keeps 10,000 seen ids and 100 events without reading either table whole", async () => {
    const stub = env.PAYMENTS_EVENTS.get(env.PAYMENTS_EVENTS.idFromName(`costs-${Date.now()}`));
    const cost = await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      const now = Date.now();
      // Five ids older than the 30 days kept, then a full 10,000, then 100 recent events.
      state.storage.transactionSync(() => {
        for (let i = 0; i < 5; i++) {
          sql.exec("INSERT INTO seen (id, at) VALUES (?, ?)", `evt_old_${i}`, now - 31 * DAY);
        }
        for (let i = 0; i < 10_000; i++) {
          sql.exec("INSERT INTO seen (id, at) VALUES (?, ?)", `evt_${i}`, now - DAY + i);
        }
        for (let i = 0; i < 100; i++) {
          sql.exec("INSERT INTO events (id, event) VALUES (?, '{}')", `evt_${9_900 + i}`);
        }
      });
      const event = { kind: "payment", eventId: "evt_new" } as unknown as PaymentsEvent;
      const measured = await metered(sql, () => instance.receive("evt_new", [event]));
      const count = (table: string) =>
        sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n;
      const has = (table: string, id: string) =>
        sql.exec(`SELECT 1 FROM ${table} WHERE id = ?`, id).toArray().length > 0;
      return {
        ...measured,
        seen: count("seen"),
        events: count("events"),
        oldGone: !has("seen", "evt_old_0"),
        oldestFreshGone: !has("seen", "evt_0"),
        newKept: has("seen", "evt_new") && has("events", "evt_new"),
        oldestEventGone: !has("events", "evt_9900"),
      };
    });
    expect(cost.result).toEqual({ duplicate: false });
    // The caps hold: the expired ids and the oldest beyond 10,000 are gone, the newest kept.
    expect(cost).toMatchObject({
      seen: 10_000,
      events: 100,
      oldGone: true,
      oldestFreshGone: true,
      newKept: true,
      oldestEventGone: true,
    });
    // Rows read are the rows removed and a few lookups: not the 10,000 seen ids and the events
    // twice over (10,234 rows read before, docs/cloudflare-costs.md).
    expect(cost.rowsRead).toBeLessThan(50);
    expect(cost.statements).toBeLessThanOrEqual(6);
  });
});
