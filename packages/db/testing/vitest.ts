// Running a Workers test suite on a client's database instead of D1 (stage 66 step 1, ADR 0612),
// without a copy of its tests: `COS_TEST_DB=client-db pnpm test` (or `pnpm test:client-db` in a
// package that has it). The suite's Worker gains a `CLIENT_DB` binding to `ClientDb` in a Worker
// of its own (testing/client-db-worker.ts), and a first setup file puts that client's database
// where `env.DB` was (testing/use-client-db.ts). With the variable unset nothing changes.
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

/** The suite's setup files, with the swap first when the suite runs on a client's database. */
export function clientDbSetupFiles(setupFiles: string[]): string[] {
  return usingClientDb() ? [CLIENT_DB_SETUP_FILE, ...setupFiles] : setupFiles;
}
