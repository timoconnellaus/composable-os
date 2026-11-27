// Proves the cookie-read check works (stage 66 step 8, ADR 0619, rule (c)): every shape of read is
// found by its enclosing function, an unlisted or stale entry fails, and the repository passes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COOKIE_READS, checkHostCookies, cookieReads, SCANNED } from "./check-host-cookies.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the repository's cookie reads are each listed", () => {
  assert.deepEqual(checkHostCookies(root), []);
});

test("every shape of cookie read is found, by its function", () => {
  const reads = cookieReads(
    [
      'function a(r) { return r.headers.get("cookie"); }',
      "const b = (r) => r.headers.get('Cookie');",
      "class C { m() { return document.cookie; } }",
      'import { parse } from "cookie";',
      'import { getCookie } from "@tanstack/react-start/server";',
      'function notOne(r) { return r.headers.has("cookie") || r.headers.get("origin"); }',
    ].join("\n"),
  );
  assert.deepEqual(
    reads.map((r) => [r.name, r.how]),
    [
      ["a", 'headers.get("cookie")'],
      ["b", 'headers.get("cookie")'],
      ["m", "document.cookie"],
      ["<module>", 'import from "cookie"'],
      ["<module>", "import { getCookie }"],
    ],
  );
});

test("core, db and the packs are scanned, and a second read inside a listed function fails (review of #543, S3)", () => {
  for (const dir of ["packages/core/src", "packages/db/src", "packs"]) {
    assert.ok(SCANNED.includes(dir), dir);
  }
  const dir = mkdtempSync(join(tmpdir(), "s66s8-cookies-"));
  mkdirSync(join(dir, "apps/app/src"), { recursive: true });
  writeFileSync(
    join(dir, "apps/app/src/a.ts"),
    'export function jar(r) { return [r.headers.get("cookie"), r.headers.get("Cookie")]; }\n',
  );
  const problems = checkHostCookies(dir, { "apps/app/src/a.ts#jar": "one read" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /reads cookies 2 times \(lines 1, 1\), the list says 1/);
  assert.deepEqual(checkHostCookies(dir, { "apps/app/src/a.ts#jar": { reads: 2, why: "x" } }), []);
});

test("a read not listed fails, and so does a listed place that reads none", () => {
  const { "apps/app/src/server/http/form-page.ts#customerCookie": _gone, ...without } =
    COOKIE_READS;
  const problems = checkHostCookies(root, { ...without, "apps/app/src/nowhere.ts#f": "x" });
  assert.equal(problems.length, 2);
  assert.match(
    problems[0],
    /form-page\.ts#customerCookie .* is not in scripts\/check-host-cookies/,
  );
  assert.match(problems[1], /nowhere\.ts#f is listed but reads no cookie now/);
});
