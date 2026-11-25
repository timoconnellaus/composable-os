// Which blocks have pictures, and the fingerprint of what each picture is drawn from. Node only,
// no install: the docs site's check (apps/docs/scripts/generate.mjs --check) reads it to fail on a
// block with no picture or a picture older than its block or its preview.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const PREVIEWS = join(ROOT, "apps/screens/previews");
/** Where the pictures and their manifest are written: served by the docs site at /screens/. */
export const OUT = join(ROOT, "apps/docs/public/screens");
export const MANIFEST = join(OUT, "screens.json");

const previewsOf = (root) => join(root, "apps/screens/previews");
const outOf = (root) => join(root, "apps/docs/public/screens");

/** Blocks that draw nothing on their own: helpers other blocks import. */
export const NOT_SCREENS = new Set(["ui-utils"]);

/** Every block (a folder with a block.json) in blocks/ and packs/<id>/blocks/, by name. */
export function allBlocks(root = ROOT) {
  const found = [];
  const scan = (parent, pack) => {
    if (!existsSync(parent)) return;
    for (const name of readdirSync(parent).sort()) {
      const dir = join(parent, name);
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, "block.json"))) continue;
      const json = JSON.parse(readFileSync(join(dir, "block.json"), "utf8"));
      found.push({ name, dir, pack, skin: json.skin, dependsOn: json.dependsOn ?? [] });
    }
  };
  scan(join(root, "blocks"), null);
  if (existsSync(join(root, "packs"))) {
    for (const pack of readdirSync(join(root, "packs")).sort()) {
      scan(join(root, "packs", pack, "blocks"), pack);
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** The blocks that should have a picture. */
export function screenBlocks(root = ROOT) {
  return allBlocks(root).filter((b) => !NOT_SCREENS.has(b.name));
}

function files(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else if (/\.(tsx?|json|css)$/.test(entry.name)) out.push(path);
  }
  return out.sort();
}

/** A preview and the shared dummy data it imports (`./data/<file>.ts` or `.tsx`), and what that imports. */
function previewFiles(preview, root) {
  const out = [];
  const visit = (path) => {
    if (out.includes(path) || !existsSync(path)) return;
    out.push(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/from\s+"(\.{1,2}\/[^"]+\.tsx?)"/g)) {
      const target = join(path, "..", match[1]);
      if (target.startsWith(join(previewsOf(root), "data"))) visit(target);
    }
  };
  visit(preview);
  return out;
}

/** What a preview and its dummy data import: blocks by name, and packs' headless entries. */
function previewImports(sources) {
  const text = sources.join("\n");
  return {
    blocks: [...text.matchAll(/from\s+"[^"]*\/blocks\/([a-z0-9-]+)\/[^"]+"/g)].map((m) => m[1]),
    packs: [...text.matchAll(/from\s+"@composable-os\/pack-([a-z0-9-]+)\/client"/g)].map(
      (m) => m[1],
    ),
    client: /from\s+"@composable-os\/client"/.test(text),
  };
}

/**
 * What a block's picture is drawn from: the block and every block it depends on or its preview
 * imports (their code and block.json), the headless entries whose hooks it is given (its pack's,
 * any pack's its preview imports, and packages/client's for a base-layer block), the harness, its
 * preview and the shared dummy data it imports. Any of them changing makes the picture stale.
 */
export function fingerprint(block, blocks = allBlocks(), root = ROOT) {
  const byName = new Map(blocks.map((b) => [b.name, b]));
  const preview = previewFiles(join(previewsOf(root), `${block.name}.tsx`), root);
  const imports = previewImports(preview.map((path) => readFileSync(path, "utf8")));
  const seen = new Set();
  const dirs = [];
  const packs = new Set(imports.packs);
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const b = byName.get(name);
    if (!b) return;
    dirs.push(b.dir);
    if (b.pack) packs.add(b.pack);
    for (const dep of b.dependsOn) visit(dep);
  };
  visit(block.name);
  for (const name of imports.blocks) visit(name);
  const paths = [
    ...dirs.flatMap(files),
    ...[...packs].flatMap((pack) => files(join(root, "packs", pack, "client"))),
    ...(!block.pack || imports.client ? files(join(root, "packages/client/src")) : []),
    ...files(join(root, "apps/screens/src")),
    ...preview,
    join(root, "templates/client/apps/web/src/styles.css"),
  ];
  const hash = createHash("sha256");
  for (const path of [...new Set(paths)].sort()) {
    if (!existsSync(path)) continue;
    hash.update(relative(root, path));
    hash.update("\0");
    // Line endings never make a picture stale.
    hash.update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** The manifest the picture script wrote: each block's picture, its size and fingerprint. */
export function readManifest(root = ROOT) {
  const file = join(outOf(root), "screens.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * What is wrong with the pictures, without drawing any: a block with no preview, a block with no
 * picture, a picture whose block or preview changed since it was drawn, a preview of no block.
 */
export function problems(root = ROOT) {
  // A repository without the harness (a test's fixture) has no pictures to check.
  if (!existsSync(join(root, "apps/screens"))) return [];
  const PREVIEWS = previewsOf(root);
  const OUT = outOf(root);
  const blocks = allBlocks(root);
  const wanted = screenBlocks(root);
  const manifest = readManifest(root);
  const out = [];
  const names = new Set(blocks.map((b) => b.name));
  for (const b of wanted) {
    const preview = join(PREVIEWS, `${b.name}.tsx`);
    if (!existsSync(preview)) {
      out.push(`${b.name}: no preview (apps/screens/previews/${b.name}.tsx)`);
      continue;
    }
    const shot = manifest[b.name];
    if (!shot || !existsSync(join(OUT, `${b.name}.png`))) {
      out.push(`${b.name}: no picture (pnpm --filter @composable-os/screens shoot ${b.name})`);
    } else if (shot.fingerprint !== fingerprint(b, blocks, root)) {
      out.push(
        `${b.name}: the picture is stale (pnpm --filter @composable-os/screens shoot ${b.name})`,
      );
    }
  }
  if (existsSync(PREVIEWS)) {
    for (const file of readdirSync(PREVIEWS)) {
      if (!file.endsWith(".tsx")) continue;
      const name = file.slice(0, -4);
      if (!names.has(name) || NOT_SCREENS.has(name)) out.push(`previews/${file}: no such block`);
    }
  }
  for (const name of Object.keys(manifest)) {
    if (!names.has(name)) out.push(`screens/${name}.png: no such block`);
  }
  return out;
}
