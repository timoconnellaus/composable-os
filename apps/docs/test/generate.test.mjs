// The docs generator: its helpers, its checks on a small repository made for each test, and the
// real repository's pages being current (as `pnpm --filter @composable-os/docs check` and CI do).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { apply, generate } from "../scripts/generate.mjs";
import { anchors, internalLinks, rewriteLinks } from "../scripts/lib/links.mjs";
import { schemaTable } from "../scripts/lib/schema.mjs";
import { cell, frontMatter, inline, slug } from "../scripts/lib/text.mjs";
import { glossary } from "../scripts/sources.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("text helpers", () => {
  it("reads the front matter the docs use", () => {
    const { data, body } = frontMatter(
      '---\ntitle: Bookings\nadrs: [0500, 0501]\nblocks:\n  - web-agree\n  - native-agree\nsidebar:\n  label: "Overview"\n---\n\nBody',
    );
    assert.equal(data.title, "Bookings");
    assert.deepEqual(data.adrs, ["0500", "0501"]);
    assert.deepEqual(data.blocks, ["web-agree", "native-agree"]);
    assert.deepEqual(data.sidebar, { label: "Overview" });
    assert.equal(body.trim(), "Body");
  });

  it("makes heading ids as Starlight does", () => {
    assert.equal(slug("agreement.attach"), "agreementattach");
    assert.equal(slug("Rostered team (rostering.team)"), "rostered-team-rosteringteam");
    assert.deepEqual([...anchors("## A\n\n## A\n\n```\n## not a heading\n```")], ["a", "a-1"]);
  });

  it("keeps code's text from becoming HTML or breaking a table", () => {
    assert.equal(inline("a <b> `<c>`\nd"), "a &lt;b&gt; `<c>` d");
    assert.equal(cell("x | y"), "x \\| y");
  });
});

describe("schemas", () => {
  it("lists nested and nullable fields with their limits", () => {
    const table = schemaTable({
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "The id" },
        when: {
          anyOf: [{ type: "object", properties: { at: { type: "string" } } }, { type: "null" }],
        },
        tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      },
    });
    assert.match(table, /\| `id` \| string \| yes \| min length 1 \| The id \|/);
    assert.match(table, /`when.at`/);
    assert.match(table, /array of `"a"`, `"b"`/);
    assert.equal(schemaTable({ type: "object", properties: {} }), "No fields.");
  });
});

describe("links", () => {
  it("turns a page's file into its address, another file into GitHub, and reports nothing", () => {
    const problems = [];
    const ctx = {
      root: REPO,
      repository: "https://github.com/o/r",
      routeOf: (p) => (p === "docs/guides/extensions.md" ? "/guides/extensions/" : null),
      problems,
    };
    const out = rewriteLinks(
      "[g](extensions.md#a) [f](../../AGENTS.md) [d](../adr/) [x](nope.md) [w](https://e.org) `[c](no.md)`",
      "docs/guides/architecture.md",
      ctx,
    );
    assert.match(out, /\[g\]\(\/guides\/extensions\/#a\)/);
    assert.match(out, /\[f\]\(https:\/\/github.com\/o\/r\/blob\/main\/AGENTS.md\)/);
    assert.match(out, /\[d\]\(https:\/\/github.com\/o\/r\/tree\/main\/docs\/adr\/\)/);
    assert.match(out, /\[w\]\(https:\/\/e.org\)/);
    assert.deepEqual(problems, [
      "docs/guides/architecture.md: link to a file that does not exist: nope.md",
    ]);
    assert.deepEqual(internalLinks('[a](/x/#y) `[b](/z/)` <a href="/q/">'), ["/x/#y", "/q/"]);
  });
});

describe("the glossary", () => {
  it("reads CONTEXT.md's entries", () => {
    const sections = glossary(REPO);
    const terms = sections.flatMap((s) => s.entries.map((e) => e.term));
    for (const term of ["Product", "Behaviour", "Pack", "Block"])
      assert.ok(terms.includes(term), term);
  });
});

// A repository with one pack, enough for the pages that need no code.
const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "docs-gen-"));
  roots.push(root);
  const base = {
    "CONTEXT.md": "# Context\n\n**Pack**\nA shipped extension. Acme Gym is the first client.\n",
    "docs/roadmap.md":
      "| # | Stage | Scope | Status |\n| --- | --- | --- | --- |\n| 70 | Widgets | Widgets for all ([spec](stages/70-widgets.md)) | spec agreed |\n",
    "docs/stages/70-widgets.md": "# Stage 70\n",
    "docs/adr/0001-one.md": "# ADR 0001: One decision\n",
    "packages/sdk/src/contract.ts":
      'export const GATEKEEPER_MODULES = [\n  "email",\n] as const;\n',
    "apps/docs/content/index.md": '---\ntitle: "Home"\n---\n\nHello.\n',
    "apps/docs/content/versions.md": '---\ntitle: "Versions"\n---\n\nMain.\n',
    "packs/demo/package.json": "{}",
    "packs/demo/index.ts": "export default {};\n",
  };
  for (const [path, text] of Object.entries({ ...base, ...files })) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const CONFIG = {
  site: "https://docs.example.org",
  repository: "https://github.com/o/r",
  overviewsPending: {},
  privateNames: ["Acme Gym"],
};
const OVERVIEW = `---
title: Demo
summary: A demo pack.
stage: 70
adrs: [0001]
---

## What it is for

Demos.

## Concepts

## How the pieces fit

## Main flows

## What is built
`;

