// The client scope of the runner's code (stage 66 step 5, ADR 0617): on a host that serves many
// clients, what core keeps at module level (the extension schema it loaded, a memo, a notice it
// sent) is kept per client, found from the scope the code runs in. The entry module gives core
// the store once (`provideRunnerClientScope`); each entry, once it has decided the client, runs
// that client's work in its scope (`inClientScope`). An operation invoked where no entry set one
// (a Durable Object's own call) runs in its database's scope (core's `invoke`). Code outside every
// scope is refused. A single-client deployment gives no store: nothing changes.
import { AsyncLocalStorage } from "node:async_hooks";
import { type ClientScope, provideClientScope, runInClientScope } from "@composable-os/core";
import { servesManyClients } from "@composable-os/db/client-entries";
import { clientOf } from "@composable-os/db/client-environment";

/** Gives core its client scope store, on a many-client host only: once, at load. */
export function provideRunnerClientScope(deployment: object): void {
  if (!servesManyClients(deployment)) return;
  provideClientScope(new AsyncLocalStorage<ClientScope>(), { unscoped: "refuse" });
}

/** Runs `run` in the scope of `env`'s client: its database, one object per client environment. */
export function inClientScope<T>(env: Env, run: () => T): T {
  return runInClientScope({ database: env.DB as object, client: clientOf(env) }, run);
}
