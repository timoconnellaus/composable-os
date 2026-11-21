import assert from "node:assert/strict";
import { test } from "node:test";
import { docsOnly } from "./ci-docs-only.mjs";

test("documents only: docs/ and root Markdown", () => {
  assert.equal(docsOnly(["docs/roadmap.md", "docs/adr/0403-x.md", "README.md"]), true);
  assert.equal(docsOnly(["docs/stages/assets/diagram.png"]), true);
  assert.equal(docsOnly(["  CONTEXT.md  ", ""]), true);
});

test("anything else runs everything", () => {
  assert.equal(docsOnly(["docs/roadmap.md", "packages/core/src/invoke.ts"]), false);
  assert.equal(docsOnly(["packages/sdk/README.md"]), false);
  assert.equal(docsOnly(["skills/write-extension/SKILL.md"]), false);
  assert.equal(docsOnly(["apps/marketing/src/content/home.md"]), false);
  assert.equal(docsOnly([".github/workflows/ci.yml"]), false);
  assert.equal(docsOnly(["package.json"]), false);
});

test("an empty list runs everything", () => {
  assert.equal(docsOnly([]), false);
  assert.equal(docsOnly(["", "  "]), false);
});