describe("the checks", () => {
  it("fails when a pack has no overview and is not listed as pending", async () => {
    const root = fixture({});
    const { problems } = await generate({ root, markdownOnly: true, config: CONFIG });
    assert.ok(
      problems.some((p) => p.includes("packs/demo: has no docs/overview.md")),
      problems.join("\n"),
    );
    const pending = await generate({
      root,
      markdownOnly: true,
      config: { ...CONFIG, overviewsPending: { demo: { stage: 70 } } },
    });
    assert.deepEqual(pending.problems, []);
  });

  it("fails when a pending pack has an overview, or an overview lacks a section", async () => {
    const root = fixture({
      "packs/demo/docs/overview.md": OVERVIEW.replace("## Main flows\n", ""),
    });
    const { problems } = await generate({
      root,
      markdownOnly: true,
      config: { ...CONFIG, overviewsPending: { demo: { stage: 70 } } },
    });
    assert.ok(
      problems.some((p) => p.includes("take it off overviewsPending")),
      problems.join("\n"),
    );
    assert.ok(
      problems.some((p) => p.includes('needs a "## Main flows" section')),
      problems.join("\n"),
    );
  });

  it("builds the overview and decisions pages, leaves documented stages off Planned, and scrubs names", async () => {
    const root = fixture({ "packs/demo/docs/overview.md": OVERVIEW });
    const result = await generate({ root, markdownOnly: true, config: CONFIG });
    // The reference pages it links to need the code, which this repository has none of.
    assert.deepEqual(
      result.problems.filter((p) => !/links to \/packs\/demo\/[a-z-]+\/, which is no page/.test(p)),
      [],
    );
    const byPath = new Map(result.pages.map((p) => [p.path, p.content]));
    assert.match(byPath.get("packs/demo/index.md"), /title: "Demo"/);
    assert.match(byPath.get("packs/demo/decisions.md"), /One decision/);
    assert.doesNotMatch(byPath.get("planned.md"), /Widgets/);
    const glossaryPage = byPath.get("reference/glossary.md");
    assert.match(glossaryPage, /the first client is the first client/);
    assert.doesNotMatch(glossaryPage, /Acme Gym/);
    assert.match(
      result.llms,
      /\[Demo\]\(https:\/\/docs.example.org\/packs\/demo\/\): A demo pack./,
    );
  });

  it("lists a stage with a spec and no pages on Planned", async () => {
    const root = fixture({});
    const result = await generate({
      root,
      markdownOnly: true,
      config: { ...CONFIG, overviewsPending: { demo: { stage: 4 } } },
    });
    const planned = result.pages.find((p) => p.path === "planned.md").content;
    assert.match(planned, /\*\*Widgets\*\* \(stage 70\)/);
  });

  it("fails on a broken internal link, a missing ADR and a price in hand-written text", async () => {
    const root = fixture({
      "packs/demo/docs/overview.md": OVERVIEW.replace("adrs: [0001]", "adrs: [0002]").replace(
        "Demos.",
        "Demos for $40 a month. See [the tools](/packs/demo/nothing/).",
      ),
    });
    const { problems } = await generate({ root, markdownOnly: true, config: CONFIG });
    assert.ok(
      problems.some((p) => p.includes("ADR 0002 does not exist")),
      problems.join("\n"),
    );
    assert.ok(
      problems.some((p) => p.includes("looks like a price")),
      problems.join("\n"),
    );
    assert.ok(
      problems.some((p) => p.includes("links to /packs/demo/nothing/, which is no page")),
      problems.join("\n"),
    );
  });

  it("finds stale and missing pages", async () => {
    const root = fixture({ "packs/demo/docs/overview.md": OVERVIEW });
    const result = await generate({ root, markdownOnly: true, config: CONFIG });
    const missing = apply(result, { root, check: true, markdownOnly: true });
    assert.ok(
      missing.some((p) => p.includes("index.md: not generated")),
      missing.join("\n"),
    );
  });
});

describe("this repository", () => {
  it("has every generated page current, every link whole and every pack documented", async () => {
    const result = await generate({ root: REPO });
    assert.deepEqual(apply(result, { root: REPO, check: true, markdownOnly: false }), []);
  });

  it("is current for the documents lane too (Markdown only, no install)", async () => {
    const result = await generate({ root: REPO, markdownOnly: true });
    assert.deepEqual(apply(result, { root: REPO, check: true, markdownOnly: true }), []);
  });
});
