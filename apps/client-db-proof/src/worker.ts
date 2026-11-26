// The proof Worker of stage 66 (ADRs 0612, 0614): clients' databases beside a D1 database, so the
// two can be timed doing the same work on Cloudflare and compared answer by answer. The clients'
// databases are in their own small Worker (`cos-client-db-proof-db`, apps/client-db), reached as
// the host will reach them: the query-only service `CLIENT_DB_QUERIES` for every timed page, the
// class's namespace `CLIENT_DB` for setup and the operator's probes. Not the host: it serves no one, holds only seeded records, and refuses every request
// without the key the deploy workflow sets (PROOF_KEY, a fresh random value each run).
//
//   GET  /health                     no key needed; says whether the key is set
//   POST /setup?db=d1|client-db      beside the databases: every migration (one call into the
//                                    object for a client's database), then seed chunks, until
//                                    `remaining` is 0; work already done is skipped
//   GET  /time?db=…&scenario=…&runs=N[&from=near|edge]   time a scenario N times, warm
//   POST /cold/setup?run=R&i=I       a fresh client's database `cold-R-I`, migrated and seeded
//   GET  /cold/time?run=R&i=I&order=d1-first|client-first   the first staff page on it, after
//                                    the caller has left it idle, and D1's after the same wait
//   GET  /subrequests?db=…&max=N&fetches=F   how many calls one request makes before a limit
//   GET  /conformance                every probe on both databases, side by side
//   POST /step2/<probe>              stage 66 step 2's probes, a bounded call at a time, the
//                                    cursor in the body (src/step2.ts, scripts/step2.mjs)
import { DurableObject } from "cloudflare:workers";
import { applyMigrations, type Migration } from "@composable-os/db";
import { type ClientDb, clientDatabase, clientDatabaseService } from "@composable-os/db/client-db";
import type { ClientDbQueryService } from "@composable-os/db/client-db-service";
import migrations from "./generated/migrations.json";
import { compareAll } from "./probes.ts";
import {
  runScenario,
  SCENARIOS,
  type Scenario,
  seed,
  seeded,
  summarise,
  timeScenario,
} from "./scenarios.ts";
import { step2 } from "./step2.ts";

/**
 * `d1`; `client-db`, a client's database as the host reaches it (the query-only service); and
 * `client-db-direct`, the same object through the class's namespace, to show what the service's
 * extra step costs.
 */
const DATABASES = ["d1", "client-db", "client-db-direct"] as const;
type Database = (typeof DATABASES)[number];
const FROMS = ["near", "edge"] as const;
type From = (typeof FROMS)[number];
const ORDERS = ["d1-first", "client-first"] as const;

const near = (env: Env) => ({ locationHint: env.LOCATION_HINT as DurableObjectLocationHint });
const clientDbs = (env: Env) => env.CLIENT_DB as unknown as DurableObjectNamespace<ClientDb>;
const queries = (env: Env) => env.CLIENT_DB_QUERIES as unknown as ClientDbQueryService;

function database(env: Env, which: Database, client = env.CLIENT_ID): D1Database {
  if (which === "d1") return env.DB;
  return which === "client-db"
    ? clientDatabaseService(queries(env), client, near(env))
    : clientDatabase(clientDbs(env), client, near(env));
}

/** A client's object, through the operator's binding: its session id says whether it restarted. */
const objectOf = (env: Env, client: string) =>
  clientDbs(env).get(clientDbs(env).idFromName(client), near(env));

/** Seed chunks one setup call makes, beside the databases (each well inside the call's limits). */
const SEED_CHUNKS_PER_CALL = 5;

