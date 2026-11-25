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
//   /api/practitioner-auth/*                  practitioner sign-in (stage 43, ADR 0581): the
//                                             same four routes, a session of its own
//   GET /api/media/<id>                       a picture published content shows (stage 28, ADR
//                                             0444), as media.serve decides; never an upload
//   GET /api/v1/agreements/acceptances/<id>.pdf
//                                             a customer's signed PDF (stage 44, ADR 0645), as
//                                             me.agreements.pdf decides; never staff's routes
// Not the staff UI, /mcp, the assistant, support access, or the native token routes
// (/api/v1/auth/*): a web app signs customers in with a cookie and has no use for device tokens.
//
// What the bound Worker is trusted to say, and what it is not:
// - It says which operation, with what input and Idempotency-Key, as any caller of the surface.
// - It forwards the customer's session cookie (`cos-customer.session_token`). The host verifies
//   it: the signature is CUSTOMER_AUTH_SECRET's, which the bound Worker never holds, and the
//   session must be a live row of an active account linked to its Person. A missing, forged,
//   tampered, signed-out or deleted session is the public.
// - Or a practitioner's (`cos-practitioner.session_token`, ADR 0581), verified the same way with
//   its own key and table, for an active account. Never both: one call is one hat, and a request
//   carrying both kinds is refused.
// - It is never staff. This entrypoint does not read a staff session at all: no Better Auth staff
//   cookie, no Cloudflare Access JWT, no support access. A request with an Authorization header
//   (a native app's bearer token, staff or customer) is refused: a bound Worker forwards the
//   cookie its own hostname holds, never a token.
// - It is never a customer (or practitioner) who has not signed in: no header, claim or body field names the
//   caller. The customer is whoever the verified cookie says, and the visibility seam gives them
//   their own rows only.
// - The visitor's address is the bound Worker's word (ADR 0940): `cos-visitor-address`, which the
//   typed client's `visitorAddress` sets from the browser's request (an older template sent only
//   `cf-connecting-ip`, on its sign-in steps, and that is still read). It keys the limit per
//   client address on public operations and on sign-in, and nothing else: it names no caller.
//   On the public surface the address is the connection's and this header is never read. A
//   bound Worker that passes none is counted in one shared bucket for the client app, never
//   unlimited.
// - `Origin` on the sign-in routes is forwarded for Better Auth's cross-site check, which
//   protects the customer's browser; nothing about the caller is decided from it.
import { WorkerEntrypoint } from "cloudflare:workers";
import { CUSTOMER_COOKIE_PREFIX, PRACTITIONER_COOKIE_PREFIX } from "@composable-os/auth";
import {
  type ClientAddress,
  coreInvoker,
  createHttpSurface,
  ForbiddenError,
  handleMedia,
  isApiPath,
  isMediaPath,
  type OutsideInvocationContext,
  type PublicPrincipal,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { type MediaEnv, mediaResizerFor, mediaStoreFor } from "../media.ts";
import { handleAgreementPdf, isAgreementPdfPath } from "./agreement-pdf.ts";
import {
  type ApiEnv,
  clientAddressOf,
  customers,
  handleCustomerAuth,
  handlePractitionerAuth,
  isCustomerAuthPath,
  isPractitionerAuthPath,
  outsideContext,
  practitioners,
} from "./api.ts";

const PUBLIC: PublicPrincipal = Object.freeze({ kind: "public" });

/** The header a client app's Worker names its visitor's address in (`visitorAddress`, ADR 0940). */
export const VISITOR_ADDRESS_HEADER = "cos-visitor-address";

/** A bound Worker that names no visitor: one bucket for the client app (ADR 0940). */
const CLIENT_APP_SHARED: ClientAddress = Object.freeze({ key: "client-app", shared: true });

/**
 * Who a call over the binding is counted as: the visitor the client app's Worker names, or, from
 * an older template, the `cf-connecting-ip` it forwarded; else the client app's shared bucket.
 */
export async function boundAddress(request: Request, env: ApiEnv): Promise<ClientAddress> {
  return (
    (await clientAddressOf(request.headers.get(VISITOR_ADDRESS_HEADER), env)) ??
    (await clientAddressOf(request.headers.get("cf-connecting-ip"), env)) ??
    CLIENT_APP_SHARED
  );
}

/**
 * A sign-in step as Better Auth's per-address limit reads it (`cf-connecting-ip`): the visitor the
 * client app names, when it names one. The limit is the sign-in's; nothing else reads the header.
 */
function signInWithVisitor(request: Request): Request {
  const visitor = request.headers.get(VISITOR_ADDRESS_HEADER);
  if (!visitor) return request;
  const headers = new Headers(request.headers);
  headers.set("cf-connecting-ip", visitor);
  headers.delete(VISITOR_ADDRESS_HEADER);
  return new Request(request, { headers });
}

/** A session cookie of `prefix` by name, with or without Better Auth's `__Secure-` prefix. */
function isCookieOf(part: string, prefix: string): boolean {
  return part.replace(/^__(Secure|Host)-/, "").startsWith(`${prefix}.`);
}

/**
 * The request as one kind of session check sees it: that kind's cookies and no other header.
 * Nothing else the bound Worker sends can reach the code that decides who the caller is.
 */
function cookiesOnly(request: Request, prefix: string): Request | null {
  const cookie = (request.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .filter((part) => part && isCookieOf(part, prefix))
    .join("; ");
  return cookie ? new Request(request.url, { headers: { cookie } }) : null;
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
  const asCustomer = cookiesOnly(request, CUSTOMER_COOKIE_PREFIX);
  const asPractitioner = cookiesOnly(request, PRACTITIONER_COOKIE_PREFIX);
  if (asCustomer && asPractitioner) {
    throw new ForbiddenError(
      "This request carries a customer session and a practitioner session. Sign out of one.",
      { reason: "one_hat" },
    );
  }
  const db = createCrmDb(env.DB);
  const address = await boundAddress(request, env);
  if (asPractitioner) {
    const resolved = (await practitioners(env)?.resolveSession(asPractitioner)) ?? null;
    return outsideContext(
      env,
      db,
      resolved?.principal ?? PUBLIC,
      resolved?.principal ? resolved.sessionId : null,
      address,
    );
  }
  const identity = customers(env);
  const { principal, sessionId } = identity
    ? await identity.resolveSession(asCustomer ?? new Request(request.url))
    : { principal: PUBLIC, sessionId: null };
  return outsideContext(env, db, principal, sessionId, address);
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
  if (isCustomerAuthPath(pathname)) return handleCustomerAuth(signInWithVisitor(request), env);
  if (isPractitionerAuthPath(pathname)) {
    return handlePractitionerAuth(signInWithVisitor(request), env);
  }
  // A customer's own signed PDF: the caller is never staff here, so only me.agreements.pdf.
  if (isAgreementPdfPath(pathname)) {
    return handleAgreementPdf(request, { context: (req) => boundContext(req, env) });
  }

  if (isMediaPath(pathname)) {
    const withMedia = env as ApiEnv & MediaEnv;
    return handleMedia(request, {
      invoker: coreInvoker,
      context: (req) => boundContext(req, env),
      media: mediaStoreFor(withMedia),
      resizer: mediaResizerFor(withMedia),
      uploads: false,
    });
  }
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
