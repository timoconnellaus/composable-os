// The packs a release carries (stage 24, Node only: the runner's bundle script, the release build).
//
// A pack is `packs/<id>/`: the shipped extension (`index.ts` and its files), `client/` for headless
// hooks and `blocks/` for its screens. Only the extension runs in the host, so only it is read
// here: the client parts are for client apps and never reach the runner.
//
// A release carries every pack in the repository (`releasePacks`), so a client product can turn on
// any of them at deploy (`COS_PACKS`). Which packs a deployment installs stays that deploy-time
// choice; a release product's own deployments install the packs its product lists
// (`productPacks`, the runner's default), exactly as before (ADR 0420, amended 2026-11-21).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ProductDefinition } from "./index.ts";

/** One pack's extension as source, in the form cos-runner's SHIPPED_EXTENSIONS holds it. */
export interface PackSource {
  id: string;
  version: string;
  /** `composableOs.optional`: shipped but opt-in, installed by an admin (ADR 0246). */
  optional?: true;
  label?: string;
  description?: string;
  /** Path inside the pack → text. */
  files: Record<string, string>;
}

/** Folders of a pack that are never source: build output and tests. */
const NOT_SOURCE = new Set(["node_modules", "test", "tests", "dist", ".turbo"]);
/** Top-level folders of a pack that are client code, not the extension. */
export const PACK_CLIENT_FOLDERS: readonly string[] = ["client", "blocks"];

function sourceFiles(dir: string, base: string, files: Record<string, string>) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (NOT_SOURCE.has(entry.name)) continue;
      if (dir === base && PACK_CLIENT_FOLDERS.includes(entry.name)) continue;
      sourceFiles(path, base, files);
    } else if (/\.(ts|js)$/.test(entry.name) && !/\.(test|config)\.(ts|js)$/.test(entry.name)) {
      files[relative(base, path).split("\\").join("/")] = readFileSync(path, "utf8");
    }
  }
}

/** The ids of every pack in the repository: each folder of `<root>/packs/` with a package.json. */
export function repositoryPackIds(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(root, "packs"));
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      try {
        return statSync(join(root, "packs", name, "package.json")).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

/** The extensions of every pack in the repository, sorted by id: what a release carries. */
export function releasePacks(root: string): PackSource[] {
  return readPacks("the release", repositoryPackIds(root), root);
}

/**
 * The extensions of the packs `product` lists, read from `<root>/packs/<id>/`, sorted by id.
 * Throws when a listed pack has no directory, package.json or index.ts.
 */
export function productPacks(product: ProductDefinition, root: string): PackSource[] {
  return readPacks(`product ${product.id}`, product.packs, root);
}

function readPacks(who: string, ids: readonly string[], root: string): PackSource[] {
  const packs: PackSource[] = [];
  for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
    const dir = join(root, "packs", id);
    let pkg: { version?: string; composableOs?: Record<string, unknown> };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      statSync(join(dir, "index.ts"));
    } catch {
      throw new Error(
        `${who} lists the pack ${id}, and packs/${id}/ has no package.json and index.ts`,
      );
    }
    const meta = pkg.composableOs ?? {};
    const files: Record<string, string> = {};
    sourceFiles(dir, dir, files);
    packs.push({
      id,
      version: String(pkg.version),
      ...(meta.optional ? { optional: true as const } : {}),
      ...(typeof meta.label === "string" ? { label: meta.label } : {}),
      ...(typeof meta.description === "string" ? { description: meta.description } : {}),
      files,
    });
  }
  return packs;
}
