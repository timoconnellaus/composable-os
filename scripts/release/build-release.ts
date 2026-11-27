#!/usr/bin/env node
// Builds a release (ADR 0053, ADR 0160): every Worker bundled exactly as `wrangler deploy` would
// upload it (`wrangler deploy --dry-run --outdir`, the repository's pinned wrangler), cos-app's
// static assets, the core migrations and the manifest, packed into one deterministic tar.gz.
//
//   <out>/<prefix>-<version>.tar.gz          the bundle (manifest.json, modules/, assets/, migrations/)
//   <out>/<prefix>-<version>.manifest.json   the manifest alone, for preflight without the bundle
//   <out>/SHA256SUMS                         sha256 of both
//
// <prefix> comes from the product (releaseFilePrefix in packages/product).
//
// Two builds of the same commit produce the same bytes (reproducibility is checked in CI by
// building twice). Nothing about the output depends on time, the machine or build order.
//
// Usage: node scripts/release/build-release.ts --version 1.2.3 [--product crm] [--out release-out]
//          [--repository owner/repo] [--skip-build]
//        node scripts/release/build-release.ts --version 1.2.3 --products all [--out release-out]
//
// --product is a product id (products/<id>/product.ts) or the path of a product.ts; the default is
// the repository's default product. The Workers, their resources, the release files and the
// strings the UI shows are named from it, and nothing else about the build changes.
//
// --products all (what a tag's release builds) builds every product in products/index.ts, each
// into a folder of its own exactly as --product would, then merges them into <out> with one
// SHA256SUMS listing every file (merge.ts). The default product is built as it is with neither
// flag (no COS_PRODUCT set), so its bundle is the same bytes either way.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { loadProduct, PRODUCT_ENV, productFile } from "@composable-os/product/node";
import { repositoryPackIds } from "@composable-os/product/packs";
import { DEFAULT_PRODUCT, products } from "@composable-os/products";
import {
  assertUnresolved,
  assetHash,
  clientKitEntry,
  formatSums,
  isVersion,
  type ManifestModule,
  normaliseGzipHeader,
  releaseAssetNames,
  sha256Hex,
  stableStringify,
  writeTar,
} from "@composable-os/release";
import { collectClientKit } from "./client-kit.ts";
import {
  generateManifest,
  readDeployablePackages,
  readMigrations,
  type WorkerBuild,
} from "./manifest-lib.ts";
import { mergeReleaseParts } from "./merge.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const MODULE_TYPES: Record<string, ManifestModule["type"]> = {
  ".js": "esm",
  ".mjs": "esm",
  ".txt": "text",
  ".svg": "text",
  ".html": "text",
  ".sql": "text",
  ".wasm": "wasm",
  ".bin": "data",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const posix = (path: string) => path.split(sep).join("/");

/** Reads a `wrangler deploy --dry-run --outdir` directory into modules (source maps dropped). */
async function collectModules(outDir: string) {
  const modules: (ManifestModule & { bytes: Uint8Array })[] = [];
  for (const file of walk(outDir)) {
    const name = posix(relative(outDir, file));
    if (name.endsWith(".map") || name === "README.md") continue;
    const type = MODULE_TYPES[extname(name)];
    if (!type) throw new Error(`unrecognised module in ${outDir}: ${name}`);
    const bytes = new Uint8Array(readFileSync(file));
    modules.push({ name, type, sha256: await sha256Hex(bytes), size: bytes.length, bytes });
  }
  const main =
    modules.find((m) => m.name === "index.js") ??
    modules.find((m) => m.type === "esm" && !m.name.includes("/"));
  if (!main) throw new Error(`no entry module in ${outDir}`);
  return { mainModule: main.name, modules };
}

