// Node-side, read by packages/db/vitest.config.ts: every name the app's and the runner's
// environments declare or their code reads, for test/client-env-names.test.ts (stage 66 step 3).
// Every one must say what it becomes in a client's environment (src/client-env-names.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Where the names come from, relative to the repository's root. */
export const ENV_NAME_SOURCES = {
  /** What `wrangler types` generated from each Worker's wrangler.jsonc. */
  generated: ["apps/app/worker-configuration.d.ts", "apps/runner/worker-configuration.d.ts"],
  /** The secrets and local variables each Worker documents. */
  devVars: ["apps/app/.dev.vars.example", "apps/runner/.dev.vars.example"],
  /** The bindings and secrets the deploy adds (AI, Vectorize, Stream's token, ...). */
  deployInputs: ["apps/app/deploy-inputs.json", "apps/runner/deploy-inputs.json"],
  /** Code that reads `env.NAME`, or `env[X_VAR]` through a constant `X_VAR = "NAME"`. */
  code: [
    "apps/app/src",
    "apps/runner/src",
    "packages/auth/src",
    "packages/core/src",
    "packages/product/src",
  ],
  /** The deploy engine: the vars `cos deploy`, the installer and a release set on a Worker. */
  deployTime: ["packages/create-composable-os/src", "packages/release/src", "scripts"],
};

/**
 * Vars the deploy engine sets on a gatekeeper's Worker, never on the app or the runner: they never
 * reach a client's environment, which is built from the app's and the runner's `env` only.
 */
export const GATEKEEPER_ONLY_VARS: ReadonlySet<string> = new Set([
  "BASE_URL",
  "PAYMENTS_FAKE_PROVIDER",
  "TEXT_PROVIDER",
]);

function generatedNames(text: string): string[] {
  const block = /interface __BaseEnv_Env \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? "";
  return [...block.matchAll(/^\s*([A-Z][A-Z0-9_]*)\??:/gm)].map((m) => m[1] as string);
}

function devVarNames(text: string): string[] {
  return [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string);
}

function deployInputNames(text: string): string[] {
  const names: string[] = [];
  const walk = (value: unknown, key?: string) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    } else if (
      typeof value === "string" &&
      (key === "binding" || key === "name") &&
      /^[A-Z][A-Z0-9_]*$/.test(value)
    ) {
      names.push(value);
    }
  };
  walk(JSON.parse(text));
  return names;
}

function codeFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...codeFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

function codeNames(text: string): string[] {
  // `env.NAME` and `this.env.NAME`, not `import.meta.env.NAME` (Vite's, not a Worker's), and a
  // name held in a `*_VAR` constant (`PRODUCT_LABEL_VAR = "COS_PRODUCT_LABEL"`).
  return [
    ...[...text.matchAll(/(?<!import\.meta\.)\benv\??\.([A-Z][A-Z0-9_]+)\b/g)],
    ...[...text.matchAll(/\b[A-Z][A-Z0-9_]*_VAR\s*=\s*"([A-Z][A-Z0-9_]+)"/g)],
  ].map((m) => m[1] as string);
}

function deployTimeNames(text: string): string[] {
  return [
    // vars.NAME, vars[worker.name]?.NAME
    ...[...text.matchAll(/\bvars(?:\[[^\]\n]+\])?\??\.([A-Z][A-Z0-9_]+)\b/g)],
    // { ...vars[worker], NAME: value }
    ...[...text.matchAll(/\.\.\.vars\[[^\]\n]+\],\s*([A-Z][A-Z0-9_]+)\s*:/g)],
  ]
    .map((m) => m[1] as string)
    .filter((name) => !GATEKEEPER_ONLY_VARS.has(name));
}

function scriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...scriptFiles(path));
    else if (/\.(?:m?[jt]s|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** Every name, sorted, once. */
export function workerEnvNames(): string[] {
  const names = new Set<string>();
  const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
  for (const path of ENV_NAME_SOURCES.generated) {
    for (const name of generatedNames(read(path))) names.add(name);
  }
  for (const path of ENV_NAME_SOURCES.devVars) {
    for (const name of devVarNames(read(path))) names.add(name);
  }
  for (const path of ENV_NAME_SOURCES.deployInputs) {
    for (const name of deployInputNames(read(path))) names.add(name);
  }
  for (const dir of ENV_NAME_SOURCES.code) {
    for (const file of codeFiles(join(ROOT, dir))) {
      for (const name of codeNames(readFileSync(file, "utf8"))) names.add(name);
    }
  }
  for (const dir of ENV_NAME_SOURCES.deployTime) {
    for (const file of scriptFiles(join(ROOT, dir))) {
      for (const name of deployTimeNames(readFileSync(file, "utf8"))) names.add(name);
    }
  }
  return [...names].sort();
}
