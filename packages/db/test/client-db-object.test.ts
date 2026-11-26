// What stage 66 step 2 gave a client's database besides its answers (ADR 0614): migrations with a
// report, its size against the storage limit, where it was first placed, and bookmarks and
// restore as far as the local runtime has them (point-in-time recovery itself is Cloudflare's
// only; the proof Worker's /pitr proves it there).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type ClientDb, clientDatabase, restoreClientDb } from "../src/client-db.ts";
import { applyMigrations, getMigrationLevel, type Migration } from "../src/migrate.ts";

const bindings = env as unknown as {
  DB: D1Database;
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
  TEST_MIGRATIONS: Migration[];
};
/** What a call rejected with, or null: an RPC call's failure taken as a value. */
const failure = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (error: unknown) => error,
  );
const stubOf = (name: string) => bindings.CLIENT_DB.get(bindings.CLIENT_DB.idFromName(name));

/** Every table, index, trigger and view, as sqlite_master holds them. */
async function schemaOf(db: D1Database) {
  const { results } = await db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type, name",
    )
    .all();
  return results;
}

const three: Migration[] = [
  { name: "9001_a.sql", queries: ["CREATE TABLE m_a (v)", "INSERT INTO m_a VALUES (1)"] },
  {
    name: "9002_b.sql",
    queries: [
      "CREATE TABLE m_b (v)",
      "INSERT INTO m_a VALUES (2)",
      "INSERT INTO nowhere VALUES (1)",
    ],
  },
  { name: "9003_c.sql", queries: ["CREATE TABLE m_c (v)"] },
];

describe("migrations inside the object", () => {
  it("rolls a failing migration back whole, keeps the ones before it, and resumes", async () => {
    const stub = stubOf("migrate-fails");
    const db = clientDatabase(bindings.CLIENT_DB, "migrate-fails");
    await stub.migrate([three[0] as Migration]);
    const before = await schemaOf(db);
    const rowsBefore = await db.prepare("SELECT v FROM m_a").raw();

    const report = await stub.migrateAndReport(three);
    expect(report.applied).toEqual([]);
    expect(report.failed?.name).toBe("9002_b.sql");
    expect(report.failed?.error).toMatch(/no such table: nowhere/);
    // Exactly as before the failing migration: no m_b, no row 2, no bookkeeping row, no 9003.
    expect(await schemaOf(db)).toEqual(before);
    expect(await db.prepare("SELECT v FROM m_a").raw()).toEqual(rowsBefore);
    expect(await db.prepare("SELECT name FROM core_migrations ORDER BY id").raw()).toEqual([
      ["9001_a.sql"],
    ]);
    expect(report.level.latest).toBe("9001_a.sql");

    // Fixed, it resumes from the one that failed.
    const fixed = three.map((m) =>
      m.name === "9002_b.sql" ? { ...m, queries: m.queries.slice(0, 2) } : m,
    );
    const resumed = await stub.migrateAndReport(fixed);
    expect(resumed).toMatchObject({ applied: ["9002_b.sql", "9003_c.sql"], failed: null });
    expect(await stub.migrate(fixed)).toEqual([]);
    // As on D1: throws when one fails.
    expect(
      String(await failure(stubOf("migrate-throws").migrate([three[1] as Migration]))),
    ).toMatch(/D1_ERROR: no such table/);
  });

  it("keeps the same order and bookkeeping as D1, out of numeric order too", async () => {
    // Every core migration, then three of a parallel stage's numbers: 9020 before 9010 arrives.
    const late = (name: string): Migration => ({
      name,
      queries: [`CREATE TABLE m_${name.slice(0, 4)} (v)`],
    });
    const first = [...bindings.TEST_MIGRATIONS, late("9020_x.sql"), late("9030_y.sql")];
    const all = [...first, late("9010_z.sql")];
    const db = clientDatabase(bindings.CLIENT_DB, "migrate-order");
    // Some first, the rest later: a lower-numbered migration then arrives after higher ones.
    await stubOf("migrate-order").migrate(first);
    const report = await stubOf("migrate-order").migrateAndReport(all);
    await applyMigrations(bindings.DB, first);
    await applyMigrations(bindings.DB, all);
    const names = "SELECT id, name FROM core_migrations ORDER BY id";
    expect(await db.prepare(names).raw()).toEqual(await bindings.DB.prepare(names).raw());
    const version = "SELECT value FROM core_meta WHERE key = 'schema_version'";
    expect(await db.prepare(version).raw()).toEqual(await bindings.DB.prepare(version).raw());
    expect(report.level).toEqual(await getMigrationLevel(bindings.DB));
    expect(await stubOf("migrate-order").level()).toEqual(report.level);
    expect(report.level.schemaVersion).toBe(9030);
  });
});

