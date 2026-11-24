// A release ships every pack and every block on main: each packs/<id>/ is a pack the release
// carries (packs.json, the runner's bundle) and an npm package `@composable-os/pack-<id>`, and each
// folder under blocks/ and packs/*/blocks/ is a block in the client kit `cos add` reads. A folder
// that would silently drop out (no package.json, no block.json) fails here unless it is listed
// below with the reason it is not published.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryPackIds } from "@composable-os/product/packs";
import { describe, expect, it } from "vitest";
import { blockDirs, collectClientKit } from "../client-kit.ts";
import { PACKAGES } from "../npm-packages.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Folders under packs/ deliberately not released, each with why. None today. */
const UNPUBLISHED_PACKS: Record<string, string> = {};

/**
 * Folders under blocks/ or packs/<id>/blocks/ deliberately not released, by path from the root,
 * each with why. None today: the platform's own block tooling is files there, not folders.
 */
const UNPUBLISHED_BLOCKS: Record<string, string> = {};

const folders = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

const packFolders = folders(join(ROOT, "packs")).filter((id) => !(id in UNPUBLISHED_PACKS));
const blockFolders = [
  ...folders(join(ROOT, "blocks")).map((name) => `blocks/${name}`),
  ...folders(join(ROOT, "packs")).flatMap((id) => {
    try {
      return folders(join(ROOT, "packs", id, "blocks")).map((n) => `packs/${id}/blocks/${n}`);
    } catch {
      return [];
    }
  }),
].filter((path) => !(path in UNPUBLISHED_BLOCKS));

const carried = repositoryPackIds(ROOT);
const kit = collectClientKit(ROOT, carried);

describe("what a release publishes", () => {
  it("carries every pack under packs/ in the bundle and the kit's packs.json", () => {
    expect(carried).toEqual(packFolders);
    expect(JSON.parse(new TextDecoder().decode(kit.get("packs.json")))).toEqual(packFolders);
  });

  it("publishes every pack under packs/ to npm as @composable-os/pack-<id>", () => {
    const published = Object.keys(PACKAGES)
      .filter((name) => name.startsWith("@composable-os/pack-"))
      .map((name) => name.slice("@composable-os/pack-".length))
      .sort();
    expect(published).toEqual(packFolders);
  });

  it("ships every folder under blocks/ and packs/*/blocks/ as a block in the client kit", () => {
    const found = blockDirs(ROOT).map(({ dir }) => dir.slice(ROOT.length + 1));
    expect(found.sort()).toEqual(blockFolders);
    for (const path of blockFolders) {
      const name = path.split("/").at(-1);
      expect(kit.has(`blocks/${name}/block.json`), `${path} in the kit`).toBe(true);
      expect(kit.has(`blocks/${name}/LICENSE`), `${path}'s licence in the kit`).toBe(true);
    }
  });

  it("lists only folders that exist in its allow-lists", () => {
    for (const id of Object.keys(UNPUBLISHED_PACKS))
      expect(folders(join(ROOT, "packs"))).toContain(id);
    for (const path of Object.keys(UNPUBLISHED_BLOCKS)) {
      expect(folders(join(ROOT, dirname(path)))).toContain(path.split("/").at(-1));
    }
  });
});
