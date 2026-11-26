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
  /** Code that reads `env.NAME`. */
  code: ["apps/app/src", "apps/runner/src", "packages/auth/src", "packages/core/src"],
};

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
  // `env.NAME` and `this.env.NAME`, not `import.meta.env.NAME` (Vite's, not a Worker's).
  return [...text.matchAll(/(?<!import\.meta\.)\benv\??\.([A-Z][A-Z0-9_]+)\b/g)].map(
    (m) => m[1] as string,
  );
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
  return [...names].sort();
}
