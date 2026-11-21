// Evaluating an extension directory outside a deployment, in the steps cos-runner takes for
// `extension.check` (apps/runner/src/executor: compile, then evaluateManifest): the import and
// syntax check (build.ts), the type check (typecheck.ts), then running the built modules with no
// host modules and taking the manifest. The first two are the runner's own functions. The third
// runs here in Node, not in a Dynamic Worker: the code under check is the caller's own and is run
// with the caller's authority, as its tests are.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { EvaluateResult, SourceIssue } from "@composable-os/core/extension-check";
import { buildExtension } from "../build.ts";
import { buildSdkTypes, sdkBundleOptions } from "../sdk-artifacts.ts";
import { createTypechecker } from "../typecheck.ts";
import type { Platform } from "./platform.ts";

const SKIPPED_DIRS = ["node_modules", "test", "tests", "dist", ".turbo"];

/**
 * The files of an extension as the release bundles them (apps/runner/scripts/bundle.mjs): its
 * .ts and .js files, without tests and config.
 */
export function readExtensionFiles(dir: string, base = dir): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.includes(entry.name)) Object.assign(files, readExtensionFiles(path, base));
    } else if (/\.(ts|js)$/.test(entry.name) && !/\.(test|config)\.(ts|js)$/.test(entry.name)) {
      files[relative(base, path).split("\\").join("/")] = readFileSync(path, "utf8");
    }
  }
  return files;
}

interface Toolchain {
  typecheck: (files: Record<string, string>) => SourceIssue[];
  sdkBundle: string;
}

const toolchains = new Map<string, Promise<Toolchain>>();

/** The compiler, the SDK's declarations and the SDK bundle for `platform`, built once a process. */
function toolchain(platform: Platform): Promise<Toolchain> {
  let cached = toolchains.get(platform.sdkSrc);
  if (!cached) {
    cached = (async () => {
      const [{ default: ts }, { build }] = await Promise.all([
        import("typescript"),
        import("esbuild"),
      ]);
      const bundle = await build(sdkBundleOptions(join(platform.sdkSrc, "index.ts")));
      const sdkBundle = bundle.outputFiles?.[0]?.text;
      if (sdkBundle === undefined) throw new Error("esbuild returned no SDK bundle");
      return { typecheck: createTypechecker(ts, buildSdkTypes(ts, platform.sdkSrc)), sdkBundle };
    })();
    toolchains.set(platform.sdkSrc, cached);
  }
  return cached;
}

interface SdkModule {
  isExtension(value: unknown): boolean;
  runExtension(
    extension: unknown,
    request: { kind: "manifest" },
    raw: Record<string, never>,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>;
}

/** Evaluates source to a manifest, or to the source issues that stop it. */
export async function evaluateFiles(
  platform: Platform,
  files: Record<string, string>,
): Promise<EvaluateResult> {
  const built = buildExtension(files);
  if (!built.ok) return { ok: false, commit: null, issues: built.issues };
  const tools = await toolchain(platform);
  const typeIssues = tools.typecheck(files);
  if (typeIssues.length) return { ok: false, commit: null, issues: typeIssues };

  // The built modules import `cos-sdk` (build.ts): a package beside them, as in the sandbox.
  const work = mkdtempSync(join(tmpdir(), "cos-ext-check-"));
  try {
    const sdkDir = join(work, "node_modules", "cos-sdk");
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(work, "package.json"), '{"type":"module"}');
    writeFileSync(join(sdkDir, "package.json"), '{"type":"module","main":"index.js"}');
    writeFileSync(join(sdkDir, "index.js"), tools.sdkBundle);
    for (const [path, code] of Object.entries(built.modules)) {
      const target = join(work, "ext", path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, code);
    }
    const failed = (message: string): EvaluateResult => ({
      ok: false,
      commit: null,
      issues: [{ code: "evaluate", path: "index.ts", message }],
    });
    try {
      const sdk = (await import(
        /* @vite-ignore */ pathToFileURL(join(sdkDir, "index.js")).href
      )) as SdkModule;
      const entry = (await import(
        /* @vite-ignore */ pathToFileURL(join(work, "ext", "index.js")).href
      )) as { default?: unknown };
      if (!sdk.isExtension(entry.default)) {
        return failed("index.ts must export default defineExtension({...})");
      }
      const response = await sdk.runExtension(entry.default, { kind: "manifest" }, {});
      if (!response.ok) return failed(response.error.message);
      return { ok: true, commit: null, manifest: response.value };
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
