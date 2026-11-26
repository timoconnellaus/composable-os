// The host's migrations as data, for the proof Worker to apply inside the client's object and to
// its D1 database (src/generated/migrations.json, gitignored): split into statements the way the
// test suites read them.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";

const dir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
const out = fileURLToPath(new URL("../src/generated/", import.meta.url));
const migrations = await readD1Migrations(dir);
mkdirSync(out, { recursive: true });
writeFileSync(`${out}migrations.json`, `${JSON.stringify(migrations)}\n`);
