// The sources that are files, not code to run: overviews, guides, the glossary, ADR titles, the
// roadmap's stages, blocks (block.json and their files' header comments) and the gatekeepers'
// packages. Node built-ins only: the documents lane reads these with no install.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { frontMatter, headerComment } from "./lib/text.mjs";

const read = (p) => readFileSync(p, "utf8");
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const dirs = (p) =>
  isDir(p)
    ? readdirSync(p)
        .filter((n) => isDir(join(p, n)))
        .sort()
    : [];

/** The headings every overview has, in this order (skills/… and AGENTS.md name the same). */
export const OVERVIEW_SECTIONS = [
  "What it is for",
  "Concepts",
  "How the pieces fit",
  "Main flows",
  "What is built",
];

/** The pack ids under packs/ (a folder with a package.json and an index.ts). */
export function packIds(root) {
  return dirs(join(root, "packs")).filter(
    (id) =>
      existsSync(join(root, "packs", id, "package.json")) &&
      existsSync(join(root, "packs", id, "index.ts")),
  );
}

function overview(root, file, kind, fallbackId) {
  const { data, body } = frontMatter(read(file));
  return {
    kind,
    id: data.id ?? fallbackId,
    path: relative(root, file),
    title: data.title,
    summary: data.summary,
    stage: data.stage,
    spec: data.spec,
    adrs: data.adrs ?? [],
    operations: data.operations ?? [],
    blocks: data.blocks ?? [],
    behaviours: data.behaviours ?? [],
    body,
  };
}

/** Each pack's docs/overview.md, by pack id. */
export function packOverviews(root) {
  const out = {};
  for (const id of packIds(root)) {
    const file = join(root, "packs", id, "docs", "overview.md");
    if (existsSync(file)) out[id] = overview(root, file, "pack", id);
  }
  return out;
}

/**
 * The core capabilities documented as a unit (Agreements): an overview at
 * `packages/<package>/src/<area>/docs/overview.md`, whose front matter names the operations (by
 * prefix), blocks and behaviours that are its.
 */
export function capabilityOverviews(root) {
  const out = {};
  for (const pkg of dirs(join(root, "packages"))) {
    for (const area of dirs(join(root, "packages", pkg, "src"))) {
      const file = join(root, "packages", pkg, "src", area, "docs", "overview.md");
      if (existsSync(file)) {
        const o = overview(root, file, "capability", area);
        out[o.id] = o;
      }
    }
  }
  return out;
}

/** docs/guides/*.md, in their `order`. */
export function guides(root) {
  const dir = join(root, "docs", "guides");
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md") && n !== "README.md")
    .map((n) => {
      const { data, body } = frontMatter(read(join(dir, n)));
      return {
        id: n.replace(/\.md$/, ""),
        path: `docs/guides/${n}`,
        title: data.title,
        description: data.description,
        order: Number(data.order ?? 99),
        body,
      };
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** ADRs by number: their file and title. */
export function adrs(root) {
  const out = {};
  const dir = join(root, "docs", "adr");
  for (const n of readdirSync(dir)) {
    const m = n.match(/^(\d{4})-.+\.md$/);
    if (!m) continue;
    const first = read(join(dir, n)).split("\n")[0];
    const title = first.replace(/^#\s*ADR\s*\d+\s*[:.]?\s*/i, "").trim();
    out[m[1]] = { number: m[1], path: `docs/adr/${n}`, title };
  }
  return out;
}

/**
 * CONTEXT.md as glossary entries: a paragraph opening with a bold term starts an entry, and the
 * paragraphs after it belong to it. `## ` headings are kept as sections.
 */
export function glossary(root) {
  const text = read(join(root, "CONTEXT.md"));
  const sections = [{ heading: null, entries: [] }];
  let current = null;
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.replace(/\s+$/, "");
    if (!p.trim()) continue;
    const heading = p.match(/^##\s+(.+)$/);
    if (heading) {
      sections.push({ heading: heading[1].trim(), entries: [] });
      current = null;
      continue;
    }
    if (p.startsWith("# ")) continue;
    const term = p.match(/^\*\*([^*\n]+)\*\*([^\n]*)(?:\n([\s\S]*))?$/);
    if (term) {
      current = { term: term[1].trim(), note: term[2].trim(), body: (term[3] ?? "").trim() };
      sections.at(-1).entries.push(current);
    } else if (current) {
      current.body += `\n\n${p}`;
    } else {
      sections.at(-1).intro = `${sections.at(-1).intro ?? ""}\n\n${p}`.trim();
    }
  }
  return sections.filter((s) => s.entries.length || s.intro);
}

/** The roadmap's stages from 29 on (the table with a spec link per stage). */
export function roadmapStages(root) {
  const out = [];
  for (const line of read(join(root, "docs", "roadmap.md")).split("\n")) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*([^|]*?)\s*\|$/);
    if (!m || Number(m[1]) < 29) continue;
    const spec = m[3].match(/\(\[spec\]\((stages\/[^)]+)\)\)/);
    out.push({
      stage: m[1],
      name: m[2],
      scope: m[3].replace(/\s*\(\[spec\]\([^)]*\)\)/, "").trim(),
      spec: spec ? `docs/${spec[1]}` : null,
      status: m[4],
    });
  }
  return out;
}

/** Every shipped block: its block.json and what its first file says it shows. */
export function blocks(root) {
  const places = [
    join(root, "blocks"),
    ...packIds(root).map((id) => join(root, "packs", id, "blocks")),
  ];
  const out = [];
  for (const place of places) {
    for (const name of dirs(place)) {
      const file = join(place, name, "block.json");
      if (!existsSync(file)) continue;
      const json = JSON.parse(read(file));
      const first = (json.files ?? []).find((f) => /\.(tsx?|jsx?)$/.test(f));
      const shows =
        first && existsSync(join(place, name, first))
          ? headerComment(read(join(place, name, first)))
          : "";
      out.push({ ...json, dir: relative(root, join(place, name)), shows });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The gatekeeper module names the contract lists (packages/sdk/src/contract.ts). */
export function gatekeeperModules(root) {
  const text = read(join(root, "packages", "sdk", "src", "contract.ts"));
  const m = text.match(/export const GATEKEEPER_MODULES = \[([\s\S]*?)\] as const/);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

/** The gatekeeper packages: their package.json, contract file and header. */
export function gatekeepers(root) {
  const modules = new Set(gatekeeperModules(root));
  return dirs(join(root, "packages"))
    .filter((n) => n.startsWith("gatekeeper-"))
    .map((dir) => {
      const base = join(root, "packages", dir);
      const pkg = JSON.parse(read(join(base, "package.json")));
      const id = dir.slice("gatekeeper-".length);
      const typesFile = ["src/types.d.ts", "src/index.ts", "src/gatekeeper.ts"].find((f) =>
        existsSync(join(base, f)),
      );
      const isWorker =
        existsSync(join(base, "wrangler.jsonc")) || existsSync(join(base, "wrangler.toml"));
      return {
        id,
        dir: `packages/${dir}`,
        name: pkg.name,
        description: pkg.description ?? "",
        module: modules.has(id) ? id : null,
        worker: isWorker,
        contractPath: typesFile ? `packages/${dir}/${typesFile}` : null,
        contract: typesFile?.endsWith(".d.ts") ? read(join(base, typesFile)) : null,
        header: typesFile ? headerComment(read(join(base, typesFile))) : "",
      };
    });
}
