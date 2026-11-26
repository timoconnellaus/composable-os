// The client scope of the runner's code (stage 66 step 5, ADR 0617): on a host that serves many
// clients, what core keeps at module level (the extension schema it loaded, a memo, a notice it
// sent) is kept per client, found from the scope the code runs in. The entry module gives core
// the store once (`provideRunnerClientScope`); each entry, once it has decided the client, runs
// that client's work in its scope (`inClientScope`). An operation invoked where no entry set one
// (a Durable Object's own call) runs in its database's scope (core's `invoke`). Code outside every
// scope is refused. A single-client deployment gives no store: nothing changes.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ClientScope,
  clientScopesHeld,
  provideClientScope,
  runInClientScope,
} from "@composable-os/core";
import { servesManyClients } from "@composable-os/db/client-entries";
import { clientOf, clientStampOf } from "@composable-os/db/client-environment";
import { provideObjectScope } from "@composable-os/db/client-objects";

/** Gives core its client scope store, on a many-client host only: once, at load. */
export function provideRunnerClientScope(deployment: object): void {
  if (!servesManyClients(deployment)) return;
  provideClientScope(new AsyncLocalStorage<ClientScope>(), { unscoped: "refuse" });
  // Every call that enters one of the runner's client objects, in that client's scope.
  provideObjectScope((env, run) => inClientScope(env as { DB?: unknown }, run));
}

/** Runs `run` in the scope of `env`'s client: its database, one object per client environment. */
export function inClientScope<T>(env: { DB?: unknown }, run: () => T): T {
  return runInClientScope({ database: env.DB as object, client: clientStampOf(env) }, run);
}

/** The one slot of a deployment that serves one client. */
const SINGLE_CLIENT = Object.freeze({});

/**
 * What a value the runner keeps per client environment is kept under: on a many-client host the
 * client's own environment object, and an environment the directory did not make is refused,
 * never put in the single client's slot (review of #522, M1). One slot for a single client.
 */
export function clientKeyOf(env: object): object {
  if (clientOf(env) !== null) return env;
  if (clientScopesHeld()) {
    throw new Error(
      "Not a client's environment: on a host that serves many clients a per-client value is kept only for one",
    );
  }
  return SINGLE_CLIENT;
}
