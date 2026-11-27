// A database out as SQL and back in, both ways between D1 and a client's database (stage 66 step 2,
// ADR 0614): every table, index, trigger and view, and every value, compared after the round trip
// by a reading of the database that shares no code with the export.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ClientDb, clientDatabase } from "../src/client-db.ts";
import { applyMigrations, type Migration } from "../src/migrate.ts";
import { seedDatabase } from "../src/seed.ts";
import {
  clientDbHold,
  type ExportOptions,
  type ExportPart,
  exportDatabase,
  exportPart,
  type ImportOptions,
  importDatabase,
  importPart,
  MAX_STATEMENT_BYTES,
  migrationsSchema,
  partToSql,
  schemaRows,
} from "../src/sql-export.ts";
import { databaseContents } from "../testing/contents.ts";

const bindings = env as unknown as {
  DB: D1Database;
  DB2: D1Database;
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
  TEST_MIGRATIONS: Migration[];
};

/** Small parts, so that tables, rows and the large values cross parts. */
const PART = { maxBytes: 64 * 1024 };

/** What the host's migrations do not have: every kind of value and object an export must carry. */
const FIXTURE = [
  // The child is made before its parent's table, and its row fills a part: the export must still
  // load the parent first.
  "CREATE TABLE x_proof_aa_child (id INTEGER PRIMARY KEY, parent TEXT NOT NULL REFERENCES x_proof_zz_parent (id), pad TEXT)",
  "CREATE TABLE x_proof_zz_parent (id TEXT PRIMARY KEY, v TEXT)",
  `CREATE TABLE x_proof_values (
     id INTEGER PRIMARY KEY AUTOINCREMENT, i INTEGER, r REAL, t TEXT, b BLOB, anything,
     g AS (i * 2), s TEXT AS (coalesce(t, '') || '!') STORED,
     j TEXT CHECK (j IS NULL OR json_valid(j)))`,
  "CREATE TABLE x_proof_keys (a TEXT, b BLOB, c INTEGER, v TEXT, PRIMARY KEY (a, b, c)) WITHOUT ROWID",
  "CREATE TABLE x_proof_plain (v TEXT)",
  "CREATE TABLE x_proof_tree (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES x_proof_tree (id), name TEXT)",
  "CREATE TABLE x_proof_log (v TEXT)",
  "CREATE VIRTUAL TABLE x_proof_fts USING fts5 (body)",
  "CREATE INDEX x_proof_partial ON x_proof_values (i) WHERE i > 0",
  "CREATE VIEW x_proof_view AS SELECT id, t FROM x_proof_values",
  "CREATE TRIGGER x_proof_logged AFTER INSERT ON x_proof_plain BEGIN INSERT INTO x_proof_log (v) VALUES (NEW.v); END",
  "INSERT INTO x_proof_aa_child VALUES (1, 'p1', hex(zeroblob(40000)))",
  "INSERT INTO x_proof_zz_parent VALUES ('p1', 'parent')",
  // Integers past 2^53 and at the ends, reals to the last bit, the infinities, NULLs.
  `INSERT INTO x_proof_values (i, r, t, b, anything, j) VALUES
     (9223372036854775807, 0.1, 'it''s', X'', 12, NULL),
     (-9223372036854775808, 1e-320, 'emoji 🦘 and é', X'00ff', '12', '{"a":[1,2,3]}'),
     (9007199254740993, 9e999, 'two
lines', X'00', X'0102', NULL),
     (0, -9e999, CAST(X'610062' AS TEXT), NULL, 1.5, NULL),
     (NULL, 1.0 / 3, CAST(X'ff61' AS TEXT), zeroblob(3), NULL, NULL),
     (-1, NULL, CAST(X'efbbbf61' AS TEXT), NULL, NULL, NULL),
     (1, 2.0, NULL, NULL, NULL, NULL)`,
  // Values larger than a statement: text with quotes and two-byte characters, bytes, JSON whose
  // CHECK sees only the whole value.
  `INSERT INTO x_proof_values (i, t, b, j) VALUES
     (7, replace(hex(zeroblob(75000)), '0', 'é'''), randomblob(200000),
      json_array(replace(hex(zeroblob(125000)), '0', 'x')))`,
  "DELETE FROM x_proof_values WHERE i = 1", // sqlite_sequence then runs ahead of the largest id
  "INSERT INTO x_proof_keys VALUES ('a', X'00', 1, 'one'), ('a', X'00', 2, 'two'), (CAST(X'6100' AS TEXT), X'01', 1, 'nul key')",
  // A child before its parent in the same table, each row large enough to be in a part of its own.
  "INSERT INTO x_proof_tree VALUES (1, 3, hex(zeroblob(25000))), (2, 1, hex(zeroblob(25000))), (3, NULL, hex(zeroblob(25000)))",
  "INSERT INTO x_proof_fts (rowid, body) VALUES (5, 'kangaroo wallaby'), (9, 'quokka')",
];

