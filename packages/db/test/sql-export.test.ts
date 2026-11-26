// A database out as SQL and back in, both ways between D1 and a client's database (stage 66 step 2,
// ADR 0614): every table, index, trigger and view, and every value, compared after the round trip
// by a reading of the database that shares no code with the export.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ClientDb, clientDatabase } from "../src/client-db.ts";
import { applyMigrations, type Migration } from "../src/migrate.ts";
import { seedDatabase } from "../src/seed.ts";
import {
  type ExportPart,
  exportDatabase,
  exportPart,
  importDatabase,
  importPart,
  MAX_STATEMENT_BYTES,
  partToSql,
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

async function makeSource(db: D1Database) {
  await applyMigrations(db, bindings.TEST_MIGRATIONS);
  await seedDatabase(db, { people: 60, organisations: 10, activities: 20, tasks: 10 });
  await db.batch(["PRAGMA defer_foreign_keys = ON", ...FIXTURE].map((sql) => db.prepare(sql)));
  // Many small rows, with gaps in their rowids.
  const rows = Array.from({ length: 1500 }, (_, i) =>
    db.prepare("INSERT INTO x_proof_plain (v) VALUES (?)").bind(`row ${i} ${"·".repeat(40)}`),
  );
  await db.batch(rows);
  await db.prepare("DELETE FROM x_proof_plain WHERE rowid % 7 = 0").run();
}

/** Everything the database holds, read without the export's code. */
const contents = (db: D1Database) => databaseContents(db, ["a*", "kangaroo"]);

async function collect(db: D1Database): Promise<ExportPart[]> {
  const parts: ExportPart[] = [];
  for await (const part of exportDatabase(db, PART)) parts.push(part);
  return parts;
}

describe("export and import as SQL", () => {
  let source: Awaited<ReturnType<typeof contents>>;
  let fromD1: ExportPart[];

  beforeAll(async () => {
    await makeSource(bindings.DB);
    source = await contents(bindings.DB);
    fromD1 = await collect(bindings.DB);
  }, 120_000);

  it("the source holds what the test means it to", () => {
    expect(Object.keys(source.tables).length).toBeGreaterThan(250);
    expect(source.tables.sqlite_sequence?.length).toBeGreaterThan(0);
    expect(source.search["core_search a*"]?.length).toBeGreaterThan(0);
    expect(fromD1.length).toBeGreaterThan(10);
    expect(fromD1.at(-1)?.last).toBe(true);
    expect(
      fromD1.every((part) => part.statements.every((s) => s.length <= MAX_STATEMENT_BYTES)),
    ).toBe(true);
  });

  it("moves a D1 database into a client's database, and back out onto D1, unchanged", async () => {
    const client = clientDatabase(bindings.CLIENT_DB, "imported");
    await importDatabase(client, fromD1);
    expect(await contents(client)).toEqual(source);

    // The leaving promise: the client's database exported and installed on D1.
    const fromClient = await collect(client);
    await importDatabase(bindings.DB2, fromClient);
    expect(await contents(bindings.DB2)).toEqual(source);

    // Nothing of the import is left behind, and no trigger fired while the rows went in.
    const leftovers = await bindings.DB2.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE '\\_cos\\_%' ESCAPE '\\'",
    ).raw();
    expect(leftovers).toEqual([]);
    // Into a database that holds tables: refused.
    await expect(importDatabase(bindings.DB2, fromClient)).rejects.toThrow(
      /the database is not empty \(it holds \d+ tables or views/,
    );
  }, 120_000);

  it("resumes an import that stopped part way, and refuses parts out of order", async () => {
    const client = clientDatabase(bindings.CLIENT_DB, "resumed");
    for (const part of fromD1.slice(0, 5)) await importPart(client, part);
    await expect(importPart(client, fromD1[7] as ExportPart)).rejects.toThrow(
      "part 5 is missing before part 7",
    );
    const other = { ...(fromD1[5] as ExportPart), id: "another" };
    await expect(importPart(client, other)).rejects.toThrow(/another export did not finish/);
    // Given every part again, the five already in are skipped.
    const steps = [];
    for (const part of fromD1) steps.push(await importPart(client, part));
    expect(steps.filter((s) => !s.applied)).toHaveLength(5);
    expect(steps.at(-1)).toEqual({ applied: true, done: true });
    expect(await contents(client)).toEqual(source);
  }, 120_000);

  it("refuses to start anywhere but part 0, and checks the row counts at the end", async () => {
    const fresh = clientDatabase(bindings.CLIENT_DB, "counted");
    await expect(importPart(fresh, fromD1[1] as ExportPart)).rejects.toThrow(
      "an import starts with part 0, not part 1",
    );
    const last = fromD1.at(-1) as ExportPart;
    const wrong = { ...last, counts: { ...last.counts, x_proof_plain: 1 } };
    await expect(importDatabase(fresh, [...fromD1.slice(0, -1), wrong])).rejects.toThrow(
      /does not match its export: x_proof_plain: \d+ rows, the export has 1/,
    );
  }, 120_000);

  it("writes parts that read as a .sql file", async () => {
    const { part } = await exportPart(clientDatabase(bindings.CLIENT_DB, "empty-export"));
    expect(part.last).toBe(true);
    expect(partToSql(part)).toMatch(
      /^-- cos-sql-export\/1 .* part 0 \(last\)\nCREATE TABLE IF NOT EXISTS "_cos_import_scratch"/,
    );
  });
});
