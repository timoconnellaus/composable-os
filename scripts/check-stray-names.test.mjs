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

// The booking system's name, put together so that no tracked file spells it (ADR 0921).
const booking = (space = "") => `Mind${space}body`;

test("the booking system's name is allowed in no file but this check, stage 65's spec included", () => {
  const files = [
    [
      "docs/stages/65-booking-system-connection.md",
      `The first source is ${booking().toUpperCase()}.`,
    ],
    ["docs/adr/0921-no-named-connector-and-a-file-source.md", booking(" ").toLowerCase()],
    ["packages/gatekeeper-booking-system/src/file.ts", booking()],
    ["scripts/check-stray-names.test.mjs", booking()],
  ];
  const problems = checkStrayNames(files);
  assert.equal(problems.length, 3);
  assert.ok(problems[0].startsWith("docs/stages/65-booking-system-connection.md:1:"));
  assert.ok(problems[1].startsWith("docs/adr/0921-no-named-connector-and-a-file-source.md:1:"));
  assert.ok(problems[2].startsWith("packages/gatekeeper-booking-system/src/file.ts:1:"));
});

test("the supplier rules are allowed only in this check and its tests", () => {
  for (const rule of RULES.filter((r) => r.allow)) {
    assert.equal(rule.allow.length, 1, rule.name);
    assert.ok(rule.allow[0].test("scripts/check-stray-names.mjs"), rule.name);
    assert.ok(rule.allow[0].test("scripts/check-stray-names.test.mjs"), rule.name);
  }
});
