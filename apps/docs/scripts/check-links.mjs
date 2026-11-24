#!/usr/bin/env node
// Checks the built site (dist/): every link to a page of the site leads to a page that was built,
// and every link to a heading leads to a heading with that id on it. Run after `astro build`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? htmlFiles(join(dir, e.name))
      : e.name.endsWith(".html")
        ? [join(dir, e.name)]
        : [],
  );
}

/** The built file a site path is served from, or null. */
function fileFor(path) {
  const clean = decodeURI(path).replace(/\/+$/, "");
  const candidates = [
    join(dist, clean, "index.html"),
    join(dist, `${clean}.html`),
    join(dist, clean),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

const ids = new Map();
function idsOf(file) {
  if (!ids.has(file))
    ids.set(
      file,
      new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])),
    );
  return ids.get(file);
}

const problems = [];
const files = htmlFiles(dist);
for (const file of files) {
  const html = readFileSync(file, "utf8");
  for (const [, href] of html.matchAll(/\shref="([^"]+)"/g)) {
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    const [path, hash] = href.split("#");
    const target = fileFor(path.split("?")[0]);
    if (!target) {
      problems.push(`${relative(dist, file)}: ${href} is no page`);
      continue;
    }
    if (
      hash &&
      hash !== "_top" &&
      target.endsWith(".html") &&
      !idsOf(target).has(decodeURIComponent(hash))
    ) {
      problems.push(`${relative(dist, file)}: ${href}: no such heading`);
    }
  }
}
if (problems.length) {
  process.stderr.write(
    `Broken links in the built site:\n${[...new Set(problems)].map((p) => `  - ${p}`).join("\n")}\n`,
  );
  process.exit(1);
}
process.stdout.write(`Links checked: ${files.length} pages, none broken.\n`);
