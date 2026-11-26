// Proves the module-level env check works (stage 66 step 4): every way of importing `env` from
// cloudflare:workers is caught, the classes and helpers that module also exports are not, and the
// real repository passes. Run by `pnpm lint` with `node --test`.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkModuleEnv, importsModuleEnv, reachesClientDb } from "./check-module-env.mjs";

test("the repository's Workers pass", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(checkModuleEnv(root), []);
});

test("every import of the module env is caught", () => {
  for (const text of [
    'import { env } from "cloudflare:workers";',
    'import { env as workerEnv } from "cloudflare:workers";',
    'import { WorkerEntrypoint, env } from "cloudflare:workers";',
    "import {\n  DurableObject,\n  env as e,\n} from 'cloudflare:workers';",
    'import * as workers from "cloudflare:workers";',
    'const { env } = await import("cloudflare:workers");',
  ]) {
    assert.equal(importsModuleEnv(text), true, text);
  }
});

test("every direct way to the clients' databases is caught, and a comment is not", () => {
  for (const text of [
    "env.CLIENT_DB.get(env.CLIENT_DB.idFromName(id)).restore(b);",
    'const ns = (env as Record<string, unknown>)["CLIENT_DB"];',
    'import type { ClientDb } from "@composable-os/db/client-db";',
    'import { clientDatabase } from "@composable-os/db/client-db";',
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
  ]) {
    assert.equal(importsModuleEnv(text), false, text);
  }
});
