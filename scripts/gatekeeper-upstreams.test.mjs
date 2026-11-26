// The upstream sync (scripts/vendor-gatekeepers.mjs) replaces each vendored package's `dirs`
// wholesale, sparing only the paths on its `keep` list. Files of ours inside those dirs must be
// kept, or the next sync deletes them (issue #517 follow-up: the kit's upstream-error helper and the
// gatekeepers' upstream-echo tests).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PACKAGES } from "./gatekeeper-upstreams.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Files of ours inside a synced dir, by package. */
const OURS = {
  "packages/gatekeeper-kit": ["src/upstream-error.ts", "__tests__/upstream-error.test.ts"],
  "packages/gatekeeper-google": ["__tests__/upstream-echo.test.ts", "__tests__/local-workerd"],
  "packages/gatekeeper-microsoft": ["__tests__/upstream-echo.test.ts"],
  "packages/gatekeeper-slack": ["src/upstream-echo.test.ts"],
  "packages/gatekeeper-websearch": ["__tests__/upstream-echo.test.ts"],
};

test("every file of ours inside a synced dir is on its package's keep list", () => {
  for (const [target, paths] of Object.entries(OURS)) {
    const pkg = PACKAGES.find((p) => p.target === target);
    assert.ok(pkg, target);
    for (const path of paths) {
      assert.ok(existsSync(join(root, target, path)), `${target}/${path} exists`);
      assert.ok(pkg.keep?.includes(path), `${target} keeps ${path}`);
    }
  }
});

test("every kept path is a top-level entry of a synced dir (the sync matches those only)", () => {
  for (const pkg of PACKAGES) {
    for (const path of pkg.keep ?? []) {
      const [dir, ...rest] = path.split("/");
      assert.ok(pkg.dirs.includes(dir), `${pkg.target}: ${path} is under a synced dir`);
      assert.equal(rest.length, 1, `${pkg.target}: ${path} is one level below ${dir}`);
    }
  }
});
