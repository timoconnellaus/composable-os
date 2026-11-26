#!/usr/bin/env node
// What code below the host's entries may not reach (stage 66 step 4, ADR 0615; review of #512, S1;
// hardening, #515, S2; review of #520, S2 and M2).
//
// On a host that serves many clients, the module-level `env` of `cloudflare:workers` is the host's
// own environment, never a client's, and `exports` (or an ExecutionContext's `ctx.exports`) reaches
// every Durable Object namespace raw and mints entrypoints with any props. The receiving side checks
// the host's proof on names and props (packages/db/src/client-proofs.ts), and a Durable Object's
// base class holds only its client's environment (`ClientDurableObject`), so a reach without the
// keys gets nothing of another client's; this check keeps the reach itself out of the code.
//
// What it reads: every source file of the two Workers (apps/app/src, apps/runner/src) and the
// packs, and every file of the workspace those import, followed through their imports (relative
// paths and workspace packages by their `exports`), so what is bundled into a host Worker is
// checked wherever it lives (review of #520, M2). Third-party packages are not read. Each file is
// parsed with TypeScript (so spacing, aliases, parentheses and casts change nothing), and the
// check fails when a file outside its allow-list:
// - imports `env` or `exports` from `cloudflare:workers` (any alias), imports the module whole
//   (`import * as`), re-exports either, or imports it dynamically;
// - imports one of the Workers' env modules whole, or re-exports from one in any form;
// - imports a module by a computed specifier, calls `require`, or uses `createRequire` (or
//   imports `node:module`);
// - reads `exports` of anything but `module` (`ctx.exports` through parentheses, `!`, a cast or an
//   alias; `state.exports`; `x["exports"]`), or destructures `{ exports }`;
// - imports `deploymentEnv`, the host's own env as the entry modules read it at load;
// - names `CLIENT_DB`, `CLIENT_DB_QUERIES` or `ClientDb`, or imports cos-client-db's modules (except
//   packages/db, which defines them): a client's database is its environment's `DB`;
// - declares a Durable Object class (extending `DurableObject`, the Agents SDK's `Agent` or
//   partyserver's `Server`, under any import alias or local alias, or a class of the same file that
//   does) that does not extend `ClientDurableObject(...)`;
// - in a `ClientDurableObject(...)` class, has a constructor that uses its env parameter (the host's
//   real `env`, which the runtime passes) other than by passing it straight to `super`;
// - reads `this.env` (or `this["env"]`, `this[k]`), binds `this` to a name (`const s = this`,
//   `{ env } = this`), or passes `this` to `Reflect.*` or `Object.*`, in a class that is neither an
//   entry (a `WorkerEntrypoint` or `WorkflowEntrypoint`, which decides the client from the real
//   `env`) nor a `ClientDurableObject(...)` (whose `this.env` is its client's), nor has an `env` of
//   its own.
//
// What a lint cannot make sound is said in ADR 0615, "What remains convention": a computed property
// name (`env["CLIENT" + "_DB"]`) is not followed, and neither is a value passed through a function.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Where the Workers' own code is: every file here is read, and what it imports. */
const ROOTS = ["apps/app/src", "apps/runner/src", "packs"];

