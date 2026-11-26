// The one address of a many-client host's gatekeeper callbacks (stage 66 step 6, ADR 0616;
// "Gatekeeper callbacks use one address per deployment").
//
// A provider's app (Google's, Microsoft's, Slack's, Stripe's webhook endpoint) is registered once,
// with one redirect or delivery address, so every client's callbacks arrive on one hostname of
// the fleet's domain: `COS_CALLBACK_HOSTNAME`, the host's own and no client's. Every gatekeeper's
// `BASE_URL` is under it (`gatekeeperBaseUrl`, set by the deploy engine, step 7).
//
// The host chooses no client from a callback. What the callback carries (an OAuth `state`, a
// webhook's endpoint id) is checked by the gatekeeper against what it stored when the client's
// own integration host started the flow, and only then does the gatekeeper act, through the
// capability that client's integration host gave it (`ConnectCallback`, a hook): so a callback
// carrying client A's state or endpoint can only ever reach client A's connection. ADR 0616 says
// which gatekeepers hold to that today and which need work first.
//
// Exported as `@composable-os/db/callbacks`; the app's entry (step 4) calls `isCallbackRequest`
// before deciding a client, and serves only `/gatekeeper/<vendor>/...` there, with no client.
import { canonicalHostname } from "./registry.ts";

export const CALLBACK_HOSTNAME_VAR = "COS_CALLBACK_HOSTNAME";

/** The paths the callback hostname serves: each gatekeeper's public routes, and nothing else. */
export const CALLBACK_PATH = /^\/gatekeeper\/([a-z][a-z0-9-]{1,40})(?:\/|$)/;

/** The deployment's callback hostname, or null when it has none (a single-client deployment). */
export function callbackHostname(env: { COS_CALLBACK_HOSTNAME?: string }): string | null {
  const value = env.COS_CALLBACK_HOSTNAME;
  if (value === undefined || value === "") return null;
  const hostname = canonicalHostname(value);
  if (hostname !== value) {
    throw new Error(`${CALLBACK_HOSTNAME_VAR} must be a lowercase hostname with no port`);
  }
  return hostname;
}

/**
 * Whether a request is a gatekeeper callback on the deployment's callback hostname: its hostname
 * is exactly that one and its path is a gatekeeper's. Then the vendor it is for, else null. A
 * request to the callback hostname on any other path is no client's and no gatekeeper's: the
 * entry answers it 404.
 */
export function isCallbackRequest(
  env: { COS_CALLBACK_HOSTNAME?: string },
  url: URL,
): { vendor: string } | null {
  const own = callbackHostname(env);
  if (!own || canonicalHostname(url.hostname) !== own) return null;
  const vendor = CALLBACK_PATH.exec(url.pathname)?.[1];
  return vendor ? { vendor } : null;
}

/** Whether `hostname` is the deployment's callback hostname (never a client's). */
export function isCallbackHostname(
  env: { COS_CALLBACK_HOSTNAME?: string },
  hostname: string | null | undefined,
): boolean {
  const own = callbackHostname(env);
  return own !== null && canonicalHostname(hostname) === own;
}

/** A gatekeeper's `BASE_URL` on a many-client deployment: under the one callback address. */
export function gatekeeperBaseUrl(env: { COS_CALLBACK_HOSTNAME?: string }, vendor: string): string {
  const own = callbackHostname(env);
  if (!own) throw new Error(`${CALLBACK_HOSTNAME_VAR} is not set`);
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(vendor)) throw new RangeError("Not a gatekeeper's vendor id");
  return `https://${own}/gatekeeper/${vendor}`;
}
