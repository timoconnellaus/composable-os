// What D1 and a client's database answer to the same calls (stage 66 step 1, ADR 0612): one probe
// per behaviour the host's code or tests depend on. The local test (test/client-db.test.ts) runs
// them on the local D1 and on `ClientDb` and expects the same answers; the proof Worker
// (apps/client-db-proof, `/conformance`) runs them on Cloudflare, where D1 and a Durable Object
// are different services, and reports every answer that differs.

/** What a probe saw: its value, or the error it was refused with. */
export type ProbeAnswer =
  | { ok: true; value: unknown }
  | { ok: false; message: string; cause?: string };

export interface Probe {
  name: string;
  /** What it checks, for the report. */
  about: string;
  run(db: D1Database, table: (name: string) => string): Promise<unknown>;
}

/** The meta fields that do not depend on timing or on where the database is served. */
function stableMeta(meta: Record<string, unknown>) {
  return {
    changes: meta.changes,
    last_row_id: meta.last_row_id,
    changed_db: meta.changed_db,
    rows_read: meta.rows_read,
    rows_written: meta.rows_written,
    size_after_positive: typeof meta.size_after === "number" && meta.size_after > 0,
  };
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export const PROBES: Probe[] = [
  {
    name: "values",
    about: "INTEGER, REAL, TEXT, NULL and BLOB round trips; booleans bound as 1 and 0",
    async run(db, t) {
      const name = t("values");
      await db
        .prepare(`CREATE TABLE ${name} (i INTEGER, r REAL, s TEXT, n TEXT, b BLOB, f INTEGER)`)
        .run();
      await db
        .prepare(`INSERT INTO ${name} VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(42, 1.5, "héllo ✓", null, new Uint8Array([0, 1, 255]), true)
        .run();
      await db
        .prepare(`INSERT INTO ${name} VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(-7, 0, "", null, [9, 8], false)
        .run();
      const { results } = await db
        .prepare(`SELECT *, typeof(b) AS tb, typeof(f) AS tf FROM ${name}`)
        .all();
      return results;
    },
  },
  {
    name: "big-integers",
    about: "An integer past 2^53 read back (D1 gives a lossy number)",
    async run(db) {
      return db.prepare("SELECT 9007199254740993 AS big, -9223372036854775808 AS min").first();
    },
  },
  {
    name: "non-finite",
    about: "NaN and Infinity bound (D1's JSON sends them as null), and 1e999 read",
    async run(db) {
      return db
        .prepare("SELECT ? AS nan, ? AS inf, typeof(?) AS t, 1e999 AS big")
        .bind(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN)
        .first();
    },
  },
  {
    name: "bind-undefined",
    about: "undefined is refused when bound",
    async run(db) {
      return db.prepare("SELECT ?").bind(undefined).all();
    },
  },
  {
    name: "bind-bigint",
    about: "a bigint is refused when bound",
    async run(db) {
      return db.prepare("SELECT ?").bind(5n).all();
    },
  },
  {
    name: "bind-object",
    about: "a plain object and a Date are refused when bound",
    async run(db) {
      return db.prepare("SELECT ?, ?").bind({ a: 1 }, new Date(0)).all();
    },
  },
  {
    name: "first",
    about: "first(): no row is null, a named column, a missing column refused",
    async run(db) {
      const none = await db.prepare("SELECT 1 AS a WHERE 0").first();
      const a = await db.prepare("SELECT 1 AS a, NULL AS b").first("a");
      const b = await db.prepare("SELECT 1 AS a, NULL AS b").first("b");
      let missing: string | null = null;
      try {
        await db.prepare("SELECT 1 AS a").first("nope");
      } catch (error) {
        missing = (error as Error).message;
      }
      return { none, a, b, missing };
    },
  },
  {
    name: "raw",
    about: "raw() with and without column names; duplicate names in all()",
    async run(db) {
      const plain = await db.prepare("SELECT 1 AS a, 'x' AS a UNION ALL SELECT 2, 'y'").raw();
      const named = await db.prepare("SELECT 1 AS a, 'x' AS b").raw({ columnNames: true });
      const dup = await db.prepare("SELECT 1 AS a, 2 AS a").all();
      return { plain, named, dup: dup.results };
    },
  },
  {
    name: "meta",
    about:
      "meta of an insert, an update, a select and a delete: changes, last_row_id, rows read and written",
    async run(db, t) {
      const name = t("meta");
      await db.prepare(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, v TEXT)`).run();
      const insert = await db.prepare(`INSERT INTO ${name} (v) VALUES ('a'), ('b'), ('c')`).run();
      const update = await db.prepare(`UPDATE ${name} SET v = 'z' WHERE id > 1`).run();
      const select = await db.prepare(`SELECT * FROM ${name}`).all();
      const remove = await db.prepare(`DELETE FROM ${name} WHERE id = 1`).run();
      return {
        insert: [insert.results, stableMeta(insert.meta as never)],
        update: stableMeta(update.meta as never),
        select: [select.results.length, stableMeta(select.meta as never)],
        remove: stableMeta(remove.meta as never),
      };
    },
  },
  {
    name: "returning",
    about: "INSERT ... RETURNING and UPDATE ... RETURNING rows",
    async run(db, t) {
      const name = t("returning");
      await db.prepare(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, v TEXT)`).run();
      const inserted = await db
        .prepare(`INSERT INTO ${name} (v) VALUES (?), (?) RETURNING id, v`)
        .bind("a", "b")
        .all();
      const updated = await db.prepare(`UPDATE ${name} SET v = v || '!' RETURNING *`).all();
      return {
        inserted: inserted.results,
        updated: updated.results,
        meta: stableMeta(updated.meta as never),
      };
    },
  },
  {
    name: "trigger-changes",
    about: "a trigger's writes in meta.changes (D1 counts total_changes)",
    async run(db, t) {
      const a = t("trig_a");
      const b = t("trig_b");
      await db.batch([
        db.prepare(`CREATE TABLE ${a} (id INTEGER PRIMARY KEY)`),
        db.prepare(`CREATE TABLE ${b} (id INTEGER PRIMARY KEY, a INTEGER)`),
        db.prepare(
          `CREATE TRIGGER ${a}_t AFTER INSERT ON ${a} BEGIN INSERT INTO ${b} (a) VALUES (new.id); INSERT INTO ${b} (a) VALUES (new.id); END`,
        ),
      ]);
      const result = await db.prepare(`INSERT INTO ${a} (id) VALUES (1)`).run();
      return stableMeta(result.meta as never);
    },
  },
  {
    name: "batch-atomic",
    about: "a batch whose second statement fails leaves nothing of the first; the error's text",
    async run(db, t) {
      const name = t("atomic");
      await db.prepare(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY)`).run();
      let error: string | null = null;
      try {
        await db.batch([
          db.prepare(`INSERT INTO ${name} (id) VALUES (1)`),
          db.prepare(`INSERT INTO ${name} (id) VALUES (1)`),
        ]);
      } catch (e) {
        error = (e as Error).message;
      }
      const count = await db.prepare(`SELECT count(*) AS n FROM ${name}`).first("n");
      return { error, count };
    },
  },
  {
    name: "batch-sees-earlier",
    about: "a batch's statements see the earlier ones; one result each",
    async run(db, t) {
      const name = t("seq");
      const results = await db.batch([
        db.prepare(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, v TEXT)`),
        db.prepare(`INSERT INTO ${name} (v) VALUES (?)`).bind("a"),
        db.prepare(`SELECT * FROM ${name}`),
      ]);
      return results.map((r) => [r.results, r.meta.changes]);
    },
  },
  {
    name: "batch-empty",
    about: "an empty batch",
    async run(db) {
      return db.batch([]);
    },
  },
  {
    name: "empty-statement",
    about: "a statement of only whitespace",
    async run(db) {
      return db.prepare("   ").all();
    },
  },
  {
    name: "two-statements",
    about: "two statements in one prepare",
    async run(db) {
      return (await db.prepare("SELECT 1 AS a; SELECT 2 AS b").all()).results;
    },
  },
  {
    name: "unique-error",
    about: "a UNIQUE violation's text (packages/core/src/errors.ts matches on it)",
    async run(db, t) {
      const name = t("uniq");
      await db.prepare(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, k TEXT UNIQUE)`).run();
      await db.prepare(`INSERT INTO ${name} VALUES ('a', 'k')`).run();
      return db.prepare(`INSERT INTO ${name} VALUES ('b', 'k')`).run();
    },
  },
  {
    name: "syntax-error",
    about: "a syntax error's text",
    async run(db) {
      return db.prepare("SELEC 1").all();
    },
  },
  {
    name: "foreign-keys",
    about: "foreign keys enforced, PRAGMA foreign_keys, defer_foreign_keys in a batch",
    async run(db, t) {
      const parent = t("fk_p");
      const child = t("fk_c");
      await db.batch([
        db.prepare(`CREATE TABLE ${parent} (id INTEGER PRIMARY KEY)`),
        db.prepare(
          `CREATE TABLE ${child} (id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES ${parent}(id))`,
        ),
      ]);
      const pragma = await db.prepare("PRAGMA foreign_keys").first();
      let refused: string | null = null;
      try {
        await db.prepare(`INSERT INTO ${child} (p) VALUES (99)`).run();
      } catch (e) {
        refused = (e as Error).message;
      }
      await db.batch([
        db.prepare("PRAGMA defer_foreign_keys = ON"),
        db.prepare(`INSERT INTO ${child} (p) VALUES (5)`),
        db.prepare(`INSERT INTO ${parent} (id) VALUES (5)`),
      ]);
      const rows = await db.prepare(`SELECT count(*) AS n FROM ${child}`).first("n");
      return { pragma, refused, rows };
    },
  },
  {
    name: "pragmas",
    about: "PRAGMA table_info allowed; journal_mode and others as each service allows",
    async run(db, t) {
      const name = t("prag");
      await db.prepare(`CREATE TABLE ${name} (a TEXT, b INTEGER)`).run();
      const out: Record<string, unknown> = {};
      out.tableInfo = (await db.prepare(`PRAGMA table_info(${name})`).all()).results.map(
        (r) => r.name,
      );
      for (const pragma of ["journal_mode", "user_version", "page_size", "compile_options"]) {
        try {
          out[pragma] = (await db.prepare(`PRAGMA ${pragma}`).all()).results.length > 0;
        } catch (e) {
          out[pragma] = (e as Error).message;
        }
      }
      return out;
    },
  },
  {
    name: "json",
    about: "json_extract, json_each, ->>, json_group_array, jsonb",
    async run(db) {
      return db
        .prepare(
          "SELECT json_extract(?1, '$.a') AS a, ?1 ->> '$.b[1]' AS b, (SELECT json_group_array(value) FROM json_each(?1, '$.b')) AS each, json(jsonb(?1)) AS round",
        )
        .bind('{"a":1,"b":[true,"x"]}')
        .first();
    },
  },
  {
    name: "fts5",
    about: "an FTS5 table and a MATCH (migrations 0006 and 0970)",
    async run(db, t) {
      const name = t("fts");
      await db
        .prepare(`CREATE VIRTUAL TABLE ${name} USING fts5(body, tokenize = 'porter unicode61')`)
        .run();
      await db
        .prepare(`INSERT INTO ${name} (body) VALUES ('running shoes'), ('a kettlebell')`)
        .run();
      return (await db.prepare(`SELECT body FROM ${name} WHERE ${name} MATCH 'run*'`).all())
        .results;
    },
  },
  {
    name: "begin",
    about: "BEGIN TRANSACTION refused",
    async run(db) {
      return db.prepare("BEGIN TRANSACTION").run();
    },
  },
  {
    name: "params-100",
    about: "100 bound parameters in one statement",
    async run(db) {
      const values = Array.from({ length: 100 }, (_, i) => i);
      return db
        .prepare(`SELECT ${placeholders(100)}`)
        .bind(...values)
        .raw();
    },
  },
  {
    name: "params-101",
    about: "101 bound parameters (D1's limit is 100)",
    async run(db) {
      const values = Array.from({ length: 101 }, (_, i) => i);
      return (
        await db
          .prepare(`SELECT ${placeholders(101)}`)
          .bind(...values)
          .raw()
      )[0]?.length;
    },
  },
  {
    name: "params-in-list-200",
    about: "an IN list of 200 bound values (D1's limit is 100)",
    async run(db) {
      const values = Array.from({ length: 200 }, (_, i) => i);
      return db
        .prepare(`SELECT count(*) AS n FROM (SELECT 1) WHERE 1 IN (${placeholders(200)})`)
        .bind(...values)
        .first("n");
    },
  },
  {
    name: "statement-100kb",
    about: "a statement over 100,000 bytes (D1's limit)",
    async run(db) {
      const literal = "x".repeat(100_500);
      return db.prepare(`SELECT length('${literal}') AS n`).first("n");
    },
  },
  {
    name: "value-2mb",
    about: "a string over 2,000,000 bytes bound (D1's row and value limit)",
    async run(db) {
      return db.prepare("SELECT length(?) AS n").bind("x".repeat(2_100_000)).first("n");
    },
  },
  {
    name: "columns-101",
    about: "a table of 101 columns (D1's limit is 100)",
    async run(db, t) {
      const columns = Array.from({ length: 101 }, (_, i) => `c${i} TEXT`).join(", ");
      return db
        .prepare(`CREATE TABLE ${t("wide")} (${columns})`)
        .run()
        .then((r) => r.success);
    },
  },
  {
    name: "function-args-33",
    about: "a function call of 33 arguments (D1's limit is 32)",
    async run(db) {
      return db
        .prepare(`SELECT max(${Array.from({ length: 33 }, (_, i) => i).join(", ")}) AS m`)
        .first("m");
    },
  },
  {
    name: "exec",
    about: "exec(): one statement a line, the count, and an error naming the line",
    async run(db, t) {
      const name = t("exec");
      const ok = await db.exec(
        `CREATE TABLE ${name} (a)\nINSERT INTO ${name} VALUES (1)\n\nINSERT INTO ${name} VALUES (2)`,
      );
      let error: string | null = null;
      try {
        await db.exec(`INSERT INTO ${name} VALUES (3)\nNOT SQL`);
      } catch (e) {
        error = (e as Error).message;
      }
      const n = await db.prepare(`SELECT count(*) AS n FROM ${name}`).first("n");
      return { count: ok.count, error, n };
    },
  },
  {
    name: "numbered-params",
    about: "?1 used twice, and ?NNN out of order",
    async run(db) {
      return db.prepare("SELECT ?2 AS b, ?1 AS a, ?1 || ?2 AS ab").bind("x", "y").first();
    },
  },
  {
    name: "error-cause",
    about: "a failure's cause carries the message without the D1_ERROR prefix",
    async run(db) {
      try {
        await db.prepare("SELECT * FROM no_such_table_here").all();
        return null;
      } catch (e) {
        return {
          message: (e as Error).message,
          cause: ((e as Error).cause as Error | undefined)?.message,
        };
      }
    },
  },
];

/** Runs one probe, catching its error as data. */
export async function runProbe(probe: Probe, db: D1Database, prefix: string): Promise<ProbeAnswer> {
  const table = (name: string) => `${prefix}_${probe.name.replace(/-/g, "_")}_${name}`;
  try {
    return { ok: true, value: await probe.run(db, table) };
  } catch (error) {
    const e = error as Error;
    const cause = (e.cause as Error | undefined)?.message;
    return { ok: false, message: e.message, ...(cause === undefined ? {} : { cause }) };
  }
}

export interface ProbeComparison {
  name: string;
  about: string;
  same: boolean;
  d1: ProbeAnswer;
  clientDb: ProbeAnswer;
}

/** Every probe on both databases, side by side. `prefix` keeps a run's tables apart. */
export async function compareDatabases(
  d1: D1Database,
  clientDb: D1Database,
  prefix = `p${Date.now().toString(36)}`,
): Promise<ProbeComparison[]> {
  const out: ProbeComparison[] = [];
  for (const probe of PROBES) {
    const a = await runProbe(probe, d1, prefix);
    const b = await runProbe(probe, clientDb, prefix);
    out.push({
      name: probe.name,
      about: probe.about,
      same: JSON.stringify(a) === JSON.stringify(b),
      d1: a,
      clientDb: b,
    });
  }
  await dropProbeTables(d1, prefix);
  await dropProbeTables(clientDb, prefix);
  return out;
}

/** Drops the tables a run made, so a database probed again is as it was. */
export async function dropProbeTables(db: D1Database, prefix: string): Promise<void> {
  // A virtual table's own tables go with it, so a pass may find names already gone.
  for (let pass = 0; pass < 3; pass += 1) {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?")
      .bind(`${prefix}_%`)
      .all<{ name: string }>();
    if (results.length === 0) return;
    for (const { name } of results) {
      try {
        await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
      } catch {
        // A shadow table of an FTS table is dropped with it.
      }
    }
  }
}