/** Who may do what (a path, relative to the repository's root). */
export const SCANNED = {
  /** The folders read whole (`ROOTS`); `scannedFiles` adds what they import. */
  dirs: ROOTS,
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
   * Who reads `exports`: the integration host, which mints entrypoints with `ctx.exports` (each with
   * the host's proof, `ClientObject.proof`), and the fake gatekeeper, a gatekeeper on the runner's
   * own env, refused on a host of many clients.
   */
  ctxExports: ["apps/runner/src/integrations/host.ts", "apps/runner/src/integrations/fake.ts"],
  /**
   * Durable Object classes that are not a client's: the fake gatekeeper's (each refuses to be built
   * on a host of many clients); the host's own in packages/db (`ClientDb`, cos-client-db's class;
   * `ParkingLedger`, which checks its own name's proof); and the mixin that is the client objects'
   * base.
   */
  hostObjects: [
    "apps/runner/src/integrations/fake.ts",
    "packages/db/src/client-db.ts",
    "packages/db/src/client-parking.ts",
    "packages/db/src/client-objects.ts",
  ],
  /**
   * Where `CLIENT_DB` and `ClientDb` are defined: the name rule does not apply there. And the deploy
   * engine's fleet bindings (stage 66 step 7, ADR 0618), which write a binding of that name into a
   * Worker upload's metadata and never hold one: reached from the app only because the self-updater
   * imports packages/release's index.
   */
  definesClientDb: ["packages/db/src/", "packages/release/src/fleet.ts"],
  /**
   * Files not read: Node-only modules (build scripts' helpers, never bundled into a Worker), and
   * third-party code bundled at build time (TypeScript's compiler, which only the type checker
   * imports, in its own isolate).
   */
  nodeOnly: ["packages/product/src/node.ts", "apps/runner/src/generated/typescript.js"],
};

/** Every workspace package's folder and manifest, by its name. */
function workspacePackages(root) {
  const byName = new Map();
  for (const base of ["apps", "packages", "packs", "products"]) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const manifest = join(dir, name, "package.json");
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      byName.set(parsed.name, { dir: join(dir, name), manifest: parsed });
    }
  }
  return byName;
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** The file a path names, as a bundler finds it: as written, with an extension, or an index. */
function fileAt(path) {
  const candidates = [path, ...EXTENSIONS.map((ext) => path + ext)];
  // TypeScript's ESM style: `./x.js` names `./x.ts`.
  if (/\.[cm]?js$/.test(path))
    candidates.push(path.replace(/\.([cm]?)js$/, ".$1ts"), path.replace(/\.js$/, ".tsx"));
  candidates.push(...EXTENSIONS.map((ext) => join(path, `index${ext}`)));
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

/** The target of a package's `exports` entry: a string, or the import/default condition's. */
function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    for (const condition of ["workerd", "worker", "import", "default", "module", "types"]) {
      const target = exportTarget(entry[condition]);
      if (target) return target;
    }
  }
  return null;
}

/** The workspace file a specifier imported from `from` names, or null (third-party, virtual). */
function resolveImport(specifier, from, packages) {
  if (specifier.startsWith(".")) return fileAt(resolvePath(dirname(from), specifier));
  const match = /^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/.exec(specifier);
  if (!match) return null;
  const pkg = packages.get(match[1]);
  if (!pkg) return null;
  const subpath = match[2] ? `.${match[2]}` : ".";
  const exportsMap = pkg.manifest.exports;
  let target = null;
  if (typeof exportsMap === "string" && subpath === ".") target = exportsMap;
  else if (exportsMap && typeof exportsMap === "object") target = exportTarget(exportsMap[subpath]);
  if (!target && subpath === ".") target = pkg.manifest.main ?? "./src/index.ts";
  if (!target && subpath !== ".") target = subpath;
  return target ? fileAt(join(pkg.dir, target)) : null;
}

function* filesUnder(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* filesUnder(path);
    else if (SOURCE.test(name) && !TEST_FILE.test(name)) yield path;
  }
}

/**
 * Every file the check reads: the Workers' and the packs' source, and every workspace file they
 * import, followed through (`import`, `export … from`, `import("…")` with a literal).
 */
export function scannedFiles(root) {
  const packages = workspacePackages(root);
  const queue = ROOTS.flatMap((dir) => [...filesUnder(join(root, dir))]);
  const seen = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!SOURCE.test(file)) continue;
    const relativeFile = relative(root, file).split(sep).join("/");
    if (SCANNED.nodeOnly.includes(relativeFile)) continue;
    const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of info.importedFiles) {
      const target = resolveImport(fileName, file, packages);
      if (target && !target.includes(`${sep}node_modules${sep}`) && !seen.has(target)) {
        queue.push(target);
      }
    }
  }
  return [...seen]
    .filter((file) => SOURCE.test(file) && !TEST_FILE.test(file))
    .map((file) => relative(root, file).split(sep).join("/"))
    .sort();
}

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const WORKERS_MODULE = "cloudflare:workers";
const ENV_MODULE = /(^|\/)(request-env|deployment-env)(\.[cm]?[jt]s)?$/;
const CLIENT_DB_NAMES = new Set(["CLIENT_DB", "CLIENT_DB_QUERIES", "ClientDb"]);
const CLIENT_DB_MODULES = new Set([
  "@composable-os/db/client-db",
  "@composable-os/db/client-db-service",
]);
/** The base classes of a Durable Object, by the module that exports each. */
const OBJECT_BASES = {
  "cloudflare:workers": ["DurableObject"],
  agents: ["Agent", "AIChatAgent", "McpAgent"],
  partyserver: ["Server"],
};
const ENTRY_BASES = new Set(["WorkerEntrypoint", "WorkflowEntrypoint"]);
const OBJECT_BASE_NAMES = new Set(Object.values(OBJECT_BASES).flat());

