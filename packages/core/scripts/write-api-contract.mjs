#!/usr/bin/env node
// Writes packages/core/api/v1/<audience>.json: the HTTP surface's contract for each audience
// (stage 23, ADR 0417). A change to the API is then a diff, and CI fails while the registry and
// the files differ.
//
//   pnpm --filter @composable-os/core api-contract
//
// The registry is read in workerd: this runs test/api-contract.test.ts, which prints each
// audience's contract, and writes what it prints.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "test/api-contract.test.ts", "--silent=false"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", PRINT_API_CONTRACT: "1" },
  },
);
const marker = "API_CONTRACT ";
const lines = `${run.stdout}\n${run.stderr}`.split("\n").filter((l) => l.includes(marker));
if (lines.length !== 5) {
  process.stderr.write(`${run.stdout}\n${run.stderr}\nCould not read the contract.\n`);
  process.exit(1);
}
const dir = join(root, "api", "v1");
mkdirSync(dir, { recursive: true });
const files = [];
for (const line of lines) {
  const rest = line.slice(line.indexOf(marker) + marker.length);
  const space = rest.indexOf(" ");
  const audience = rest.slice(0, space);
  const file = join(dir, `${audience}.json`);
  writeFileSync(file, `${JSON.stringify(JSON.parse(rest.slice(space + 1)), null, 2)}\n`);
  files.push(file);
}
spawnSync("pnpm", ["exec", "biome", "format", "--write", ...files], {
  cwd: root,
  encoding: "utf8",
});
process.stdout.write(`Wrote ${files.length} contract file(s) in ${dir}.\n`);
