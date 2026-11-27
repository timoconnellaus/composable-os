// On a many-client host, a state-changing request is the client's own page's, or nothing (stage
// 66 step 8, ADR 0619; the owner's rule (b) of 2026-11-27, which with (a) and (c) replaces a
// Public Suffix List listing of the fleet's domain, ADR 0616 "Cookies").
//
// Every client's staff (and desk) hostname is a sibling under the fleet's one domain, so a page
// on one client's hostname is "same-site" with every other client's: `SameSite` cookies do not
// keep them apart. What does is the origin. The entry checks it once, after it has decided the
// client and before any route runs, for every method but GET, HEAD and OPTIONS (operations, the
// staff, customer and practitioner auth routes, uploads, MCP consent, the desk, TanStack Start's
// server functions, the assistant's routes, everything):
//
// - `Origin` names a site: it must be exactly the request's own origin, except
//   - a customer-facing route (`/api/v<n>/…`, customer and practitioner sign-in) called from the
//     client's own web address or an origin in its `API_ALLOWED_ORIGINS` (the existing allow-list
//     of the HTTP surface, ADR 0403; never one under the fleet's registrable domain, which is a
//     sibling, not the client's own site), and
//   - a request that carries `Authorization` and no `Cookie`: a token call (a native app, `cos`,
//     an MCP client, the browser build's token sign-in) uses no ambient credential, so there is
//     nothing a page elsewhere could ride on; the surface's own origin check still decides which
//     origins may read its answers, and
//   - OAuth's token and registration endpoints with no `Cookie`: they act on a code and its PKCE
//     verifier, or register a client, never on a session.
// - `Origin` is absent or `null`: `Sec-Fetch-Site: same-origin` passes (a page whose referrer
//   policy withholds its origin, as the native sign-in page's does). With neither header, the
//   request is not a modern browser's: it passes only with no `Cookie` (a native app, `cos`, a
//   provider), since a browser that sent a cookie would have sent one of them.
// - Anything else: 403, before any route runs.
//
// A single-client deployment never reaches this (its own rules stand, unchanged: staff-origin.ts
// and each route's). The deployment's callback hostname is answered before any client is decided
// and never reaches it either (gatekeeper callbacks, ADR 0616).
import { isApiPath, parseAllowedOrigins } from "@composable-os/core";
import { callbackHostname } from "@composable-os/db/callbacks";
import { isUnder, registrableDomain } from "@composable-os/db/registry";
import { isCustomerAuthPath, isPractitionerAuthPath } from "./http/api.ts";

/** What the rule reads of the client's environment (its own addresses, from the registry). */
export interface WriteOriginEnv {
  CUSTOMER_AUTH_URL?: string;
  API_ALLOWED_ORIGINS?: string;
}

/** What it reads of the host's own: the callback hostname, on the fleet's domain (ADR 0616). */
export interface WriteOriginHost {
  COS_CALLBACK_HOSTNAME?: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const OAUTH_TOKEN_PATHS = new Set(["/oauth/token", "/oauth/register"]);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The origins a customer-facing route may be written to from, besides the request's own. */
function customerOrigins(env: WriteOriginEnv, host: WriteOriginHost): string[] {
  const fleet = (() => {
    try {
      const callback = callbackHostname(host);
      return callback ? registrableDomain(callback) : null;
    } catch {
      return null;
    }
  })();
  const out = [originOf(env.CUSTOMER_AUTH_URL), ...parseAllowedOrigins(env.API_ALLOWED_ORIGINS)];
  return out.filter((o): o is string => {
    if (!o) return false;
    if (!fleet) return true;
    // A sibling under the fleet's domain is never a client's own site (rule (a)).
    return !isUnder(new URL(o).hostname, fleet);
  });
}

/**
 * Why a state-changing request is refused on a many-client host, or null when it may go on.
 * `env` is the client's environment the entry decided; `host` the host's own.
 */
export function writeOriginRefusal(
  request: Request,
  env: WriteOriginEnv,
  host: WriteOriginHost,
): string | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const cookie = request.headers.has("cookie");
  if (origin !== null && origin !== "null") {
    if (origin === url.origin) return null;
    if (request.headers.has("authorization") && !cookie) return null;
    if (OAUTH_TOKEN_PATHS.has(url.pathname) && !cookie) return null;
    const customerFacing =
      isApiPath(url.pathname) ||
      isCustomerAuthPath(url.pathname) ||
      isPractitionerAuthPath(url.pathname);
    if (customerFacing && customerOrigins(env, host).includes(origin)) return null;
    return "cross-origin";
  }
  if (site === "same-origin") return null;
  if (origin === null && site === null && !cookie) return null;
  return origin === null ? "cross-site" : "opaque-origin";
}

/** The refusal's answer: 403, the same for every reason, naming none of the client's. */
export function writeOriginResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "forbidden",
        message: "A change is made only from this site's own pages",
      },
    }),
    {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    },
  );
}
