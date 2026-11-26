#!/usr/bin/env node
// Times the deployed proof Worker (stage 66 step 1): D1 against a client's database, a typical
// staff page (the People list, a person's page) and a customer checkout.
//
//   PROOF_KEY=… node scripts/time.mjs --url https://<worker>.workers.dev [--runs 10] [--rounds 5]
//     [--out results.json] [--skip-setup] [--from near,edge]
//
// It sets up both databases (migrations, then the seed in chunks), prints the probes on which D1
// and the client's database answer differently on Cloudflare, then for each scenario asks the
// Worker `rounds` times, alternating databases, to time `runs` runs. `near` times them in a
// Durable Object created beside the databases (the host's own time for a member near them,
// wherever this script runs); `edge` in the Worker where the request landed. It prints the median
// and p95 of every run, and of each request's round trip divided by its runs.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    runs: { type: "string", default: "10" },
    rounds: { type: "string", default: "5" },
    out: { type: "string" },
    "skip-setup": { type: "boolean", default: false },
    from: { type: "string", default: "near,edge" },
  },
});
const key = process.env.PROOF_KEY;
if (!values.url || !key) {
  console.error("usage: PROOF_KEY=… node scripts/time.mjs --url https://… [--runs N] [--rounds N]");
  process.exit(2);
}
const base = values.url.replace(/\/$/, "");
const runs = Number(values.runs);
const rounds = Number(values.rounds);
const SCENARIOS = ["staff-list", "record-page", "checkout"];
const FROMS = values.from.split(",").map((from) => from.trim());
const DATABASES = ["d1", "client-db"];

async function call(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "x-proof-key": key, ...init.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function summarise(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const rank = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
  const round = (n) => Math.round(n * 10) / 10;
  return { n: sorted.length, median: round(rank(0.5)), p95: round(rank(0.95)) };
}

if (!values["skip-setup"]) {
  for (const db of DATABASES) {
    let remaining = Number.POSITIVE_INFINITY;
    while (remaining > 0) {
      ({ remaining } = await call(`/setup?db=${db}`, { method: "POST" }));
      process.stdout.write(`setup ${db}: ${remaining} people to make\r`);
    }
    console.log(`setup ${db}: done                 `);
  }
}

const conformance = await call("/conformance");
console.log(`\nProbes: ${conformance.same} answer the same on D1 and the client's database.`);
for (const probe of conformance.differ) {
  console.log(`  differs: ${probe.name} (${probe.about})`);
  console.log(`    D1:        ${JSON.stringify(probe.d1).slice(0, 300)}`);
  console.log(`    client db: ${JSON.stringify(probe.clientDb).slice(0, 300)}`);
}

const results = [];
for (const from of FROMS) {
  for (const scenario of SCENARIOS) {
    const inside = { d1: [], "client-db": [] };
    const trip = { d1: [], "client-db": [] };
    const colos = new Set();
    for (let round = 0; round < rounds; round += 1) {
      for (const db of round % 2 ? [...DATABASES].reverse() : DATABASES) {
        const started = performance.now();
        const result = await call(`/time?db=${db}&scenario=${scenario}&runs=${runs}&from=${from}`);
        trip[db].push((performance.now() - started) / runs);
        inside[db].push(...result.times);
        if (result.colo) colos.add(result.colo);
      }
    }
    for (const db of DATABASES) {
      results.push({
        from,
        scenario,
        db,
        inside: summarise(inside[db]),
        roundTripPerRun: summarise(trip[db]),
        colos: [...colos],
      });
    }
  }
}

console.log(
  "\nms on Cloudflare. near: timed beside the databases (the host's own time for a member",
);
console.log("near them). edge: timed in the Worker where this request landed (distance included).");
console.log("from  scenario      database    median      p95   per-request median   colo");
for (const r of results) {
  console.log(
    `${r.from.padEnd(5)} ${r.scenario.padEnd(13)} ${r.db.padEnd(11)} ${String(r.inside.median).padStart(6)} ${String(r.inside.p95).padStart(8)} ${String(r.roundTripPerRun.median).padStart(20)}   ${r.colos.join(",")}`,
  );
}
for (const from of FROMS) {
  for (const scenario of SCENARIOS) {
    const [d1, client] = DATABASES.map((db) =>
      results.find((r) => r.from === from && r.scenario === scenario && r.db === db),
    );
    const ratio = (a, b) => (b > 0 ? (a / b).toFixed(2) : "n/a");
    console.log(
      `${from} ${scenario}: client's database / D1, median ${ratio(client.inside.median, d1.inside.median)}x, p95 ${ratio(client.inside.p95, d1.inside.p95)}x`,
    );
  }
}
if (values.out) {
  writeFileSync(
    values.out,
    `${JSON.stringify({ base: new URL(base).host, runs, rounds, results, conformance }, null, 2)}\n`,
  );
}
