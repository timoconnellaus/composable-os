#!/usr/bin/env node
// CI's unit tests, split across runners. One list (SHARDS, below) is the layout: CI's matrix is
// generated from it (`--matrix`), each runner runs its shard by name (`--run`), and `--check`
// (part of `pnpm lint`) fails if a package with a `test` script is in no shard or in two.
//
//   node scripts/ci-unit-shards.mjs --run "core 2/3"   one shard, exactly as CI runs it
//   node scripts/ci-unit-shards.mjs --list             the shards' names
//   node scripts/ci-unit-shards.mjs --check            every package's tests run exactly once
//   node scripts/ci-unit-shards.mjs --matrix           the matrix for .github/workflows/ci.yml
//
// A shard marked `critical` runs on CI's fast runner (the Namespace profile, ADR 0630); the others
// run on GitHub's runners. The profile runs only a few jobs at once, so only the shards that would
// otherwise finish after the e2e shards go there. On Namespace's 8 vCPU (Nov 2026) core 2/3 took
// 168 s and the runner 199 s, against 233-388 s and 292-384 s on GitHub's 4; every other shard
// finishes on GitHub (at most ~290 s) before the e2e shards do on Namespace (~300-320 s).
//
// Each shard is `turbo run test` over some packages, so a test still gets its `^typecheck` first
// and nothing is cached between runs (CI keeps no turbo cache). A package's own suite is split
// with vitest's `--shard=i/n` (it shards by test file, so one long file stays in one shard).
// The last shard takes every package the others do not name, so a new package is never left
// out; `--check` asks turbo what each shard really runs, so a filter that matches the wrong
// packages fails too.
//
// Balanced by measured time, not by count. On main (Nov 2026, the single job at --concurrency=2)
// core took 426-519 s, runner 222-288 s, app 138-222 s, the gatekeepers ~170 s and every other
// package ~190 s together. Core's slowest files are http-isolation (~130 s) and
// audiences-isolation (~80 s); vitest's split by thirds puts them in different shards.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The shards. `critical` sends a shard to the fast runner (above). `filter` is turbo's `--filter` list; `args` go to the package's test script (a
 * sharded package's script must pass them to every vitest run, as apps/app/scripts/test.mjs does);
 * `group` names a package split across several shards; `after` runs once the tests pass.
 * `concurrency` caps how many packages run at once (as `pnpm test --concurrency=2` did).
 */
const NAMED = [
  ...[1, 2, 3].map((i) => ({
    name: `core ${i}/3`,
    group: "core",
    filter: ["@composable-os/core"],
    args: [`--shard=${i}/3`],
    // Core's second third holds its slowest file (http-isolation).
    critical: i === 2,
  })),
  { name: "runner", filter: ["@composable-os/runner"], critical: true },
  ...[1, 2].map((i) => ({
    name: `app ${i}/2`,
    group: "app",
    filter: ["@composable-os/app"],
    args: [`--shard=${i}/2`],
  })),
  {
    name: "gatekeepers",
    filter: ["./packages/gatekeeper-*"],
    // The vendored gatekeepers' thousands of CPU-heavy tests flake when every package runs at
    // once on a 4-vCPU runner.
    concurrency: 2,
    // Wall-clock-sensitive vendored tests, run alone so CPU contention doesn't fail them.
    after: ["--filter", "@composable-os/gatekeeper-microsoft", "test:timing"],
  },
];

/** Everything the named shards leave out: turbo with only `!` filters starts from every package. */
export function restShard(named) {
  const filter = [...new Set(named.flatMap((shard) => shard.filter))].map((f) => `!${f}`);
  return { name: "the rest", filter, concurrency: 2 };
}

export const SHARDS = [...NAMED, restShard(NAMED)];

/** CI's matrix: each shard by name, and whether it runs on the fast runner. */
export function matrix(shards = SHARDS) {
  return { include: shards.map((s) => ({ shard: s.name, critical: Boolean(s.critical) })) };
}