// A sealed screen version (stage 75 step 3, migration 1490), made as the host makes one: open,
// its files, then sealed. Its triggers must hold again once the import has made them.
const SHA = "a".repeat(64);
const SCREEN_VERSION = [
  `INSERT INTO core_screen_blob VALUES ('${SHA}', 12, 'screens/${SHA}/scv_export', '2026-11-27', '2026-11-27')`,
  "INSERT INTO core_screen_version (id, state, created_at, created_by, expires_at) VALUES ('scv_export', 'open', '2026-11-27', 'usr_x', '2026-11-28')",
  `INSERT INTO core_screen_version_file VALUES ('scv_export', 'index.html', '${SHA}', 12, 'text/html; charset=utf-8')`,
  `UPDATE core_screen_version SET state = 'sealed', expires_at = NULL, sealed_at = '2026-11-27', sealed_by = 'usr_x', manifest = '{}', manifest_sha256 = '${SHA}', entry = 'index.html', contract = 'v1', build_tool = 'test', file_count = 1, total_bytes = 12 WHERE id = 'scv_export'`,
];

async function makeSource(db: D1Database) {
  await applyMigrations(db, bindings.TEST_MIGRATIONS);
  await seedDatabase(db, { people: 60, organisations: 10, activities: 20, tasks: 10 });
  await db.batch(["PRAGMA defer_foreign_keys = ON", ...FIXTURE].map((sql) => db.prepare(sql)));
  await db.batch(SCREEN_VERSION.map((sql) => db.prepare(sql)));
  // Many small rows, with gaps in their rowids.
  const rows = Array.from({ length: 1500 }, (_, i) =>
    db.prepare("INSERT INTO x_proof_plain (v) VALUES (?)").bind(`row ${i} ${"·".repeat(40)}`),
  );
  await db.batch(rows);
  await db.prepare("DELETE FROM x_proof_plain WHERE rowid % 7 = 0").run();
}

/** Everything the database holds, read without the export's code. */
const contents = (db: D1Database) => databaseContents(db, ["a*", "kangaroo"]);

let references = 0;

/**
 * What the import expects, as step 7 will build it: the core schema from the code's own
 * migrations at the export's level, and the rest (the fixture's and the seed's extension tables)
 * from `truth`, standing in for what the reconciler would derive from the manifests.
 */
function expectedFrom(truth: D1Database): ImportOptions {
  return {
    async expectedSchema(_db, source) {
      references += 1;
      const reference = clientDatabase(bindings.CLIENT_DB, `reference-${references}`);
      const core = await migrationsSchema(reference, bindings.TEST_MIGRATIONS, source.migrations);
      const known = new Set(core.map((row) => `${row.type} ${row.name}`));
      const rest = (await schemaRows(truth)).filter((row) => !known.has(`${row.type} ${row.name}`));
      return [...core, ...rest];
    },
  };
}

async function collect(db: D1Database, hold: ExportOptions["hold"]): Promise<ExportPart[]> {
  const parts: ExportPart[] = [];
  for await (const part of exportDatabase(db, { ...PART, hold })) parts.push(part);
  return parts;
}