function parse(text, file = "file.ts") {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const isString = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/** An expression without what changes nothing at run time: parentheses, `!`, `as`, `satisfies`. */
function bare(node) {
  let at = node;
  while (
    at &&
    (ts.isParenthesizedExpression(at) ||
      ts.isNonNullExpression(at) ||
      ts.isAsExpression(at) ||
      ts.isSatisfiesExpression?.(at) ||
      ts.isTypeAssertionExpression(at))
  ) {
    at = at.expression;
  }
  return at;
}

const isThis = (node) => bare(node)?.kind === ts.SyntaxKind.ThisKeyword;

/**
 * What each local name of a file stands for, as far as an import or a `const x = y` says: the
 * imported name of `import { DurableObject as DO }`, and a local alias's target, followed through.
 */
function localNames(source) {
  const imported = new Map();
  const aliases = new Map();
  walk(source, (node) => {
    if (ts.isImportDeclaration(node) && isString(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          imported.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = bare(node.initializer);
      if (ts.isIdentifier(init)) aliases.set(node.name.text, init.text);
      if (ts.isPropertyAccessExpression(init)) aliases.set(node.name.text, init.name.text);
    }
  });
  const resolve = (name, depth = 0) => {
    if (depth > 8) return name;
    if (aliases.has(name)) return resolve(aliases.get(name), depth + 1);
    return imported.get(name) ?? name;
  };
  return resolve;
}

/** Every identifier and property name inside `node`, each resolved to what it stands for. */
function namesIn(node, resolve) {
  const names = [];
  walk(node, (inner) => {
    if (ts.isIdentifier(inner)) names.push(resolve(inner.text));
  });
  return names;
}

/** Every rule `text` breaks, by name, each with the line it breaks it on. */
export function findings(text, file = "file.ts") {
  const source = parse(text, file);
  const found = [];
  const add = (rule, node) =>
    found.push({
      rule,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  const resolve = localNames(source);
  const kinds = new Map();
  const kindOf = (cls) => {
    if (!kinds.has(cls)) kinds.set(cls, classKind(cls, resolve, source, kindOf));
    return kinds.get(cls);
  };
  const isolatedClass = (node) => {
    const owner = enclosingClass(node);
    const kind = owner ? kindOf(owner) : "none";
    return kind !== "client-object" && kind !== "entry" && !(owner && hasOwnEnv(owner));
  };

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
      if (!typeOnly && (from === "node:module" || from === "module")) add("require", node);
      const named = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : node.exportClause;
      const whole =
        (ts.isImportDeclaration(node) && named && ts.isNamespaceImport(named)) ||
        (ts.isExportDeclaration(node) && (!named || ts.isNamespaceExport(named)));
      const elements =
        named && (ts.isNamedImports(named) || ts.isNamedExports(named))
          ? named.elements.filter((element) => !element.isTypeOnly)
          : [];
      const original = (element) => (element.propertyName ?? element.name).text;
      if (!typeOnly && from === WORKERS_MODULE) {
        if (whole) add("module-env", node);
        for (const element of elements) {
          if (original(element) === "env" || original(element) === "exports") {
            add("module-env", element);
          }
        }
      }
      if (!typeOnly && ENV_MODULE.test(from)) {
        // Whole, or re-exported in any form: the env module's names travel further unseen.
        if (whole || ts.isExportDeclaration(node)) add("env-module-whole", node);
        for (const element of elements) {
          if (original(element) === "deploymentEnv") add("deployment-env", element);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      // import(…) and require(…), createRequire(…)
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [specifier] = node.arguments;
        if (!isString(specifier)) add("computed-import", node);
        else if (specifier.text === WORKERS_MODULE) add("module-env", node);
        else if (ENV_MODULE.test(specifier.text)) add("env-module-whole", node);
        else if (CLIENT_DB_MODULES.has(specifier.text)) add("client-db", node);
      }
      const callee = bare(node.expression);
      if (
        ts.isIdentifier(callee) &&
        (callee.text === "require" || resolve(callee.text) === "createRequire")
      ) {
        add("require", node);
      }
      // Reflect.get(this, …), Object.getOwnPropertyDescriptor(this, …) and the like
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        (callee.expression.text === "Reflect" || callee.expression.text === "Object") &&
        node.arguments[0] &&
        isThis(node.arguments[0]) &&
        isolatedClass(node)
      ) {
        add("this-env-reflect", node);
      }
    }
    if (ts.isIdentifier(node) && resolve(node.text) === "createRequire") add("require", node);
    // `.exports` of anything (ctx.exports, (this.ctx as X).exports, state.exports, an alias of
    // ctx), `["exports"]`, and destructuring `{ exports }`: the code of the Workers reads no
    // `exports` but `cloudflare:workers`' own (refused above).
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === "exports") ||
      (ts.isElementAccessExpression(node) &&
        isString(node.argumentExpression) &&
        node.argumentExpression.text === "exports") ||
      (ts.isBindingElement(node) &&
        (node.propertyName && ts.isIdentifier(node.propertyName)
          ? node.propertyName.text
          : ts.isIdentifier(node.name)
            ? node.name.text
            : "") === "exports")
    ) {
      const target = ts.isBindingElement(node) ? null : bare(node.expression);
      const moduleExports = target && ts.isIdentifier(target) && target.text === "module";
      if (!moduleExports) add("ctx-exports", node);
    }
    // CLIENT_DB, CLIENT_DB_QUERIES, ClientDb: as a name or a string key
    if (ts.isIdentifier(node) && CLIENT_DB_NAMES.has(node.text)) add("client-db", node);
    if (isString(node) && CLIENT_DB_NAMES.has(node.text)) add("client-db", node);
    // Durable Object classes; a client object's constructor and its real `env`
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const kind = kindOf(node);
      if (kind === "object") add("object-base", node);
      if (kind === "client-object") {
        for (const member of node.members) {
          if (ts.isConstructorDeclaration(member) && !forwardsEnvOnly(member)) {
            add("constructor-env", member);
          }
        }
      }
    }
    // `this.env`, `this["env"]`, `this[k]`, an alias of `this`, `{ env } = this`
    if (isThisEnv(node) && isolatedClass(node)) add("this-env", node);
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isThis(node.initializer) &&
      isolatedClass(node)
    ) {
      add("this-env", node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isThis(node.right) &&
      isolatedClass(node)
    ) {
      add("this-env", node);
    }
  });
  return found;
}

