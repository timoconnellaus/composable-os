// The proof of stage 66 step 2 on Cloudflare (ADR 0614): what the local runtime cannot show.
// Point-in-time recovery exists only on Cloudflare; an export and import there cross real
// services; real D1 may refuse what the export and import use; and only a real object shows its
// memory, its size after deletes and its own errors. Each probe uses a client of its own (a fresh
// id per run), never the timed client's database. (How many calls one request may make is step
// 1's `/subrequests`.)
//
//   GET /step2/pitr      bookmark, a write, restore (a call made while it waits is refused),
//                        then the undo: what each leaves, and how long each took
//   GET /step2/export    the D1 database out as SQL into a fresh client's database, out of that
//                        (held still) into another, every table compared with D1's
//   GET /step2/d1        each feature the export and import use, run on real D1 and rolled back
//   GET /step2/answers   a 200,000-statement batch, a 40 MB read, and a 60 MB read that must be
//                        refused cleanly with the object still answering
//   GET /step2/size      whether `databaseSize` falls after deletes, and what VACUUM answers
import {
  type ClientDb,
  clientDatabase,
  clientDbCalls,
  RESTORING_MESSAGE,
  restoreClientDb,
} from "@composable-os/db/client-db";
import {
  clientDbHold,
  type ExportPart,
  exportDatabase,
  importDatabase,
  schemaRows,
} from "@composable-os/db/sql-export";
import { contentsDiffer, databaseContents } from "@composable-os/db/testing/contents";

interface Step2Env {
  DB: D1Database;
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
  LOCATION_HINT: string;
}

function hint(env: Step2Env) {
  return { locationHint: env.LOCATION_HINT as DurableObjectLocationHint };
}

