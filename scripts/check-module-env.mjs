#!/usr/bin/env node
// What code below the host's entries may not reach (stage 66 step 4, ADR 0615; review of #512, S1).
//
// On a host that serves many clients, the module-level `env` of `cloudflare:workers` is the host's
// own environment, never a client's, and `exports` (or an ExecutionContext's `ctx.exports`) reaches
// every Durable Object namespace raw and mints entrypoints with any props. The receiving side checks
// the host's proof on names and props (packages/db/src/client-proofs.ts), so a reach without the
// key gets nothing of another client's; this check keeps the reach itself out of the code. It runs
// in `pnpm lint` over the two Workers' sources and every package bundled into them, and fails when a
// file outside its allow-list:
// - imports `env` or `exports` from `cloudflare:workers` (any alias, a namespace import, a
//   re-export, or a dynamic import with a string or template literal);
// - uses `ctx.exports` (or `this.ctx.exports`);
// - imports `deploymentEnv`, the host's own env as the entry modules read it at load;
// - names `CLIENT_DB` or `ClientDb`: a client's database is its environment's `DB`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The packages bundled into cos-app and cos-runner (their own gatekeepers are other Workers). */
const BUNDLED_PACKAGES = [
  "agent-a2ui",
  "agent-core",
  "agent-plugins",
  "agent-voice",
  "auth",
  "calendar-file",
  "client",
  "core",
  "mcp-shared",
  "pdf",
  "product",
  "sdk",
  "ui",
];

/** Every folder scanned, and who may do what (a path, relative to the repository's root). */
export const SCANNED = {
  dirs: [
    "apps/app/src",
    "apps/runner/src",
    "packs",
    ...BUNDLED_PACKAGES.map((name) => `packages/${name}/src`),
  ],
  /** The one module of each Worker that imports the module `env` (and re-exports it as such). */
  moduleEnv: ["apps/app/src/server/request-env.ts", "apps/runner/src/deployment-env.ts"],
  /** Who imports `deploymentEnv`: the entry modules, for what they read at load. */
  deploymentEnv: [
    "apps/app/src/server.ts",
    "apps/app/src/server/request-env.ts",
    "apps/runner/src/index.ts",
    "apps/runner/src/deployment-env.ts",
  ],
  /**
   * Who mints entrypoints with `ctx.exports`: the integration host (each with the host's proof,
   * `ClientObject.proof`) and the fake gatekeeper, which is a gatekeeper on the runner's own env.
   */
  ctxExports: ["apps/runner/src/integrations/host.ts", "apps/runner/src/integrations/fake.ts"],
};

const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;
const TEST_FILE = /\.test\.tsx?$/;

function* files(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "generated") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (SOURCE.test(name) && !TEST_FILE.test(name)) yield path;
  }
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const WORKERS_MODULE = String.raw`["'\x60]cloudflare:workers["'\x60]`;

/** Whether `text` reaches the module-level `env` or `exports` of `cloudflare:workers`. */
export function importsModuleEnv(text) {
  const code = stripComments(text);
  const forbidden = (clause) => {
    if (/\*\s+as\s+\w+/.test(clause) || /^\s*\*\s*$/.test(clause)) return true;
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
    return named.split(",").some((part) => {
      const name = part.trim().replace(/^type\s+/, "");
      return /^(env|exports)(\s+as\s+\w+)?$/.test(name);
    });
  };
  for (const [, clause] of code.matchAll(
    new RegExp(String.raw`\bimport\s+(?!type\b)([^'"\x60;]*?)\s+from\s+${WORKERS_MODULE}`, "g"),
  )) {
    if (forbidden(clause)) return true;
  }
  // `export { env } from`, `export * from`, `export * as w from`.
  for (const [, clause] of code.matchAll(
    new RegExp(String.raw`\bexport\s+(?!type\b)([^'"\x60;]*?)\s+from\s+${WORKERS_MODULE}`, "g"),
  )) {
    if (forbidden(clause)) return true;
  }
  // `await import("cloudflare:workers")` (or a template literal) hands back the whole module.
  return new RegExp(String.raw`\bimport\s*\(\s*${WORKERS_MODULE}\s*\)`).test(code);
}

/** Whether `text` mints entrypoints through an ExecutionContext's `exports`. */
export function usesCtxExports(text) {
  return /\bctx\s*\.\s*exports\b|\bctx\s*\?\.\s*exports\b/.test(stripComments(text));
}

/** Whether `text` imports `deploymentEnv`. */
export function importsDeploymentEnv(text) {
  return /\bimport\s+[^;]*\bdeploymentEnv\b[^;]*\sfrom\s/.test(stripComments(text));
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

/** Every problem under `root`, as "path: message" strings. */
export function checkModuleEnv(root) {
  const problems = [];
  for (const dir of SCANNED.dirs) {
    for (const path of files(join(root, dir))) {
      const file = relative(root, path).split(sep).join("/");
      const text = readFileSync(path, "utf8");
      if (!SCANNED.moduleEnv.includes(file) && importsModuleEnv(text)) {
        problems.push(
          `${file}: imports env or exports from cloudflare:workers; read the entry's env, or requestEnv() in the app (ADR 0615)`,
        );
      }
      if (!SCANNED.ctxExports.includes(file) && usesCtxExports(text)) {
        problems.push(`${file}: mints entrypoints with ctx.exports (ADR 0615)`);
      }
      if (!SCANNED.deploymentEnv.includes(file) && importsDeploymentEnv(text)) {
        problems.push(`${file}: imports deploymentEnv, the host's own env (ADR 0615)`);
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