/** Reads a static-asset directory, honouring its .assetsignore (exact names). */
export async function collectAssets(dir: string) {
  let ignore = new Set<string>([".assetsignore"]);
  try {
    ignore = new Set([
      ".assetsignore",
      ...readFileSync(join(dir, ".assetsignore"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ]);
  } catch {}
  const files: Record<string, { hash: string; size: number }> = {};
  const blobs = new Map<string, Uint8Array>();
  for (const file of walk(dir)) {
    const rel = posix(relative(dir, file));
    if (ignore.has(rel)) continue;
    const bytes = new Uint8Array(readFileSync(file));
    const path = `/${rel}`;
    const hash = await assetHash(bytes, path);
    files[path] = { hash, size: bytes.length };
    blobs.set(hash, bytes);
  }
  return { files, blobs };
}

function run(cwd: string, command: string, args: string[], env: Record<string, string> = {}) {
  console.log(`$ (${relative(ROOT, cwd) || "."}) ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: "true", ...env },
  });
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i] as string;
    if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key.slice(2)] = true;
    else {
      args[key.slice(2)] = next;
      i++;
    }
  }
  return args;
}

/**
 * The products `--products` names, in order, each as `--product` would take it: `all` is every
 * product in products/index.ts. The default product is given as undefined, so it is built exactly
 * as a build with neither flag builds it (no COS_PRODUCT set).
 */
export function productsToBuild(value: string): (string | undefined)[] {
  const ids = value === "all" ? Object.keys(products) : value.split(",").map((id) => id.trim());
  if (!ids.length || ids.some((id) => !id)) throw new Error("--products names no product");
  if (new Set(ids).size !== ids.length) throw new Error("--products names a product twice");
  for (const id of ids) {
    if (!products[id]) {
      throw new Error(`--products: no product ${id} (${Object.keys(products).join(", ")})`);
    }
  }
  return ids.map((id) => (id === DEFAULT_PRODUCT ? undefined : id));
}

/** The products a `--products` build makes (`productsToBuild`), after refusing what cannot go with it. */
export function productsOfArgs(
  args: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
): (string | undefined)[] {
  if (typeof args.products !== "string") throw new Error("--products needs a value (all)");
  // Each product is built with its own COS_PRODUCT: without a build, every product's bundle
  // would be made from whatever the last build left in dist/ (review of #553).
  if (args["skip-build"]) throw new Error("--products builds every product: not with --skip-build");
  if (args.product !== undefined || env[PRODUCT_ENV]?.trim()) {
    throw new Error(
      `--products builds each product itself: give neither --product nor ${PRODUCT_ENV}`,
    );
  }
  return productsToBuild(args.products);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = String(args.version ?? process.env.RELEASE_VERSION ?? "0.0.0-beta.0").replace(
    /^v/,
    "",
  );
  if (!isVersion(version))
    throw new Error(`--version must be X.Y.Z or X.Y.Z-beta.N, got ${version}`);
  const out = resolve(String(args.out ?? "release-out"));
  if (args.products !== undefined) {
    const ids = productsOfArgs(args, process.env);
    const partsDir = mkdtempSync(join(tmpdir(), "cos-release-parts-"));
    try {
      const parts = [];
      for (const id of ids) {
        const product = await loadProduct(id ?? DEFAULT_PRODUCT);
        const dir = join(partsDir, product.id);
        await buildOne(args, version, dir, id);
        parts.push({ product: product.id, dir });
      }
      const sums = await mergeReleaseParts(parts, version, out);
      console.log(
        `\n${parts.map((p) => p.product).join(", ")} ${version} -> ${relative(process.cwd(), out)}\n${sums}`,
      );
    } finally {
      rmSync(partsDir, { recursive: true, force: true });
    }
    return;
  }
  const chosen = typeof args.product === "string" ? args.product : process.env[PRODUCT_ENV]?.trim();
  await buildOne(args, version, out, chosen || undefined);
}

/** Builds one product's release into `out`: `chosen` as --product takes it, else the default. */
async function buildOne(
  args: Record<string, string | boolean>,
  version: string,
  out: string,
  chosen: string | undefined,
) {
  const product = await loadProduct(chosen || DEFAULT_PRODUCT);
  // Every build step below bundles the chosen product's definition (packages/product/src/node.ts).
  const productEnv: Record<string, string> = chosen ? { [PRODUCT_ENV]: productFile(chosen) } : {};
  const repository = String(
    args.repository ?? process.env.GITHUB_REPOSITORY ?? product.updateRepository,
  );
  const commit =
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const wranglerVersion = JSON.parse(
    readFileSync(join(ROOT, "apps/app/node_modules/wrangler/package.json"), "utf8"),
  ).version as string;

  // 1. Build every package (turbo): the runner and gatekeepers write their dry-run bundles to dist/.
  // CORE_SCHEMA_VERSION is written from the migration files first, whatever turbo's cache holds.
  if (!args["skip-build"]) {
    run(ROOT, "node", ["packages/db/scripts/schema-version.mjs"]);
    run(ROOT, "pnpm", ["build"], productEnv);
  }

  const packages = readDeployablePackages(ROOT);
  const scratch = mkdtempSync(join(tmpdir(), "cos-release-"));
  const builds: WorkerBuild[] = [];
  const moduleBlobs = new Map<string, Uint8Array>();
  const assetBlobs = new Map<string, Uint8Array>();
  try {
    for (const pkg of packages) {
      const dir = join(ROOT, pkg.dir);
      let outDir = join(dir, "dist");
      let assets: WorkerBuild["assets"];
      if (pkg.role === "app") {
        // vite build wrote dist/server (the Worker) and dist/client (assets); wrangler bundles the
        // redirected config the Cloudflare Vite plugin left in .wrangler/deploy.
        outDir = join(scratch, "app");
        run(
          dir,
          "pnpm",
          ["exec", "wrangler", "deploy", "--dry-run", "--outdir", outDir],
          productEnv,
        );
        const collected = await collectAssets(join(dir, "dist/client"));
        const generated = JSON.parse(readFileSync(join(dir, "dist/server/wrangler.json"), "utf8"));
        const { directory: _directory, binding: _binding, ...config } = generated.assets ?? {};
        assets = { config, files: collected.files };
        for (const [hash, bytes] of collected.blobs) assetBlobs.set(hash, bytes);
      }
      const { mainModule, modules } = await collectModules(outDir);
      for (const m of modules) moduleBlobs.set(m.sha256, m.bytes);
      builds.push({
        pkg,
        mainModule,
        modules: modules.map(({ bytes: _bytes, ...m }) => m),
        ...(assets ? { assets } : {}),
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const migrations = readMigrations(ROOT);
  const manifest = await generateManifest(
    { root: ROOT, product, version, commit, repository, wranglerVersion },
    builds,
    migrations,
  );
  assertUnresolved(manifest);
  // The client kit (stage 24): template, skills, blocks and the API contract. Its packs.json is
  // every pack the release carries, as the runner's bundle does (ADR 0420 as amended).
  const kit = collectClientKit(ROOT, repositoryPackIds(ROOT));
  manifest.client = await clientKitEntry(kit);

  const manifestText = `${stableStringify(manifest)}\n`;
  const enc = new TextEncoder();
  const entries: { path: string; bytes: Uint8Array }[] = [
    { path: "manifest.json", bytes: enc.encode(manifestText) },
  ];
  for (const [sha, bytes] of moduleBlobs) entries.push({ path: `modules/${sha}`, bytes });
  for (const [hash, bytes] of assetBlobs) entries.push({ path: `assets/${hash}`, bytes });
  for (const [name, sql] of migrations)
    entries.push({ path: `migrations/${name}`, bytes: enc.encode(sql) });
  for (const [path, bytes] of kit) entries.push({ path: `client/${path}`, bytes });
  // node:zlib at a fixed level; the header's time and OS bytes are pinned.
  const bundle = normaliseGzipHeader(new Uint8Array(gzipSync(writeTar(entries), { level: 9 })));

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const names = releaseAssetNames(product.id, version);
  writeFileSync(join(out, names.bundle), bundle);
  writeFileSync(join(out, names.manifest), manifestText);
  const sums = formatSums(
    new Map([
      [names.bundle, await sha256Hex(bundle)],
      [names.manifest, await sha256Hex(manifestText)],
    ]),
  );
  writeFileSync(join(out, names.sums), sums);
  console.log(
    `\n${product.label} ${version}: ${manifest.workers.length} Workers, ${moduleBlobs.size} modules, ` +
      `${assetBlobs.size} assets, ${migrations.length} migrations -> ${relative(process.cwd(), out)}\n${sums}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`release build failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
