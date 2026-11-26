#!/usr/bin/env node
// Runs stage 66 step 2's probes on the deployed proof Worker (ADR 0614): bookmarks and restore on a
// real object, an export and import between D1 and clients' databases, the largest batch and read,
// and how many calls to a client's database one request may make. Prints what each answered and
// fails when bookmarks, restore, the export or the answers did not do what they should.
//
//   PROOF_KEY=… node scripts/step2.mjs --url https://<worker>.workers.dev
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { url: { type: "string" } } });
const key = process.env.PROOF_KEY;
if (!values.url || !key) {
  console.error("usage: PROOF_KEY=… node scripts/step2.mjs --url https://…");
  process.exit(2);
}
const base = values.url.replace(/\/$/, "");

async function call(path) {
  const response = await fetch(`${base}${path}`, { headers: { "x-proof-key": key } });
  const body = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: `${response.status} ${JSON.stringify(body)}` };
  return body;
}

let failed = false;
const show = (name, result, mustPass = true) => {
  console.log(`\n${name}:\n${JSON.stringify(result, null, 2)}`);
  if (mustPass && result?.ok !== true) failed = true;
};

show("Bookmarks and restore (/step2/pitr)", await call("/step2/pitr"));
show("Export and import (/step2/export)", await call("/step2/export"));
show("A 200,000-statement batch and a 40 MB read (/step2/answers)", await call("/step2/answers"));
// Past the documented 10,000 subrequests: where the limit falls, and its error.
show(
  "Calls to a client's database in one request (/step2/calls)",
  await call("/step2/calls?n=12000"),
  false,
);
show("Calls and D1 queries in one request", await call("/step2/calls?n=6000&d1=6000"), false);
if (failed) {
  console.error("\nA step 2 probe failed.");
  process.exit(1);
}
