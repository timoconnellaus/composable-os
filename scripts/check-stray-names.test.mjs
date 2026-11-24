import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ALLOW, CLIENTS, checkStrayNames, productClients, RULES } from "./check-stray-names.mjs";

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
  for (const pattern of CLIENTS) assert.ok(pattern instanceof RegExp);
  assert.ok(RULES.some((rule) => rule.supplier), "the supplier rules are marked");
});

// The booking system's connector (stage 65 step 2, ADR 0921): each allowed path, and a path one
// directory outside it that is not.
const CONNECTOR = [
  ["packages/gatekeeper-booking-system-mindbody/src/index.ts", "packages/gatekeeper-booking-system/src/index.ts"],
  ["docs/adr/0927-the-mindbody-gatekeeper.md", "docs/adr/0920-the-booking-system-contract.md"],
  ["docs/stages/65-booking-system-connection.md", "docs/stages/33-leaving.md"],
  ["docs/integrations.md", "docs/integrations/mindbody.md"],
  ["packages/core/src/integrations/catalogue.ts", "packages/core/src/integrations/runtime.ts"],
  ["apps/marketing/src/solutions.ts", "apps/app/src/solutions.ts"],
  ["apps/marketing/SITE.md", "apps/SITE.md"],
];

test("the booking system's name passes where its connector is defined, documented and listed", () => {
  const files = CONNECTOR.map(([allowed]) => [allowed, "The connector for Mindbody."]);
  assert.deepEqual(checkStrayNames(files), []);
});

test("the booking system's name fails one directory outside each allowed path", () => {
  const files = CONNECTOR.map(([, outside]) => [outside, "Reads from MindBody."]);
  const problems = checkStrayNames(files);
  assert.equal(problems.length, CONNECTOR.length);
  CONNECTOR.forEach(([, outside], index) => {
    assert.ok(problems[index].startsWith(`${outside}:1: "MindBody" (a client's booking system)`));
  });
});

test("the course platform and the CMS stay allowed nowhere but this check", () => {
  const files = CONNECTOR.map(([allowed]) => [allowed, "LearnWorlds and EmDash"]);
  assert.equal(checkStrayNames(files).length, CONNECTOR.length * 2);
});

test("a client's name in a file allowed a system's name fails", () => {
  const clients = [/\bAcme Gym\b/i];
  const problems = checkStrayNames(
    [
      ["docs/integrations.md", "# Integrations\n\nThe booking system connector.\nUsed by Acme Gym.\n"],
      ["apps/marketing/SITE.md", "Mindbody, for ACME GYM"],
    ],
    RULES,
    ALLOW,
    clients,
  );
  assert.deepEqual(problems, [
    'docs/integrations.md:4: "Acme Gym" (a business named beside a system): a file that names a system a business uses never says which business uses, used or is leaving it (ADR 0921): say "a business"',
    'apps/marketing/SITE.md:1: "ACME GYM" (a business named beside a system): a file that names a system a business uses never says which business uses, used or is leaving it (ADR 0921): say "a business"',
  ]);
});

test("a phrase pointing at one client fails in a file allowed a system's name", () => {
  const problems = checkStrayNames([
    ["packages/gatekeeper-booking-system-mindbody/README.md", "Our client keeps Mindbody."],
    ["docs/stages/65-booking-system-connection.md", "The first clients' setup."],
    ["docs/adr/0927-the-mindbody-gatekeeper.md", "the first   client"],
  ]);
  assert.equal(problems.length, 3);
  for (const problem of problems) assert.ok(problem.includes("(a business named beside a system)"));
});

test("a client's name with no system's name in an ordinary file passes", () => {
  const problems = checkStrayNames(
    [
      ["docs/roadmap.md", "Stage 27: Acme Gym, the first client."],
      ["docs/adr/0450-client-environments.md", "The first client needs a staging host."],
    ],
    RULES,
    ALLOW,
    [/\bAcme Gym\b/i],
  );
  assert.deepEqual(problems, []);
});

test("this check and its tests may name both", () => {
  const files = [["scripts/check-stray-names.test.mjs", "Mindbody, our client Acme Gym"]];
  assert.deepEqual(checkStrayNames(files, RULES, ALLOW, [/Acme Gym/]), []);
});

test("clients come from the products' labels, leaving out the platform's own", () => {
  const root = mkdtempSync(join(tmpdir(), "stray-names-"));
  try {
    const product = (id, text) => {
      mkdirSync(join(root, "products", id), { recursive: true });
      writeFileSync(join(root, "products", id, "product.ts"), text);
    };
    product("crm", 'defineProduct({ id: "crm", label: "CRM" });');
    product("acme", 'defineProduct({\n  id: "acme",\n  label: "Acme  Gym (Co.)",\n});');
    product("blank", "defineProduct({});");
    mkdirSync(join(root, "products", "empty"));
    writeFileSync(join(root, "products", "index.ts"), 'label: "Not a product"');
    const clients = productClients(root);
    assert.equal(clients.length, 1);
    assert.ok(clients[0].test("used by acme gym (co.) since May"));
    assert.ok(!clients[0].test("used by Acme Gym (Co)"));
    assert.ok(!clients[0].test("the CRM"));
    assert.deepEqual(productClients(join(root, "missing")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository's own products name no client", () => {
  assert.deepEqual(productClients(join(import.meta.dirname, "..")), []);
});

test("the booking system's name is allowed in stage 65's spec and nowhere else", () => {
  const files = [
    ["docs/stages/65-booking-system-connection.md", "The first connector is for Mindbody."],
    ["docs/stages/33-leaving.md", "Leaving Mindbody."],
    ["docs/adr/0920-the-booking-system-contract.md", "Mindbody"],
  ];
  const problems = checkStrayNames(files);
  assert.equal(problems.length, 2);
  assert.ok(problems[0].startsWith("docs/stages/33-leaving.md:1:"));
  assert.ok(problems[1].startsWith("docs/adr/0920-the-booking-system-contract.md:1:"));
});
