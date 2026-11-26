// The environment code below an entry reads when it is not handed one (stage 66 step 4, ADR 0615):
// TanStack Start's middleware, its server functions and the routes that do not get the fetch
// handler's `env`. Until stage 66 they read the module-level `env` of `cloudflare:workers`; on a
// many-client host that is the host's own, never a client's, so they read `requestEnv()`: the
// environment of the client the entry decided, held for the length of the request (and of
// anything it starts, `waitUntil` included) by AsyncLocalStorage.
//
// This is the one module of the app that imports the module-level `env`
// (scripts/check-module-env.mjs refuses any other).
//
// Single-client deployment: no store is ever set, and `requestEnv()` is the module `env` after
// one constant check, exactly as before.

import { env as workerEnv } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { type ClientScope, provideClientScope, runInClientScope } from "@composable-os/core";
import { servesManyClients } from "@composable-os/db/client-entries";
import { clientStampOf } from "@composable-os/db/client-environment";
import { provideObjectScope } from "@composable-os/db/client-objects";

const current = new AsyncLocalStorage<Env>();

// On a host that serves many clients (stage 66 step 5, ADR 0617), what core keeps at module level
// is kept per client: each entry runs its client's code in that client's scope (`runInClientEnv`),
// and code outside every client's scope is refused rather than given another client's.
if (servesManyClients(workerEnv)) {
  provideClientScope(new AsyncLocalStorage<ClientScope>(), { unscoped: "refuse" });
  // Every call that enters one of the app's client objects, in that client's scope.
  provideObjectScope((env, run) => runInClientEnv(env as Env, run));
}

/**
 * The deployment's own environment, for what a Worker reads once at load (the product's label,
 * the Stream host, the staff codes given for the module `env`): the host's values, never a
 * client's. Stage 66 step 5 moves those reads per client.
 */
export const deploymentEnv: Env = workerEnv;

/**
 * Runs `run` with `env` as the request's environment: what the entries do once they decide. It
 * runs in the client's scope too (stage 66 step 5, ADR 0617), so what core keeps at module level
 * for it is its own: the scope is its database, one object per client environment.
 */
export function runInClientEnv<T>(env: Env, run: () => T): T {
  const scope = { database: env.DB as object, client: clientStampOf(env) };
  return current.run(env, () => runInClientScope(scope, run));
}

/**
 * The request's environment. On a many-client host it is the client's that the entry decided;
 * outside an entry that decided one it refuses, rather than give the host's own.
 */
export function requestEnv(): Env {
  if (!servesManyClients(workerEnv)) return workerEnv;
  const env = current.getStore();
  if (env) return env;
  throw new Error(
    "No client for this code: on a many-client host it runs only inside an entry that decided one",
  );
}
