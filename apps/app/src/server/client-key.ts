// What a value the app keeps per client environment is kept under (stage 66 step 5, ADR 0617):
// on a many-client host the client's own environment object, and nothing else; on a deployment
// that serves one client, one slot for it. An environment the directory did not make (a copy, a
// proxy that is not a registered view) on a many-client host is refused, never put in the single
// client's slot, where every such caller would share one value (review of #522, M1).
import { clientScopesHeld } from "@composable-os/core";
import { clientOf } from "@composable-os/db/client-environment";

/** The one slot of a deployment that serves one client. */
const SINGLE_CLIENT = Object.freeze({});

/** The key for `env`'s per-client values. */
export function clientKeyOf(env: object): object {
  if (clientOf(env) !== null) return env;
  if (clientScopesHeld()) {
    throw new Error(
      "Not a client's environment: on a host that serves many clients a per-client value is kept only for one",
    );
  }
  return SINGLE_CLIENT;
}
