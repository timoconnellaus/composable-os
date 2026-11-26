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
// - A practitioner session (`cos-practitioner.*`, its own key and table, stage 43, ADR 0581) is
//   that practitioner, while their account is active.
// - Anything else is the public. So a customer's credential on a staff operation gets exactly the
//   answer none gets: the operation is not open to them, and that is answered as a name that
//   does not exist.
// - A request carrying two kinds of session (staff and customer, staff and practitioner, customer
//   and practitioner) is refused: they are separate accounts and never one caller (ADR 0402,
//   ADR 0581: one hat per call).
//
// Every call goes through `coreInvoker`, which is `invoke()`. A customer's or the public's call
// gets an outside context: a principal and the database for the pipeline, never a staff user.
// The screens this build holds, for screens.mine (stage 47).
import "../built-screens.ts";
import {
  addressKey,
  CUSTOMER_AUTH_BASE_PATH,
  CUSTOMER_COOKIE_PREFIX,
  type CustomerIdentity,
  type CustomerIdentityEnv,
  clientAddressSecret,
  codeRequestRefusal,
  createIdentityProvider,
  getBetterAuth,
  getCustomerIdentity,
  getPractitionerIdentity,
  type IdentityEnv,
  PRACTITIONER_AUTH_BASE_PATH,
  PRACTITIONER_COOKIE_PREFIX,
  type PractitionerIdentity,
  type Principal,
  requestStaffCode,
  staffSignInWithCode,
  validClientAddress,
} from "@composable-os/auth";
import {
  type AnyInvocationContext,
  type ClientAddress,
  type CustomerPrincipal,
  coreInvoker,
  createHttpSurface,
  dataReply,
  errorReply,
  ForbiddenError,
  type HttpReply,
  invalidCode,
  issueDeviceSession,
  loadCustomer,
  type OutsideInvocationContext,
  type PractitionerPrincipal,
  type PublicLimitEnv,
  type PublicPrincipal,
  parseAllowedOrigins,
  parseFloor,
  publicLimitBindings,
  type RateLimitBinding,
  RateLimitedError,
  rateLimit,
  readBounded,
  redeemNativeHandoff,
  refreshDeviceSession,
  resolveAccessToken,
  resolveActingUser,
  signOutDeviceSession,
  UNKNOWN_ADDRESS,
  ValidationError,
} from "@composable-os/core";
import { type CrmDb, createCrmDb } from "@composable-os/db";
import { perClientMissing } from "@composable-os/db/client-entries";
import { sendSignInCode, signInMailProblem } from "../host-mail.ts";
import { integrationRuntimeFor } from "../integrations.ts";
import {
  automationWiring,
  ensureShippedExtensions,
  extensionHostFor,
  type OperationsEnv,
  staffContext,
} from "../operations.ts";
import { personCodeKeysEntry } from "../person-codes.ts";
import { staffCookieAllowed, staffCrossOrigin } from "../staff-origin.ts";
import { type SupportEnv, supportPrincipal } from "../support.ts";

export interface ApiEnv extends OperationsEnv, IdentityEnv, CustomerIdentityEnv, PublicLimitEnv {
  COS_SUPPORT_PUBLIC_KEY?: string;
  /** Origins a browser may call the API from, comma separated (a client app's site). */
  API_ALLOWED_ORIGINS?: string;
  /** A customer's calls, per account and operation (Workers Rate Limiting, stage 22). */
  CUSTOMER_RATE_LIMIT?: RateLimitBinding;
}

const PUBLIC: PublicPrincipal = Object.freeze({ kind: "public" });

/**
 * A client address as the pipeline's limit sees it (ADR 0940): a keyed hash of its bucket (an
 * IPv6 address's /64), made here and never stored as given. Null when there is none to read.
 */
export async function clientAddressOf(
  value: string | null | undefined,
  env: ApiEnv,
): Promise<ClientAddress | null> {
  // A malformed or over-long value is no address (validClientAddress): never keyed as given.
  const address = validClientAddress(value);
  if (!address) return null;
  return { key: await addressKey(address, clientAddressSecret(env)), shared: false };
}