/**
 * Whether a client object's constructor uses its environment parameter (the second, which the
 * runtime fills with the host's real `env`) only by passing it straight to `super` in the same
 * place: `super(ctx, env)`, or `super(...args)` with a rest parameter. Anything else (keeping it,
 * handing it to a helper, destructuring it) would hold the host's env in object code (review of
 * #520, S2).
 */
function forwardsEnvOnly(ctor) {
  const params = ctor.parameters;
  const rest = params.find((p) => p.dotDotDotToken);
  const envParam = rest ?? params[1];
  if (!envParam) return true;
  if (!ts.isIdentifier(envParam.name)) return false;
  if (ts.getModifiers(envParam)?.length) return false;
  const name = envParam.name.text;
  let ok = true;
  walk(ctor.body ?? ctor, (node) => {
    if (!ts.isIdentifier(node) || node.text !== name || node === envParam.name) return;
    const parent = node.parent;
    const call = rest ? parent?.parent : parent;
    const inSuper =
      call &&
      ts.isCallExpression(call) &&
      call.expression.kind === ts.SyntaxKind.SuperKeyword &&
      (rest
        ? ts.isSpreadElement(parent) && call.arguments.indexOf(parent) === 0
        : call.arguments.indexOf(node) === 1);
    if (!inSuper) ok = false;
  });
  return ok;
}

