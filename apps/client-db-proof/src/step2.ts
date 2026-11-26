// The proof of stage 66 step 2 on Cloudflare (ADR 0614): what the local runtime cannot show.
// Point-in-time recovery exists only on Cloudflare, an export and import there cross real
// services, and how many calls to a client's database one request may make is Cloudflare's limit.
// Each probe uses a client of its own (a fresh id per run), never the timed client's database.
//
//   GET /step2/pitr        bookmark, restore to it, restore the undo: what each leaves
//   GET /step2/export      the D1 database out as SQL, into a fresh client's database, out of
//                          that and into another, every table compared with D1's
//   GET /step2/calls?n=N[&d1=M]   N calls to a client's database, then M D1 queries, in one
//                          request: how many succeed before Cloudflare's limit, and its error
//   GET /step2/answers     a batch of 200,000 statements and a 40 MB read, as D1 answers them
import {
  type ClientDb,
  clientDatabase,
  clientDbCalls,
  restoreClientDb,
} from "@composable-os/db/client-db";
import { exportDatabase, importDatabase } from "@composable-os/db/sql-export";
import { contentsDiffer, databaseContents } from "@composable-os/db/testing/contents";

interface Step2Env {
  DB: D1Database;
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
  LOCATION_HINT: string;
}

const MAX_CALLS = 20_000;

function hint(env: Step2Env) {
  return { locationHint: env.LOCATION_HINT as DurableObjectLocationHint };
}

function fresh(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function rows(db: D1Database): Promise<unknown[][]> {
  return db.prepare("SELECT v FROM t ORDER BY v").raw();
}

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
  let started = Date.now();
  const { undo } = await restoreClientDb(env.CLIENT_DB, client, bookmark, hint(env));
  const restoreMs = Date.now() - started;
  const afterRestore = await rows(db);
  const sessionAfter = await stub().session();
  started = Date.now();
  await restoreClientDb(env.CLIENT_DB, client, undo, hint(env));
  const undoMs = Date.now() - started;
  const afterUndo = await rows(db);
  let bookmarkAMinuteAgo: string;
  try {
    bookmarkAMinuteAgo = await stub().bookmarkAt(Date.now() - 60_000);
  } catch (error) {
    bookmarkAMinuteAgo = `refused: ${(error as Error).message}`;
  }
  const ok =
    JSON.stringify(beforeRestore) === "[[1],[2]]" &&
    JSON.stringify(afterRestore) === "[[1]]" &&
    JSON.stringify(afterUndo) === "[[1],[2]]" &&
    session.id !== sessionAfter.id;
  return {
    ok,
    bookmark,
    beforeRestore,
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
  const first = clientDatabase(env.CLIENT_DB, fresh("export-a"), hint(env));
  const second = clientDatabase(env.CLIENT_DB, fresh("export-b"), hint(env));
  let parts = 0;
  let statements = 0;
  async function* counted(db: D1Database) {
    for await (const part of exportDatabase(db, { maxBytes: 512 * 1024 })) {
      parts += 1;
      statements += part.statements.length;
      yield part;
    }
  }
  await importDatabase(first, counted(env.DB));
  await importDatabase(second, counted(first));
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

/** How many calls to a client's database, then D1 queries, one request can make. */
async function calls(env: Step2Env, n: number, d1: number) {
  const db = clientDatabase(env.CLIENT_DB, fresh("calls"), hint(env));
  let clientDb = 0;
  let d1Done = 0;
  let error: string | null = null;
  try {
    for (; clientDb < n; clientDb += 1) await db.prepare("SELECT 1").first();
    for (; d1Done < d1; d1Done += 1) await env.DB.prepare("SELECT 1").first();
  } catch (e) {
    error = (e as Error).message;
  }
  return { asked: { clientDb: n, d1 }, done: { clientDb, d1: d1Done }, error };
}

/** The review's B1 and S1 on a real object: a huge batch and a 40 MB read. */
async function answers(env: Step2Env) {
  const db = clientDatabase(env.CLIENT_DB, fresh("answers"), hint(env));
  await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, v)").run();
  const statements = Array.from({ length: 200_000 }, (_, i) =>
    db.prepare("INSERT INTO t VALUES (?, ?)").bind(i + 1, i),
  );
  let started = Date.now();
  const results = await db.batch(statements);
  const batchMs = Date.now() - started;
  await db.prepare("DELETE FROM t").run();
  await db
    .prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40) INSERT INTO t SELECT i, hex(zeroblob(500000)) FROM n",
    )
    .run();
  started = Date.now();
  const read = await db.prepare("SELECT * FROM t").all();
  const readMs = Date.now() - started;
  return {
    ok: results.length === 200_000 && read.results.length === 40,
    batch: { results: results.length, ms: batchMs },
    read: { rows: read.results.length, ms: readMs },
    calls: clientDbCalls(db),
  };
}

/** The step 2 probes' router: null when the path is not one of them; a failure as data. */
export async function step2(url: URL, env: Step2Env): Promise<unknown | null> {
  try {
    return await route(url, env);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function route(url: URL, env: Step2Env): Promise<unknown | null> {
  switch (url.pathname) {
    case "/step2/pitr":
      return pitr(env);
    case "/step2/export":
      return exportProbe(env);
    case "/step2/calls": {
      const count = (name: string, fallback: number) => {
        const value = Number(url.searchParams.get(name) ?? fallback);
        return Number.isInteger(value) && value >= 0 ? Math.min(value, MAX_CALLS) : fallback;
      };
      return calls(env, count("n", 1_200), count("d1", 0));
    }
    case "/step2/answers":
      return answers(env);
    default:
      return null;
  }
}
