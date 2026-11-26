#!/usr/bin/env node
// Runs stage 66 step 2's probes on the deployed proof Worker (ADR 0614): bookmarks and restore on a
// real object, an export and import between D1 and clients' databases, the features of real D1
// they use, the largest batch and reads, and the size after deletes.
//
//   PROOF_URL=https://… PROOF_KEY=… node scripts/step2.mjs [--limit 600]
//
// Each probe is driven a call at a time: the Worker works a few seconds, then answers its result
// or a cursor, which is sent back. Every call's progress is printed. A probe that has not finished
// within `--limit` seconds is reported with how far it got. One probe's failure never stops the
// others: every probe runs and prints its result, and the script exits 1 at the end if any failed.
//
// The URL names the account's workers.dev subdomain: it is read from PROOF_URL and never printed.
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { limit: { type: "string", default: "600" } } });
const limitSeconds = Number(values.limit);
if (!Number.isInteger(limitSeconds) || limitSeconds < 10 || limitSeconds > 3600) {
  console.error("--limit must be a whole number of seconds from 10 to 3600");
  process.exit(2);
}
const key = process.env.PROOF_KEY;
const base = (process.env.PROOF_URL ?? "").replace(/\/$/, "");
if (!/^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1):\d{2,5})$/.test(base) || !key) {
  console.error("PROOF_URL (https://…, no path) and PROOF_KEY must be set");
  process.exit(2);
}

/** Which probes must pass; `size` is reported, not judged. */
const PROBES = [
  { name: "pitr", title: "Bookmarks and restore", judged: true },
  { name: "export", title: "Export and import", judged: true },
  { name: "d1", title: "What the export and import use, on real D1", judged: true },
  {
    name: "answers",
    title: "A 200,000-statement batch, a 40 MB read, a 60 MB read refused",
    judged: true,
  },
  { name: "size", title: "Size after deletes, and VACUUM", judged: false },
];

/** One call: a minute at most (the Worker answers within seconds). */
async function call(probe, cursor) {
  const response = await fetch(`${base}/step2/${probe}`, {
    method: "POST",
    headers: { "x-proof-key": key, "content-type": "application/json" },
    body: JSON.stringify({ cursor }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)?.slice(0, 300)}`);
  return body;
}

const failed = [];
for (const probe of PROBES) {
  console.log(`\n== ${probe.title} (/step2/${probe.name})`);
  const started = Date.now();
  let cursor = null;
  let result = null;
  let last = "not started";
  for (let calls = 1; ; calls += 1) {
    if (Date.now() - started > limitSeconds * 1000) {
      result = { ok: false, error: `not finished within ${limitSeconds} s; last: ${last}` };
      break;
    }
    let step;
    try {
      step = await call(probe.name, cursor);
    } catch (error) {
      result = { ok: false, error: `call ${calls} failed: ${error.message}; last: ${last}` };
      break;
    }
    if (step.done) {
      result = step.result;
      break;
    }
    cursor = step.cursor;
    last = step.progress;
    console.log(
      `  call ${calls}, ${Math.round((Date.now() - started) / 1000)} s: ${step.progress}`,
    );
  }
  console.log(JSON.stringify(result, null, 2));
  console.log(`  (${Math.round((Date.now() - started) / 1000)} s)`);
  if (probe.judged && result?.ok !== true) failed.push(probe.name);
}

console.log(
  failed.length
    ? `\nStep 2 probes: ${failed.length} failed (${failed.join(", ")}).`
    : "\nStep 2 probes: every judged probe passed.",
);
process.exit(failed.length ? 1 : 0);