/** `this.env`, `this["env"]` or `this[k]`. */
function isThisEnv(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return isThis(node.expression) && node.name.text === "env";
  }
  if (ts.isElementAccessExpression(node) && isThis(node.expression)) {
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

/**
 * What a class is by what it extends, its names resolved through imports and local aliases (so
 * `import { DurableObject as DO }` and `const B = DurableObject` are seen), and through a class of
 * the same file it extends: a client's object (`ClientDurableObject(...)`), an entry, a raw
 * object, or neither.
 */
function classKind(cls, resolve, source, kindOf) {
  const heritage = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  const base = heritage?.types[0]?.expression;
  if (!base) return "other";
  const bareBase = bare(base);
  if (
    ts.isCallExpression(bareBase) &&
    ts.isIdentifier(bareBase.expression) &&
    resolve(bareBase.expression.text) === "ClientDurableObject"
  ) {
    return "client-object";
  }
  const names = namesIn(base, resolve);
  if (names.some((name) => OBJECT_BASE_NAMES.has(name))) return "object";
  if (names.some((name) => ENTRY_BASES.has(name))) return "entry";
  // A class of this file it extends.
  for (const statement of source.statements) {
    if (
      ts.isClassDeclaration(statement) &&
      statement !== cls &&
      statement.name &&
      names.includes(statement.name.text)
    ) {
      const kind = kindOf(statement);
      if (kind !== "other") return kind;
    }
  }
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
    ["this-env", "this-env-reflect", "object-base", "env-module-whole", "constructor-env"].includes(
      f.rule,
    ),
  );
}

const MESSAGES = {
  "module-env":
    "imports env or exports from cloudflare:workers; read the entry's env, or requestEnv() in the app (ADR 0615)",
  "env-module-whole":
    "imports or re-exports a Worker's env module whole; import requestEnv by name (ADR 0615)",
  "computed-import": "imports a module by a computed name, which this check cannot read (ADR 0615)",
  require: "calls require or createRequire, which this check cannot read (ADR 0615)",
  "ctx-exports": "reads exports (ctx.exports or an alias of it) (ADR 0615)",
  "deployment-env": "imports deploymentEnv, the host's own env (ADR 0615)",
  "client-db":
    "reaches CLIENT_DB, CLIENT_DB_QUERIES or ClientDb; a client's database is its environment's DB (ADR 0615)",
  "object-base":
    "declares a Durable Object class that does not extend ClientDurableObject(...), so it would hold the host's env (ADR 0615)",
  "constructor-env":
    "uses its constructor's env (the host's real env) other than by passing it straight to super (ADR 0615)",
  "this-env":
    "reads this.env (or an alias of this) in a class that is neither an entry nor a ClientDurableObject: it may be the host's env (ADR 0615)",
  "this-env-reflect":
    "reads this by reflection (Reflect or Object) outside an entry or a client's object (ADR 0615)",
};

/** Who may break which rule: the allow-lists above. */
function allowed(rule, file) {
  if (SCANNED.definesClientDb.some((dir) => file.startsWith(dir)) && rule === "client-db")
    return true;
  if (rule === "module-env") return SCANNED.moduleEnv.includes(file);
  if (rule === "deployment-env" || rule === "env-module-whole") {
    return SCANNED.deploymentEnv.includes(file);
  }
  if (rule === "ctx-exports") return SCANNED.ctxExports.includes(file);
  if (rule === "object-base" || rule === "this-env" || rule === "this-env-reflect") {
    return SCANNED.hostObjects.includes(file);
  }
  return false;
}

/** Every problem under `root`, as "path: message" strings. */
export function checkModuleEnv(root) {
  const problems = [];
  for (const file of scannedFiles(root)) {
    if (SCANNED.nodeOnly.includes(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    const seen = new Set();
    for (const { rule, line } of findings(text, file)) {
      if (allowed(rule, file) || seen.has(rule)) continue;
      seen.add(rule);
      problems.push(`${file}:${line}: ${MESSAGES[rule]}`);
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
