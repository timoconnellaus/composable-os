// cos-app's adapter for the HTTP surface (stage 23, ADR 0403, ADR 0415, ADR 0419): `/api/v<n>/*`
// and customer sign-in (`/api/customer-auth/*`), served in src/server.ts before TanStack Start.
// The surface itself is core's (`createHttpSurface`); this file says who the caller is, from the
// credential the request carries, and nothing else.
//
// - A bearer access token (a native app's, ADR 0419) is its session's: a staff user's or a
//   customer's. When one is sent, no cookie is read.
// - A staff session (Better Auth's cookie, or Cloudflare Access's JWT, or hosted support access)
//   is staff, with the context the UI's server functions build (`staffContext`), origin `client`.
// - A customer session (`cos-customer.*`, its own secret and table, stage 22) is that customer.
// - Anything else is the public. So a customer's credential on a staff operation gets exactly the
//   answer none gets: the operation is not open to them, and that is answered as a name that
//   does not exist.
// - A request carrying both a staff session and a customer session is refused: the two are
//   separate accounts and never one caller (ADR 0402).
//
// Every call goes through `coreInvoker`, which is `invoke()`. A customer's or the public's call
// gets an outside context: a principal and the database for the pipeline, never a staff user.
import {
  CUSTOMER_AUTH_BASE_PATH,
  CUSTOMER_COOKIE_PREFIX,
  type CustomerIdentity,
  type CustomerIdentityEnv,
  createIdentityProvider,
  getCustomerIdentity,
  type IdentityEnv,
  type Principal,
} from "@composable-os/auth";
import {
  type AnyInvocationContext,
  type CustomerPrincipal,
  coreInvoker,
  createHttpSurface,
  customerCodeTarget,
  dataReply,
  errorReply,
  ForbiddenError,
  type HttpReply,
  hostMailCall,
  issueDeviceSession,
  loadCustomer,
  type OutsideInvocationContext,
  type PublicPrincipal,
  parseAllowedOrigins,
  parseFloor,
  type RateLimitBinding,
  readBounded,
  refreshDeviceSession,
  resolveAccessToken,
  resolveActingUser,
  sendCustomerCode,
  ValidationError,
} from "@composable-os/core";
import { type CrmDb, createCrmDb } from "@composable-os/db";
import { integrationRuntimeFor } from "../integrations.ts";
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

const PUBLIC: PublicPrincipal = Object.freeze({ kind: "public" });

/**
 * Sends a sign-in code as the host itself (ADR 0419): through the email-send connection the
 * customer settings name, called by the system user with actor `automation`, never by a staff
 * member.
 */
function hostSendsCodes(env: ApiEnv) {
  return async (message: { to: string; code: string }) => {
    const db = createCrmDb(env.DB);
    const target = await customerCodeTarget(db.query);
    if ("problem" in target) throw new Error(target.problem);
    const runtime = integrationRuntimeFor(env);
    if (!runtime) throw new Error("The integration host is not bound");
    await sendCustomerCode(hostMailCall(runtime), target.target, message);
  };
}

/** Customer sign-in for this env, or null when CUSTOMER_AUTH_SECRET is not set. */
function customers(env: ApiEnv): CustomerIdentity | null {
  if (!env.CUSTOMER_AUTH_SECRET) return null;
  return getCustomerIdentity(env, hostSendsCodes(env), async () => {
    const target = await customerCodeTarget(createCrmDb(env.DB).query);
    return "problem" in target ? target.problem : null;
  });
}

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

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match)
    throw new ForbiddenError("Send the access token as Bearer <token>", { httpStatus: 401 });
  return match[1] as string;
}

async function outsideContext(
  env: ApiEnv,
  db: CrmDb,
  principal: CustomerPrincipal | PublicPrincipal,
  sessionId: string | null,
): Promise<OutsideInvocationContext> {
  await ensureShippedExtensions(env);
  const extensionHost = extensionHostFor(env);
  const { events } = automationWiring(env);
  const integrations = integrationRuntimeFor(env);
  return {
    principal,
    db,
    origin: { surface: "client", ...(sessionId ? { sessionId } : {}) },
    floor: parseFloor(env.APPROVAL_FLOOR),
    ...(env.CUSTOMER_RATE_LIMIT ? { rateLimit: env.CUSTOMER_RATE_LIMIT } : {}),
    ...(events ? { events } : {}),
    // A pack's tool open to this caller runs in cos-runner, as them (ADR 0414).
    ...(extensionHost ? { extensionHost } : {}),
    // Only a hostInternal core operation's handler gets it: order.checkout (stage 25, ADR 0429).
    ...(integrations ? { integrations } : {}),
  };
}

const ended = (reason: string) =>
  new ForbiddenError("This session has ended: sign in again", { reason, httpStatus: 401 });

