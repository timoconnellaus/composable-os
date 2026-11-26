#!/usr/bin/env node
// What code below the host's entries may not reach (stage 66 step 4, ADR 0615; review of #512, S1;
// hardening, #515, S2).
//
// On a host that serves many clients, the module-level `env` of `cloudflare:workers` is the host's
// own environment, never a client's, and `exports` (or an ExecutionContext's `ctx.exports`) reaches
// every Durable Object namespace raw and mints entrypoints with any props. The receiving side checks
// the host's proof on names and props (packages/db/src/client-proofs.ts), and a Durable Object's
// base class holds only its client's environment (`ClientDurableObject`), so a reach without the
// keys gets nothing of another client's; this check keeps the reach itself out of the code. It runs
// in `pnpm lint` over the two Workers' sources and every package bundled into them, parsing each
// file with TypeScript (not by pattern, so spacing, aliases and comments change nothing), and fails
// when a file outside its allow-list:
// - imports `env` or `exports` from `cloudflare:workers` (any alias), imports the module whole
//   (`import * as`), re-exports either, or imports it dynamically;
// - imports one of the Workers' env modules whole (`import * as` of request-env or deployment-env);
// - imports a module by a computed specifier (`import(x)`, a template with a substitution), or
//   calls `require`;
// - uses `ctx.exports` (or `this.ctx.exports`, `ctx?.exports`);
// - imports `deploymentEnv`, the host's own env as the entry modules read it at load;
// - names `CLIENT_DB`, `CLIENT_DB_QUERIES` or `ClientDb`, or imports cos-client-db's modules: a
//   client's database is its environment's `DB`;
// - declares a Durable Object class (extending `DurableObject`, the Agents SDK's `Agent` or
//   partyserver's `Server`) that does not extend `ClientDurableObject(...)`;
// - reads `this.env` (or `this["env"]`, `Reflect.get(this, "env")`) in a class that is neither an
//   entry (a `WorkerEntrypoint` or `WorkflowEntrypoint`, which decides the client from the real
//   `env`) nor a `ClientDurableObject(...)` (whose `this.env` is its client's), nor has an `env`
//   of its own.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The packages bundled into cos-app and cos-runner (their own gatekeepers are other Workers). */
const BUNDLED_PACKAGES = [
  "agent-a2ui",
  "agent-core",
  "agent-plugins",
  "agent-voice",
  "auth",
  "calendar-file",
  "client",
  "core",
  "mcp-shared",
  "pdf",
  "product",
  "sdk",
  "ui",
];

/** Every folder scanned, and who may do what (a path, relative to the repository's root). */
export const SCANNED = {
  dirs: [
    "apps/app/src",
    "apps/runner/src",
    "packs",
    ...BUNDLED_PACKAGES.map((name) => `packages/${name}/src`),
  ],
  /** The one module of each Worker that imports the module `env` (and re-exports it as such). */
  moduleEnv: ["apps/app/src/server/request-env.ts", "apps/runner/src/deployment-env.ts"],
  /** Who imports `deploymentEnv`: the entry modules, for what they read at load. */
  deploymentEnv: [
    "apps/app/src/server.ts",
    "apps/app/src/server/request-env.ts",
    "apps/runner/src/index.ts",
    "apps/runner/src/deployment-env.ts",
  ],
  /**
   * Who mints entrypoints with `ctx.exports`: the integration host (each with the host's proof,
   * `ClientObject.proof`) and the fake gatekeeper, which is a gatekeeper on the runner's own env.
   */
  ctxExports: ["apps/runner/src/integrations/host.ts", "apps/runner/src/integrations/fake.ts"],
  /**
   * Durable Object classes that are not a client's: the fake gatekeeper's (refused on a host of
   * many clients, ADR 0616) and mcp-shared's account base, which the MCP gatekeeper Workers use
   * (another Worker, never bundled into the host's objects).
   */
  hostObjects: [
    "apps/runner/src/integrations/fake.ts",
    "packages/mcp-shared/src/account.ts",
    "packages/mcp-shared/src/facet.ts",
  ],
  /** Node-only modules (build scripts' helpers), never bundled into a Worker: no rule applies. */
  nodeOnly: ["packages/product/src/node.ts"],
};

const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;
const TEST_FILE = /\.test\.tsx?$/;
const WORKERS_MODULE = "cloudflare:workers";
const ENV_MODULE = /(^|\/)(request-env|deployment-env)(\.ts)?$/;
const CLIENT_DB_NAMES = new Set(["CLIENT_DB", "CLIENT_DB_QUERIES", "ClientDb"]);
const CLIENT_DB_MODULES = new Set([
  "@composable-os/db/client-db",
  "@composable-os/db/client-db-service",
]);

