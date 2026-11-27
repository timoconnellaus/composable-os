// cos-app's unit tests: the workerd suite (vitest.config.ts), then the Node-side tooling's
// (vitest.node.config.ts), then the two-client suite (vitest.two-client.config.ts, stage 66 step
// 4). Arguments go to the first two, so CI's `--shard=i/n` (scripts/ci-unit-shards.mjs) splits
// each and every file still runs exactly once. The two-client suite is a few files (step 4's
// entries, step 5's caches), which a shard split could leave some shard without (and vitest fails
// a run that finds no test file): it runs whole, once, in the first shard, or in an unsharded run.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const args = process.argv.slice(2);
const shard = args.map((arg) => /^--shard=(\d+)\/(\d+)$/.exec(arg)).find(Boolean);
const unsharded = args.filter((arg) => !/^--shard=/.test(arg));

// A worker of the two-client suite cannot take a second test file (its workerd exits, as core's
// two-client mode's does: packages/core/scripts/test-two-clients.mjs), so each file has a worker
// of its own however few cores the machine has (a CI runner's 4 gave 3 workers for 4 files).
const twoClientFiles = readdirSync(new URL("../test-two-clients", import.meta.url)).filter((name) =>
  name.endsWith(".test.ts"),
).length;

const runs = [
  ["vitest.config.ts", args],
  ["vitest.node.config.ts", args],
  ...(!shard || shard[1] === "1"
    ? [["vitest.two-client.config.ts", [`--maxWorkers=${twoClientFiles}`, ...unsharded]]]
    : []),
];
for (const [config, runArgs] of runs) {
  const run = spawnSync("vitest", ["run", "-c", config, ...runArgs], { stdio: "inherit" });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}
