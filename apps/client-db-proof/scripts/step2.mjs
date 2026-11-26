#!/usr/bin/env node
// Runs stage 66 step 2's probes on the deployed proof Worker (ADR 0614): bookmarks and restore on a
// real object, an export and import between D1 and clients' databases, the features of real D1
// they use, the largest batch and reads, and the size after deletes. Prints what each answered and
// fails when restore, the export, D1's features or the answers did not do what they should.
//
//   PROOF_URL=https://… PROOF_KEY=… node scripts/step2.mjs
//
// The URL names the account's workers.dev subdomain: it is read from PROOF_URL and never printed.

const key = process.env.PROOF_KEY;
const base = (process.env.PROOF_URL ?? "").replace(/\/$/, "");
if (!/^https:\/\/[^/]+$/.test(base) || !key) {
  console.error("PROOF_URL (https://…, no path) and PROOF_KEY must be set");
  process.exit(2);
}

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
show("What the export and import use, on real D1 (/step2/d1)", await call("/step2/d1"));
show(
  "A 200,000-statement batch, a 40 MB read, a 60 MB read refused (/step2/answers)",
  await call("/step2/answers"),
);
show("Size after deletes, and VACUUM (/step2/size)", await call("/step2/size"), false);
if (failed) {
  console.error("\nA step 2 probe failed.");
  process.exit(1);
}
