// The proof of stage 66 step 2 on Cloudflare (ADR 0614): what the local runtime cannot show.
// Point-in-time recovery exists only on Cloudflare; an export and import there cross real
// services; real D1 may refuse what the export and import use; and only a real object shows its
// memory, its size after deletes and its own errors. Each probe uses a client of its own (a fresh
// id per run), never the timed client's database. (How many calls one request may make is step
// 1's `/subrequests`.)
//
//   POST /step2/<probe>, body { cursor }: one call of a probe. It answers `{ done: true, result }`,
//   or `{ done: false, cursor, progress }` for the script (scripts/step2.mjs) to send back; no
//   call works more than about `BUDGET_MS`, so no request comes near a limit, and a probe that
//   stops part way says how far it got.
//
//   pitr      bookmark, a write, restore (a call made while it waits is refused), then the undo:
//             what each leaves, and how long each took (one call)
//   export    the D1 database out as SQL into a fresh client's database, out of that (held still)
//             into another, a part a step; then every table of the three hashed and compared
//   d1        each feature the export and import use, run on real D1 and rolled back (one call)
//   answers   a 200,000-statement batch, a 40 MB read, and a 60 MB read that must be refused
//             cleanly with the object still answering (a step a call)
//   size      whether `databaseSize` falls after deletes, and what VACUUM answers (one call)
import {
  type ClientDb,
  clientDatabase,
  RESTORING_MESSAGE,
  restoreClientDb,
} from "@composable-os/db/client-db";
import {
  clientDbHold,
  type ExportCursor,
  exportPart,
  importPart,
  schemaRows,
} from "@composable-os/db/sql-export";
import { contentTables, tableContents } from "@composable-os/db/testing/contents";

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

/** How long one call of a probe works before it returns its cursor: well inside a request. */
const BUDGET_MS = 8_000;

/** What every probe call answers: done with its result, or a cursor for the next call. */
type Step =
  | { done: true; result: Record<string, unknown> }
  | { done: false; cursor: unknown; progress: string };

const short = async (value: unknown) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

// --- /step2/export, in parts -----------------------------------------------------------------------

type Reading = "d1" | "a" | "b";
interface ExportProbeCursor {
  phase: "d1-to-a" | "a-to-b" | "read" | "done";
  a: string;
  b: string;
  exported: ExportCursor | null;
  parts: number;
  statements: number;
  reading: Reading;
  table: number;
  hashes: Record<Reading, Record<string, string>>;
  started: number;
}

/**
 * D1 → a client's database → another client's database (the second export held still), then every
 * table of the three read and hashed, a few tables a call, and compared with D1's. Each call
 * works up to `BUDGET_MS` and returns its cursor.
 */
async function exportProbe(env: Step2Env, given: unknown): Promise<Step> {
  const at: ExportProbeCursor = (given as ExportProbeCursor | null) ?? {
    phase: "d1-to-a",
    a: fresh("export-a"),
    b: fresh("export-b"),
    exported: null,
    parts: 0,
    statements: 0,
    reading: "d1",
    table: 0,
    hashes: { d1: {}, a: {}, b: {} },
    started: Date.now(),
  };
  const db = (which: Reading) =>
    which === "d1" ? env.DB : clientDatabase(env.CLIENT_DB, which === "a" ? at.a : at.b, hint(env));
  // The expected schema is the source's own: the proof compares two copies of one database.
  const expected = { expectedSchema: async () => schemaRows(env.DB) };
  const until = Date.now() + BUDGET_MS;
  while (Date.now() < until && at.phase !== "done") {
    if (at.phase === "d1-to-a" || at.phase === "a-to-b") {
      const from = at.phase === "d1-to-a" ? db("d1") : db("a");
      const into = at.phase === "d1-to-a" ? db("a") : db("b");
      const hold =
        at.phase === "d1-to-a" ? ("caller-paused" as const) : clientDbHold(env.CLIENT_DB, at.a);
      const { part, next } = await exportPart(from, at.exported, { maxBytes: 256 * 1024, hold });
      await importPart(into, part, expected);
      at.parts += 1;
      at.statements += part.statements.length;
      at.exported = next;
      if (!next) at.phase = at.phase === "d1-to-a" ? "a-to-b" : "read";
      continue;
    }
    // Reading: the schema, then a table at a time, hashed.
    const { schema, tables, virtual } = await contentTables(db(at.reading));
    if (at.table === 0) at.hashes[at.reading]["(schema)"] = await short(schema);
    while (Date.now() < until && at.table < tables.length) {
      const table = tables[at.table] as (typeof tables)[number];
      at.hashes[at.reading][table.name] = await short(
        await tableContents(db(at.reading), table, virtual),
      );
      at.table += 1;
    }
    if (at.table >= tables.length) {
      const order: Reading[] = ["d1", "a", "b"];
      const next = order[order.indexOf(at.reading) + 1];
      if (next) {
        at.reading = next;
        at.table = 0;
      } else {
        at.phase = "done";
      }
    }
  }
  if (at.phase !== "done") {
    const progress =
      at.phase === "read"
        ? `reading ${at.reading}: ${at.table} tables hashed`
        : `${at.phase}: ${at.parts} parts, ${at.statements} statements so far`;
    return { done: false, cursor: at, progress };
  }
  const differ = (other: Reading) =>
    [...new Set([...Object.keys(at.hashes.d1), ...Object.keys(at.hashes[other])])].filter(
      (name) => at.hashes.d1[name] !== at.hashes[other][name],
    );
  const result = { firstFromD1: differ("a"), secondFromFirst: differ("b") };
  return {
    done: true,
    result: {
      ok: result.firstFromD1.length === 0 && result.secondFromFirst.length === 0,
      tables: Object.keys(at.hashes.d1).length - 1,
      parts: at.parts,
      statements: at.statements,
      differ: result,
      ms: Date.now() - at.started,
    },
  };
}

