#!/usr/bin/env node
// The module-level `env` stays out of the host's Workers (stage 66 step 4, ADR 0615).
//
// On a host that serves many clients, `env` from `cloudflare:workers` is the host's own
// environment, never a client's: code that reads it would act for no client, or for all of them.
// The app's and the runner's code reads its environment from its entry (the client decided there)
// or, in the app, from `requestEnv()` (src/server/request-env.ts), the one module allowed to import
// it. This check, run by `pnpm lint`, fails when any other source file of apps/app/src or
// apps/runner/src imports `env` from `cloudflare:workers` (under any alias, or as a namespace),
// and when any of them names CLIENT_DB or ClientDb (`reachesClientDb`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The Workers' source folders, and the one module in each that may import the module `env`. */
export const WORKERS = [
  { dir: "apps/app/src", allowed: ["apps/app/src/server/request-env.ts"] },
  { dir: "apps/runner/src", allowed: ["apps/runner/src/deployment-env.ts"] },
];

const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;
const TEST_FILE = /\.test\.tsx?$/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (SOURCE.test(name) && !TEST_FILE.test(name)) yield path;
  }
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Whether `text` imports the module-level `env` from `cloudflare:workers`. */
export function importsModuleEnv(text) {
  const code = stripComments(text);
  const imports = code.matchAll(
    /\bimport\s+(?!type\b)([^'"`;]*?)\s+from\s+["']cloudflare:workers["']/g,
  );
  for (const [, clause] of imports) {
    if (/\*\s+as\s+\w+/.test(clause)) return true;
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
    for (const part of named.split(",")) {
      const name = part.trim().replace(/^type\s+/, "");
      if (/^env(\s+as\s+\w+)?$/.test(name)) return true;
    }
  }
  // `await import("cloudflare:workers")` hands back the whole module, `env` with it.
  return /\bimport\s*\(\s*["']cloudflare:workers["']\s*\)/.test(code);
}

/**
 * Whether `text` reaches every client's databases directly: the `CLIENT_DB` binding, the
 * `ClientDb` class or `@composable-os/db/client-db`. The app and the runner reach a client's
 * database only as the `DB` of its environment (`clientDatabase`, inside packages/db), so that
 * `CLIENT_DB` can become a service binding to `cos-client-db`'s query-only entrypoint (stage 66
 * step 2) without touching them, and no code of theirs can call an operator's method (restore,
 * migrate, a bookmark) on a client's object.
 */
export function reachesClientDb(text) {
  const code = stripComments(text);
  return /\bCLIENT_DB\b|\bClientDb\b|["']@composable-os\/db\/client-db["']/.test(code);
}

/** Every file under `root` that imports the module `env`, or reaches CLIENT_DB, where it may not. */
export function checkModuleEnv(root) {
  const problems = [];
  for (const { dir, allowed } of WORKERS) {
    for (const path of files(join(root, dir))) {
      const file = relative(root, path).split(sep).join("/");
      if (allowed.includes(file)) continue;
      const text = readFileSync(path, "utf8");
      if (importsModuleEnv(text)) {
        problems.push(
          `${file}: imports the module-level env from cloudflare:workers; read the entry's env, or requestEnv() in the app (ADR 0615)`,
        );
      }
      if (reachesClientDb(text)) {
        problems.push(
          `${file}: reaches CLIENT_DB or ClientDb; a client's database is its environment's DB (ADR 0615)`,
        );
      }
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const problems = checkModuleEnv(root);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
}
