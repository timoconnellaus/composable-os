// Proves the check on what code below the entries may reach works (stage 66 step 4, review of
// #512, S1): every way to the module env, `exports` and `ctx.exports`, `deploymentEnv` and the
// clients' databases is caught, the module's other exports are not, and the real repository
// passes. Run by `pnpm lint` with `node --test`.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkModuleEnv,
  findings as findingsOf,
  importsDeploymentEnv,
  importsModuleEnv,
  loadsByComputedName,
  reachesClientDb,
  reachesHostEnv,
  SCANNED,
  scannedFiles,
  usesCtxExports,
} from "./check-module-env.mjs";

test("the repository's Workers and the packages bundled into them pass", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(checkModuleEnv(root), []);
  assert.ok(SCANNED.dirs.includes("packs"));
  // What the Workers import is read wherever it lives (review of #520, M2): packages/db's objects
  // and parking, packages/core, packages/release.
  const scanned = scannedFiles(root);
  for (const file of [
    "packages/db/src/client-objects.ts",
    "packages/db/src/client-parking.ts",
    "packages/core/src/index.ts",
  ]) {
    assert.ok(scanned.includes(file), file);
  }
  assert.ok(scanned.some((file) => file.startsWith("packages/release/")));
});

test("every way to the module env or exports is caught", () => {
  for (const text of [
    'import { env } from "cloudflare:workers";',
    'import { env as workerEnv } from "cloudflare:workers";',
    'import { WorkerEntrypoint, env } from "cloudflare:workers";',
    "import {\n  DurableObject,\n  env as e,\n} from 'cloudflare:workers';",
    'import * as workers from "cloudflare:workers";',
    'import { exports } from "cloudflare:workers";',
    'import { exports as x } from "cloudflare:workers";',
    'export { env } from "cloudflare:workers";',
    'export { exports } from "cloudflare:workers";',
    'export * from "cloudflare:workers";',
    'export * as w from "cloudflare:workers";',
    'const { env } = await import("cloudflare:workers");',
    "const { exports } = await import(`cloudflare:workers`);",
    // Spacing, comments and line breaks change nothing: the file is parsed (#515, S2).
    'import {\n  // the module env\n  env\n} from "cloudflare:workers"',
    'import{env}from"cloudflare:workers"',
    "const w = await import(/* any */ 'cloudflare:workers');",
  ]) {
    assert.equal(importsModuleEnv(text), true, text);
  }
});

test("ctx.exports, deploymentEnv and the clients' databases are caught", () => {
  for (const text of [
    "this.ctx.exports.ClientApp({ props: { client } })",
    "ctx.exports.AssistantAgent.idFromName(name)",
    "ctx?.exports.default({ props })",
  ]) {
    assert.equal(usesCtxExports(text), true, text);
  }
  assert.equal(usesCtxExports("// ctx.exports is the integration host's\nconst a = 1;"), false);
  for (const text of [
    'import { deploymentEnv } from "./request-env.ts";',
    'import { requestEnv, deploymentEnv as host } from "../server/request-env.ts";',
  ]) {
    assert.equal(importsDeploymentEnv(text), true, text);
  }
  assert.equal(importsDeploymentEnv('import { requestEnv } from "./request-env.ts";'), false);
  for (const text of [
    "env.CLIENT_DB.get(env.CLIENT_DB.idFromName(id)).restore(b);",
    'const ns = (env as Record<string, unknown>)["CLIENT_DB"];',
    'import type { ClientDb } from "@composable-os/db/client-db";',
    'import { clientDatabase } from "@composable-os/db/client-db";',
    // The query path's binding too (#515, S1), and cos-client-db's service module.
    "env.CLIENT_DB_QUERIES.query({ client: 'gym-b' }, [])",
    'const q = env["CLIENT_DB_QUERIES"];',
    'import type { ClientDbQueryService } from "@composable-os/db/client-db-service";',
  ]) {
    assert.equal(reachesClientDb(text), true, text);
  }
  assert.equal(reachesClientDb("// CLIENT_DB is the host's\nconst db = env.DB;"), false);
});

test("the module's other exports, types and comments pass", () => {
  for (const text of [
    'import { DurableObject } from "cloudflare:workers";',
    'import { WorkerEntrypoint, RpcTarget, waitUntil } from "cloudflare:workers";',
    'import type { env } from "cloudflare:workers";',
    '// import { env } from "cloudflare:workers";',
    'import { environment } from "cloudflare:workers";',
    'export { DurableObject } from "cloudflare:workers";',
  ]) {
    assert.equal(importsModuleEnv(text), false, text);
  }
});

test("code loaded by a name the check cannot read is caught (#515, S2)", () => {
  for (const text of [
    "const m = await import(name);",
    "const m = await import(`cloudflare:${'workers'}`);",
    'const m = await import("cloudflare:" + "workers");',
    'const { env } = require("cloudflare:workers");',
    "const m = require(name);",
  ]) {
    assert.equal(loadsByComputedName(text) || importsModuleEnv(text), true, text);
  }
  assert.equal(loadsByComputedName('const m = await import("./module.ts");'), false);
});