/**
 * The address of a call on the public HTTP surface: the connection's, `cf-connecting-ip`, which
 * Cloudflare sets and a client cannot. A header naming a visitor (`cos-visitor-address`) is never
 * read here: only a client app's Worker, over the binding, may say who its visitor is (bound.ts).
 * No address (local development): the shared unknown bucket.
 */
export async function connectionAddress(request: Request, env: ApiEnv): Promise<ClientAddress> {
  return (await clientAddressOf(request.headers.get("cf-connecting-ip"), env)) ?? UNKNOWN_ADDRESS;
}

/**
 * Why customer or practitioner sign-in is not set up: no CUSTOMER_AUTH_SECRET, which on a
 * many-client host is each client's own and comes with stage 66 step 6.
 */
function signInNotSetUp(env: ApiEnv, who: "Customer" | "Practitioner"): string {
  const perClient = perClientMissing(env, "CUSTOMER_AUTH_SECRET");
  return perClient
    ? `${who} sign-in is not set up here: ${perClient}`
    : `${who} sign-in is not set up on this deployment (CUSTOMER_AUTH_SECRET)`;
}

/** Customer sign-in for this env, or null when CUSTOMER_AUTH_SECRET is not set. */
export function customers(env: ApiEnv): CustomerIdentity | null {
  if (!env.CUSTOMER_AUTH_SECRET) return null;
  // The host sends the codes itself, as its sign-in mail (ADRs 0419, 0456): ready only while
  // that kind applies at once on the host's mail connection.
  return getCustomerIdentity(
    env,
    (message) => sendSignInCode(env, "customer", message),
    () => signInMailProblem(env),
  );
}

/**
 * Practitioner sign-in for this env (stage 43, ADR 0581), or null when CUSTOMER_AUTH_SECRET is not
 * set: its key is derived from that secret. Codes go out as the host's sign-in mail.
 */
export function practitioners(env: ApiEnv): PractitionerIdentity | null {
  if (!env.CUSTOMER_AUTH_SECRET) return null;
  return getPractitionerIdentity(
    env,
    (message) => sendSignInCode(env, "practitioner", message),
    () => signInMailProblem(env),
  );
}

/**
 * The staff session a request carries, if any. Refused (`staff_cross_origin`) when the request
 * does not come from the host's own pages (`staffCookieAllowed`): every staff call here, the
 * token exchange included, reads its session through this.
 */
async function staffSession(request: Request, env: ApiEnv): Promise<Principal | null> {
  const staff =
    (await supportPrincipal(request, env as SupportEnv)) ??
    (await createIdentityProvider(env).resolve(request));
  if (staff && !staffCookieAllowed(request)) throw staffCrossOrigin();
  return staff;
}

function hasCookie(request: Request, prefix: string): boolean {
  const cookie = request.headers.get("cookie") ?? "";
  // Better Auth prefixes secure cookies with `__Secure-`.
  return cookie
    .split(/;\s*/)
    .some((part) => part.replace(/^__(Secure|Host)-/, "").startsWith(`${prefix}.`));
}

function hasCustomerCookie(request: Request): boolean {
  return hasCookie(request, CUSTOMER_COOKIE_PREFIX);
}

function hasPractitionerCookie(request: Request): boolean {
  return hasCookie(request, PRACTITIONER_COOKIE_PREFIX);
}

/**
 * Refuses a request that carries two kinds of session: one call is one hat (ADR 0581). Which
 * sessions are valid is not looked at: a second kind's cookie at all is refused.
 */
function oneHat(request: Request, staff: boolean): void {
  const kinds = [staff, hasCustomerCookie(request), hasPractitionerCookie(request)].filter(Boolean);
  if (kinds.length > 1) {
    throw new ForbiddenError(
      staff && hasCustomerCookie(request)
        ? "This request carries a staff session and a customer session. Sign out of one."
        : "This request carries more than one kind of session (staff, customer, practitioner). Sign out of all but one.",
    );
  }
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match)
    throw new ForbiddenError("Send the access token as Bearer <token>", { httpStatus: 401 });
  return match[1] as string;
}

