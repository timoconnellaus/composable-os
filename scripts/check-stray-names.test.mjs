import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOW, checkStrayNames, RULES } from "./check-stray-names.mjs";

const rules = [{ name: "old brand", pattern: /Old Brand/, instead: "say New Brand" }];
const allow = [/^docs\/history\//];

test("reports a stray name with its file, line and what to write instead", () => {
  const problems = checkStrayNames(
    [["packages/a/src/index.ts", "const a = 1;\nconst b = 'Old Brand';\n"]],
    rules,
    allow,
  );
  assert.deepEqual(problems, ['packages/a/src/index.ts:2: "Old Brand" (old brand): say New Brand']);
});

test("leaves allowed files and product definitions alone", () => {
  const problems = checkStrayNames(
    [
      ["docs/history/0001.md", "Old Brand"],
      ["products/x/product.ts", "Old Brand"],
      ["pnpm-lock.yaml", "Old Brand"],
    ],
    rules,
    allow,
  );
  assert.deepEqual(problems, []);
});

test("a rule with its own allow list reaches files the shared list allows", () => {
  const own = [{ name: "supplier", pattern: /Acme/, instead: "say a supplier", allow: [] }];
  const problems = checkStrayNames([["docs/history/0001.md", "Acme"]], own, allow);
  assert.deepEqual(problems, ['docs/history/0001.md:1: "Acme" (supplier): say a supplier']);
});

test("a file with no stray name passes", () => {
  assert.deepEqual(checkStrayNames([["README.md", "New Brand"]], rules, allow), []);
});

test("the repository's rules are well formed", () => {
  for (const rule of RULES) {
    assert.ok(rule.name && rule.instead && rule.pattern instanceof RegExp);
    for (const pattern of rule.allow ?? []) assert.ok(pattern instanceof RegExp);
  }
  for (const pattern of ALLOW) assert.ok(pattern instanceof RegExp);
});
