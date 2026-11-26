#!/usr/bin/env node
// What a host Worker may hold at module level (stage 66 step 5, ADR 0617).
//
// A many-client host runs every client's requests in the same isolates, so whatever a module keeps
// at its top level outlives the request that wrote it and is there for the next one, whichever
// client that is. This check finds every piece of module-level state in the code the host's
// Workers load (the app, the runner, the packs, the packages bundled into them, and every
// gatekeeper, whose Workers serve every client's connections) and fails unless it is on the list
// in scripts/module-state.mjs with what it is and why that is safe: keyed by client, holding
// nothing of a client's, or living for one call. It runs in `pnpm lint`.
//
// Module-level state, as this check reads a file's top-level statements:
// - a `let` or `var` (it can be written later, by anything);
// - a `const` made with `new` of a keeping kind (WeakMap, WeakSet, WeakRef, AsyncLocalStorage,
//   FinalizationRegistry), or of any class but a few that keep nothing (TextEncoder, URL, …);
// - a `const` Map, Set, array, object or typed array that the file changes (`.set(`, `.add(`,
//   `.push(`, `x[k] =`, `x.k =`, `delete x…`, `Object.assign(x, …)`, …);
// - a `static` class field that is not `readonly`.
//
// It is textual where it must be: a value made by a call (`const x = memo()`), a closure's own
// variables, and a change made in another file are not seen. A new cache written in one of those
// shapes passes this check; review is what catches it, and the two-client tests what fails.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { MODULE_STATE } from "./module-state.mjs";

/** The packages bundled into cos-app and cos-runner (as scripts/check-module-env.mjs lists). */
const BUNDLED_PACKAGES = [
  "agent-a2ui",
  "agent-core",
  "agent-plugins",
  "agent-voice",
  "auth",
  "calendar-file",
  "client",
  "core",
  "db",
  "mcp-shared",
  "pdf",
  "product",
  "sdk",
  "ui",
];

/** The folders scanned: the host's Workers, the packs and every package a host Worker loads. */
export function scannedDirs(root) {
  const gatekeepers = readdirSync(join(root, "packages"))
    .filter((name) => name.startsWith("gatekeeper-"))
    .map((name) => `packages/${name}/src`);
  return [
    "apps/app/src",
    "apps/runner/src",
    "packs",
    ...BUNDLED_PACKAGES.map((name) => `packages/${name}/src`),
    ...gatekeepers,
  ];
}

const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;
const NOT_SHIPPED = /\.(test|spec)\.tsx?$|\.d\.ts$/;
const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "generated",
  "test",
  "tests",
  "__tests__",
  "e2e",
  "testing",
]);

function* files(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (SOURCE.test(name) && !NOT_SHIPPED.test(name)) yield path;
  }
}

/** Classes whose instances keep something: always state. */
const KEEPING = new Set([
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "AsyncLocalStorage",
  "FinalizationRegistry",
]);
/** Classes whose instances hold nothing that changes. */
const STATELESS = new Set([
  "TextEncoder",
  "TextDecoder",
  "RegExp",
  "URL",
  "Date",
  "Error",
  "Intl.DateTimeFormat",
  "Intl.NumberFormat",
  "Intl.Collator",
  "Intl.PluralRules",
  "Intl.RelativeTimeFormat",
  "Intl.ListFormat",
  "Intl.Segmenter",
]);
/** Containers that are state only when the file changes them. */
const CONTAINERS = new Set([
  "Map",
  "Set",
  "Array",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "Int32Array",
  "Float64Array",
]);

const escapeName = (name) => name.replace(/[$]/g, "\\$&");