/**
 * The context of a customer's or the public's call. Also the client-app binding's (bound.ts) and
 * the desk's. `clientAddress` is who the call is counted as per address (ADR 0940): the
 * connection's on the public surface, the client app's word over the binding.
 */
export async function outsideContext(
  env: ApiEnv,
  db: CrmDb,
  principal: CustomerPrincipal | PublicPrincipal | PractitionerPrincipal,
  sessionId: string | null,
  clientAddress: ClientAddress,
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
    // Every call from outside to an operation open to the public, per client address (ADR 0940).
    publicLimits: publicLimitBindings(env),
    clientAddress,
    ...(events ? { events } : {}),
    // A pack's tool open to this caller runs in cos-runner, as them (ADR 0414).
    ...(extensionHost ? { extensionHost } : {}),
    // Only a hostInternal core operation's handler gets it: order.checkout (stage 25, ADR 0429).
    ...(integrations ? { integrations } : {}),
    // Likewise: me.code and me.pin.set (stage 51, ADR 0783).
    ...personCodeKeysEntry(env),
  };
}

const ended = (reason: string) =>
  new ForbiddenError("This session has ended: sign in again", { reason, httpStatus: 401 });

/** A device session's caller: refused when its account is no longer one that may call. */
async function deviceContext(
  env: ApiEnv,
  db: CrmDb,
  token: string,
  url: URL,
  address: ClientAddress,
) {
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
    return outsideContext(env, db, principal, device.sessionId, address);
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
    // A device session, not a browser (ADR 0872): no setup change is made or approved from it.
    { surface: "client", staffDevice: true },
    url.origin,
  );
}

/** The context of one API call, from the request's credential. */
export async function apiContext(request: Request, env: ApiEnv): Promise<AnyInvocationContext> {
  const db = createCrmDb(env.DB);
  const address = await connectionAddress(request, env);
  const token = bearer(request);
  if (token) return deviceContext(env, db, token, new URL(request.url), address);
  const staff = await staffSession(request, env);
  oneHat(request, Boolean(staff));
  if (staff) {
    // `staffSession` refused a staff cookie from anywhere but the host's own pages (stage 47,
    // ADR 0660). A native app's bearer token above, and customer cookies, are unchanged.
    return staffContext(env, staff, { surface: "client" }, new URL(request.url).origin);
  }
  // A practitioner's session (ADR 0581): that practitioner, or, when it no longer resolves, the
  // public, as a customer's session that no longer resolves is.
  if (hasPractitionerCookie(request)) {
    const resolved = (await practitioners(env)?.resolveSession(request)) ?? null;
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
    ? await identity.resolveSession(request)
    : { principal: PUBLIC, sessionId: null };
  return outsideContext(env, db, principal, sessionId, address);
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

/** A required string field of a sign-in body. */
function field(input: Record<string, unknown>, name: string, max: number): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError(`${name} is required`, { field: name });
  }
  return value.trim();
}

/** The native sign-in routes (ADR 0455): no cookie is read or set, and no token is taken. */
const NATIVE_ROUTES = new Set([
  "/auth/customer/code",
  "/auth/customer/sign-in",
  "/auth/staff/code",
  "/auth/staff/sign-in",
  "/auth/staff/exchange",
  "/auth/sign-out",
]);

const notSetUp = (message: string) =>
  new ForbiddenError(message, { reason: "sign_in_not_set_up", httpStatus: 503 });

/**
 * The headers Better Auth sees on a native sign-in: the client address (for the per-address
 * limit) and nothing else, so no cookie the request carries is read.
 */
function nativeHeaders(request: Request): Headers {
  const headers = new Headers();
  const address = request.headers.get("cf-connecting-ip");
  if (address) headers.set("cf-connecting-ip", address);
  return headers;
}

