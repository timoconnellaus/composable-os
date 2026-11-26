#!/usr/bin/env node
// The core suite with two clients taking turns in one isolate (stage 66 step 5, criterion 5,
// ADR 0617): `pnpm --filter @composable-os/core test:two-clients [files…]`. Every test file runs
// with COS_TEST_DB=two-clients (vitest.config.ts, test/two-clients-turns.ts).
//
// In this mode the pool's workerd exits when a worker starts its second test file (its setup file
// loads the whole of core, which a normal setup file does not), so each vitest run is given at most
// one file per worker: the files go in batches the size of the worker count. Every batch runs;
// the failed ones are named at the end.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const given = process.argv.slice(2);
const files = given.length
  ? given
  : readdirSync(new URL("../test", import.meta.url))
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => `test/${name}`);
const workers = Math.max(1, Math.min(8, availableParallelism() - 2));

let passed = 0;
const failed = [];
for (let at = 0; at < files.length; at += workers) {
  const batch = files.slice(at, at + workers);
  const run = spawnSync("vitest", ["run", `--maxWorkers=${batch.length}`, ...batch], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, COS_TEST_DB: "two-clients" },
  });
  if (run.error) throw run.error;
  if (run.status === 0) passed += batch.length;
  else failed.push(...batch);
}
console.log(`two clients: ${passed} test files passed, each with a second client taking turns`);
if (failed.length) {
  console.error(`two clients: batches failed, holding ${failed.join(", ")}`);
  process.exit(1);
}
