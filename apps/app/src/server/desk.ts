// The desk origin's configuration (stage 44 step 6, stage 51; ADRs 0649 and 0780): its hostname
// (`desk.` before the host's name, set by `cos deploy` on a custom domain) and the env secret
// every enrolment code, device credential, session code and token is HMACed under. Both are the
// deployment's, never a setting: with either missing there is no desk mode at all, and nothing
// falls back to the staff origin.
import type { DeskHost } from "@composable-os/core";

export interface DeskEnv {
  /** The desk origin's hostname, e.g. desk.crm.example.com. Empty: no desk mode. */
  DESK_HOSTNAME?: string;
  /** The HMAC key of desk codes, device credentials and session tokens (an auth secret). */
  DESK_SECRET?: string;
  /** Desk calls per client address (Workers Rate Limiting). */
  DESK_RATE_LIMIT?: import("@composable-os/core").RateLimitBinding;
}

/** The desk's hostname, lower-cased, or null. */
export function deskHostname(env: DeskEnv): string | null {
  const host = env.DESK_HOSTNAME?.trim().toLowerCase();
  return host ? host : null;
}

/** Whether this request came to the desk origin. */
export function isDeskRequest(request: Request, env: DeskEnv): boolean {
  const host = deskHostname(env);
  return host !== null && new URL(request.url).hostname === host;
}

/**
 * The desk origin as an address, in the scheme and port of `from` (the staff origin a person is
 * on, or the desk request itself): https in production, the dev server's own locally.
 */
export function deskOrigin(env: DeskEnv, from?: string): string | null {
  const host = deskHostname(env);
  if (!host) return null;
  if (!from) return `https://${host}`;
  const url = new URL(from);
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
}

/** What the host gets of the desk on a staff call: the secret and where the desk is. */
export function deskHostFor(env: DeskEnv, from?: string): DeskHost | undefined {
  if (!env.DESK_SECRET) return undefined;
  return { secret: env.DESK_SECRET, origin: deskOrigin(env, from) };
}
