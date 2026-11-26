// Running a Workers test suite on a client's database instead of D1 (stage 66 step 1, ADR 0612),
// without a copy of its tests: `COS_TEST_DB=client-db pnpm test` (or `pnpm test:client-db` in a
// package that has it). The suite's Worker gains a `CLIENT_DB` binding to `ClientDb` in a Worker
// of its own (testing/client-db-worker.ts), and a first setup file puts that client's database
// where `env.DB` was (testing/use-client-db.ts). With the variable unset nothing changes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** The variable and the value that switch a suite to a client's database. */
export const TEST_DB_VAR = "COS_TEST_DB";
export const CLIENT_DB_MODE = "client-db";

/** The auxiliary Worker the suites' `ClientDb` runs in. */
export const CLIENT_DB_TEST_WORKER = "cos-client-db-test";

export function usingClientDb(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TEST_DB_VAR] === CLIENT_DB_MODE;
}

/** The setup file that swaps `env.DB`; it runs before the suite's own setup files. */
export const CLIENT_DB_SETUP_FILE = fileURLToPath(new URL("./use-client-db.ts", import.meta.url));

let bundled: Promise<string> | undefined;

/** testing/client-db-worker.ts as one module, built once per run. */
function clientDbWorkerScript(): Promise<string> {
  bundled ??= build({
    entryPoints: [fileURLToPath(new URL("./client-db-worker.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:*"],
    write: false,
    logLevel: "error",
  }).then((result) => result.outputFiles[0]?.text ?? "");
  return bundled;
}

interface MiniflareLike {
  durableObjects?: Record<string, unknown>;
  workers?: unknown[];
  [key: string]: unknown;
}

/**
 * The suite's Miniflare options, with the client's database added when the suite runs on it, and
 * unchanged otherwise.
 */
export async function withClientDb<T extends MiniflareLike>(miniflare: T): Promise<T> {
  return usingClientDb() ? addClientDb(miniflare) : miniflare;
}

/**
 * A Worker shaped as `cos-client-db` (apps/client-db) is, named `name`: `ClientDb` and the
 * query-only entrypoint `ClientDbQueries`, for a suite or a Worker that binds them by script name
 * (the proof Worker's tests use it as its `cos-client-db-proof-db`).
 */
export async function clientDbWorker(name = CLIENT_DB_TEST_WORKER) {
  return {
    name,
    modules: [
      { type: "ESModule" as const, path: "client-db.mjs", contents: await clientDbWorkerScript() },
    ],
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CLIENT_DB: { className: "ClientDb", useSQLite: true } },
  };
}

/** `miniflare` with a `CLIENT_DB` binding to `ClientDb`, whatever the suite runs on. */
export async function addClientDb<T extends MiniflareLike>(miniflare: T): Promise<T> {
  return {
    ...miniflare,
    durableObjects: {
      ...miniflare.durableObjects,
      CLIENT_DB: { className: "ClientDb", scriptName: CLIENT_DB_TEST_WORKER, useSQLite: true },
    },
    workers: [...(miniflare.workers ?? []), await clientDbWorker()],
  };
}

/**
 * The operator's binding to every client's database in the two-client suites: the raw namespace,
 * for the test helpers that stand in for step 7's operator commands (`migrate`). Never named
 * `CLIENT_DB`, so the Worker under test holds what production gives it: the query path only.
 */
export const OPERATOR_CLIENT_DB = "OPERATOR_CLIENT_DB";

/**
 * `miniflare` as a many-client host's Worker binds `cos-client-db` (stage 66 step 2): the
 * query-only service `CLIENT_DB_QUERIES` (entrypoint `ClientDbQueries`), and for the suite's
 * operator stand-ins the raw namespace as `OPERATOR_CLIENT_DB`.
 */
export async function addClientDbService<T extends MiniflareLike>(miniflare: T): Promise<T> {
  const services = (miniflare as { serviceBindings?: Record<string, unknown> }).serviceBindings;
  return {
    ...miniflare,
    durableObjects: {
      ...miniflare.durableObjects,
      [OPERATOR_CLIENT_DB]: {
        className: "ClientDb",
        scriptName: CLIENT_DB_TEST_WORKER,
        useSQLite: true,
      },
    },
    serviceBindings: {
      ...services,
      CLIENT_DB_QUERIES: { name: CLIENT_DB_TEST_WORKER, entrypoint: "ClientDbQueries" },
    },
    workers: [...(miniflare.workers ?? []), await clientDbWorker()],
  };
}

/** The suite's setup files, with the swap first when the suite runs on a client's database. */
export function clientDbSetupFiles(setupFiles: string[]): string[] {
  return usingClientDb() ? [CLIENT_DB_SETUP_FILE, ...setupFiles] : setupFiles;
}

/** JSONC → JSON: drops // and /* comments outside strings, and trailing commas. */
function parseJsonc(text: string): Record<string, unknown> {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * A Worker's committed wrangler.jsonc as a many-client deployment has it, for the two-client
 * suites: without what is for local development only (the fake gatekeeper's loopback binding,
 * `GATEKEEPER_FAKE`, which a many-client host refuses, ADR 0616), written next to the original
 * (so its relative paths hold) as `wrangler.two-client.jsonc`, which git ignores. Its path.
 */
export function manyClientWranglerConfig(appDir: string): string {
  const config = parseJsonc(readFileSync(join(appDir, "wrangler.jsonc"), "utf8"));
  const services = config.services as { binding: string }[] | undefined;
  if (services) config.services = services.filter((s) => s.binding !== "GATEKEEPER_FAKE");
  const vars = (config.vars ?? {}) as Record<string, string>;
  delete vars.INTEGRATIONS_FAKE_PROVIDER;
  config.vars = vars;
  const path = join(appDir, "wrangler.two-client.jsonc");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}