/** Whether `code` changes the module-level binding `name` (a container's contents). */
export function changes(code, name) {
  const n = escapeName(name);
  return [
    new RegExp(
      String.raw`(?<![\w$.])${n}\s*(?:\?\.|\.)\s*(?:set|add|delete|clear|push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)\s*\(`,
    ),
    new RegExp(
      String.raw`(?<![\w$.])${n}\s*(?:\[[^\]]*\]|\.[\w$]+)\s*(?:[-+*/%&|^]|\?\?|&&|\|\|)?=(?!=)`,
    ),
    new RegExp(String.raw`\bdelete\s+${n}\s*[.[]`),
    new RegExp(String.raw`\bObject\.(?:assign|defineProperty|defineProperties)\(\s*${n}\s*[,)]`),
    new RegExp(String.raw`(?<![\w$.])${n}\.length\s*=(?!=)`),
  ].some((pattern) => pattern.test(code));
}

function unwrap(node) {
  let value = node;
  while (
    value &&
    (ts.isAsExpression(value) ||
      ts.isParenthesizedExpression(value) ||
      ts.isTypeAssertionExpression(value) ||
      ts.isNonNullExpression(value) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(value)))
  ) {
    value = value.expression;
  }
  return value;
}

/** The module-level state in one file's text, as `{ name, line, kind }`. */
export function moduleState(text, fileName = "module.ts") {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const add = (node, name, what) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push({ name, line, kind: what });
  };
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(source);
        if (!isConst) {
          add(declaration, name, "let");
          continue;
        }
        const value = unwrap(declaration.initializer);
        if (!value) continue;
        if (ts.isNewExpression(value)) {
          const made = value.expression.getText(source);
          if (KEEPING.has(made)) add(declaration, name, `new ${made}`);
          else if (CONTAINERS.has(made)) {
            if (changes(text, name)) add(declaration, name, `new ${made}, changed`);
          } else if (!STATELESS.has(made)) add(declaration, name, `new ${made}`);
        } else if (ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value)) {
          if (changes(text, name)) add(declaration, name, "a literal, changed");
        }
      }
    } else if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (!ts.isPropertyDeclaration(member)) continue;
        const modifiers = member.modifiers ?? [];
        const isStatic = modifiers.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
        const isReadonly = modifiers.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword);
        if (isStatic && !isReadonly) {
          add(
            member,
            `${statement.name?.text ?? "class"}.${member.name.getText(source)}`,
            "static",
          );
        }
      }
    }
  }
  return found;
}

/** The decisions an entry on the list may give. */
export const DECISIONS = Object.freeze({
  /** Kept apart per client: by the client scope, or keyed by a client's environment or handle. */
  client: "keyed by client",
  /** Holds nothing of any client's: code, constants, the deployment's own values, a counter. */
  independent: "holds nothing of a client's",
  /** Lives for one request or call (AsyncLocalStorage), or only in a browser. */
  call: "one call's, or the browser's",
});

/** Every problem under `root`, as "path: message" strings. */
export function checkModuleState(root, list = MODULE_STATE) {
  const problems = [];
  const seen = new Set();
  for (const dir of scannedDirs(root)) {
    for (const path of files(join(root, dir))) {
      const file = relative(root, path).split(sep).join("/");
      for (const state of moduleState(readFileSync(path, "utf8"), file)) {
        const key = `${file}#${state.name}`;
        seen.add(key);
        const entry = list[key];
        if (!entry) {
          problems.push(
            `${file}:${state.line}: module-level state \`${state.name}\` (${state.kind}) is not on the list in scripts/module-state.mjs: key it by client, or list it with why it holds nothing of a client's (ADR 0617)`,
          );
        } else if (!Object.hasOwn(DECISIONS, entry[0]) || !entry[1]?.trim()) {
          problems.push(
            `${key}: the list's entry needs a decision (${Object.keys(DECISIONS).join(", ")}) and a reason`,
          );
        }
      }
    }
  }
  for (const key of Object.keys(list)) {
    if (!seen.has(key)) {
      problems.push(`${key}: on scripts/module-state.mjs but not found; take it off the list`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const problems = checkModuleState(root);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
}
