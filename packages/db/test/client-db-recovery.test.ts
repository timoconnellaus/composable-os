// The review of #511 (stage 66 step 2, ADR 0614): a set that changes only the schema is recorded
// as committed (S1); an outcome that cannot be learned is never retryable (S2); a read too large
// is refused while it is read, and the object goes on answering (S7); a dead caller's held answer
// does not block a live one for long (M1); `exec` keeps the flags (M2); every argument is checked
// (M4).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type ClientDb,
  type ClientDbAnswer,
  type ClientDbError,
  type ClientDbTransport,
  databaseOver,
  HELD_IDLE_MS,
} from "../src/client-db.ts";

const bindings = env as unknown as { CLIENT_DB: DurableObjectNamespace<ClientDb> };
const stubOf = (name: string) => bindings.CLIENT_DB.get(bindings.CLIENT_DB.idFromName(name));

/** Straight to the object; `lose` makes a call commit and then lose its answer. */
function losing(name: string, options: { outcomeFails?: boolean } = {}) {
  const stub = () => stubOf(name);
  const state = { lose: false };
  const transport: ClientDbTransport = {
    async query(queries, id) {
      const answer = (await stub().query(queries, id)) as ClientDbAnswer;
      if (state.lose) {
        state.lose = false;
        throw Object.assign(new Error("Network connection lost."), { retryable: true });
      }
      return answer;
    },
    take: (id, part) => stub().take(id, part) as never,
    async outcome(id) {
      if (options.outcomeFails)
        throw new Error("Durable Object reset because its code was updated.");
      return stub().outcome(id) as never;
    },
  };
  return { db: databaseOver(transport), state };
}

const MB_OF_ZEROS = "hex(zeroblob(500000))";

describe("a set that changes only the schema (S1)", () => {
  it("is recorded, so a lost answer is reported as committed", async () => {
    const { db, state } = losing("s1-ddl");
    await db.prepare("CREATE TABLE base (id INTEGER PRIMARY KEY, v TEXT)").run();
    const ddl = [
      "CREATE TABLE made (v)",
      "CREATE INDEX base_v ON base (v)",
      "CREATE TRIGGER base_t AFTER INSERT ON base BEGIN SELECT 1; END",
      "ALTER TABLE base ADD COLUMN extra TEXT",
      "DROP TABLE made",
    ];
    for (const sql of ddl) {
      state.lose = true;
      const error = (await db
        .prepare(sql)
        .run()
        .catch((e) => e)) as ClientDbError;
      expect(error.message, sql).toMatch(/^D1_ERROR: the batch committed, but its answer was lost/);
      expect(error.committed, sql).toBe(true);
      expect(error.retryable, sql).toBe(false);
    }
    const { results } = await db
      .prepare("SELECT type, name FROM sqlite_master WHERE name IN ('made', 'base_v', 'base_t')")
      .all();
    expect(results).toEqual([
      { type: "index", name: "base_v" },
      { type: "trigger", name: "base_t" },
    ]);
  });
});

describe("an outcome that cannot be learned (S2)", () => {
  it("is never retryable for a set that may have written", async () => {
    const { db, state } = losing("s2-unknown", { outcomeFails: true });
    await db.prepare("CREATE TABLE t (v)").run();
    state.lose = true;
    const error = (await db
      .prepare("INSERT INTO t VALUES (1)")
      .run()
      .catch((e) => e)) as ClientDbError;
    expect(error.message).toBe("D1_ERROR: Network connection lost.");
    expect(error.committed).toBe("unknown");
    expect(error.retryable).toBe(false);
    // It had committed: a blind retry would have written it twice.
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(1);
  });

  it("keeps the runtime's flags for a read, which wrote nothing", async () => {
    const { db, state } = losing("s2-read", { outcomeFails: true });
    state.lose = true;
    const error = (await db
      .prepare("SELECT 1")
      .all()
      .catch((e) => e)) as ClientDbError;
    expect(error.retryable).toBe(true);
    expect(error.committed).toBeUndefined();
  });

  it("is carried by exec too (M2)", async () => {
    const { db, state } = losing("m2-exec", { outcomeFails: true });
    await db.prepare("CREATE TABLE t (v)").run();
    state.lose = true;
    const error = (await db.exec("INSERT INTO t VALUES (1)").catch((e) => e)) as ClientDbError;
    expect(error.message).toMatch(/^D1_EXEC_ERROR: /);
    expect(error.committed).toBe("unknown");
    expect(error.retryable).toBe(false);
  });
});

describe("a read too large (S7)", () => {
  it("is refused while it is read, and the object goes on answering", async () => {
    const stub = stubOf("s7-large");
    await stub.query([{ sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)", params: [] }]);
    await stub.query([
      {
        sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
              INSERT INTO t SELECT i, ${MB_OF_ZEROS} FROM n`,
        params: [],
      },
    ]);
    const session = await stub.session();
    const answer = await stub.query([{ sql: "SELECT * FROM t", params: [] }]);
    expect(answer).toEqual({
      ok: false,
      error:
        "the result is more than 48 MiB, the most a client's database returns for one query set; read it in pages. Nothing was applied",
    });
    expect(await stubOf("s7-large").session()).toEqual(session);
    const count = await stub.query([{ sql: "SELECT count(*) FROM t", params: [] }]);
    expect(count.ok && count.pieces[0]?.[3]).toEqual([[60]]);
  }, 60_000);
});

describe("held answers of callers that went away (M1)", () => {
  it("make room for a live caller once they have been idle", async () => {
    const stub = stubOf("m1-idle");
    await stub.query([{ sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)", params: [] }]);
    await stub.query([
      {
        sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25)
              INSERT INTO t SELECT i, ${MB_OF_ZEROS} FROM n`,
        params: [],
      },
    ]);
    const read = [{ sql: "SELECT * FROM t", params: [] }];
    // Two callers take their first part and go: about 50 MB held of the 64 MiB.
    expect((await stub.query(read)).ok).toBe(true);
    expect((await stub.query(read)).ok).toBe(true);
    const refused = await stub.query(read);
    expect(refused.ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, HELD_IDLE_MS + 300));
    const live = await stub.query(read);
    expect(live.ok && live.held?.parts).toBeGreaterThan(1);
  }, 60_000);
});

describe("arguments (M4)", () => {
  it("are checked on every call, refusing with nothing applied", async () => {
    const stub = stubOf("m4-types");
    await stub.query([{ sql: "CREATE TABLE t (v)", params: [] }]);
    const insert = [{ sql: "INSERT INTO t VALUES (1)", params: [] }];
    expect((await stub.stage("b", "1" as unknown as number, insert)).ok).toBe(false);
    expect((await stub.commit("b", "1" as unknown as number, insert)).ok).toBe(false);
    expect((await stub.take("b", -1)).ok).toBe(false);
    expect(
      (await stub.query([{ sql: "INSERT INTO t VALUES (?)", params: [{} as unknown as null] }])).ok,
    ).toBe(false);
    expect((await stub.query("SELECT 1" as unknown as never)).ok).toBe(false);
    expect((await stub.query(insert, 7 as unknown as string)).ok).toBe(false);
    const count = await stub.query([{ sql: "SELECT count(*) FROM t", params: [] }]);
    expect(count.ok && count.pieces[0]?.[3]).toEqual([[0]]);
  });
});
