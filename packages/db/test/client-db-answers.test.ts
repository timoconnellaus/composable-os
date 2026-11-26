// A query set is never committed unless its answer can be returned, and a caller whose answer was
// lost can ask whether it committed (stage 66 step 2, ADR 0614; the review of step 1, B1, S1, M1,
// M2, M4 and S6).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type ClientDb,
  type ClientDbAnswer,
  type ClientDbError,
  type ClientDbTransport,
  clientDatabase,
  clientDbCalls,
  databaseOver,
  MAX_HELD_BYTES,
  PART_BYTES,
} from "../src/client-db.ts";

const bindings = env as unknown as { DB: D1Database; CLIENT_DB: DurableObjectNamespace<ClientDb> };
const stubOf = (name: string) => bindings.CLIENT_DB.get(bindings.CLIENT_DB.idFromName(name));

/** A transport straight to the object, which tests can make lose answers. */
function transportOf(
  name: string,
): ClientDbTransport & { stub: () => DurableObjectStub<ClientDb> } {
  const stub = () => stubOf(name);
  return {
    stub,
    query: (queries, id) => stub().query(queries, id) as Promise<ClientDbAnswer>,
    stage: (batch, index, queries) => stub().stage(batch, index, queries) as never,
    commit: (batch, parts, queries) => stub().commit(batch, parts, queries) as never,
    take: (id, part) => stub().take(id, part) as never,
    outcome: (id) => stub().outcome(id) as never,
  };
}

const MB_OF_ZEROS = "hex(zeroblob(500000))"; // a text of 1,000,000 characters

describe("a query set's answer", () => {
  it("returns every result of a batch whose answer is larger than one call (B1)", async () => {
    const db = clientDatabase(bindings.CLIENT_DB, "b1-large-answer");
    await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)").run();
    const statements = Array.from({ length: 200_000 }, (_, i) =>
      db.prepare("INSERT INTO t VALUES (?, ?)").bind(i + 1, i),
    );
    const results = await db.batch(statements);
    expect(results).toHaveLength(200_000);
    expect(results.at(-1)?.meta.last_row_id).toBe(200_000);
    expect(results.every((r) => r.meta.changes === 1)).toBe(true);
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(200_000);
  }, 120_000);

  it("rolls a set back when its answer is too large to hold, with a clear error (B1)", async () => {
    const db = clientDatabase(bindings.CLIENT_DB, "b1-too-large");
    await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").run();
    const insert = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
      INSERT INTO t SELECT i, ${MB_OF_ZEROS} FROM n RETURNING v`;
    await expect(db.prepare(insert).all()).rejects.toThrow(
      /D1_ERROR: the result is about \d+ MiB, more than the 48 MiB .* Nothing was applied/,
    );
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(0);
  }, 60_000);

  it("reads a result larger than one call as D1 does (S1)", async () => {
    const db = clientDatabase(bindings.CLIENT_DB, "s1-large-read");
    for (const target of [db, bindings.DB]) {
      await target.prepare("CREATE TABLE s1 (id INTEGER PRIMARY KEY, v TEXT)").run();
      await target
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
           INSERT INTO s1 SELECT i, ${MB_OF_ZEROS} FROM n`,
        )
        .run();
    }
    const calls = clientDbCalls(db) ?? 0;
    const [mine, d1] = await Promise.all([
      db.prepare("SELECT * FROM s1 ORDER BY id").all<{ id: number; v: string }>(),
      bindings.DB.prepare("SELECT * FROM s1 ORDER BY id").all<{ id: number; v: string }>(),
    ]);
    expect(mine.results).toHaveLength(40);
    expect(mine.results.map((r) => [r.id, r.v.length])).toEqual(
      d1.results.map((r) => [r.id, r.v.length]),
    );
    expect(mine.results.every((r, i) => r.v === d1.results[i]?.v)).toBe(true);
    // 40 MB in parts of 8 MiB: the query and four more calls (S6: each is a subrequest).
    expect((clientDbCalls(db) ?? 0) - calls).toBe(Math.ceil(40_000_000 / PART_BYTES));
    expect(clientDbCalls(bindings.DB)).toBeNull();
  }, 60_000);

  it("answers again a committed set whose answer was lost, while it is held", async () => {
    const transport = transportOf("lost-answer-held");
    const db = databaseOver(transport);
    await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").run();
    let lose = true;
    const losing: ClientDbTransport = {
      ...transport,
      async take(id, part) {
        if (lose) {
          lose = false;
          throw new Error("Network connection lost.");
        }
        return transport.take?.(id, part) as never;
      },
    };
    const results = await databaseOver(losing)
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12)
         INSERT INTO t SELECT i, ${MB_OF_ZEROS} FROM n RETURNING id, v`,
      )
      .all<{ id: number }>();
    expect(lose).toBe(false);
    expect(results.results.map((r) => r.id)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(12);
  }, 60_000);

  it("says a set committed when its answer is gone, so it is not sent again", async () => {
    const transport = transportOf("lost-answer-gone");
    const db = databaseOver(transport);
    await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").run();
    const restarting: ClientDbTransport = {
      ...transport,
      async take(id, part) {
        // The object restarts between the commit and the caller's fetch of the rest.
        await transport
          .stub()
          .restart()
          .catch(() => {});
        return transport.take?.(id, part) as never;
      },
    };
    const error = (await databaseOver(restarting)
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12)
         INSERT INTO t SELECT i, ${MB_OF_ZEROS} FROM n RETURNING id, v`,
      )
      .all()
      .catch((e) => e)) as ClientDbError;
    expect(error.message).toMatch(/^D1_ERROR: the batch committed, but its answer was lost/);
    expect(error.committed).toBe(true);
    expect(error.retryable).toBe(false);
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(12);
  }, 60_000);

  it("records whether a set with an id committed, and never runs it twice", async () => {
    const stub = stubOf("outcomes");
    await stub.query([{ sql: "CREATE TABLE t (v)", params: [] }]);
    const insert = [{ sql: "INSERT INTO t VALUES (1)", params: [] }];
    expect((await stub.query(insert, "once")).ok).toBe(true);
    expect(await stub.outcome("once")).toEqual({ committed: true, held: null });
    const again = await stub.query(insert, "once");
    expect(again).toEqual({
      ok: false,
      error: "this batch was already committed; it was not applied again",
    });
    // Asked about before it arrived: fenced, then refused when it comes.
    expect(await stub.outcome("late")).toEqual({ committed: false, held: null });
    expect((await stub.query(insert, "late")).ok).toBe(false);
    // A read is not recorded.
    await stub.query([{ sql: "SELECT * FROM t", params: [] }], "read");
    expect((await stub.outcome("read")).committed).toBe(false);
    const count = await stub.query([{ sql: "SELECT count(*) FROM t", params: [] }]);
    expect(count.ok && count.pieces[0]?.[3]).toEqual([[1]]);
  });
});

