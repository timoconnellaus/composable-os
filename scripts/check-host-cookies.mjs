#!/usr/bin/env node
// Every cookie the host reads, and why a many-client host reads only `__Host-` names there
// (stage 66 step 8, ADR 0619: the owner's rule (c) of 2026-11-27, which with (a) and (b) replaces a
// Public Suffix List listing of the fleet's domain, ADR 0616 "Cookies").
//
// A page on a sibling hostname of the fleet's domain can set a cookie for the whole domain under
// any name without the `__Host-` prefix, and browsers send it to every client's hostname; a
// `__Host-` cookie can be set only by the hostname itself. So on a many-client host no code may
// read a cookie without the prefix. This check finds every place the app's and auth's code reads
// a request's cookies (`<headers>.get("cookie")`, `document.cookie`, a cookie parser's import) and
// fails unless it is listed below, by file and enclosing function, with how that place keeps to
// the rule and the test that shows it. A listed place that no longer reads cookies fails too, so
// the list stays true. Each listed read has a behavioural test; this check is what makes a new
// read be looked at. It runs in `pnpm lint`.
//
// Better Auth reads its own cookies inside the library, by the names `cookieOptions` gives it:
// `__Host-` on a many-client host (packages/auth/test/host-cookies.test.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The folders whose code a many-client host runs on its own hostnames. */
export const SCANNED = ["apps/app/src", "packages/auth/src"];

/** Every place that reads a request's cookies, and how it reads only `__Host-` names on a fleet. */
export const COOKIE_READS = {
  "apps/app/src/server/support.ts#readCookie":
    "called only with supportCookieName(env): `__Host-cos_support` on a many-client host (apps/app/test/support.test.ts)",
  "apps/app/src/server/http/api.ts#hasCookie":
    "isSessionCookie with hostOnlyCookies(env): only `__Host-` session names count (the app's two-client entries test, a planted cos-customer cookie)",
  "apps/app/src/server/http/bound.ts#cookiesOnly":
    "isCookieOf with hostOnlyCookies(env): only `__Host-` names reach the session check (packages/auth host-cookies.test.ts, the app's two-client entries test)",
  "apps/app/src/server/http/form-page.ts#customerCookie":
    "isSessionCookie with hostOnlyCookies(env) (apps/app/test/form-page.test.ts, the many-client case)",
  "apps/app/src/server/http/desk.ts#cookies":
    "a jar read only by DEVICE_COOKIE and SESSION_COOKIE, both `__Host-` names (ADR 0649)",
  "packages/auth/src/cloudflare-access.ts#readToken":
    "headerOnly on a many-client host: the CF_Authorization cookie is never read, only Access's header (packages/auth/test/cloudflare-access.test.ts)",
};

const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;
const NOT_SHIPPED = /\.(test|spec)\.tsx?$|\.d\.ts$/;

function* files(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (SOURCE.test(name) && !NOT_SHIPPED.test(name)) yield path;
  }
}

const COOKIE_PARSERS = new Set(["cookie", "cookie-es", "cookies", "js-cookie"]);

/** The name of the function a node is in: a declaration, a method, or a variable it is bound to. */
function enclosingName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name)
      return n.name.getText();
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent)
    ) {
      return n.parent.name.getText();
    }
  }
  return "<module>";
}

/** Every cookie read of one file's text: `{ name, line, how }`. */
export function cookieReads(text, fileName = "a.ts") {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const add = (node, how) =>
    out.push({
      name: enclosingName(node),
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      how,
    });
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.toLowerCase() === "cookie"
    ) {
      add(node, 'headers.get("cookie")');
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "cookie" &&
      node.expression.getText() === "document"
    ) {
      add(node, "document.cookie");
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      COOKIE_PARSERS.has(node.moduleSpecifier.text)
    ) {
      add(node, `import from "${node.moduleSpecifier.text}"`);
    }
    if (
      ts.isImportSpecifier(node) &&
      /^get(Cookie|Cookies)$/.test((node.propertyName ?? node.name).text)
    ) {
      add(node, `import { ${node.name.text} }`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The problems: a read not listed, or a listed place that reads no cookie now. */
export function checkHostCookies(root, list = COOKIE_READS) {
  const found = new Map();
  for (const dir of SCANNED) {
    for (const path of files(join(root, dir))) {
      const file = relative(root, path).split(sep).join("/");
      for (const read of cookieReads(readFileSync(path, "utf8"), path)) {
        const key = `${file}#${read.name}`;
        if (!found.has(key)) found.set(key, read);
      }
    }
  }
  const problems = [];
  for (const [key, read] of found) {
    if (!Object.hasOwn(list, key)) {
      problems.push(
        `${key} (line ${read.line}, ${read.how}) reads a cookie and is not in scripts/check-host-cookies.mjs: on a many-client host it must read only \`__Host-\` names; say how, with its test`,
      );
    }
  }
  for (const key of Object.keys(list)) {
    if (!found.has(key)) problems.push(`${key} is listed but reads no cookie now: remove it`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const problems = checkHostCookies(root);
  if (problems.length) {
    for (const p of problems) console.error(`check-host-cookies: ${p}`);
    process.exit(1);
  }
  console.log(`check-host-cookies: ${Object.keys(COOKIE_READS).length} cookie reads, each listed`);
}
