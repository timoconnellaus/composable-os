// A product's packs, as its release carries them (stage 24, Node only: the runner's bundle script).
//
// A pack is `packs/<id>/`: the shipped extension (`index.ts` and its files), `client/` for headless
// hooks and `blocks/` for its screens. Only the extension runs in the host, so only it is read
// here: the client parts are for client apps and never reach the runner. A pack the product does
// not list is not read at all, so it is not in that product's release.
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

/**
 * The extensions of the packs `product` lists, read from `<root>/packs/<id>/`, sorted by id.
 * Throws when a listed pack has no directory, package.json or index.ts.
 */
export function productPacks(product: ProductDefinition, root: string): PackSource[] {
  const packs: PackSource[] = [];
  for (const id of [...product.packs].sort((a, b) => a.localeCompare(b))) {
    const dir = join(root, "packs", id);
    let pkg: { version?: string; composableOs?: Record<string, unknown> };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      statSync(join(dir, "index.ts"));
    } catch {
      throw new Error(
        `product ${product.id} lists the pack ${id}, and packs/${id}/ has no package.json and index.ts`,
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
