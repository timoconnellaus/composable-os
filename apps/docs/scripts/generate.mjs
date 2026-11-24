#!/usr/bin/env node
// Writes the docs site's pages (src/content/docs/), its sidebar (src/sidebar.json) and
// public/llms.txt from the code and the Markdown beside it. Nobody edits those by hand.
//
//   node scripts/generate.mjs                  write everything
//   node scripts/generate.mjs --check          fail when a written page differs from what the
//                                              sources give, a pack has no overview, a link is
//                                              broken or something has no reference page
//   node scripts/generate.mjs --check --markdown-only
//                                              the same for the pages made from Markdown alone:
//                                              the documents lane, which has no install
//
// No network: the code is bundled and read locally (extract.mjs).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import defaultConfig from "../docs.config.mjs";
import { anchors, internalLinks } from "./lib/links.mjs";
import { frontMatter } from "./lib/text.mjs";
import { buildPages, sidebar, urlOf } from "./pages.mjs";
import * as sources from "./sources.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** Where the generated files are, under a repository's root. */
export function outputs(root) {
  const app = join(root, "apps", "docs");
  return {
    app,
    content: join(app, "src", "content", "docs"),
    sidebar: join(app, "src", "sidebar.json"),
    llms: join(app, "public", "llms.txt"),
  };
}

/** Every file under `dir`, relative to it. */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name))],
  );
}

/** Pages made from Markdown alone live here; anything else in the content folder needs the code. */
function isMarkdownPath(path, ctx) {
  if (["index.md", "versions.md", "planned.md", "reference/glossary.md"].includes(path))
    return true;
  if (path.startsWith("guides/")) return true;
  const pack = path.match(/^packs\/([a-z0-9]+)\/(index|decisions)\.md$/);
  if (pack) return Boolean(ctx.packOverviews[pack[1]]);
  return /^capabilities\/[a-z0-9-]+\/(index|decisions|screens)\.md$/.test(path);
}

/** Replaces a client's name with "the first client" (docs.config.mjs). */
function scrub(text, config) {
  let out = text;
  for (const name of config.privateNames) out = out.split(name).join("the first client");
  return out;
}

const PRICE = /[$€£]\s?\d/;

export async function generate({ root, markdownOnly = false, config = defaultConfig }) {
  const problems = [];
  const { content: CONTENT } = outputs(root);
  const packIds = sources.packIds(root);
  const ctx = {
    root,
    repository: config.repository,
    problems,
    packIds,
    pending: config.overviewsPending,
    packOverviews: sources.packOverviews(root),
    capabilityOverviews: sources.capabilityOverviews(root),
    guides: sources.guides(root),
    adrs: sources.adrs(root),
    glossary: sources.glossary(root),
    stages: sources.roadmapStages(root),
    blocks: sources.blocks(root),
    gatekeepers: sources.gatekeepers(root),
    facts: null,
    opNames: null,
  };
  const routes = new Map([
    ["CONTEXT.md", "/reference/glossary/"],
    ...ctx.guides.map((g) => [g.path, `/guides/${g.id}/`]),
    ...Object.values(ctx.packOverviews).map((o) => [o.path, `/packs/${o.id}/`]),
    ...Object.values(ctx.capabilityOverviews).map((o) => [o.path, `/capabilities/${o.id}/`]),
  ]);
  ctx.routeOf = (p) => routes.get(p) ?? null;

  for (const id of packIds) {
    const has = Boolean(ctx.packOverviews[id]);
    if (!has && !config.overviewsPending[id]) {
      problems.push(`packs/${id}: has no docs/overview.md (write one: AGENTS.md, "The docs site")`);
    }
    if (has && config.overviewsPending[id]) {
      problems.push(
        `packs/${id}: has an overview now; take it off overviewsPending in apps/docs/docs.config.mjs`,
      );
    }
  }
  for (const id of Object.keys(config.overviewsPending)) {
    if (!packIds.includes(id))
      problems.push(`docs.config.mjs: overviewsPending names ${id}, which is not a pack`);
  }

  if (!markdownOnly) {
    const { extractCodeFacts } = await import("./extract.mjs");
    ctx.facts = await extractCodeFacts(root);
    ctx.opNames = new Set(ctx.facts.operations.map((o) => o.name));
  }

  let pages = buildPages(ctx).map((p) => ({ ...p, content: scrub(p.content, config) }));
  if (markdownOnly) {
    pages = pages.filter((p) => !p.code);
    // The pages that need the code are taken as they are written, for the links and llms.txt.
    const made = new Set(pages.map((p) => p.path));
    for (const path of walk(CONTENT)) {
      if (made.has(path) || isMarkdownPath(path, ctx)) continue;
      pages.push({
        path,
        code: true,
        content: readFileSync(join(CONTENT, path), "utf8"),
        kept: true,
      });
    }
  }

  // Nothing private, no prices.
  for (const p of pages) {
    if (p.kept) continue;
    const handWritten = !p.code;
    for (const name of config.privateNames) {
      if (p.content.includes(name)) problems.push(`${p.path}: names ${name}`);
    }
    const price = p.content.match(new RegExp(`.{0,30}${PRICE.source}.{0,10}`));
    if (price && handWritten)
      problems.push(`${p.path}: shows what looks like a price: "${price[0]}"`);
  }

  // Internal links and anchors.
  const byUrl = new Map(pages.map((p) => [urlOf(p.path), p]));
  const anchorCache = new Map();
  for (const p of pages) {
    for (const link of internalLinks(p.content)) {
      const [path, hash] = link.split("#");
      const url = path.endsWith("/") ? path : `${path}/`;
      const target = byUrl.get(url);
      if (!target) {
        problems.push(`${p.path}: links to ${link}, which is no page`);
        continue;
      }
      if (hash && hash !== "_top") {
        if (!anchorCache.has(url)) anchorCache.set(url, anchors(target.content));
        if (!anchorCache.get(url).has(hash))
          problems.push(`${p.path}: links to ${link}: no such heading`);
      }
    }
  }

  // Every pack, block, core operation and gatekeeper has its page.
  if (ctx.facts) {
    for (const id of packIds) {
      if (!byUrl.has(`/packs/${id}/`)) problems.push(`packs/${id}: no reference page`);
    }
    for (const op of ctx.facts.operations) {
      const url = `/reference/operations/${op.name.split(".")[0].toLowerCase()}/`;
      if (!byUrl.get(url)?.content.includes(`\n## ${op.name}\n`))
        problems.push(`${op.name}: no reference entry`);
    }
  }
  for (const b of ctx.blocks) {
    if (!byUrl.has(`/reference/blocks/${b.name}/`))
      problems.push(`block ${b.name}: no reference page`);
  }
  for (const g of ctx.gatekeepers) {
    if (!byUrl.has(`/reference/gatekeepers/${g.id}/`) && !markdownOnly) {
      problems.push(`gatekeeper ${g.id}: no reference page`);
    }
  }

  const llms = llmsTxt(pages, config);
  const side = ctx.facts ? `${JSON.stringify(sidebar(ctx), null, 2)}\n` : null;
  return { pages, llms, sidebar: side, problems };
}