/** Sign-in attempts, exchanges and sign-outs per client address, as code requests are limited. */
async function limitAttempts(request: Request, env: ApiEnv): Promise<void> {
  const address = request.headers.get("cf-connecting-ip");
  if (!address || !env.CUSTOMER_CODE_ADDRESS_RATE_LIMIT) return;
  const limited = await rateLimit(
    env.CUSTOMER_CODE_ADDRESS_RATE_LIMIT,
    `auth-from:${await addressKey(address, clientAddressSecret(env))}`,
  );
  if (!limited.ok) {
    throw new RateLimitedError(
      `Too many sign-in attempts; retry in ${limited.retryAfterSeconds}s`,
      {
        retryAfterSeconds: limited.retryAfterSeconds,
      },
    );
  }
}

/** Asks for a code; the same answer whoever the address is. */
async function requestCode(ask: () => Promise<void>): Promise<HttpReply> {
  try {
    await ask();
  } catch (error) {
    const refusal = codeRequestRefusal(error);
    if (refusal?.refused === "not_set_up") throw notSetUp(refusal.message);
    if (refusal?.refused === "rate_limited") {
      throw new RateLimitedError(refusal.message, {
        retryAfterSeconds: refusal.retryAfterSeconds,
      });
    }
    // Better Auth's other refusal here is a malformed address: the same for everyone.
    if (error instanceof Error && "statusCode" in error && error.statusCode === 400) {
      throw new ValidationError("email is not an email address", { field: "email" });
    }
    throw error;
  }
  return dataReply({ ok: true });
}

/** A staff account that may still hold a session: refused as a wrong code otherwise. */
async function activeStaff(db: CrmDb, userId: string): Promise<string> {
  const user = await db.query
    .selectFrom("core_user")
    .select(["id", "kind", "deactivated_at"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (user?.kind !== "human" || user.deactivated_at) throw invalidCode();
  return user.id;
}

async function nativeRoute(
  route: string,
  request: Request,
  env: ApiEnv,
  input: Record<string, unknown>,
): Promise<HttpReply> {
  const db = createCrmDb(env.DB);
  const now = new Date();
  const headers = nativeHeaders(request);
  if (route === "/auth/sign-out") {
    await limitAttempts(request, env);
    const refreshToken = field(input, "refreshToken", 300);
    // Ends that one device session if the token is its own; the same answer either way.
    await signOutDeviceSession(db, refreshToken, now);
    return dataReply({ ok: true });
  }
  if (route === "/auth/customer/code" || route === "/auth/customer/sign-in") {
    const identity = customers(env);
    if (!identity) {
      throw notSetUp(signInNotSetUp(env, "Customer"));
    }
    const email = field(input, "email", 254);
    if (route === "/auth/customer/code") {
      return requestCode(() => identity.requestCode(email, headers));
    }
    await limitAttempts(request, env);
    const code = field(input, "code", 20);
    const deviceName = deviceNameSchema(input.deviceName);
    // Signing in again in place (stage 48, ADR 0715 amended): the device session this one
    // replaces, by its refresh token. Ended only once the new sign-in has worked.
    const replaces = input.replaces === undefined ? null : field(input, "replaces", 300);
    const signedIn = await identity.signInWithCode(email, code, headers);
    if (!signedIn) throw invalidCode();
    const tokens = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: signedIn.customerId },
      deviceName,
      now,
    );
    // Only this customer's own earlier session is ended: a token of another customer's, or of a
    // staff session, ends nothing, and the answer is the same either way. A failure to end it
    // never fails the sign-in that has already worked (the old session idles out).
    if (replaces) {
      await signOutDeviceSession(db, replaces, now, { customerId: signedIn.customerId }).catch(
        () => false,
      );
    }
    return dataReply({ ...tokens, account: signedIn.account });
  }
  if (route === "/auth/staff/exchange") {
    await limitAttempts(request, env);
    const deviceName = deviceNameSchema(input.deviceName);
    const userId = await redeemNativeHandoff(
      db,
      {
        code: field(input, "code", 200),
        codeVerifier: field(input, "codeVerifier", 200),
        redirectUri: field(input, "redirectUri", 500),
      },
      now,
    );
    const subjectId = await activeStaff(db, userId);
    return dataReply(
      await issueDeviceSession(db, { audience: "staff", subjectId }, deviceName, now),
    );
  }
  // Staff sign-in by code: the host's own sign-in only (Better Auth); under Access there is none.
  const auth = getBetterAuth(env);
  if (!auth) throw notSetUp("Staff sign in through Cloudflare Access here, not by code");
  const email = field(input, "email", 254);
  if (route === "/auth/staff/code") {
    return requestCode(() => requestStaffCode(auth, email, headers));
  }
  await limitAttempts(request, env);
  const code = field(input, "code", 20);
  const deviceName = deviceNameSchema(input.deviceName);
  const signedIn = await staffSignInWithCode(auth, env.DB, email, code, headers);
  if (!signedIn) throw invalidCode();
  const subjectId = await activeStaff(db, signedIn.userId);
  return dataReply(await issueDeviceSession(db, { audience: "staff", subjectId }, deviceName, now));
}

