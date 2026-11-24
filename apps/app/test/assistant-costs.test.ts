// What the assistant's Durable Objects cost per unit of use (docs/cloudflare-costs.md), in workerd
// against the real objects' SQLite: rows read and statements per read of a long thread. The local
// runtime does not bill, so the counts come from each statement's cursor.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Principal } from "@composable-os/auth";
import { resolveActingUser } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { describe, expect, it } from "vitest";
import { type AssistantHttpEnv, threadStub } from "../src/server/assistant/http.ts";

const appEnv = env as unknown as AssistantHttpEnv;
const db = createCrmDb(env.DB);

let n = 0;
async function member() {
  n += 1;
  const principal: Principal = {
    userId: `auth-costs-${Date.now()}-${n}`,
    email: `costs-${Date.now()}-${n}@example.com`,
    name: `Costs tester ${n}`,
    roles: [],
  };
  return resolveActingUser(db, principal);
}

/** Counts what the object's SQLite does while `run` runs: statements and rows read and written. */
async function metered<T>(
  sql: SqlStorage,
  run: () => Promise<T>,
): Promise<{ result: T; statements: number; rowsRead: number; rowsWritten: number }> {
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
      rowsWritten: cursors.reduce((sum, c) => sum + c.rowsWritten, 0),
    };
  } finally {
    sql.exec = exec;
  }
}

describe("the assistant thread's storage costs", () => {
  it("reads a window of a long thread without reading every turn it ever had", async () => {
    const user = await member();
    const stub = await threadStub(
      appEnv.ASSISTANT as NonNullable<AssistantHttpEnv["ASSISTANT"]>,
      user.id,
    );
    const TURNS = 1_500;
    const cost = await runInDurableObject(stub, async (agent, state) => {
      // The tables, and the owner, as the first read makes them.
      await agent.threadState(user.id);
      const sql = state.storage.sql;
      // A year of use: a question and an answer a turn, the odd failed turn among the oldest.
      state.storage.transactionSync(() => {
        for (let turn = 1; turn <= TURNS; turn++) {
          const at = new Date(Date.UTC(2026, 0, 1) + turn * 60_000).toISOString();
          const failed = turn % 100 === 0 && turn < TURNS / 2;
          sql.exec(
            "INSERT INTO thread_messages (turn, role, via, parts, created_at) VALUES (?, 'user', 'text', ?, ?)",
            turn,
            JSON.stringify([{ type: "text", text: `Question ${turn}` }]),
            at,
          );
          if (!failed) {
            sql.exec(
              "INSERT INTO thread_messages (turn, role, via, parts, created_at) VALUES (?, 'assistant', 'text', ?, ?)",
              turn,
              JSON.stringify([{ type: "text", text: `Answer ${turn}` }]),
              at,
            );
          }
          sql.exec(
            "INSERT INTO thread_turns (turn, status, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?)",
            turn,
            failed ? "error" : "done",
            failed ? "The model failed" : null,
            at,
            at,
          );
        }
        const last = sql.exec<{ seq: number }>("SELECT MAX(seq) AS seq FROM thread_messages").one();
        sql.exec(
          "INSERT INTO thread_meta (key, value) VALUES ('last_seen_seq', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          String(last.seq),
        );
      });
      return metered(sql, () => agent.threadState(user.id));
    });
    // The newest 200 messages are 100 turns, and none of the failed turns is among them.
    expect(cost.result.items.filter((i) => i.kind === "error")).toEqual([]);
    expect(cost.result.hasEarlier).toBe(true);
    // The window (its 200 rows are counted twice, by the inner and the outer select), its 100
    // turns, a few keys and maxima: 508 rows. Not the 1,500 turns of the thread as well (1,908
    // before, docs/cloudflare-costs.md).
    expect(cost.rowsRead).toBeLessThan(600);
    expect(cost.statements).toBeLessThanOrEqual(12);
    expect(cost.rowsWritten).toBe(0);
  });
});
