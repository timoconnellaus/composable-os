// `cos ext test <dir>`: the extension's Vitest tests, after one check of its own: every tool and
// every automation the extension declares is named in a test file. Tests are required for each
// (ADR 0405); a name no test mentions is a tool or automation no test runs.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExtCheckError } from "./check.ts";
import { evaluateFiles, readExtensionFiles } from "./evaluate.ts";
import { findPlatform } from "./platform.ts";

function testFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", ".turbo"].includes(entry.name)) walk(path);
      } else if (/\.test\.(ts|js)$/.test(entry.name)) {
        files[path] = readFileSync(path, "utf8");
      }
    }
  };
  walk(dir);
  return files;
}

/** Tools and automations of the extension in `dir` that no test file names. */
export async function untested(dir: string): Promise<string[]> {
  const root = resolve(dir);
  const platform = findPlatform(root);
  if (!platform) throw new ExtCheckError(`${dir} is not inside a Composable OS checkout`);
  const evaluated = await evaluateFiles(platform, readExtensionFiles(root));
  if (!evaluated.ok) {
    throw new ExtCheckError(
      `${dir} does not evaluate (${evaluated.issues[0]?.message}); run cos ext check first`,
    );
  }
  const manifest = evaluated.manifest as {
    tools?: Record<string, unknown>;
    automations?: Record<string, unknown>;
  };
  const tests = Object.values(testFiles(root)).join("\n");
  const missing: string[] = [];
  for (const [kind, names] of [
    ["tool", Object.keys(manifest.tools ?? {})],
    ["automation", Object.keys(manifest.automations ?? {})],
  ] as const) {
    for (const name of names) {
      if (!new RegExp(`["'\`]${name}["'\`]`).test(tests)) missing.push(`${kind} ${name}`);
    }
  }
  return missing;
}

/** Runs `vitest run` in `dir` with the caller's terminal. Returns its exit code. */
export function runVitest(dir: string): Promise<number> {
  const root = resolve(dir);
  const bin = join(root, "node_modules", ".bin", "vitest");
  if (!existsSync(bin)) {
    throw new ExtCheckError(
      `${dir} has no vitest installed (node_modules/.bin/vitest). Give it a package.json with ` +
        "vitest in devDependencies, as extensions/deals has, and run pnpm install",
    );
  }
  return new Promise((done, fail) => {
    const child = spawn(bin, ["run"], { cwd: root, stdio: "inherit" });
    child.on("error", fail);
    child.on("exit", (code) => done(code ?? 1));
  });
}
