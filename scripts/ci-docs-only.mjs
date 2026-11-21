#!/usr/bin/env node
// CI's fast lane for documents. Reads the changed file paths, one per line, on stdin and prints
// `true` when every one of them is a document, so the workflow can skip the slow jobs.
//
// A document is anything under docs/ or a Markdown file at the repository root (README.md,
// AGENTS.md, CONTEXT.md). Nothing else counts: skills/ is read by the version guard, Markdown
// under apps/ can be built into the site, and package READMEs sit beside code. An empty list is
// not documents only: with nothing to judge by, run everything.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DOCUMENT = /^(docs\/.+|[^/]+\.md)$/;

/** Whether `paths` is a non-empty list of documents and nothing else. */
export function docsOnly(paths) {
  const changed = paths.map((path) => path.trim()).filter(Boolean);
  return changed.length > 0 && changed.every((path) => DOCUMENT.test(path));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${docsOnly(readFileSync(0, "utf8").split("\n"))}\n`);
}