describe("a batch sent in parts", () => {
  it("refuses a repeated part even when the count of parts is right (M1)", async () => {
    const stub = stubOf("m1-repeated");
    await stub.query([{ sql: "CREATE TABLE t (v)", params: [] }]);
    const part = (v: number) => [{ sql: `INSERT INTO t VALUES (${v})`, params: [] }];
    await stub.stage("b", 0, part(1));
    expect(await stub.stage("b", 0, part(1))).toEqual({
      ok: false,
      error: "part 0 of a batch sent in parts arrived twice",
    });
    expect((await stub.commit("b", 2, part(3))).ok).toBe(false);
    // Part 1 only, where parts 0 and 1 were due.
    await stub.stage("c", 1, part(2));
    await stub.stage("c", 2, part(2));
    expect((await stub.commit("c", 2, part(3))).ok).toBe(false);
    const count = await stub.query([{ sql: "SELECT count(*) FROM t", params: [] }]);
    expect(count.ok && count.pieces[0]?.[3]).toEqual([[0]]);
  });

  it("applies the parts in their order, whatever order they arrived in", async () => {
    const stub = stubOf("ordered-parts");
    await stub.query([
      { sql: "CREATE TABLE t (n INTEGER PRIMARY KEY AUTOINCREMENT, v)", params: [] },
    ]);
    const part = (v: number) => [{ sql: `INSERT INTO t (v) VALUES (${v})`, params: [] }];
    await stub.stage("b", 1, part(1));
    await stub.stage("b", 0, part(0));
    expect((await stub.commit("b", 2, part(2))).ok).toBe(true);
    const rows = await stub.query([{ sql: "SELECT v FROM t ORDER BY n", params: [] }]);
    expect(rows.ok && rows.pieces[0]?.[3]).toEqual([[0], [1], [2]]);
  });

  it("bounds what the object holds for callers (M2)", async () => {
    const stub = stubOf("m2-bound");
    const big = "x".repeat(PART_BYTES - 1024);
    const part = [{ sql: "SELECT ?", params: [big] }];
    let refused: unknown = null;
    for (let index = 0; index * PART_BYTES <= MAX_HELD_BYTES; index += 1) {
      const staged = await stub.stage("b", index, part);
      if (!staged.ok) {
        refused = staged.error;
        break;
      }
    }
    expect(refused).toMatch(/holding as much as it may for other callers/);
    // The refused batch was dropped whole: a new one fits.
    expect((await stub.stage("next", 0, part)).ok).toBe(true);
  }, 60_000);

  it("loses its parts when the object restarts, and the commit applies nothing", async () => {
    const stub = stubOf("restart-parts");
    await stub.query([{ sql: "CREATE TABLE t (v)", params: [] }]);
    const before = await stub.session();
    await stub.stage("b", 0, [{ sql: "INSERT INTO t VALUES (1)", params: [] }]);
    await stub.restart().catch(() => {});
    const after = await stubOf("restart-parts").session();
    expect(after.id).not.toBe(before.id);
    const commit = await stubOf("restart-parts").commit("b", 1, [
      { sql: "INSERT INTO t VALUES (2)", params: [] },
    ]);
    expect(commit.ok).toBe(false);
  });
});

describe("errors", () => {
  it("carry the runtime's retryable and overloaded flags (M4)", async () => {
    const failing: ClientDbTransport = {
      async query() {
        throw Object.assign(new Error("Durable Object is overloaded."), {
          retryable: true,
          overloaded: true,
        });
      },
    };
    const error = (await databaseOver(failing)
      .prepare("SELECT 1")
      .all()
      .catch((e) => e)) as ClientDbError;
    expect(error.message).toBe("D1_ERROR: Durable Object is overloaded.");
    expect(error.retryable).toBe(true);
    expect(error.overloaded).toBe(true);
  });

  it("refuse dump and query() clearly", async () => {
    const db = clientDatabase(bindings.CLIENT_DB, "refusals");
    await expect(db.dump()).rejects.toThrow(/D1_DUMP_ERROR: .*export it as SQL/);
    await expect((db as unknown as { query(): Promise<unknown> }).query()).rejects.toThrow(
      /d1_binding_jsrpc/,
    );
    expect(db.withSession().getBookmark()).toBeNull();
  });
});
