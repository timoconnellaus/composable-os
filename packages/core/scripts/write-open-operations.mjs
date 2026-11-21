#!/usr/bin/env node
// Writes packages/core/open-operations.json: every operation open to customers or the public,
// with its risk class (stage 22, ADR 0411). Opening an operation is then a line in a diff.
//
//   pnpm --filter @composable-os/core open-operations
//
// The registry only loads in workerd, so this runs test/open-operations.test.ts, which prints the
// list it computes from the registry, and writes that to the file. `pnpm test` (and so CI) fails
// while the file and the registry differ.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "test/open-operations.test.ts", "--silent=false"],
  { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
);
const marker = "OPEN_OPERATIONS ";
const line = `${run.stdout}\n${run.stderr}`.split("\n").find((l) => l.includes(marker));
if (!line) {
  process.stderr.write(`${run.stdout}\n${run.stderr}\nCould not read the registry's list.\n`);
  process.exit(1);
}
const list = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
const file = join(root, "open-operations.json");
writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
// In the repository's own format, so `pnpm lint` passes on the file as written.
spawnSync("pnpm", ["exec", "biome", "format", "--write", file], { cwd: root, encoding: "utf8" });
process.stdout.write(`Wrote ${file}: ${list.operations.length} open operation(s).\n`);
