#!/usr/bin/env node
// Times and checks the deployed proof Worker (stage 66): D1 against a client's database, the
// client's database in its own Worker and reached as the host reaches it (the query-only service;
// `client-db-direct` is the same object through the class's namespace, for comparison).
//
//   PROOF_URL=https://… PROOF_KEY=… node scripts/time.mjs [--runs 10] [--rounds 5]
//     [--cold 3] [--cold-wait 150] [--subrequest-max 11000] [--out results.json] [--skip-setup]
//
// 0. What was deployed: each Worker's startup time and size, from PROOF_DEPLOY_FILE (deploy.mjs).
// 1. Setup: migrations and the seed on both databases, beside them (each call loops inside the
//    proof's timer object near the databases; work already done is skipped).
// 2. Conformance: every probe on D1 and on the client's database, printed side by side. A
//    difference not in conformance-allow.json fails the run (exit 1), after everything else ran.
// 3. Warm timing: a staff list, a person's page and a checkout, `rounds` requests of `runs` runs
//    each, alternating databases. `near`: timed in a Durable Object beside the databases (the
//    host's own time for a member near them, wherever this runs); `edge`: where the request landed.
// 4. Cold start: `cold` fresh clients' databases, each left idle `cold-wait` seconds (Cloudflare
//    evicts an idle object after 70 to 140 seconds, at the runtime's discretion), then the first
//    staff page on it and on D1, after the same wait: the very first query alone, then the rest
//    of the page. Each sample says whether the object really had been evicted.
// 5. Subrequests: how many calls one request makes to each database before a limit stops it.
// 6. A verdict against the review's thresholds (docs/deploying.md). Timing never fails the run.
//
// The URL names the account's workers.dev subdomain: it is read from PROOF_URL and never printed
// or written out.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "10" },
    rounds: { type: "string", default: "5" },
    cold: { type: "string", default: "3" },
    "cold-wait": { type: "string", default: "150" },
    "subrequest-max": { type: "string", default: "11000" },
    fetches: { type: "string", default: "20" },
    out: { type: "string" },
    "skip-setup": { type: "boolean", default: false },
  },
});

function integer(name, min, max) {
  const raw = values[name];
  if (!/^\d{1,6}$/.test(raw ?? "") || Number(raw) < min || Number(raw) > max) {
    console.error(`--${name} must be an integer from ${min} to ${max}`);
    process.exit(2);
  }
  return Number(raw);
}
const runs = integer("runs", 1, 50);
const rounds = integer("rounds", 1, 20);
const coldSamples = integer("cold", 0, 10);
const coldWait = integer("cold-wait", 0, 900);
const subrequestMax = integer("subrequest-max", 1, 20000);
const fetches = integer("fetches", 0, 100);
const key = process.env.PROOF_KEY;
const base = (process.env.PROOF_URL ?? "").replace(/\/$/, "");
// https, or `wrangler dev` on this machine.
if (!/^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1):\d{2,5})$/.test(base) || !key) {
  console.error("PROOF_URL (https://…, no path) and PROOF_KEY must be set");
  process.exit(2);
}

const SCENARIOS = ["staff-list", "record-page", "checkout"];
const DATABASES = ["d1", "client-db", "client-db-direct"];
const FROMS = ["near", "edge"];
const allow = JSON.parse(
  readFileSync(new URL("../conformance-allow.json", import.meta.url), "utf8"),
);

