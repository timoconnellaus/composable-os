// cos-app's unit tests: the workerd suite (vitest.config.ts), then the Node-side tooling's
// (vitest.node.config.ts), then the two-client suite (vitest.two-client.config.ts, stage 66 step
// 4). Arguments go to the first two, so CI's `--shard=i/n` (scripts/ci-unit-shards.mjs) splits
// each and every file still runs exactly once. The two-client suite is a few files (step 4's
// entries, step 5's caches), which a shard split could leave some shard without (and vitest fails
// a run that finds no test file): it runs whole, once, in the first shard, or in an unsharded run.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";

const args = process.argv.slice(2);
const shard = args.map((arg) => /^--shard=(\d+)\/(\d+)$/.exec(arg)).find(Boolean);
const unsharded = args.filter((arg) => !/^--shard=/.test(arg));

function run(config, runArgs) {
  const result = spawnSync("vitest", ["run", "-c", config, ...runArgs], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("vitest.config.ts", args);
run("vitest.node.config.ts", args);

// A worker of the two-client suite cannot take a second test file (its workerd exits, as core's
// two-client mode's does: packages/core/scripts/test-two-clients.mjs). So its files run in batches
// the size of the worker count, each file with a worker of its own, however few cores the machine
// has (a CI runner's 4 gave 3 workers to 4 files) and however many files the suite grows to. A
// file named on the command line runs only if it is one of the suite's.
if (!shard || shard[1] === "1") {
  const flags = unsharded.filter((arg) => arg.startsWith("-"));
  const named = unsharded.filter((arg) => !arg.startsWith("-"));
  const files = readdirSync(new URL("../test-two-clients", import.meta.url))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => `test-two-clients/${name}`)
    .filter((file) => !named.length || named.some((name) => file.includes(name)));
  const workers = Math.max(1, Math.min(8, availableParallelism() - 2));
  for (let at = 0; at < files.length; at += workers) {
    const batch = files.slice(at, at + workers);
    run("vitest.two-client.config.ts", [`--maxWorkers=${batch.length}`, ...flags, ...batch]);
  }
}