/** llms.txt (llmstxt.org): the site's pages, each with its description, from the same pages. */
function llmsTxt(pages, config) {
  const entry = (p) => {
    const { data } = frontMatter(p.content);
    const title = data.title || p.path;
    const description = data.description ? `: ${data.description}` : "";
    return `- [${title}](${config.site}${urlOf(p.path)})${description}`;
  };
  const sorted = [...pages].sort((a, b) => a.path.localeCompare(b.path));
  const section = (heading, test) => {
    const list = sorted.filter((p) => test(p.path));
    return list.length ? `## ${heading}\n\n${list.map(entry).join("\n")}\n` : "";
  };
  return [
    "# Composable OS\n",
    "> A platform for composing products on a trusted host on Cloudflare. These docs follow the main branch: reference pages are generated from the code, and guides and overviews are written beside it.\n",
    section("Start", (p) => ["index.md", "versions.md", "planned.md"].includes(p)),
    section("Guides", (p) => p.startsWith("guides/")),
    section("Packs", (p) => p.startsWith("packs/")),
    section("Capabilities", (p) => p.startsWith("capabilities/")),
    section("Solutions", (p) => p.startsWith("solutions/")),
    section("Reference", (p) => p.startsWith("reference/")),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Writes the result, or compares it with what is written. Returns the problems. */
export function apply(result, { root, check, markdownOnly }) {
  const problems = [...result.problems];
  const { app, content: CONTENT, sidebar: SIDEBAR, llms: LLMS } = outputs(root);
  const files = new Map(
    result.pages.filter((p) => !p.kept).map((p) => [join(CONTENT, p.path), p.content]),
  );
  files.set(LLMS, result.llms);
  if (result.sidebar) files.set(SIDEBAR, result.sidebar);
  if (check) {
    for (const [file, content] of files) {
      const rel = relative(app, file);
      if (!existsSync(file))
        problems.push(`${rel}: not generated (run pnpm --filter @composable-os/docs generate)`);
      else if (readFileSync(file, "utf8") !== content) {
        problems.push(
          `${rel}: stale (run pnpm --filter @composable-os/docs generate; never edit it by hand)`,
        );
      }
    }
    if (!markdownOnly) {
      for (const path of walk(CONTENT)) {
        if (!files.has(join(CONTENT, path)))
          problems.push(`src/content/docs/${path}: no longer generated (run generate)`);
      }
    }
    return problems;
  }
  if (problems.length) return problems;
  rmSync(CONTENT, { recursive: true, force: true });
  for (const [file, content] of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return [];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const markdownOnly = process.argv.includes("--markdown-only");
  if (markdownOnly && !check) {
    process.stderr.write("--markdown-only only checks: writing needs the code too.\n");
    process.exit(2);
  }
  const root = join(here, "..", "..", "..");
  const result = await generate({ root, markdownOnly });
  const problems = apply(result, { root, check, markdownOnly });
  if (problems.length) {
    process.stderr.write(`The docs site:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    process.exit(1);
  }
  const n = result.pages.filter((p) => !p.kept).length;
  process.stdout.write(
    check
      ? `The docs site is current (${n} pages checked${markdownOnly ? ", Markdown only" : ""}).\n`
      : `Wrote ${n} pages, the sidebar and llms.txt.\n`,
  );
}