/**
 * `/auth/token`: exchanges the sign-in the request carries (a staff or customer cookie session)
 * for a native app's tokens. `/auth/refresh`: rotates them. Neither takes a bearer token. The
 * native sign-in routes (ADR 0455) answer with tokens and never touch a cookie.
 */
async function authRoutes(route: string, request: Request, env: ApiEnv): Promise<HttpReply | null> {
  const native = NATIVE_ROUTES.has(route);
  if (!native && route !== "/auth/token" && route !== "/auth/refresh") return null;
  try {
    const input = await body(request);
    if (native) {
      if (request.headers.get("authorization")) {
        throw new ValidationError("Sign in without an Authorization header");
      }
      return await nativeRoute(route, request, env, input);
    }
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
    // A body a cross-site form or a simple fetch cannot send: a browser asks first (stage 47).
    if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
      throw new ValidationError("Send the body as JSON (content-type: application/json)", {
        httpStatus: 415,
      });
    }
    const deviceName = deviceNameSchema(input.deviceName);
    const staff = await staffSession(request, env);
    oneHat(request, Boolean(staff));
    // A practitioner works on the web (ADR 0581): their session is not exchanged for app tokens.
    if (hasPractitionerCookie(request)) {
      throw new ForbiddenError("A practitioner's sign-in is not exchanged for app tokens", {
        reason: "practitioner_web_only",
        httpStatus: 401,
      });
    }
    if (staff) {
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
          // The app's session is as recent as the browser sign-in it came from (ADR 0712).
          resolved.signedInAt,
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

export function isPractitionerAuthPath(pathname: string): boolean {
  return (
    pathname === PRACTITIONER_AUTH_BASE_PATH ||
    pathname.startsWith(`${PRACTITIONER_AUTH_BASE_PATH}/`)
  );
}

/**
 * Practitioner sign-in (`/api/practitioner-auth/*`, stage 43, ADR 0581): a code by email, then a
 * session of its own. Without CUSTOMER_AUTH_SECRET it answers that sign-in is not set up.
 */
export async function handlePractitionerAuth(request: Request, env: ApiEnv): Promise<Response> {
  const identity = practitioners(env);
  if (!identity) {
    return Response.json(
      {
        code: "SIGN_IN_NOT_SET_UP",
        message: signInNotSetUp(env, "Practitioner"),
      },
      { status: 503 },
    );
  }
  return (await identity.handle(request)) ?? new Response("Not found", { status: 404 });
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
        message: signInNotSetUp(env, "Customer"),
      },
      { status: 503 },
    );
  }
  return (await identity.handle(request)) ?? new Response("Not found", { status: 404 });
}