/** `pnpm` arguments that run `shard`'s tests. */
export function turboArgs(shard, { dry = false } = {}) {
  return [
    "exec",
    "turbo",
    "run",
    "test",
    ...shard.filter.map((f) => `--filter=${f}`),
    ...(shard.concurrency ? [`--concurrency=${shard.concurrency}`] : []),
    ...(dry ? ["--dry=json"] : shard.args?.length ? ["--", ...shard.args] : []),
  ];
}

/**
 * What is wrong with a layout, given every package `turbo run test` runs (`all`) and what each
 * shard runs (`runs`: `{ shard, packages }`). Empty when every package runs in exactly one group
 * of shards and every split package's shards are 1/n to n/n.
 */
export function coverageProblems(all, runs) {
  const problems = [];
  const groups = new Map();
  for (const { shard, packages } of runs) {
    if (packages.length === 0) problems.push(`shard "${shard.name}" runs no tests`);
    const key = shard.group ?? shard.name;
    const group = groups.get(key) ?? { shards: [], packages: new Set(packages) };
    group.shards.push(shard);
    if ([...group.packages].sort().join() !== [...packages].sort().join()) {
      problems.push(`the shards of "${key}" do not all run the same packages`);
    }
    groups.set(key, group);
  }
  for (const [key, { shards }] of groups) {
    if (shards.length === 1 && !shards[0].group) continue;
    const parts = shards.map((s) => /^--shard=(\d+)\/(\d+)$/.exec(s.args?.join(" ") ?? ""));
    const count = shards.length;
    const seen = parts.map((m) => (m && Number(m[2]) === count ? Number(m[1]) : 0));
    if (
      seen.sort((a, b) => a - b).join() !== Array.from({ length: count }, (_, i) => i + 1).join()
    ) {
      problems.push(
        `"${key}" is split into ${count} shards but they are not --shard=1/${count} to ${count}/${count}`,
      );
    }
  }
  const owners = new Map();
  for (const [key, { packages }] of groups) {
    for (const pkg of packages) owners.set(pkg, [...(owners.get(pkg) ?? []), key]);
  }
  for (const pkg of all) {
    const keys = owners.get(pkg) ?? [];
    if (keys.length === 0) problems.push(`${pkg} has a test script but is in no shard`);
    if (keys.length > 1) problems.push(`${pkg} is in more than one shard: ${keys.join(", ")}`);
  }
  for (const pkg of owners.keys()) {
    if (!all.includes(pkg)) problems.push(`${pkg} is in a shard but \`pnpm test\` does not run it`);
  }
  return problems;
}

/** The packages whose `test` task a turbo dry run would execute. */
function testedPackages(args) {
  const run = spawnSync("pnpm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed:\n${run.stderr}`);
  const { tasks } = JSON.parse(run.stdout);
  return tasks
    .filter((t) => t.task === "test" && t.command && t.command !== "<NONEXISTENT>")
    .map((t) => t.package)
    .sort();
}

function pnpm(args) {
  console.log(`$ pnpm ${args.join(" ")}`);
  const run = spawnSync("pnpm", args, { stdio: "inherit" });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, name] = process.argv.slice(2);
  if (command === "--matrix") {
    process.stdout.write(`${JSON.stringify(matrix())}\n`);
  } else if (command === "--list") {
    for (const shard of SHARDS) console.log(shard.name);
  } else if (command === "--run") {
    const shard = SHARDS.find((s) => s.name === name);
    if (!shard) {
      console.error(`No shard "${name}". The shards: ${SHARDS.map((s) => s.name).join(", ")}`);
      process.exit(1);
    }
    pnpm(turboArgs(shard));
    if (shard.after) pnpm(shard.after);
  } else if (command === "--check") {
    const all = testedPackages(["exec", "turbo", "run", "test", "--dry=json"]);
    const runs = SHARDS.map((shard) => ({
      shard,
      packages: testedPackages(turboArgs(shard, { dry: true })),
    }));
    const problems = coverageProblems(all, runs);
    if (problems.length > 0) {
      console.error(`ci-unit-shards: ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`ci-unit-shards: ${all.length} packages, each in one of ${SHARDS.length} shards`);
  } else {
    console.error("Usage: ci-unit-shards.mjs --run <shard> | --list | --check | --matrix");
    process.exit(2);
  }
}