// A secret set with `wrangler secret put` takes a few seconds to reach every place the Worker
// runs. Until it does the proof answers 503 (no key yet) or 404 (the last run's key): the first
// run on Cloudflare failed on exactly that, 1.6 s after the deploy. So the first calls wait.
let keyReached = false;
async function call(path, init = {}) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "x-proof-key": key, ...init.headers },
    });
    const body = await response.json().catch(() => null);
    if (response.ok) {
      keyReached = true;
      return body;
    }
    const notYet = !keyReached && (response.status === 503 || response.status === 404);
    if (!notYet || Date.now() > deadline)
      throw new Error(`${path.split("?")[0]}: ${response.status} ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

function summarise(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const rank = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
  const round = (n) => Math.round(n * 10) / 10;
  return { n: sorted.length, median: round(rank(0.5)), p95: round(rank(0.95)) };
}
const show = (value) => JSON.stringify(value).slice(0, 240);
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// 0. What was deployed.
if (process.env.PROOF_DEPLOY_FILE) {
  try {
    console.log(`== Deployed\n${readFileSync(process.env.PROOF_DEPLOY_FILE, "utf8").trim()}`);
  } catch {
    console.log("== Deployed: no deploy report");
  }
}

// 1. Setup.
if (!values["skip-setup"]) {
  for (const db of ["d1", "client-db"]) {
    const started = Date.now();
    let remaining = Number.POSITIVE_INFINITY;
    let migrated = 0;
    while (remaining > 0) {
      const step = await call(`/setup?db=${db}`, { method: "POST" });
      ({ remaining } = step);
      migrated += step.migrationsApplied;
      console.log(
        `setup ${db}: ${step.migrationsApplied} migrations applied, ${remaining} people still to seed (${Math.round(step.ms)} ms beside the database)`,
      );
    }
    console.log(
      `setup ${db}: done in ${Math.round((Date.now() - started) / 1000)} s (${migrated} migrations applied)`,
    );
  }
}

// 2. Conformance.
const conformance = await call("/conformance");
console.log(
  `\n== Conformance: ${conformance.all.length} probes, ${conformance.same} the same on both`,
);
for (const probe of conformance.all) {
  const mark = probe.same ? "same   " : allow[probe.name] ? "ALLOWED" : "DIFFERS";
  console.log(`${mark} ${probe.name}: ${probe.about}`);
  if (!probe.same) {
    console.log(`    D1:        ${show(probe.d1)}`);
    console.log(`    client db: ${show(probe.clientDb)}`);
    if (allow[probe.name]) console.log(`    allowed:   ${allow[probe.name]}`);
  } else {
    console.log(`    both:      ${show(probe.d1)}`);
  }
}
const unallowed = conformance.all.filter((p) => !p.same && !allow[p.name]).map((p) => p.name);

// 3. Warm timing.
const results = [];
for (const from of FROMS) {
  for (const scenario of SCENARIOS) {
    const inside = Object.fromEntries(DATABASES.map((db) => [db, []]));
    let statements = 0;
    const failed = {};
    for (let round = 0; round < rounds; round += 1) {
      for (const db of round % 2 ? [...DATABASES].reverse() : DATABASES) {
        if (failed[db]) continue;
        try {
          const result = await call(
            `/time?db=${db}&scenario=${scenario}&runs=${runs}&from=${from}`,
          );
          inside[db].push(...result.times);
          statements = result.statementsPerRun;
        } catch (error) {
          // Reported, and the run goes on: a limit on the service is itself a finding.
          failed[db] = error.message.slice(0, 300);
        }
      }
    }
    for (const db of DATABASES) {
      results.push({
        from,
        scenario,
        db,
        statements,
        failed: failed[db] ?? null,
        ...summarise(inside[db]),
      });
    }
  }
}
console.log(
  "\n== Warm, ms. near: beside the databases (read this). edge: where the request landed.",
);
console.log(
  "client: the host's shape (the query-only service). direct: the same object by its namespace.",
);
console.log(
  "from  scenario      statements  D1 median  D1 p95  client median  client p95  direct median  direct p95",
);
const pair = (from, scenario) =>
  DATABASES.map((db) =>
    results.find((r) => r.from === from && r.scenario === scenario && r.db === db),
  );
for (const from of FROMS) {
  for (const scenario of SCENARIOS) {
    const [d1, client, direct] = pair(from, scenario);
    console.log(
      `${from.padEnd(5)} ${scenario.padEnd(13)} ${String(d1.statements).padStart(10)} ${String(d1.median).padStart(10)} ${String(d1.p95).padStart(7)} ${String(client.median).padStart(14)} ${String(client.p95).padStart(11)} ${String(direct.median).padStart(14)} ${String(direct.p95).padStart(11)}`,
    );
    for (const r of [d1, client, direct]) {
      if (r.failed) console.log(`    ${r.db} FAILED: ${r.failed}`);
    }
  }
}

// 4. Cold start.
const cold = [];
if (coldSamples > 0) {
  const run = Date.now().toString(36);
  const instances = [];
  for (let i = 0; i < coldSamples; i += 1) {
    const { instance } = await call(`/cold/setup?run=${run}&i=${i}`, { method: "POST" });
    instances.push(instance);
  }
  for (let i = 0; i < coldSamples; i += 1) {
    console.log(
      `cold sample ${i + 1}/${coldSamples}: waiting ${coldWait} s with both databases idle`,
    );
    await sleep(coldWait);
    const order = i % 2 ? "client-first" : "d1-first";
    cold.push(await call(`/cold/time?run=${run}&i=${i}&order=${order}&instance=${instances[i]}`));
  }
  console.log(
    "\n== Cold: the first staff page after the idle wait, ms (near): the first query alone + the rest of the page = total",
  );
  const parts = (p) =>
    `${Math.round(p.firstQueryMs)} + ${Math.round(p.pageMs)} = ${Math.round(p.totalMs)}`;
  for (const s of cold) {
    console.log(
      `D1 ${parts(s.d1)}   client db ${parts(s.clientDb)}   (the object ${s.clientWasCold ? "had been evicted: a real cold start" : "was still in memory: NOT a cold sample"})`,
    );
  }
}

// 5. Subrequests.
const subrequests = [];
for (const db of DATABASES) {
  subrequests.push(await call(`/subrequests?db=${db}&max=${subrequestMax}&fetches=${fetches}`));
}
console.log(
  `\n== Calls one request makes (${fetches} fetches first, then up to ${subrequestMax} queries; near)`,
);
for (const s of subrequests) {
  console.log(
    `${s.db}: ${s.fetched} fetches, ${s.queries} queries in ${s.ms} ms, then ${s.error ? `refused: ${s.error.slice(0, 200)}` : "no limit reached"}`,
  );
}

// 6. Verdict.
const reasons = [];
for (const r of results) {
  if (r.failed && r.db !== "client-db-direct") {
    reasons.push(`${r.from} ${r.scenario} on ${r.db} failed: ${r.failed}`);
  }
}
for (const scenario of ["staff-list", "record-page"]) {
  const [d1, client] = pair("near", scenario);
  if (client.median > 1.5 * d1.median || client.median - d1.median > 20) {
    reasons.push(
      `${scenario} near median ${client.median} ms against D1's ${d1.median} ms (over 1.5x or 20 ms more)`,
    );
  }
}
{
  const [d1, client] = pair("near", "checkout");
  if (client.p95 > 2 * d1.p95)
    reasons.push(`checkout near p95 ${client.p95} ms against D1's ${d1.p95} ms (over 2x)`);
}
const realCold = cold.filter((s) => s.clientWasCold);
if (realCold.length > 0) {
  const extra = summarise(realCold.map((s) => s.clientDb.totalMs - s.d1.totalMs)).median;
  const first = summarise(realCold.map((s) => s.clientDb.firstQueryMs - s.d1.firstQueryMs)).median;
  console.log(
    `\nCold, median over ${realCold.length} real cold sample(s): the client's first page ${Math.round(extra)} ms more than D1's, of which the first query ${Math.round(first)} ms`,
  );
  if (extra > 300)
    reasons.push(
      `a cold first page ${Math.round(extra)} ms worse than D1's (over 300 ms; the first query alone ${Math.round(first)} ms)`,
    );
} else if (coldSamples > 0) {
  reasons.push(
    "no cold sample was really cold: the cold start is unmeasured (run again with a longer --cold-wait)",
  );
}
if (unallowed.length) reasons.push(`conformance differences not allowed: ${unallowed.join(", ")}`);
console.log(
  reasons.length
    ? `\nVERDICT: STOP and return to the owner before step 2:\n${reasons.map((r) => `  - ${r}`).join("\n")}`
    : "\nVERDICT: within the review's thresholds (go on to step 2, the owner deciding)",
);

if (values.out) {
  // No URL: it names the account's workers.dev subdomain.
  writeFileSync(
    values.out,
    `${JSON.stringify({ runs, rounds, coldWait, results, cold, subrequests, conformance, verdict: reasons }, null, 2)}\n`,
  );
}
if (unallowed.length) {
  console.error(
    `Failing: ${unallowed.length} conformance difference(s) not in conformance-allow.json.`,
  );
  process.exit(1);
}