// --- /step2/answers, a step a call -----------------------------------------------------------------

interface AnswersCursor {
  client: string;
  step: number;
  found: Record<string, unknown>;
}

const ANSWER_STEPS = ["batch", "fill-40", "read-40", "fill-60", "read-60"] as const;

/** The review's B1 and S1, and S7: a huge batch, a 40 MB read, a 60 MB read refused; a step a call. */
async function answers(env: Step2Env, given: unknown): Promise<Step> {
  const at: AnswersCursor = (given as AnswersCursor | null) ?? {
    client: fresh("answers"),
    step: 0,
    found: {},
  };
  const db = clientDatabase(env.CLIENT_DB, at.client, hint(env));
  const stub = () => env.CLIENT_DB.get(env.CLIENT_DB.idFromName(at.client), hint(env));
  const fill = async (n: number) => {
    await db.prepare("DELETE FROM t").run();
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) INSERT INTO t SELECT i, hex(zeroblob(500000)) FROM n`,
      )
      .run();
  };
  const step = ANSWER_STEPS[at.step];
  const started = Date.now();
  switch (step) {
    case "batch": {
      await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v)").run();
      const results = await db.batch(
        Array.from({ length: 200_000 }, (_, i) =>
          db.prepare("INSERT INTO t VALUES (?, ?)").bind(i + 1, i),
        ),
      );
      at.found.batch = { results: results.length, ms: Date.now() - started };
      break;
    }
    case "fill-40":
      await fill(40);
      break;
    case "read-40": {
      const read = await db.prepare("SELECT * FROM t").all();
      at.found.read = { rows: read.results.length, ms: Date.now() - started };
      break;
    }
    case "fill-60":
      await fill(60);
      break;
    case "read-60": {
      const session = await stub().session();
      at.found.tooLarge = await db
        .prepare("SELECT * FROM t")
        .all()
        .then(
          () => "returned",
          (error) => message(error),
        );
      const sessionAfter = await stub().session();
      at.found.objectReset = session.id !== sessionAfter.id;
      at.found.stillAnswers = await db.prepare("SELECT count(*) AS n FROM t").first("n");
      break;
    }
  }
  at.step += 1;
  if (at.step < ANSWER_STEPS.length) {
    return { done: false, cursor: at, progress: `${step}: done in ${Date.now() - started} ms` };
  }
  const f = at.found as {
    batch?: { results: number };
    read?: { rows: number };
    tooLarge?: string;
    objectReset?: boolean;
    stillAnswers?: unknown;
  };
  return {
    done: true,
    result: {
      ok:
        f.batch?.results === 200_000 &&
        f.read?.rows === 40 &&
        /read it in pages/.test(f.tooLarge ?? "") &&
        f.objectReset === false &&
        f.stillAnswers === 60,
      ...at.found,
    },
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

/** The step 2 probes, by name. */
export const STEP2_PROBES = ["pitr", "export", "d1", "answers", "size"] as const;

/** The step 2 probes' router: null when the path is not one of them; a failure as data. */
export async function step2(url: URL, env: Step2Env, body: unknown): Promise<Step | null> {
  const name = url.pathname.replace(/^\/step2\//, "");
  if (!(STEP2_PROBES as readonly string[]).includes(name)) return null;
  const cursor = (body as { cursor?: unknown } | null)?.cursor ?? null;
  try {
    switch (name) {
      case "pitr":
        return { done: true, result: await pitr(env) };
      case "export":
        return await exportProbe(env, cursor);
      case "d1":
        return { done: true, result: await d1Features(env) };
      case "answers":
        return await answers(env, cursor);
      default:
        return { done: true, result: await size(env) };
    }
  } catch (error) {
    return { done: true, result: { ok: false, error: message(error) } };
  }
}
