// cos-app's unit tests: the workerd suite (vitest.config.ts), then the Node-side tooling's
// (vitest.node.config.ts), then the two-client suite. Arguments go to every run, so CI's `--shard=i/n`
// (scripts/ci-unit-shards.mjs) splits each suite and every file still runs exactly once.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
for (const config of [
  "vitest.config.ts",
  "vitest.node.config.ts",
  // Two clients on one deployment (stage 66 step 4, ADR 0615): test-two-clients/.
  "vitest.two-client.config.ts",
]) {
  const run = spawnSync("vitest", ["run", "-c", config, ...args], { stdio: "inherit" });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}