/** An integer query parameter within [min, max], its default when absent, or null when invalid. */
function int(url: URL, name: string, min: number, max: number, fallback: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

function oneOf<T extends string>(
  url: URL,
  name: string,
  list: readonly T[],
  fallback?: T,
): T | null {
  const raw = url.searchParams.get(name) ?? fallback ?? null;
  return raw !== null && (list as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** A cold-start sample's client: `cold-<run>-<i>`, the run a short lowercase token. */
function coldClient(url: URL): string | null {
  const run = url.searchParams.get("run") ?? "";
  const i = int(url, "i", 0, 99, -1);
  return /^[a-z0-9]{1,20}$/.test(run) && i !== null && i >= 0 ? `cold-${run}-${i}` : null;
}

/** `db`, counting the statements prepared through it: each is one call to the database. */
function counted(db: D1Database): { db: D1Database; count: () => number } {
  let statements = 0;
  const proxy = new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "prepare") {
        return (sql: string) => {
          statements += 1;
          return target.prepare(sql);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, count: () => statements };
}

async function time(env: Env, which: Database, scenario: Scenario, runs: number) {
  const { db, count } = counted(database(env, which));
  const data = await seeded(db);
  const before = count();
  const times = await timeScenario(scenario, db, data, runs);
  // timeScenario runs once unmeasured first.
  return {
    ...summarise(times),
    statementsPerRun: Math.round((count() - before) / (runs + 1)),
    times,
  };
}

/**
 * The first staff page on `db` after idle, in two parts so the cost can be attributed: the very
 * first query alone (on a cold object: its Worker's isolate, the constructor, SQLite opening, and
 * the hop), then the page itself (the seed's lookups included), which then finds the object warm.
 */
async function firstPage(db: D1Database) {
  let started = performance.now();
  await db.prepare("SELECT 1 AS one").first();
  const firstQueryMs = performance.now() - started;
  started = performance.now();
  await runScenario("staff-list", db, await seeded(db));
  const pageMs = performance.now() - started;
  return { firstQueryMs, pageMs, totalMs: firstQueryMs + pageMs };
}

/** Times from beside the databases (`from=near`), and runs the cold and subrequest samples. */
export class ProofTimer extends DurableObject<Env> {
  async time(which: Database, scenario: Scenario, runs: number) {
    return time(this.env, which, scenario, runs);
  }

  /**
   * Setup beside the databases, so each query crosses metres, not the world: every migration
   * (for a client's database one call that loops inside the object), then up to
   * `SEED_CHUNKS_PER_CALL` chunks of the seed. Work already done is skipped, so a rerun's setup is
   * a few queries.
   */
  async setup(which: "d1" | "client-db", client: string) {
    const started = performance.now();
    const list = migrations as Migration[];
    const applied =
      which === "d1"
        ? await applyMigrations(this.env.DB, list)
        : await objectOf(this.env, client).migrate(list);
    const db = database(this.env, which === "d1" ? "d1" : "client-db-direct", client);
    let remaining = Number.POSITIVE_INFINITY;
    for (let chunk = 0; chunk < SEED_CHUNKS_PER_CALL && remaining > 0; chunk += 1) {
      ({ remaining } = await seed(db));
    }
    return { migrationsApplied: applied.length, remaining, ms: performance.now() - started };
  }

  /** A cold sample's client: migrated and seeded one chunk, and the object's session then. */
  async coldSetup(client: string) {
    const stub = objectOf(this.env, client);
    await stub.migrate(migrations as Migration[]);
    await seed(database(this.env, "client-db-direct", client));
    return { client, instance: (await stub.session()).id };
  }

  async cold(client: string, d1First: boolean, setupInstance: string) {
    const order: ("d1" | "client-db")[] = d1First ? ["d1", "client-db"] : ["client-db", "d1"];
    const ms: Record<string, Awaited<ReturnType<typeof firstPage>>> = {};
    for (const which of order) ms[which] = await firstPage(database(this.env, which, client));
    // Another session than the one setup saw: the object had been evicted (or hibernated) and
    // constructed again, so its first query paid the start. Read after timing, through the
    // operator's binding, so the check itself never warms it.
    const clientWasCold = (await objectOf(this.env, client).session()).id !== setupInstance;
    return { client, d1: ms.d1, clientDb: ms["client-db"], clientWasCold };
  }

  async subrequests(which: Database, max: number, fetches: number) {
    let fetched = 0;
    let fetchError: string | null = null;
    for (let i = 0; i < fetches; i += 1) {
      try {
        const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace");
        await response.body?.cancel();
        fetched += 1;
      } catch (error) {
        fetchError = (error as Error).message;
        break;
      }
    }
    const db = database(this.env, which);
    let queries = 0;
    let error: string | null = null;
    const started = performance.now();
    while (queries < max) {
      try {
        await db.prepare("SELECT 1 AS one").first();
        queries += 1;
      } catch (e) {
        error = (e as Error).message;
        break;
      }
    }
    return {
      db: which,
      fetched,
      fetchError,
      queries,
      error,
      ms: Math.round(performance.now() - started),
    };
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const bad = (what: string) => json({ error: what }, 400);

async function keyMatches(given: string | null, key: string): Promise<boolean> {
  if (!given) return false;
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(given), digest(key)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // A secret the workflow sets after deploying, so not in the generated Env.
    const key = (env as Env & { PROOF_KEY?: string }).PROOF_KEY;
    if (url.pathname === "/health") return json({ ok: true, keySet: Boolean(key) });
    if (!key) return json({ error: "PROOF_KEY is not set" }, 503);
    if (!(await keyMatches(request.headers.get("x-proof-key"), key))) {
      return json({ error: "not found" }, 404);
    }
    const timer = () => env.PROOF_TIMER.get(env.PROOF_TIMER.idFromName("timer"), near(env));
    const post = request.method === "POST";

    if (url.pathname === "/setup" && post) {
      const which = oneOf(url, "db", ["d1", "client-db"] as const);
      if (!which) return bad("db=d1|client-db");
      return json({ db: which, ...(await timer().setup(which, env.CLIENT_ID)) });
    }
    if (url.pathname === "/time") {
      const which = oneOf(url, "db", DATABASES);
      const scenario = oneOf(url, "scenario", SCENARIOS);
      const from = oneOf<From>(url, "from", FROMS, "near");
      const runs = int(url, "runs", 1, 50, 10);
      if (!which) return bad(`db=${DATABASES.join("|")}`);
      if (!scenario) return bad(`scenario=${SCENARIOS.join("|")}`);
      if (!from) return bad(`from=${FROMS.join("|")}`);
      if (runs === null) return bad("runs: an integer from 1 to 50");
      const result =
        from === "edge"
          ? await time(env, which, scenario, runs)
          : await timer().time(which, scenario, runs);
      return json({ db: which, scenario, from, colo: request.cf?.colo ?? null, ...result });
    }
    if (url.pathname === "/cold/setup" && post) {
      const client = coldClient(url);
      if (!client) return bad("run=[a-z0-9]{1,20}&i=0..99");
      // One chunk of the seed: the admin, the shop and the first people, enough for the page.
      return json(await timer().coldSetup(client));
    }
    if (url.pathname === "/cold/time") {
      const client = coldClient(url);
      const order = oneOf(url, "order", ORDERS, "d1-first");
      const instance = url.searchParams.get("instance") ?? "";
      if (!client) return bad("run=[a-z0-9]{1,20}&i=0..99");
      if (!order) return bad(`order=${ORDERS.join("|")}`);
      if (!/^[0-9a-f-]{36}$/.test(instance)) return bad("instance: the token /cold/setup returned");
      return json(await timer().cold(client, order === "d1-first", instance));
    }
    if (url.pathname === "/subrequests") {
      const which = oneOf(url, "db", DATABASES);
      const max = int(url, "max", 1, 20_000, 11_000);
      const fetches = int(url, "fetches", 0, 100, 20);
      if (!which) return bad(`db=${DATABASES.join("|")}`);
      if (max === null || fetches === null) return bad("max: 1 to 20000; fetches: 0 to 100");
      return json(await timer().subrequests(which, max, fetches));
    }
    // Stage 66 step 2 (ADR 0614): bookmarks and restore, export and import, large answers, size.
    if (url.pathname.startsWith("/step2/")) {
      // One call of a probe: its cursor, if any, in the body (scripts/step2.mjs drives the calls).
      const body = post ? await request.json().catch(() => null) : null;
      const answer = await step2(url, { ...env, CLIENT_DB: clientDbs(env) }, body);
      if (answer !== null) return json(answer);
    }
    if (url.pathname === "/conformance") {
      const compared = await compareAll(env.DB, database(env, "client-db", "conformance"));
      return json({
        same: compared.filter((c) => c.same).length,
        allowed: compared.filter((c) => !c.same && c.allowed),
        differ: compared.filter((c) => !c.same && !c.allowed),
        all: compared,
      });
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