describe("size", () => {
  it("reports usage and refuses a write that grows the database past its limit", async () => {
    const stub = stubOf("size-limit");
    const db = clientDatabase(bindings.CLIENT_DB, "size-limit");
    await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").run();
    const fresh = await stub.usage();
    expect(fresh).toMatchObject({ state: "ok", limitBytes: 10_000_000_000 });
    expect(fresh.bytes).toBe(await stub.size());

    const at = fresh.bytes;
    await stub.setSizeLimits({
      warnAtBytes: at,
      refuseAtBytes: at + 200_000,
      reserveBytes: 3_000_000,
    });
    await db.prepare("INSERT INTO t VALUES (1, ?)").bind("x".repeat(100_000)).run();
    expect((await stub.usage()).state).toBe("warning");
    const full =
      /^D1_ERROR: this client's database is full: .* small writes such as an erase still work$/;
    // Past the line, a set that grows the database by more than 1 MiB is refused.
    await expect(
      db.prepare("INSERT INTO t VALUES (2, ?)").bind("y".repeat(2_000_000)).run(),
    ).rejects.toThrow(full);
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(1);
    // A small one (an erase: a delete and its audit row) still goes in, inside the reserve.
    await db.batch([
      db.prepare("DELETE FROM t WHERE id = 1"),
      db.prepare("INSERT INTO t VALUES (3, ?)").bind("audit".repeat(60_000)),
    ]);
    expect((await stub.usage()).state).toBe("refusing");
    // Small sets fill the reserve; past it, any set that grows the database is refused.
    let refused: unknown = null;
    for (let id = 10; id < 40 && !refused; id += 1) {
      refused = await db
        .prepare("INSERT INTO t VALUES (?, ?)")
        .bind(id, "z".repeat(500_000))
        .run()
        .then(
          () => null,
          (e: Error) => e.message,
        );
    }
    expect(refused).toMatch(full);
    expect((await stub.usage()).bytes).toBeLessThanOrEqual(at + 200_000 + 3_000_000);
    // A delete, which does not grow it, still works.
    await db.prepare("DELETE FROM t").run();
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(0);
    expect(
      String(await failure(stub.setSizeLimits({ warnAtBytes: 10, refuseAtBytes: 5 }))),
    ).toMatch(/size limits/);
  });
});

describe("holding still for an export (S3)", () => {
  it("refuses every set that may write while held, and only then", async () => {
    const stub = stubOf("held");
    const db = clientDatabase(bindings.CLIENT_DB, "held");
    await db.prepare("CREATE TABLE t (v)").run();
    const hold = await stub.hold(60_000);
    if (!hold.ok) throw new Error(hold.error);
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "CREATE TABLE u (v)",
      "PRAGMA defer_foreign_keys = ON",
    ]) {
      await expect(db.prepare(sql).run(), sql).rejects.toThrow(
        "D1_ERROR: this client's database is held still while it is exported; nothing was applied",
      );
    }
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(0);
    expect((await stub.hold(60_000)).ok).toBe(false);
    expect((await stub.renewHold(hold.token)).ok).toBe(true);
    expect((await stub.renewHold("another")).ok).toBe(false);
    // It outlives a restart.
    await stub.restart().catch(() => {});
    await expect(db.prepare("INSERT INTO t VALUES (1)").run()).rejects.toThrow(/held still/);
    expect(await stubOf("held").release(hold.token)).toEqual({ ok: true });
    await db.prepare("INSERT INTO t VALUES (1)").run();
    expect((await stubOf("held").renewHold(hold.token)).ok).toBe(false);
    expect((await stubOf("held").hold(10)).ok).toBe(false);
  });
});

describe("place", () => {
  it("records the first location hint and says when a later one differs", async () => {
    const stub = bindings.CLIENT_DB.get(bindings.CLIENT_DB.idFromName("placed"), {
      locationHint: "oc",
    });
    const first = await stub.place("oc");
    expect(first).toMatchObject({ locationHint: "oc", first: true, differs: false });
    expect(await stub.place("oc")).toMatchObject({ first: false, differs: false });
    expect(await stub.place("weur")).toMatchObject({
      locationHint: "oc",
      first: false,
      differs: true,
    });
    expect(await stub.place()).toMatchObject({ locationHint: "oc", differs: false });
  });
});

describe("bookmarks and restore, locally", () => {
  it("gives a bookmark, refuses a restore clearly, and keeps working", async () => {
    const stub = stubOf("bookmarks");
    const db = clientDatabase(bindings.CLIENT_DB, "bookmarks");
    await db.prepare("CREATE TABLE t (v)").run();
    // The local runtime answers a bookmark of zeros, and has no point-in-time recovery.
    expect(await stub.bookmark()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/);
    expect(String(await failure(stub.bookmarkAt(Date.now() - 1000)))).toMatch(
      /point-in-time recovery/,
    );
    const session = await stub.session();
    await expect(
      restoreClientDb(bindings.CLIENT_DB, "bookmarks", await stub.bookmark()),
    ).rejects.toThrow(
      /could not restore bookmarks's database: .*does not implement point-in-time recovery/,
    );
    // Nothing changed: the same session, not restoring, and writes still go in.
    expect(await stub.session()).toEqual({ ...session, restoring: false });
    await db.prepare("INSERT INTO t VALUES (1)").run();
    expect(await db.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(1);
  });
});