const PAUSED = "caller-paused" as const;
const holdOf = (client: string, ms?: number) => clientDbHold(bindings.CLIENT_DB, client, ms);

describe("export and import as SQL", () => {
  let source: Awaited<ReturnType<typeof contents>>;
  let fromD1: ExportPart[];
  let options: ImportOptions;

  beforeAll(async () => {
    await makeSource(bindings.DB);
    source = await contents(bindings.DB);
    fromD1 = await collect(bindings.DB, PAUSED);
    options = expectedFrom(bindings.DB);
  }, 120_000);

  it("the source holds what the test means it to", () => {
    expect(Object.keys(source.tables).length).toBeGreaterThan(250);
    expect(source.tables.sqlite_sequence?.length).toBeGreaterThan(0);
    expect(source.search["core_search a*"]?.length).toBeGreaterThan(0);
    expect(fromD1.length).toBeGreaterThan(10);
    expect(fromD1.at(-1)?.last).toBe(true);
    expect(fromD1[0]?.source?.migrations).toHaveLength(bindings.TEST_MIGRATIONS.length);
    expect(
      fromD1.every((part) => part.statements.every((s) => s.length <= MAX_STATEMENT_BYTES)),
    ).toBe(true);
  });

  it("moves a D1 database into a client's database, and back out onto D1, unchanged", async () => {
    const client = clientDatabase(bindings.CLIENT_DB, "imported");
    await importDatabase(client, fromD1, options);
    expect(await contents(client)).toEqual(source);

    // The leaving promise: the client's database exported and installed on D1.
    const fromClient = await collect(client, holdOf("imported"));
    await importDatabase(bindings.DB2, fromClient, options);
    expect(await contents(bindings.DB2)).toEqual(source);

    // A client's screen versions go with it (stage 75 step 3), and stay fixed where they land.
    expect(source.tables.core_screen_version?.length).toBe(1);
    await expect(
      bindings.DB2.prepare("UPDATE core_screen_version SET entry = 'x' WHERE id = 'scv_export'").run(),
    ).rejects.toThrow(/core_screen_version_sealed/);

    // Nothing of the import is left behind, and no trigger fired while the rows went in.
    const leftovers = await bindings.DB2.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE '\\_cos\\_%' ESCAPE '\\'",
    ).raw();
    expect(leftovers).toEqual([]);
    // Into a database that holds tables: refused.
    await expect(importDatabase(bindings.DB2, fromClient, options)).rejects.toThrow(
      /the database is not empty \(it holds \d+ tables or views/,
    );
  }, 120_000);

  it("resumes an import that stopped part way, and refuses parts out of order", async () => {
    const client = clientDatabase(bindings.CLIENT_DB, "resumed");
    for (const part of fromD1.slice(0, 5)) await importPart(client, part, options);
    await expect(importPart(client, fromD1[7] as ExportPart, options)).rejects.toThrow(
      "part 5 is missing before part 7",
    );
    const other = { ...(fromD1[5] as ExportPart), id: "another" };
    await expect(importPart(client, other, options)).rejects.toThrow(
      /another export did not finish/,
    );
    // Given every part again, the five already in are skipped.
    const steps = [];
    for (const part of fromD1) steps.push(await importPart(client, part, options));
    expect(steps.filter((s) => !s.applied)).toHaveLength(5);
    expect(steps.at(-1)).toEqual({ applied: true, done: true });
    expect(await contents(client)).toEqual(source);
  }, 120_000);

  it("finishes an import whose last part went in but whose end was lost (S4)", async () => {
    const client = clientDatabase(bindings.CLIENT_DB, "end-lost");
    // The import's last statement, the drop of its own record, fails once after the last part.
    let lose = true;
    const losing = new Proxy(client, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (sql === 'DROP TABLE "_cos_import"' && lose) {
              lose = false;
              return {
                ...statement,
                run: async () => Promise.reject(new Error("Network connection lost.")),
              };
            }
            return statement;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(importDatabase(losing, fromD1, options)).rejects.toThrow(
      "Network connection lost.",
    );
    // Given the same parts again, every part is in, and the last one finishes it.
    expect(await importDatabase(client, fromD1, options)).toEqual({ parts: fromD1.length });
    expect(await contents(client)).toEqual(source);
  }, 120_000);

  it("refuses to start anywhere but part 0, and empties the database on wrong counts (S4)", async () => {
    const fresh = clientDatabase(bindings.CLIENT_DB, "counted");
    await expect(importPart(fresh, fromD1[1] as ExportPart, options)).rejects.toThrow(
      "an import starts with part 0, not part 1",
    );
    const last = fromD1.at(-1) as ExportPart;
    const wrong = { ...last, counts: { ...last.counts, x_proof_plain: 1 } };
    await expect(importDatabase(fresh, [...fromD1.slice(0, -1), wrong], options)).rejects.toThrow(
      "the import was refused and the database emptied: its row counts do not match the export's",
    );
    expect(await schemaRows(fresh)).toEqual([]);
  }, 120_000);

  it("writes parts that read as a .sql file", async () => {
    const { part } = await exportPart(clientDatabase(bindings.CLIENT_DB, "empty-export"), null, {
      hold: PAUSED,
    });
    expect(part.last).toBe(true);
    expect(partToSql(part)).toMatch(
      /^-- cos-sql-export\/1 .* part 0 \(last\)\nCREATE TABLE IF NOT EXISTS "_cos_import_scratch"/,
    );
  });

  describe("a file from elsewhere (S5)", () => {
    const first = () => structuredClone(fromD1[0] as ExportPart);

    it("refuses a statement an export does not write, before running anything", async () => {
      const target = clientDatabase(bindings.CLIENT_DB, "hostile-statements");
      const hostile = [
        "CREATE TRIGGER core_person_spy AFTER INSERT ON core_person BEGIN SELECT 1; END",
        'INSERT INTO "core_settings" ("key", "value") VALUES ((SELECT 1), 2)',
        "DELETE FROM core_person",
        'UPDATE "core_settings" SET "value" = 1',
        "PRAGMA writable_schema = ON",
        'INSERT INTO "_cf_KV" ("key", "value") VALUES (\'a\', X\'00\')',
        'INSERT INTO "core_settings" ("key") VALUES (\'a\'); DROP TABLE core_person',
      ];
      for (const sql of hostile) {
        const part = first();
        part.statements.push(sql);
        await expect(importPart(target, part, options), sql).rejects.toThrow(
          /^part 0 holds a statement an export does not write/,
        );
      }
      expect(await schemaRows(target)).toEqual([]);
    });

    it("empties the database when the schema is not what this code makes", async () => {
      const target = clientDatabase(bindings.CLIENT_DB, "hostile-schema");
      const extra = "CREATE TABLE core_people (v TEXT)";
      const trigger =
        "CREATE TRIGGER core_person_spy AFTER INSERT ON core_person BEGIN DELETE FROM core_settings; END";
      const parts = structuredClone(fromD1);
      const head = parts[0] as ExportPart;
      head.source?.schema.push(extra, trigger);
      head.statements.push(extra);
      (parts.at(-1) as ExportPart).statements.splice(-1, 0, trigger);
      await expect(importDatabase(target, parts, options)).rejects.toThrow(
        /the import was refused and the database emptied: its schema is not what this code makes \(table core_people; trigger core_person_spy\)/,
      );
      expect(await schemaRows(target)).toEqual([]);
    }, 120_000);

    it("refuses a part whose fields are of the wrong type (M4)", async () => {
      const target = clientDatabase(bindings.CLIENT_DB, "hostile-types");
      const part = { ...first(), index: "0" } as unknown as ExportPart;
      await expect(importPart(target, part, options)).rejects.toThrow(
        "not a part of an export: its index is not a whole number from 0",
      );
    });
  });
});

describe("an export held still (S3)", () => {
  it("refuses a client's writes while it is exported, and takes them after", async () => {
    const name = "held-export";
    const db = clientDatabase(bindings.CLIENT_DB, name);
    await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").run();
    await db.batch(
      Array.from({ length: 300 }, (_, i) =>
        db.prepare("INSERT INTO t VALUES (?, ?)").bind(i + 1, "x".repeat(400)),
      ),
    );
    const hold = holdOf(name);
    let { part, next } = await exportPart(db, null, { maxBytes: 8 * 1024, hold });
    const parts = [part];
    await expect(db.prepare("UPDATE t SET v = 'changed' WHERE id = 1").run()).rejects.toThrow(
      /held still while it is exported/,
    );
    await expect(db.prepare("INSERT INTO t VALUES (0, 'behind')").run()).rejects.toThrow(
      /held still/,
    );
    while (next) {
      ({ part, next } = await exportPart(db, next, { maxBytes: 8 * 1024, hold }));
      parts.push(part);
    }
    expect(parts.length).toBeGreaterThan(3);
    // Released at the end: writes are taken again.
    await db.prepare("UPDATE t SET v = 'changed' WHERE id = 1").run();
    const target = clientDatabase(bindings.CLIENT_DB, "held-import");
    await importDatabase(target, parts, { expectedSchema: async () => schemaRows(db) });
    expect(await target.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(300);
    expect(await target.prepare("SELECT v FROM t WHERE id = 1").first("v")).toBe("x".repeat(400));
  });

  it("fails when the hold lapsed between parts, or the schema changed", async () => {
    const name = "lapsed-export";
    const db = clientDatabase(bindings.CLIENT_DB, name);
    await db.prepare("CREATE TABLE t (v TEXT)").run();
    await db.batch(
      Array.from({ length: 50 }, () =>
        db.prepare("INSERT INTO t VALUES (?)").bind("y".repeat(400)),
      ),
    );
    const hold = holdOf(name, 1_000);
    const { next } = await exportPart(db, null, { maxBytes: 4 * 1024, hold });
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await expect(exportPart(db, next, { maxBytes: 4 * 1024, hold })).rejects.toThrow(
      "the export was refused: the database was not held still for the whole export (the hold lapsed or was replaced)",
    );
    const paused = await exportPart(db, null, { maxBytes: 4 * 1024, hold: PAUSED });
    await db.prepare("CREATE TABLE u (v)").run();
    await expect(exportPart(db, paused.next, { maxBytes: 4 * 1024, hold: PAUSED })).rejects.toThrow(
      "the schema changed during the export; it must start again",
    );
  });
});

describe("tables an export must read from SQLite itself", () => {
  it("carries a WITHOUT ROWID table with a trailing comment, and FTS over a view (M3, M9)", async () => {
    const db = clientDatabase(bindings.CLIENT_DB, "odd-tables");
    await db.batch(
      [
        "CREATE TABLE x_wr (k TEXT PRIMARY KEY, v INTEGER) WITHOUT ROWID -- a trailing comment",
        "INSERT INTO x_wr VALUES ('a', 1), ('b', 2)",
        "CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT)",
        "INSERT INTO docs VALUES (1, 'kangaroo'), (2, 'wombat')",
        "CREATE VIEW docs_v AS SELECT id, body FROM docs",
        "CREATE VIRTUAL TABLE docs_fts USING fts5 (body, content = 'docs_v', content_rowid = 'id')",
        "INSERT INTO docs_fts (docs_fts) VALUES ('rebuild')",
      ].map((sql) => db.prepare(sql)),
    );
    const parts = await collect(db, holdOf("odd-tables"));
    const target = clientDatabase(bindings.CLIENT_DB, "odd-tables-in");
    await importDatabase(target, parts, { expectedSchema: async () => schemaRows(db) });
    expect(await databaseContents(target, ["kangaroo"])).toEqual(
      await databaseContents(db, ["kangaroo"]),
    );
    expect(
      await target.prepare("SELECT rowid FROM docs_fts WHERE docs_fts MATCH 'kangaroo'").raw(),
    ).toEqual([[1]]);
  });
});