/** A device session's caller: refused when its account is no longer one that may call. */
async function deviceContext(env: ApiEnv, db: CrmDb, token: string, url: URL) {
  const device = await resolveAccessToken(db, token, new Date());
  if (device.audience === "customer") {
    const account = await loadCustomer(db.query, device.subjectId);
    if (account?.status !== "active" || account.linkState !== "linked" || !account.personId) {
      throw ended("account_unavailable");
    }
    const principal: CustomerPrincipal = Object.freeze({
      kind: "customer",
      customerId: account.id,
      personId: account.personId,
    });
    return outsideContext(env, db, principal, device.sessionId);
  }
  const user = await db.query
    .selectFrom("core_user")
    .select(["id", "email", "name", "deactivated_at"])
    .where("id", "=", device.subjectId)
    .executeTakeFirst();
  if (!user || user.deactivated_at) throw ended("account_unavailable");
  return staffContext(
    env,
    // A device session is its user's; roles come from core_user, as for any staff call.
    { userId: user.id, email: user.email, name: user.name, roles: [] },
    { surface: "client" },
    url.origin,
  );
}

/** The context of one API call, from the request's credential. */
export async function apiContext(request: Request, env: ApiEnv): Promise<AnyInvocationContext> {
  const db = createCrmDb(env.DB);
  const token = bearer(request);
  if (token) return deviceContext(env, db, token, new URL(request.url));
  const staff = await staffSession(request, env);
  if (staff) {
    if (hasCustomerCookie(request)) {
      throw new ForbiddenError(
        "This request carries a staff session and a customer session. Sign out of one.",
      );
    }
    return staffContext(env, staff, { surface: "client" }, new URL(request.url).origin);
  }
  const identity = customers(env);
  const { principal, sessionId } = identity
    ? await identity.resolveSession(request)
    : { principal: PUBLIC, sessionId: null };
  return outsideContext(env, db, principal, sessionId);
}

const deviceNameSchema = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw new ValidationError("deviceName is the device's name, 1 to 100 characters", {
      field: "deviceName",
    });
  }
  return value.trim();
};

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.method !== "POST") {
    throw new ValidationError("Use POST", { httpStatus: 405 });
  }
  const text = await readBounded(request, 10_000);
  try {
    const parsed = JSON.parse(text || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  throw new ValidationError("The request body is not a JSON object");
}

/**
 * `/auth/token`: exchanges the sign-in the request carries (a staff or customer cookie session)
 * for a native app's tokens. `/auth/refresh`: rotates them. Neither takes a bearer token.
 */
async function authRoutes(route: string, request: Request, env: ApiEnv): Promise<HttpReply | null> {
  if (route !== "/auth/token" && route !== "/auth/refresh") return null;
  try {
    const input = await body(request);
    const db = createCrmDb(env.DB);
    const now = new Date();
    if (route === "/auth/refresh") {
      const refreshToken = input.refreshToken;
      if (typeof refreshToken !== "string" || refreshToken.length > 300) {
        throw new ValidationError("refreshToken is required", { field: "refreshToken" });
      }
      return dataReply(await refreshDeviceSession(db, refreshToken, now));
    }
    if (request.headers.get("authorization")) {
      throw new ValidationError("Exchange a sign-in, not a token: send the session cookie");
    }
    const deviceName = deviceNameSchema(input.deviceName);
    const staff = await staffSession(request, env);
    if (staff) {
      if (hasCustomerCookie(request)) {
        throw new ForbiddenError(
          "This request carries a staff session and a customer session. Sign out of one.",
        );
      }
      const user = await resolveActingUser(db, staff);
      return dataReply(
        await issueDeviceSession(db, { audience: "staff", subjectId: user.id }, deviceName, now),
      );
    }
    const identity = customers(env);
    const resolved = identity ? await identity.resolveSession(request) : null;
    if (resolved?.principal.kind === "customer") {
      return dataReply(
        await issueDeviceSession(
          db,
          { audience: "customer", subjectId: resolved.principal.customerId },
          deviceName,
          now,
        ),
      );
    }
    throw new ForbiddenError("Sign in first, then exchange the sign-in for tokens", {
      reason: "not_signed_in",
      httpStatus: 401,
    });
  } catch (error) {
    return errorReply(error, true);
  }
}

const surfaces = new WeakMap<object, ReturnType<typeof createHttpSurface>>();

/** Serves `/api/v<n>/*`; null for any other path. */
export function handleApi(request: Request, env: ApiEnv): Promise<Response | null> {
  let surface = surfaces.get(env);
  if (!surface) {
    surface = createHttpSurface({
      invoker: coreInvoker,
      context: (req) => apiContext(req, env),
      allowedOrigins: parseAllowedOrigins(env.API_ALLOWED_ORIGINS),
      routes: (route, req) => authRoutes(route, req, env),
    });
    surfaces.set(env, surface);
  }
  return surface.handle(request);
}

export function isCustomerAuthPath(pathname: string): boolean {
  return pathname === CUSTOMER_AUTH_BASE_PATH || pathname.startsWith(`${CUSTOMER_AUTH_BASE_PATH}/`);
}

/**
 * Customer sign-in (`/api/customer-auth/*`, stage 22's routes, mounted here). Without
 * CUSTOMER_AUTH_SECRET there are no customers: it answers that sign-in is not set up.
 */
export async function handleCustomerAuth(request: Request, env: ApiEnv): Promise<Response> {
  const identity = customers(env);
  if (!identity) {
    return Response.json(
      {
        code: "SIGN_IN_NOT_SET_UP",
        message: "Customer sign-in is not set up on this deployment (CUSTOMER_AUTH_SECRET)",
      },
      { status: 503 },
    );
  }
  return (await identity.handle(request)) ?? new Response("Not found", { status: 404 });
}