test("a real env reached from a class that should hold a client's is caught (#515, S2)", () => {
  for (const text of [
    // A Durable Object class on its own base: its `env` is the host's.
    "export class X extends DurableObject<Env> { m() { return 1; } }",
    "export class X extends Agent<Env> {}",
    "export class X extends withVoice(Agent<Env>) {}",
    // `this.env` outside an entry or a client's object, plain, by key or by reflection.
    "class Helper extends Base { m() { return this.env.REGISTRY; } }",
    'class Helper { m() { return this["env"]; } }',
    'class Helper { m() { return Reflect.get(this, "env"); } }',
    "class Helper { m(k) { return this[k]; } }",
    // A Worker's env module, whole.
    'import * as hostEnv from "./server/request-env.ts";',
    'import * as hostEnv from "../deployment-env";',
  ]) {
    assert.equal(reachesHostEnv(text), true, text);
  }
  for (const text of [
    "export class X extends ClientDurableObject(DurableObject<Env>) { m() { return this.env.DB; } }",
    "export class X extends ClientDurableObject(withVoice(Agent<Env>)) { m() { return this.env; } }",
    "export class E extends WorkerEntrypoint<Env> { m() { return this.env; } }",
    "export class W extends WorkflowEntrypoint<Env, P> { run() { return this.env; } }",
    "class Compiler { constructor(readonly env: Scope) {} m() { return this.env.fields; } }",
    "class Compiler { env: Scope; m() { return this.env; } }",
    'import { requestEnv } from "./server/request-env.ts";',
  ]) {
    assert.equal(reachesHostEnv(text), false, text);
  }
});

test("the evasions of the review of #520 (M2) are each caught", () => {
  const caught = (text, rule) =>
    assert.ok(
      // biome-ignore lint/suspicious/noExplicitAny: a test reads the findings' rules
      findingsOf(text).some((f) => f.rule === rule),
      `${rule}: ${text}`,
    );
  // A Durable Object base under another name.
  caught(
    'import { DurableObject } from "cloudflare:workers"; const B = DurableObject; class X extends B {}',
    "object-base",
  );
  caught(
    'import { DurableObject as DO } from "cloudflare:workers"; class X extends DO {}',
    "object-base",
  );
  caught('import { Agent as A } from "agents"; class X extends A<Env> {}', "object-base");
  caught("class Base extends DurableObject {} class X extends Base {}", "object-base");
  // `this` under another name, or destructured.
  caught("class X extends Base { m() { const s = this; return s.env; } }", "this-env");
  caught("class X extends Base { m() { const { env } = this; return env; } }", "this-env");
  caught("class X extends Base { m() { let s; s = this; return s.env; } }", "this-env");
  caught(
    'class X extends Base { m() { return Object.getOwnPropertyDescriptor(this, "env"); } }',
    "this-env-reflect",
  );
  // ctx.exports through parentheses, `!`, a cast, an alias, destructuring, another name.
  for (const text of [
    "(this.ctx).exports.X",
    "this.ctx!.exports.X",
    "(this.ctx as any).exports.X",
    "const c = this.ctx; c.exports.X",
    "const { exports } = this.ctx;",
    "state.exports.X",
    'ctx["exports"].X',
  ]) {
    caught(text, "ctx-exports");
  }
  assert.equal(usesCtxExports("module.exports = {};"), false);
  // Re-exports of an env module, in any form.
  caught('export * from "../request-env.ts";', "env-module-whole");
  caught('export * as x from "./server/request-env.ts";', "env-module-whole");
  caught('export { deploymentEnv } from "../deployment-env.ts";', "deployment-env");
  caught('export { requestEnv } from "../request-env.ts";', "env-module-whole");
  // createRequire, and node:module.
  caught(
    'import { createRequire } from "node:module"; const r = createRequire(import.meta.url); r("x");',
    "require",
  );
  caught('const r = (await import("node:module")).createRequire(import.meta.url);', "require");
});

test("a client object's constructor passes its env (the host's) straight to super and no further (review of #520, S2)", () => {
  for (const text of [
    "class X extends ClientDurableObject(DurableObject<Env>) { constructor(ctx, env) { super(ctx, env); this.x = env; } }",
    "class X extends ClientDurableObject(DurableObject<Env>) { constructor(ctx, env) { super(ctx, env); new Helper(env); } }",
    "class X extends ClientDurableObject(DurableObject<Env>) { constructor(ctx, env) { const e = env; super(ctx, e); } }",
    "class X extends ClientDurableObject(DurableObject<Env>) { constructor(ctx, { REGISTRY }) { super(ctx, {}); } }",
    "class X extends ClientDurableObject(DurableObject<Env>) { constructor(ctx, private env) { super(ctx, env); } }",
    "class X extends ClientDurableObject(DurableObject<Env>) { constructor(...args) { super(...args); keep(args); } }",
  ]) {
    assert.equal(reachesHostEnv(text), true, text);
  }
  for (const text of [
    "class X extends ClientDurableObject(DurableObject<Env>) { constructor(ctx, env) { super(ctx, env); this.w = new W(ctx.storage); } }",
    "class X extends ClientDurableObject(DurableObject<Env>) { constructor(...args) { super(...args); } }",
    "class X extends ClientDurableObject(DurableObject<Env>) { constructor(ctx) { super(ctx, undefined); } }",
  ]) {
    assert.equal(reachesHostEnv(text), false, text);
  }
});
