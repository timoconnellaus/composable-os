// cos-app's adapter for the HTTP surface (stage 23, ADR 0403, ADR 0415): `/api/v1/*`, served in
// src/server.ts before TanStack Start. The surface itself is core's (`createHttpSurface`); this
// file says who the caller is, from the session the request carries, and nothing else.
//
// - A staff session (Better Auth's cookie, or Cloudflare Access's JWT, or hosted support access)
//   is staff, with the context the UI's server functions build (`staffContext`), origin `client`.
// - A customer session (`cos-customer.*`, its own secret and table, stage 22) is that customer.
// - Anything else is the public. So a customer's session on a staff operation gets exactly the
//   answer no session gets: the operation is not open to them, and that is answered as a name
//   that does not exist.
// - A request carrying both a staff session and a customer session is refused: the two are
//   separate accounts and never one caller (ADR 0402).
//
// Every call goes through `coreInvoker`, which is `invoke()`. A customer's or the public's call
// gets an outside context: a principal and the database for the pipeline, never a staff user.
import {
  CUSTOMER_COOKIE_PREFIX,
  type CustomerIdentityEnv,
  createIdentityProvider,
  getCustomerIdentity,
  type IdentityEnv,
  type Principal,
} from "@composable-os/auth";
import {
  type AnyInvocationContext,
  coreInvoker,
  createHttpSurface,
  ForbiddenError,
  type OutsideInvocationContext,
  parseAllowedOrigins,
  parseFloor,
  type RateLimitBinding,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import {
  automationWiring,
  ensureShippedExtensions,
  extensionHostFor,
  type OperationsEnv,
  staffContext,
} from "../operations.ts";
import { type SupportEnv, supportPrincipal } from "../support.ts";

export interface ApiEnv extends OperationsEnv, IdentityEnv, CustomerIdentityEnv {
  COS_SUPPORT_PUBLIC_KEY?: string;
  /** Origins a browser may call the API from, comma separated (a client app's site). */
  API_ALLOWED_ORIGINS?: string;
  /** A customer's calls, per account and operation (Workers Rate Limiting, stage 22). */
  CUSTOMER_RATE_LIMIT?: RateLimitBinding;
}

/** Customer sign-in codes are sent by the sign-in routes, not here: this adapter only reads sessions. */
const noCodes = async () => {
  throw new Error("customer sign-in codes are not sent from the API adapter");
};

/** The staff session a request carries, if any. */
async function staffSession(request: Request, env: ApiEnv): Promise<Principal | null> {
  const support = await supportPrincipal(request, env as SupportEnv);
  if (support) return support;
  return createIdentityProvider(env).resolve(request);
}

function hasCustomerCookie(request: Request): boolean {
  const cookie = request.headers.get("cookie") ?? "";
  // Better Auth prefixes secure cookies with `__Secure-`.
  return cookie
    .split(/;\s*/)
    .some((part) => part.replace(/^__(Secure|Host)-/, "").startsWith(`${CUSTOMER_COOKIE_PREFIX}.`));
}

/** The context of one API call, from the request's session. */
export async function apiContext(request: Request, env: ApiEnv): Promise<AnyInvocationContext> {
  const staff = await staffSession(request, env);
  if (staff) {
    if (hasCustomerCookie(request)) {
      throw new ForbiddenError(
        "This request carries a staff session and a customer session. Sign out of one.",
      );
    }
    return staffContext(env, staff, { surface: "client" }, new URL(request.url).origin);
  }
  const principal = env.CUSTOMER_AUTH_SECRET
    ? await getCustomerIdentity(env, noCodes).resolve(request)
    : ({ kind: "public" } as const);
  await ensureShippedExtensions(env);
  const extensionHost = extensionHostFor(env);
  const { events } = automationWiring(env);
  const ctx: OutsideInvocationContext = {
    principal,
    db: createCrmDb(env.DB),
    origin: { surface: "client" },
    floor: parseFloor(env.APPROVAL_FLOOR),
    ...(env.CUSTOMER_RATE_LIMIT ? { rateLimit: env.CUSTOMER_RATE_LIMIT } : {}),
    ...(events ? { events } : {}),
    // A pack's tool open to this caller runs in cos-runner, as them (ADR 0414).
    ...(extensionHost ? { extensionHost } : {}),
  };
  return ctx;
}

const surfaces = new WeakMap<object, ReturnType<typeof createHttpSurface>>();

/** Serves `/api/v1/*`; null for any other path. */
export function handleApi(request: Request, env: ApiEnv): Promise<Response | null> {
  let surface = surfaces.get(env);
  if (!surface) {
    surface = createHttpSurface({
      invoker: coreInvoker,
      context: (req) => apiContext(req, env),
      allowedOrigins: parseAllowedOrigins(env.API_ALLOWED_ORIGINS),
    });
    surfaces.set(env, surface);
  }
  return surface.handle(request);
}
