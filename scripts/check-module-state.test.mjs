// Proves the check on module-level state works (stage 66 step 5, ADR 0617): every shape of state
// it names is found, constants and per-client state made by `clientState` are not, an unlisted or
// stale entry fails, and the real repository passes. Run by `pnpm lint` with `node --test`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkModuleState, moduleState, scannedDirs } from "./check-module-state.mjs";

const names = (text, file = "a.ts") => moduleState(text, file).map((s) => s.name);

test("the repository's Workers, packs and packages pass, and every gatekeeper is scanned", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(checkModuleState(root), []);
  const dirs = scannedDirs(root);
  for (const dir of ["apps/app/src", "apps/runner/src", "packs", "packages/core/src"]) {
    assert.ok(dirs.includes(dir), dir);
  }
  assert.ok(dirs.includes("packages/gatekeeper-google/src"));
});

test("every shape of module-level state is found", () => {
  assert.deepEqual(names("let cached = null;\nvar old;"), ["cached", "old"]);
  assert.deepEqual(names("const byEnv = new WeakMap();\nconst seen = new WeakSet();"), [
    "byEnv",
    "seen",
  ]);
  assert.deepEqual(
    names('import { AsyncLocalStorage } from "x";\nconst als = new AsyncLocalStorage();'),
    ["als"],
  );
  assert.deepEqual(names("const lru = new Lru(100);"), ["lru"]);
  assert.deepEqual(
    names("const cache = new Map();\nexport function put(k, v) { cache.set(k, v); }"),
    ["cache"],
  );
  assert.deepEqual(names("const seen = new Set<string>();\nfunction f(x) { seen.add(x); }"), [
    "seen",
  ]);
  assert.deepEqual(names("const hooks = [];\nexport const on = (h) => hooks.push(h);"), ["hooks"]);
  assert.deepEqual(names("const byId: Record<string, number> = {};\nbyId[id] = 1;"), ["byId"]);
  assert.deepEqual(names("const state = { at: 0 };\nfunction f() { state.at = Date.now(); }"), [
    "state",
  ]);
  assert.deepEqual(names("const memo = {} as Record<string, string>;\ndelete memo[k];"), ["memo"]);
  assert.deepEqual(names("class A { static options = {}; static readonly B = 1; }"), ["A.options"]);
});

test("constants and per-client state are not state", () => {
  assert.deepEqual(
    names(
      [
        'const KINDS = new Set(["a", "b"]);',
        "const BY = new Map([[1, 2]]);",
        "const LIST = [1, 2, 3];",
        "const encoder = new TextEncoder();",
        "const PATTERN = new RegExp('x');",
        "const memo = clientState(() => new Map());",
        "function f() { let local = 1; const m = new Map(); m.set(1, 2); }",
        "if (KINDS.has('a')) BY.get(1);",
      ].join("\n"),
    ),
    [],
  );
});

test("an unlisted piece of state, a stale entry and an entry with no reason fail", () => {
  const root = mkdtempSync(join(tmpdir(), "s66s5-module-state-"));
  try {
    mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "core", "src", "a.ts"), "let cached = null;\n");
    const unlisted = checkModuleState(root, {});
    assert.equal(unlisted.length, 1);
    assert.match(unlisted[0], /packages\/core\/src\/a\.ts:1: module-level state `cached`/);
    assert.deepEqual(
      checkModuleState(root, { "packages/core/src/a.ts#cached": ["independent", "a counter"] }),
      [],
    );
    assert.match(
      checkModuleState(root, { "packages/core/src/a.ts#cached": ["maybe", ""] })[0],
      /needs a decision/,
    );
    const stale = checkModuleState(root, {
      "packages/core/src/a.ts#cached": ["independent", "a counter"],
      "packages/core/src/b.ts#gone": ["client", "was here"],
    });
    assert.deepEqual(stale, [
      "packages/core/src/b.ts#gone: on scripts/module-state.mjs but not found; take it off the list",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
