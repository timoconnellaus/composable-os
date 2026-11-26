// A client's database answers as D1 does (stage 66 step 1, ADR 0612). Every probe of
// testing/conformance.ts runs on the local D1 and on a `ClientDb`, and the answers must be the
// same. The local D1 is itself SQLite in a Durable Object, so this proves the binding's side: the
// result shapes, value conversions, error text, batch atomicity and meta. What only Cloudflare can
// show (D1's own limits, its PRAGMAs) the proof Worker's /conformance reports there.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type ClientDb, clientDatabase, splitParts } from "../src/client-db.ts";
import { applyMigrations, getMigrationLevel } from "../src/migrate.ts";
import { compareDatabases, PROBES } from "../testing/conformance.ts";

const bindings = env as unknown as { DB: D1Database; CLIENT_DB: DurableObjectNamespace<ClientDb> };

describe("ClientDb against D1", () => {
  it("answers every probe as the local D1 does", async () => {
    const compared = await compareDatabases(
      bindings.DB,
      clientDatabase(bindings.CLIENT_DB, "conformance"),
    );
    expect(compared).toHaveLength(PROBES.length);
    // PRINT_CONFORMANCE=1: every answer, for ADR 0612's table.
    if ((env as unknown as { PRINT_CONFORMANCE?: string }).PRINT_CONFORMANCE === "1") {
      console.log(
        JSON.stringify(
          compared.map((c) => [c.name, c.d1]),
          null,
          1,
        ),
      );
    }
    const differ = compared
      .filter((c) => !c.same)
      .map((c) => ({ name: c.name, d1: c.d1, clientDb: c.clientDb }));
    expect(differ).toEqual([]);
  });

  it("migrates inside the object, to the level D1 reaches", async () => {
    const name = "migrated";
    const stub = bindings.CLIENT_DB.get(bindings.CLIENT_DB.idFromName(name));
    const applied = await stub.migrate(env.TEST_MIGRATIONS);
    expect(applied.length).toBe(env.TEST_MIGRATIONS.length);
    expect(await stub.migrate(env.TEST_MIGRATIONS)).toEqual([]);
    const level = await getMigrationLevel(clientDatabase(bindings.CLIENT_DB, name));
    await applyMigrations(bindings.DB, env.TEST_MIGRATIONS);
    expect(level).toEqual(await getMigrationLevel(bindings.DB));
    expect(level.upToDate).toBe(true);
    expect(await stub.size()).toBeGreaterThan(0);
  });

  it("sends a batch too large for one call in parts, still all or nothing", async () => {
    const db = clientDatabase(bindings.CLIENT_DB, "large-batch");
    await db.prepare("CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)").run();
    const value = "x".repeat(1_900_000);
    const insert = (id: number) => db.prepare("INSERT INTO big VALUES (?, ?)").bind(id, value);
    // About 1.9 MB a statement on the wire (one byte a character of a one-byte string): two parts
    // of the 8 MiB each.
    const rows = [1, 2, 3, 4, 5, 6];
    expect(
      splitParts(rows.map((id) => ({ sql: "INSERT INTO big VALUES (?, ?)", params: [id, value] }))),
    ).toHaveLength(2);
    await expect(db.batch([...rows.map(insert), insert(1)])).rejects.toThrow(
      "D1_ERROR: UNIQUE constraint failed: big.id",
    );
    expect(await db.prepare("SELECT count(*) AS n FROM big").first("n")).toBe(0);
    const done = await db.batch(rows.map(insert));
    expect(done).toHaveLength(6);
    expect(await db.prepare("SELECT count(*) AS n FROM big").first("n")).toBe(6);
  });

  it("refuses a parted batch whose earlier part is missing, applying nothing", async () => {
    const stub = bindings.CLIENT_DB.get(bindings.CLIENT_DB.idFromName("lost-part"));
    await stub.query([{ sql: "CREATE TABLE t (v)", params: [] }]);
    await stub.stage("b1", 0, [{ sql: "INSERT INTO t VALUES (1)", params: [] }]);
    const answer = await stub.commit("b1", 2, [{ sql: "INSERT INTO t VALUES (2)", params: [] }]);
    expect(answer.ok).toBe(false);
    const count = await stub.query([{ sql: "SELECT count(*) FROM t", params: [] }]);
    expect(count.ok && count.pieces[0]?.[3]).toEqual([[0]]);
  });

  it("keeps two clients' databases apart", async () => {
    const a = clientDatabase(bindings.CLIENT_DB, "apart-a");
    const b = clientDatabase(bindings.CLIENT_DB, "apart-b");
    await a.prepare("CREATE TABLE only_a (v TEXT)").run();
    await a.prepare("INSERT INTO only_a VALUES ('a')").run();
    await expect(b.prepare("SELECT * FROM only_a").all()).rejects.toThrow(
      "D1_ERROR: no such table: only_a",
    );
  });
});
