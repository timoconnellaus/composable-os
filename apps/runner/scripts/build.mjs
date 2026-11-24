#!/usr/bin/env node
// cos-runner's shipped build (ADR 0043 as amended 2026-11-23): wrangler bundles the Worker
// (`wrangler deploy --dry-run`, for the product COS_PRODUCT names), then the main module is
// minified for whitespace only. Nothing is renamed and no syntax is rewritten: identifiers,
// `keep_names`, function and class names, string and template contents (the Dynamic Workers'
// entry modules among them) and error stacks' function names are as wrangler emitted them. The
// Text modules (checker.txt, sdk-bundle.txt, shipped.txt) are copied untouched. The source map is
// chained through to the original sources and written next to the module as index.js.map.
//
// Every path that ships the runner builds it here: `pnpm build` (the release, ADR 0160),
// scripts/deploy.mjs (which then uploads this output with --no-bundle) and the bundle budget.
// `wrangler dev` and the tests bundle the sources themselves, unminified.
//
// Usage (from apps/runner): node scripts/build.mjs [--outdir dist] [wrangler args]
import { execFileSync } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { productAlias } from "../../../packages/product/src/node.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Builds cos-runner into `outDir` as it ships. `args` are passed to wrangler (e.g. `--config`).
 * Returns the paths of the main module and its source map.
 */
export async function buildRunner(outDir, args = [], { quiet = false } = {}) {
  const out = resolve(root, outDir);
  await rm(out, { recursive: true, force: true });
  const alias = Object.entries(productAlias()).flatMap(([from, to]) => [
    "--alias",
    `${from}:${to}`,
  ]);
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "deploy", "--dry-run", "--outdir", out, ...alias, ...args],
    { cwd: root, stdio: ["ignore", quiet ? "ignore" : "inherit", "inherit"] },
  );
  const main = join(out, "index.js");
  const map = `${main}.map`;
  await minifyWhitespace(main, map);
  return { main, map };
}

/**
 * Rewrites a bundled module with esbuild's whitespace minification only, keeping a source map
 * chained to the original sources: esbuild reads the module's own `sourceMappingURL` (wrangler's
 * map) and composes the new mappings through it.
 */
export async function minifyWhitespace(main, map) {
  const before = (await stat(main)).size;
  const result = await build({
    entryPoints: [main],
    bundle: false,
    write: false,
    outfile: main,
    allowOverwrite: true,
    format: "esm",
    // Whitespace only: no identifier renaming, no syntax rewriting, no lowering.
    minifyWhitespace: true,
    minifyIdentifiers: false,
    minifySyntax: false,
    target: "esnext",
    // Keep non-ASCII as wrangler emitted it (escaped), so strings are byte-for-byte the same text.
    charset: "ascii",
    legalComments: "none",
    sourcemap: "linked",
    logLevel: "error",
  });
  for (const file of result.outputFiles) await writeFile(file.path, file.contents);
  const after = (await stat(main)).size;
  if (!(await readFile(map, "utf8")).includes('"mappings"'))
    throw new Error(`no source map at ${map}`);
  return { before, after };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--outdir");
  const outDir = at >= 0 ? argv[at + 1] : "dist";
  const args = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv;
  // wrangler's own summary (its "Total Upload") is of the module before minifying, so it is hidden.
  const { main } = await buildRunner(outDir, args, { quiet: true });
  console.log(
    `cos-runner built into ${outDir}: main module ${((await stat(main)).size / 1024).toFixed(0)} KiB, whitespace-minified, with index.js.map`,
  );
}