function fresh(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function rows(db: D1Database): Promise<unknown[][]> {
  return db.prepare("SELECT v FROM t ORDER BY v").raw();
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Bookmark, restore and undo on a real object: what restore does to writes after the bookmark. */
async function pitr(env: Step2Env) {
  const client = fresh("pitr");
  const db = clientDatabase(env.CLIENT_DB, client, hint(env));
  const stub = () => env.CLIENT_DB.get(env.CLIENT_DB.idFromName(client), hint(env));
  await db.prepare("CREATE TABLE t (v INTEGER)").run();
  await db.prepare("INSERT INTO t VALUES (1)").run();
  const bookmark = await stub().bookmark();
  await db.prepare("INSERT INTO t VALUES (2)").run();
  const beforeRestore = await rows(db);
  const session = await stub().session();

  // The restore by hand, to see the window between arranging it and the restart.
  let started = Date.now();
  const arranged = await stub().restore(bookmark);
  if (!arranged.ok) return { ok: false, error: arranged.error };
  const duringWindow = await db
    .prepare("INSERT INTO t VALUES (3)")
    .run()
    .then(
      () => "accepted",
      (error) => message(error),
    );
  await stub()
    .restart()
    .catch(() => {});
  let sessionAfter = session;
  for (let i = 0; i < 200 && (sessionAfter.id === session.id || sessionAfter.restoring); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    sessionAfter = await stub()
      .session()
      .catch(() => session);
  }
  const restoreMs = Date.now() - started;
  const afterRestore = await rows(db);

  started = Date.now();
  await restoreClientDb(env.CLIENT_DB, client, arranged.undo, hint(env));
  const undoMs = Date.now() - started;
  const afterUndo = await rows(db);
  let bookmarkAMinuteAgo: string;
  try {
    bookmarkAMinuteAgo = await stub().bookmarkAt(Date.now() - 60_000);
  } catch (error) {
    bookmarkAMinuteAgo = `refused: ${message(error)}`;
  }
  const ok =
    JSON.stringify(beforeRestore) === "[[1],[2]]" &&
    JSON.stringify(afterRestore) === "[[1]]" &&
    JSON.stringify(afterUndo) === "[[1],[2]]" &&
    duringWindow.includes(RESTORING_MESSAGE) &&
    session.id !== sessionAfter.id;
  return {
    ok,
    bookmark,
    beforeRestore,
    duringWindow,
    afterRestore,
    afterUndo,
    restarted: session.id !== sessionAfter.id,
    restoreMs,
    undoMs,
    bookmarkAMinuteAgo,
  };
}

/** D1 → a client's database → another client's database, every table compared with D1's. */
async function exportProbe(env: Step2Env) {
  const started = Date.now();
  const firstName = fresh("export-a");
  const first = clientDatabase(env.CLIENT_DB, firstName, hint(env));
  const second = clientDatabase(env.CLIENT_DB, fresh("export-b"), hint(env));
  let parts = 0;
  let statements = 0;
  async function* counted(from: AsyncIterable<ExportPart>): AsyncGenerator<ExportPart> {
    for await (const part of from) {
      parts += 1;
      statements += part.statements.length;
      yield part;
    }
  }
  // The expected schema is the source's own: the proof compares two copies of one database.
  const expected = { expectedSchema: async () => schemaRows(env.DB) };
  await importDatabase(
    first,
    counted(exportDatabase(env.DB, { maxBytes: 512 * 1024, hold: "caller-paused" })),
    expected,
  );
  await importDatabase(
    second,
    counted(
      exportDatabase(first, { maxBytes: 512 * 1024, hold: clientDbHold(env.CLIENT_DB, firstName) }),
    ),
    expected,
  );
  const [d1, a, b] = await Promise.all([
    databaseContents(env.DB),
    databaseContents(first),
    databaseContents(second),
  ]);
  const differ = { firstFromD1: contentsDiffer(d1, a), secondFromFirst: contentsDiffer(d1, b) };
  return {
    ok: differ.firstFromD1.length === 0 && differ.secondFromFirst.length === 0,
    tables: Object.keys(d1.tables).length,
    rows: Object.values(d1.tables).reduce((sum, t) => sum + t.length, 0),
    parts,
    statements,
    differ,
    ms: Date.now() - started,
    calls: (clientDbCalls(first) ?? 0) + (clientDbCalls(second) ?? 0),
  };
}

/**
 * Each feature an export or an import uses, on real D1. Reads run as they are; each write runs in
 * a batch that ends with a statement that must fail, so nothing stays: the feature worked when the
 * batch fails only at that last statement.
 */
async function d1Features(env: Step2Env) {
  const db = env.DB;
  const reads: Record<string, string> = {
    tableXinfo:
      "SELECT count(*) FROM sqlite_master m JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND m.name = 'core_person'",
    foreignKeys:
      "SELECT count(*) FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND m.name LIKE 'core\\_%' ESCAPE '\\'",
    tableList: "SELECT count(*) FROM pragma_table_list WHERE schema = 'main' AND wr = 1",
    hexAndQuote:
      "SELECT CASE typeof(name) WHEN 'text' THEN 'T' || hex(name) ELSE quote(name) END FROM sqlite_master LIMIT 1",
    masterByRowid: "SELECT type, name FROM sqlite_master ORDER BY rowid LIMIT 1",
  };
  const writes: Record<string, string[]> = {
    deferForeignKeys: ["PRAGMA defer_foreign_keys = ON"],
    scratchConcat: [
      'CREATE TABLE IF NOT EXISTS "_cos_import_scratch" (k INTEGER PRIMARY KEY, v)',
      `INSERT INTO "_cos_import_scratch" (k, v) VALUES (1, CAST(X'610062' AS TEXT))`,
      `UPDATE "_cos_import_scratch" SET v = v || X'00ff' WHERE k = 1`,
      'DROP TABLE IF EXISTS "_cos_import_scratch"',
    ],
    sqliteSequence: [
      "CREATE TABLE _cos_probe_seq (id INTEGER PRIMARY KEY AUTOINCREMENT)",
      "DELETE FROM sqlite_sequence WHERE name = '_cos_probe_seq'",
      "INSERT INTO sqlite_sequence (name, seq) VALUES ('_cos_probe_seq', 41)",
    ],
    ftsRebuild: [`INSERT INTO "core_search" ("core_search") VALUES ('rebuild')`],
    checkTable: [
      'CREATE TABLE "_cos_import_check" (t TEXT NOT NULL, ok INTEGER NOT NULL CHECK (ok = 1))',
      `INSERT INTO "_cos_import_check" VALUES ('core_person', (SELECT count(*) FROM "core_person") = (SELECT count(*) FROM "core_person"))`,
      'DROP TABLE "_cos_import_check"',
    ],
  };
  const result: Record<string, string> = {};
  for (const [name, sql] of Object.entries(reads)) {
    result[name] = await db
      .prepare(sql)
      .raw()
      .then(
        () => "ok",
        (error) => message(error),
      );
  }
  const tail = "INSERT INTO _cos_probe_missing VALUES (1)";
  for (const [name, statements] of Object.entries(writes)) {
    result[name] = await db.batch([...statements, tail].map((sql) => db.prepare(sql))).then(
      () => "the tail did not fail",
      (error) => (/no such table: _cos_probe_missing/.test(message(error)) ? "ok" : message(error)),
    );
  }
  return { ok: Object.values(result).every((r) => r === "ok"), ...result };
}

/** The review's B1 and S1, and S7: a huge batch, a 40 MB read, and a 60 MB read refused. */
async function answers(env: Step2Env) {
  const client = fresh("answers");
  const db = clientDatabase(env.CLIENT_DB, client, hint(env));
  const stub = () => env.CLIENT_DB.get(env.CLIENT_DB.idFromName(client), hint(env));
  await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v)").run();
  const statements = Array.from({ length: 200_000 }, (_, i) =>
    db.prepare("INSERT INTO t VALUES (?, ?)").bind(i + 1, i),
  );
  let started = Date.now();
  const results = await db.batch(statements);
  const batchMs = Date.now() - started;
  await db.prepare("DELETE FROM t").run();
  const fill = (n: number) =>
    db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) INSERT INTO t SELECT i, hex(zeroblob(500000)) FROM n`,
      )
      .run();
  await fill(40);
  started = Date.now();
  const read = await db.prepare("SELECT * FROM t").all();
  const readMs = Date.now() - started;
  await db.prepare("DELETE FROM t").run();
  await fill(60);
  const session = await stub().session();
  const tooLarge = await db
    .prepare("SELECT * FROM t")
    .all()
    .then(
      () => "returned",
      (error) => message(error),
    );
  const sessionAfter = await stub().session();
  const stillAnswers = await db.prepare("SELECT count(*) AS n FROM t").first("n");
  return {
    ok:
      results.length === 200_000 &&
      read.results.length === 40 &&
      /read it in pages/.test(tooLarge) &&
      session.id === sessionAfter.id &&
      stillAnswers === 60,
    batch: { results: results.length, ms: batchMs },
    read: { rows: read.results.length, ms: readMs },
    tooLarge,
    objectReset: session.id !== sessionAfter.id,
    calls: clientDbCalls(db),
  };
}

/** Whether a client's database gets smaller after deletes, and what VACUUM answers there. */
async function size(env: Step2Env) {
  const client = fresh("size");
  const db = clientDatabase(env.CLIENT_DB, client, hint(env));
  const stub = () => env.CLIENT_DB.get(env.CLIENT_DB.idFromName(client), hint(env));
  await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v)").run();
  const empty = await stub().size();
  await db
    .prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20) INSERT INTO t SELECT i, hex(zeroblob(500000)) FROM n",
    )
    .run();
  const filled = await stub().size();
  await db.prepare("DELETE FROM t").run();
  const afterDelete = await stub().size();
  const vacuum = await db
    .prepare("VACUUM")
    .run()
    .then(
      () => "ran",
      (error) => message(error),
    );
  const afterVacuum = await stub().size();
  return {
    ok: true,
    bytes: { empty, filled, afterDelete, afterVacuum },
    fellAfterDelete: afterDelete < filled,
    vacuum,
    usage: await stub().usage(),
  };
}

/** The step 2 probes' router: null when the path is not one of them; a failure as data. */
export async function step2(url: URL, env: Step2Env): Promise<unknown | null> {
  try {
    return await route(url, env);
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

async function route(url: URL, env: Step2Env): Promise<unknown | null> {
  switch (url.pathname) {
    case "/step2/pitr":
      return pitr(env);
    case "/step2/export":
      return exportProbe(env);
    case "/step2/d1":
      return d1Features(env);
    case "/step2/answers":
      return answers(env);
    case "/step2/size":
      return size(env);
    default:
      return null;
  }
}
