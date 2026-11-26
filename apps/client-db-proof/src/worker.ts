// The proof Worker of stage 66 step 1 (ADR 0612): `ClientDb` deployed with one client beside a D1
// database, so the two can be timed doing the same work on Cloudflare and compared answer by
// answer. Not the host: it serves no one, holds only seeded records, and refuses every request
// without the key the deploy workflow sets (PROOF_KEY, a fresh random value each run).
//
//   POST /setup?db=d1|client-db      migrate (inside the object, for the client's database) and
//                                    seed one chunk; call until `remaining` is 0
//   GET  /time?db=…&scenario=…&runs=N[&from=near|edge]   time a scenario N times
//   GET  /conformance                 every probe of @composable-os/db/testing/conformance on both
//   GET  /health                      no key needed; says whether the key is set
import { DurableObject } from "cloudflare:workers";
import { applyMigrations, type Migration } from "@composable-os/db";
import { clientDatabase } from "@composable-os/db/client-db";
import { compareDatabases } from "@composable-os/db/testing/conformance";
import migrations from "./generated/migrations.json";
import { SCENARIOS, type Scenario, seed, seeded, summarise, timeScenario } from "./scenarios.ts";
import { step2 } from "./step2.ts";

export { ClientDb } from "@composable-os/db/client-db";

const DATABASES = ["d1", "client-db"] as const;
type Database = (typeof DATABASES)[number];
const MAX_RUNS = 50;

/**
 * Where a scenario is timed from. `near` (the default): a Durable Object created with the
 * databases' location hint, so the time is the host's own as it is for a member near the
 * databases, wherever the caller is. `edge`: the Worker itself, where the request landed, the
 * distance to the databases included on every query.
 */
const FROMS = ["near", "edge"] as const;
type From = (typeof FROMS)[number];

const near = (env: Env) => ({ locationHint: env.LOCATION_HINT as DurableObjectLocationHint });

function database(env: Env, which: Database, client = env.CLIENT_ID): D1Database {
  return which === "d1" ? env.DB : clientDatabase(env.CLIENT_DB, client, near(env));
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

/** Times the scenarios from beside the databases (`from=near`). */
export class ProofTimer extends DurableObject<Env> {
  async time(which: Database, scenario: Scenario, runs: number) {
    return time(this.env, which, scenario, runs);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

    const which = url.searchParams.get("db") as Database | null;
    if (url.pathname === "/setup" && request.method === "POST") {
      if (!which || !DATABASES.includes(which)) return json({ error: "db=d1|client-db" }, 400);
      const list = migrations as Migration[];
      const applied =
        which === "d1"
          ? await applyMigrations(env.DB, list)
          : await env.CLIENT_DB.get(env.CLIENT_DB.idFromName(env.CLIENT_ID), near(env)).migrate(
              list,
            );
      const { remaining } = await seed(database(env, which));
      return json({ db: which, migrationsApplied: applied.length, remaining });
    }
    if (url.pathname === "/time") {
      const scenario = url.searchParams.get("scenario") as Scenario | null;
      const from = (url.searchParams.get("from") ?? "near") as From;
      const runs = Math.min(MAX_RUNS, Math.max(1, Number(url.searchParams.get("runs") ?? 10)));
      if (!which || !DATABASES.includes(which)) return json({ error: "db=d1|client-db" }, 400);
      if (!scenario || !SCENARIOS.includes(scenario)) {
        return json({ error: `scenario=${SCENARIOS.join("|")}` }, 400);
      }
      if (!FROMS.includes(from)) return json({ error: `from=${FROMS.join("|")}` }, 400);
      const result =
        from === "edge"
          ? await time(env, which, scenario, runs)
          : await env.PROOF_TIMER.get(env.PROOF_TIMER.idFromName("timer"), near(env)).time(
              which,
              scenario,
              runs,
            );
      return json({ db: which, scenario, from, colo: request.cf?.colo ?? null, ...result });
    }
    // Stage 66 step 2: bookmarks and restore, export and import, calls a request may make.
    if (url.pathname.startsWith("/step2/")) {
      const answer = await step2(url, env);
      if (answer !== null) return json(answer);
    }
    if (url.pathname === "/conformance") {
      const compared = await compareDatabases(env.DB, database(env, "client-db", "conformance"));
      return json({
        same: compared.filter((c) => c.same).length,
        differ: compared.filter((c) => !c.same),
        all: compared,
      });
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