function* files(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "generated") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (SOURCE.test(name) && !TEST_FILE.test(name)) yield path;
  }
}

function parse(text, file = "file.ts") {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const isString = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/** Every rule `text` breaks, by name, each with the line it breaks it on. */
export function findings(text, file = "file.ts") {
  const source = parse(text, file);
  const found = [];
  const add = (rule, node) =>
    found.push({
      rule,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });

  walk(source, (node) => {
    // import … from "…", export … from "…"
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isString(node.moduleSpecifier)
    ) {
      const from = node.moduleSpecifier.text;
      const typeOnly = ts.isImportDeclaration(node)
        ? Boolean(node.importClause?.isTypeOnly)
        : node.isTypeOnly;
      if (CLIENT_DB_MODULES.has(from)) add("client-db", node);
      if (!typeOnly && from === WORKERS_MODULE) {
        if (ts.isImportDeclaration(node)) {
          const bindings = node.importClause?.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) add("module-env", node);
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              const imported = (element.propertyName ?? element.name).text;
              if (!element.isTypeOnly && (imported === "env" || imported === "exports")) {
                add("module-env", element);
              }
            }
          }
        } else if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
          add("module-env", node);
        } else {
          for (const element of node.exportClause.elements) {
            const exported = (element.propertyName ?? element.name).text;
            if (!element.isTypeOnly && (exported === "env" || exported === "exports")) {
              add("module-env", element);
            }
          }
        }
      }
      if (!typeOnly && ENV_MODULE.test(from) && ts.isImportDeclaration(node)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) add("env-module-whole", node);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === "deploymentEnv") {
              add("deployment-env", element);
            }
          }
        }
      }
    }
    // import(…) and require(…)
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [specifier] = node.arguments;
        if (!isString(specifier)) add("computed-import", node);
        else if (specifier.text === WORKERS_MODULE) add("module-env", node);
        else if (ENV_MODULE.test(specifier.text)) add("env-module-whole", node);
        else if (CLIENT_DB_MODULES.has(specifier.text)) add("client-db", node);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add("require", node);
      }
      // Reflect.get(this, "env"), Reflect.get(ctx, "exports")
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Reflect"
      ) {
        const [target, key] = node.arguments;
        if (target?.kind === ts.SyntaxKind.ThisKeyword && (!isString(key) || key.text === "env")) {
          add("this-env-reflect", node);
        }
      }
    }
    // ctx.exports, this.ctx.exports, ctx?.exports, ctx["exports"]
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "exports") ||
      (ts.isElementAccessExpression(node) &&
        isString(node.argumentExpression) &&
        node.argumentExpression.text === "exports")
    ) {
      const target = node.expression;
      const named =
        (ts.isIdentifier(target) && target.text === "ctx") ||
        (ts.isPropertyAccessExpression(target) && target.name.text === "ctx");
      if (named) add("ctx-exports", node);
    }
    // CLIENT_DB, CLIENT_DB_QUERIES, ClientDb: as a name or a string key
    if (ts.isIdentifier(node) && CLIENT_DB_NAMES.has(node.text)) add("client-db", node);
    if (isString(node) && CLIENT_DB_NAMES.has(node.text)) add("client-db", node);
    // Durable Object classes, and `this.env` by the class it is in
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const kind = classKind(node, source);
      if (kind === "object") add("object-base", node);
    }
    if (isThisEnv(node)) {
      const owner = enclosingClass(node);
      const kind = owner ? classKind(owner, source) : "none";
      if (kind !== "client-object" && kind !== "entry" && !(owner && hasOwnEnv(owner))) {
        add("this-env", node);
      }
    }
  });
  return found;
}

/** `this.env` or `this["env"]`. */
function isThisEnv(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.expression.kind === ts.SyntaxKind.ThisKeyword && node.name.text === "env";
  }
  if (ts.isElementAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return !isString(node.argumentExpression) || node.argumentExpression.text === "env";
  }
  return false;
}

/** The class whose `this` a node's `this` is: arrow functions keep it, functions do not. */
function enclosingClass(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isClassDeclaration(at) || ts.isClassExpression(at)) return at;
    if (ts.isFunctionDeclaration(at) || ts.isFunctionExpression(at)) return null;
  }
  return null;
}

