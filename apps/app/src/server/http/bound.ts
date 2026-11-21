// The client-app binding (stage 24, ADR 0421): how a company's own Worker (its web app) reaches
// the host. The web app's wrangler config has a service binding to cos-app's `ClientApp`
// entrypoint; the entrypoint serves a narrower door than the public hostname, and decides the
// caller exactly as the HTTP surface does for a customer, from a credential the host verifies.
//
// What it serves, and nothing else (404):
//   /api/v<n>/op/<name>, /api/v<n>/manifest   the HTTP surface (core's createHttpSurface), every
//                                             call through invoke()
//   /api/customer-auth/*                      customer sign-in (stage 22's routes): send a code,
//                                             sign in, get the session, sign out
// Not the staff UI, /mcp, the assistant, support access, or the native token routes
// (/api/v1/auth/*): a web app signs customers in with a cookie and has no use for device tokens.
//
// What the bound Worker is trusted to say, and what it is not:
// - It says which operation, with what input and Idempotency-Key, as any caller of the surface.
// - It forwards the customer's session cookie (`cos-customer.session_token`). The host verifies
//   it: the signature is CUSTOMER_AUTH_SECRET's, which the bound Worker never holds, and the
//   session must be a live row of an active account linked to its Person. A missing, forged,
//   tampered, signed-out or deleted session is the public.
// - It is never staff. This entrypoint does not read a staff session at all: no Better Auth staff
//   cookie, no Cloudflare Access JWT, no support access. A request with an Authorization header
//   (a native app's bearer token, staff or customer) is refused: a bound Worker forwards the
//   cookie its own hostname holds, never a token.
// - It is never a customer who has not signed in: no header, claim or body field names the
//   caller. The customer is whoever the verified cookie says, and the visibility seam gives them
//   their own rows only.
// - `cf-connecting-ip` is the bound Worker's word (it should forward its visitor's). It is used
//   only to limit sign-in code requests per client address; the per-address-asked-for limit and
//   the edge rules hold whatever it says.
// - `Origin` on the sign-in routes is forwarded for Better Auth's cross-site check, which
//   protects the customer's browser; nothing about the caller is decided from it.
import { WorkerEntrypoint } from "cloudflare:workers";
import { CUSTOMER_COOKIE_PREFIX } from "@composable-os/auth";
import {
  coreInvoker,
  createHttpSurface,
  ForbiddenError,
  isApiPath,
  type OutsideInvocationContext,
  type PublicPrincipal,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import {
  type ApiEnv,
  customers,
  handleCustomerAuth,
  isCustomerAuthPath,
  outsideContext,
} from "./api.ts";

const PUBLIC: PublicPrincipal = Object.freeze({ kind: "public" });

/** A customer's session cookie by name, with or without Better Auth's `__Secure-` prefix. */
function isCustomerCookie(part: string): boolean {
  return part.replace(/^__(Secure|Host)-/, "").startsWith(`${CUSTOMER_COOKIE_PREFIX}.`);
}

/**
 * The request as the customer session check sees it: its customer cookies and no other header.
 * Nothing else the bound Worker sends can reach the code that decides who the caller is.
 */
function customerCookiesOnly(request: Request): Request {
  const cookie = (request.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .filter((part) => part && isCustomerCookie(part))
    .join("; ");
  return new Request(request.url, { headers: cookie ? { cookie } : {} });
}

/**
 * The caller of a call over the binding: the customer whose verified session cookie the bound
 * Worker forwarded, or the public. Never staff, and never from anything the Worker asserts.
 */
export async function boundContext(
  request: Request,
  env: ApiEnv,
): Promise<OutsideInvocationContext> {
  if (request.headers.has("authorization")) {
    throw new ForbiddenError(
      "A bound Worker forwards the customer's session cookie, never a token",
      { reason: "binding_takes_cookies_only", httpStatus: 401 },
    );
  }
  const identity = customers(env);
  const { principal, sessionId } = identity
    ? await identity.resolveSession(customerCookiesOnly(request))
    : { principal: PUBLIC, sessionId: null };
  return outsideContext(env, createCrmDb(env.DB), principal, sessionId);
}

const surfaces = new WeakMap<object, ReturnType<typeof createHttpSurface>>();

const notServed = () =>
  Response.json(
    { error: { code: "not_found", message: "Not served over the client-app binding" } },
    { status: 404 },
  );

/** Serves one request that came over the client-app binding. */
export async function handleBound(request: Request, env: ApiEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (isCustomerAuthPath(pathname)) return handleCustomerAuth(request, env);
  if (!isApiPath(pathname)) return notServed();
  let surface = surfaces.get(env);
  if (!surface) {
    // No `routes`: the native token routes are not served here. No allowed origins: the bound
    // Worker's own server-side calls carry no Origin, and a browser never reaches this door.
    surface = createHttpSurface({
      invoker: coreInvoker,
      context: (req) => boundContext(req, env),
    });
    surfaces.set(env, surface);
  }
  return (await surface.handle(request)) ?? notServed();
}

/**
 * The entrypoint a company's web app binds to:
 * `"services": [{ "binding": "HOST", "service": "<product>-app", "entrypoint": "ClientApp" }]`.
 * It has one method, `fetch`; there is no RPC method that takes a caller.
 */
export class ClientApp extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return handleBound(request, this.env as unknown as ApiEnv);
  }
}