/** Whether a class declares `env` itself (a field or a constructor's parameter property). */
function hasOwnEnv(cls) {
  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      if (member.name.text === "env") return true;
    }
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        const modified = ts.getModifiers(parameter)?.length;
        if (modified && ts.isIdentifier(parameter.name) && parameter.name.text === "env") {
          return true;
        }
      }
    }
  }
  return false;
}

/** What a class is by what it extends: a client's object, an entry, a raw object, or neither. */
function classKind(cls, source) {
  const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  const base = heritage?.types[0]?.expression;
  if (!base) return "other";
  if (
    ts.isCallExpression(base) &&
    ts.isIdentifier(base.expression) &&
    base.expression.text === "ClientDurableObject"
  ) {
    return "client-object";
  }
  const text = base.getText(source);
  if (/^(WorkerEntrypoint|WorkflowEntrypoint)\b/.test(text)) return "entry";
  if (/\b(DurableObject|Agent|Server)\b/.test(text)) return "object";
  return "other";
}

/** Whether `text` reaches the module-level `env` or `exports` of `cloudflare:workers`. */
export function importsModuleEnv(text) {
  return findings(text).some((f) => f.rule === "module-env");
}

/** Whether `text` mints entrypoints through an ExecutionContext's `exports`. */
export function usesCtxExports(text) {
  return findings(text).some((f) => f.rule === "ctx-exports");
}

/** Whether `text` imports `deploymentEnv`. */
export function importsDeploymentEnv(text) {
  return findings(text).some((f) => f.rule === "deployment-env");
}

/**
 * Whether `text` reaches every client's databases directly: the `CLIENT_DB` or `CLIENT_DB_QUERIES`
 * binding, the `ClientDb` class or cos-client-db's modules. The app and the runner reach a client's
 * database only as the `DB` of its environment (inside packages/db, with the host's proof of the
 * client on each call), and no code of theirs can call an operator's method on a client's object.
 */
export function reachesClientDb(text) {
  return findings(text).some((f) => f.rule === "client-db");
}

/** Whether `text` loads code by a name the check cannot read: a computed `import()`, `require`. */
export function loadsByComputedName(text) {
  return findings(text).some((f) => f.rule === "computed-import" || f.rule === "require");
}

/** Whether `text` reaches a real `env` from a class that should only hold a client's. */
export function reachesHostEnv(text) {
  return findings(text).some((f) =>
    ["this-env", "this-env-reflect", "object-base", "env-module-whole"].includes(f.rule),
  );
}

const MESSAGES = {
  "module-env":
    "imports env or exports from cloudflare:workers; read the entry's env, or requestEnv() in the app (ADR 0615)",
  "env-module-whole": "imports a Worker's env module whole; import requestEnv by name (ADR 0615)",
  "computed-import": "imports a module by a computed name, which this check cannot read (ADR 0615)",
  require: "calls require, which this check cannot read (ADR 0615)",
  "ctx-exports": "mints entrypoints with ctx.exports (ADR 0615)",
  "deployment-env": "imports deploymentEnv, the host's own env (ADR 0615)",
  "client-db":
    "reaches CLIENT_DB, CLIENT_DB_QUERIES or ClientDb; a client's database is its environment's DB (ADR 0615)",
  "object-base":
    "declares a Durable Object class that does not extend ClientDurableObject(...), so it would hold the host's env (ADR 0615)",
  "this-env":
    "reads this.env in a class that is neither an entry nor a ClientDurableObject: it may be the host's env (ADR 0615)",
  "this-env-reflect": "reads this.env by reflection (ADR 0615)",
};

/** Who may break which rule: the allow-lists above. */
function allowed(rule, file) {
  if (rule === "module-env") return SCANNED.moduleEnv.includes(file);
  if (rule === "deployment-env") return SCANNED.deploymentEnv.includes(file);
  if (rule === "ctx-exports") return SCANNED.ctxExports.includes(file);
  if (rule === "object-base" || rule === "this-env") return SCANNED.hostObjects.includes(file);
  return false;
}

/** Every problem under `root`, as "path: message" strings. */
export function checkModuleEnv(root) {
  const problems = [];
  for (const dir of SCANNED.dirs) {
    for (const path of files(join(root, dir))) {
      const file = relative(root, path).split(sep).join("/");
      if (SCANNED.nodeOnly.includes(file)) continue;
      const text = readFileSync(path, "utf8");
      const seen = new Set();
      for (const { rule, line } of findings(text, file)) {
        if (allowed(rule, file) || seen.has(rule)) continue;
        seen.add(rule);
        problems.push(`${file}:${line}: ${MESSAGES[rule]}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const problems = checkModuleEnv(root);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
}
