// Better Auth adapter (the default): email + password, Google sign-in, and a code by email for
// invited staff and verified accounts (ADR 0455), stored in core_* tables.
//
// Sign-up stays closed after the first user unless AUTH_ALLOW_SIGNUP=true. An invite opens it for
// one address, and only through the code sign-in: the account is made with the invite's role,
// pack role and grants in the insert, after the invite is marked accepted. Password and Google
// sign-up never accept an invite.
import {
  acceptInvite,
  assertUserCapacity,
  checkCodeRequestLimit,
  inviteColumns,
  newId,
  PlanLimitError,
  type RateLimitBinding,
  RateLimitedError,
  rateLimit,
  recordInviteAccount,
  staffMayGetCode,
} from "@composable-os/core";
import { createDb } from "@composable-os/db";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { IdentityProvider, Principal } from "./principal.ts";

/** How the host sends staff sign-in codes (ADR 0455), given by cos-app per env. */
export interface StaffCodes {
  /** Sends one code, as the host, through its mail connection. */
  send(message: { to: string; code: string }): Promise<void>;
  /** Null when codes can be sent, or why not (no mail connection is chosen). */
  ready(): Promise<string | null>;
}

export interface BetterAuthOptions {
  db: D1Database;
  /** BETTER_AUTH_SECRET: signs sessions. Required. */
  secret: string;
  /** BETTER_AUTH_URL: the app's public origin. Inferred from the request when unset. */
  baseURL?: string | undefined;
  google?: { clientId: string; clientSecret: string } | undefined;
  /**
   * When false (the default), only the first user can sign up; everyone after that needs an
   * existing account or an invite. Set AUTH_ALLOW_SIGNUP=true to open password sign-up.
   */
  allowSignUp?: boolean;
  /** Staff sign-in codes: looked up when a code is asked for. Null: not set up. */
  codes?: (() => StaffCodes | null) | undefined;
  /** Code requests per address asked for (the customer binding: one inbox, one limit). */
  codeRateLimit?: RateLimitBinding | undefined;
  /** Code requests per client address, keyed by a keyed hash of it. */
  codeAddressRateLimit?: RateLimitBinding | undefined;
  /** What the address is keyed with (`clientAddressSecret`): one count for every kind of sign-in. */
  addressSecret?: string | undefined;
  /** A many-client host: every cookie `__Host-` prefixed (`cookieOptions`). */
  hostOnlyCookies?: boolean | undefined;
  clock?: () => Date;
}

/**
 * Whether a cookie (`name=value` or a name) is a session cookie of `prefix` (stage 66, ADR
 * 0616): on a host of many clients (`hostOnly`, the client's environment has `COS_CLIENT_ID`) only
 * the `__Host-` name counts, so a sibling hostname that plants `cos-customer.*` on the parent
 * domain cannot make a staff request look like two hats; elsewhere with or without `__Secure-`.
 *
 * Better Auth's cookie options for one sign-in (staff, customer, practitioner). On a host that
 * serves many clients (stage 66, ADR 0616) every cookie it sets is `__Host-` prefixed: Secure,
 * `Path=/` and no `Domain`, so a page on a sibling hostname of the fleet's domain can never plant
 * one (a cookie it sets with `Domain=` cannot carry the prefix, and a cookie without the prefix is
 * not read). A single-client deployment keeps its names (`__Secure-<prefix>.*` on https), so
 * nobody is signed out.
 */
export function isSessionCookie(part: string, prefix: string, hostOnly: boolean): boolean {
  const name = part.trim();
  // A many-client host sets only `__Host-` names, which a sibling hostname cannot plant; a
  // cookie of the same name without the prefix (set with `Domain=` on the parent) is not one.
  if (hostOnly) return name.startsWith(`__Host-${prefix}.`);
  return name.replace(/^__(Secure|Host)-/, "").startsWith(`${prefix}.`);
}

/**
 * Better Auth's cookie options (see the comment above `isSessionCookie`).
 */
export function cookieOptions(
  prefix: string,
  hostOnly: boolean | undefined,
): {
  cookiePrefix: string;
  useSecureCookies?: boolean;
  defaultCookieAttributes?: { secure: boolean; path: string };
} {
  if (!hostOnly) return { cookiePrefix: prefix };
  // Better Auth would add `__Secure-` itself; the prefix is ours instead, and Secure is set here.
  return {
    cookiePrefix: `__Host-${prefix}`,
    useSecureCookies: false,
    defaultCookieAttributes: { secure: true, path: "/" },
  };
}

/** Better Auth's own cookie prefix for staff sessions (`better-auth.session_token`). */
export const STAFF_COOKIE_PREFIX = "better-auth";

export const BETTER_AUTH_BASE_PATH = "/api/auth";
/** A staff code is six digits, lives five minutes and allows three tries, as a customer's. */
export const STAFF_CODE_LENGTH = 6;
export const STAFF_CODE_TTL_SECONDS = 300;
export const STAFF_CODE_ATTEMPTS = 3;

const CODE_REQUEST_PATH = "/email-otp/send-verification-otp";
export const CODE_SIGN_IN_PATH = "/sign-in/email-otp";

/**
 * The email OTP plugin's routes that are served: asking for a code and signing in with it.
 * Password reset, email change and email verification by code are not.
 */
function codeRouteServed(route: string): boolean {
  if (route === CODE_REQUEST_PATH || route === CODE_SIGN_IN_PATH) return true;
  return !route.startsWith("/email-otp/") && !route.startsWith("/forget-password/email-otp");
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 32 random alphanumeric characters, like Better Auth's default ids. */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

/**
 * What one client is, for a per-client limit (ADR 0459): an IPv4 address as it is; an IPv6
 * address as its /64, the block one subscriber is usually given, so a client cannot step through
 * the addresses of its own network to get round the limit. Anything unreadable is kept as given.
 */
export function clientAddressBucket(address: string): string {
  const ip = address.trim().toLowerCase().split("%")[0] ?? "";
  if (!ip.includes(":")) return ip;
  // An IPv4 address written as IPv6 (`::ffff:192.0.2.1`) is that IPv4 address: its own bucket,
  // not the /64 every such address shares (review of PR #459, F3).
  const mapped = /^(?:0{0,4}:){0,5}(?::|0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped?.[1] && isIpv4(mapped[1])) return mapped[1];
  const [head = "", tail, extra] = ip.split("::");
  if (extra !== undefined) return ip; // more than one "::": not an address
  const groups = (part: string) => (part ? part.split(":") : []);
  const left = groups(head);
  const right = groups(tail ?? "");
  const all =
    tail === undefined
      ? left
      : [...left, ...Array(Math.max(8 - left.length - right.length, 0)).fill("0"), ...right];
  const prefix = all.slice(0, 4);
  if (prefix.length < 4 || prefix.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${prefix.map((g) => Number.parseInt(g, 16).toString(16)).join(":")}::/64`;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isIpv6(value: string): boolean {
  if (value.length > 45 || !/^[0-9a-f:.]+$/.test(value)) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h ? h.split(":") : []));
  const last = groups.at(-1) ?? "";
  // An IPv4 tail (`::ffff:192.0.2.1`) counts as two groups.
  const v4 = last.includes(".");
  if (v4 && !isIpv4(last)) return false;
  const hex = v4 ? groups.slice(0, -1) : groups;
  if (hex.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return false;
  const count = hex.length + (v4 ? 2 : 0);
  return halves.length === 2 ? count < 8 : count === 8;
}

/**
 * A client address as given (`cf-connecting-ip`, or a client app's word over the binding) when it
 * is a well-formed IPv4 or IPv6 address, else null: a malformed or over-long value is no address,
 * and is counted in a shared bucket, never keyed as given.
 */
export function validClientAddress(value: string | null | undefined): string | null {
  const ip = value?.trim().toLowerCase() ?? "";
  if (!ip || ip.length > 45) return null;
  return isIpv4(ip) || isIpv6(ip) ? ip : null;
}

let isolateSecret: string | null = null;

/**
 * The one secret client addresses are keyed with (ADR 0940): sign-in for staff, customers and
 * practitioners, and the pipeline's limits, so an address has one count whichever door it uses.
 * Derived from the staff secret, or the customer one on a host without it. A host with neither
 * gets a random key for the isolate's life, logged: never an empty one, which would let a key be
 * reversed to its IPv4 address by trying them all.
 *
 * On a host that serves many clients (`COS_CLIENT_ID` set, ADR 0616) it is the client's own
 * derived `CLIENT_ADDRESS_SECRET`, never the staff or customer secret: one key, one purpose.
 */
export function clientAddressSecret(env: {
  BETTER_AUTH_SECRET?: string | undefined;
  CUSTOMER_AUTH_SECRET?: string | undefined;
  CLIENT_ADDRESS_SECRET?: string | undefined;
  COS_CLIENT_ID?: string | undefined;
}): string {
  if (env.COS_CLIENT_ID) {
    if (env.CLIENT_ADDRESS_SECRET) return `client-address\n${env.CLIENT_ADDRESS_SECRET}`;
  }
  const secret = env.COS_CLIENT_ID ? undefined : env.BETTER_AUTH_SECRET || env.CUSTOMER_AUTH_SECRET;
  if (secret) return `client-address\n${secret}`;
  if (!isolateSecret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    isolateSecret = `client-address\nisolate\n${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    console.error(
      "No BETTER_AUTH_SECRET or CUSTOMER_AUTH_SECRET: client addresses are keyed with a random key " +
        "for this isolate only, so rate limit counts do not carry across isolates",
    );
  }
  return isolateSecret;
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();

/**
 * A client address as a rate-limit key: an HMAC-SHA256 of its bucket (an IPv6 address's /64, an
 * IPv4-mapped one's IPv4 address) under `secret`, so no address is passed on.
 */
export async function addressKey(address: string, secret: string): Promise<string> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    hmacKeys.set(secret, key);
  }
  const digest = await crypto.subtle.sign(
    "HMAC",
    await key,
    new TextEncoder().encode(clientAddressBucket(address)),
  );
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The checks before a code is made, for staff and customers alike: set up at all (the same for
 * everyone), then the per-client-address and per-address-asked-for limits.
 */
export async function beforeCodeRequest(
  ctx: { headers?: Headers | undefined; body?: unknown },
  options: {
    ready?: (() => Promise<string | null>) | undefined;
    secret: string;
    /** The secret the client address is keyed with: one for every kind of sign-in (ADR 0940). */
    addressSecret?: string | undefined;
    codeRateLimit?: RateLimitBinding | undefined;
    codeAddressRateLimit?: RateLimitBinding | undefined;
    what: string;
  },
): Promise<void> {
  const problem = options.ready ? await options.ready() : null;
  if (problem) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      message: `${options.what} is not set up: ${problem}`,
      code: "SIGN_IN_NOT_SET_UP",
    });
  }
  const address = ctx.headers?.get("cf-connecting-ip");
  if (address && options.codeAddressRateLimit) {
    const limited = await rateLimit(
      options.codeAddressRateLimit,
      `code-from:${await addressKey(address, options.addressSecret ?? options.secret)}`,
    );
    if (!limited.ok) {
      throw new APIError("TOO_MANY_REQUESTS", {
        message: `Too many sign-in code requests; retry in ${limited.retryAfterSeconds}s`,
        code: "RATE_LIMITED",
        retryAfterSeconds: limited.retryAfterSeconds,
      });
    }
  }
  const email = (ctx.body as { email?: unknown } | undefined)?.email;
  if (typeof email !== "string") return;
  try {
    await checkCodeRequestLimit(options.codeRateLimit, email);
  } catch (error) {
    if (!(error instanceof RateLimitedError)) throw error;
    throw new APIError("TOO_MANY_REQUESTS", {
      message: error.message,
      code: "RATE_LIMITED",
      retryAfterSeconds: (error.details as { retryAfterSeconds?: number } | undefined)
        ?.retryAfterSeconds,
    });
  }
}

/**
 * One answer for every failed code sign-in (ADR 0455): a wrong code, an expired one, one tried
 * too often, or none at all say the same, so the answer never tells that a code was sent.
 */
export async function uniformCodeSignIn(response: Response): Promise<Response> {
  if (response.ok) return response;
  return Response.json({ code: "INVALID_OTP", message: "Invalid code" }, { status: 400 });
}

const timestamps = { createdAt: "created_at", updatedAt: "updated_at" } as const;

export function createBetterAuth(options: BetterAuthOptions) {
  const { db, allowSignUp = false } = options;
  const clock = options.clock ?? (() => new Date());
  const kysely = createDb(db);
  const ready = async () => {
    const codes = options.codes?.();
    if (!codes) return "the host cannot send mail here";
    return codes.ready();
  };
  return betterAuth({
    database: db,
    secret: options.secret,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    basePath: BETTER_AUTH_BASE_PATH,
    telemetry: { enabled: false },
    advanced: {
      ...cookieOptions(STAFF_COOKIE_PREFIX, options.hostOnlyCookies),
      database: {
        // Users get CRM ids (`usr_…`, ADR 0015) so audit rows, owners and assignees all use one id
        // format. Sessions, accounts and verifications are Better Auth's own and keep its default
        // shape (random, not time-ordered), which we generate here because a function replaces it.
        generateId: ({ model }) =>
          model === "user" || model === "core_user" ? newId("user") : randomId(),
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== CODE_REQUEST_PATH) return;
        await beforeCodeRequest(ctx, {
          ready,
          secret: options.secret,
          addressSecret: options.addressSecret,
          codeRateLimit: options.codeRateLimit,
          codeAddressRateLimit: options.codeAddressRateLimit,
          what: "Sign-in by code",
        });
      }),
    },
    emailAndPassword: { enabled: true },
    socialProviders: options.google
      ? {
          google: {
            clientId: options.google.clientId,
            clientSecret: options.google.clientSecret,
          },
        }
      : {},
    user: {
      modelName: "core_user",
      fields: { emailVerified: "email_verified", ...timestamps },
      // Written only from an accepted invite, in the insert (below). No request may set them.
      additionalFields: {
        role: { type: "string", required: false, input: false, returned: false },
        packRole: {
          type: "string",
          required: false,
          input: false,
          returned: false,
          fieldName: "pack_role",
        },
        grantedPermissions: {
          type: "string",
          required: false,
          input: false,
          returned: false,
          fieldName: "granted_permissions",
        },
      },
    },
    session: {
      modelName: "core_session",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        ...timestamps,
      },
    },
    account: {
      modelName: "core_account",
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        ...timestamps,
      },
    },
    verification: {
      modelName: "core_verification",
      fields: { expiresAt: "expires_at", ...timestamps },
    },
    plugins: [
      emailOTP({
        otpLength: STAFF_CODE_LENGTH,
        expiresIn: STAFF_CODE_TTL_SECONDS,
        allowedAttempts: STAFF_CODE_ATTEMPTS,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }, ctx) {
          const allowed = type === "sign-in" && (await staffMayGetCode(kysely, email, clock()));
          const codes = options.codes?.();
          if (!allowed || !codes) {
            // The same answer as a sent code, and nothing is kept: the code just stored for this
            // address is removed, so it can never be guessed into an account.
            await ctx?.context.internalAdapter.deleteVerificationByIdentifier(
              `${type}-otp-${email.toLowerCase()}`,
            );
            return;
          }
          try {
            await codes.send({ to: email, code: otp });
          } catch (error) {
            // Not sent (queued for review, or failed): the code is removed, as for a refused
            // address, so a code nobody received never works. Queued, its text is in the
            // Approvals preview, where whoever approves it could otherwise sign in as this
            // address (ADR 0455). The answer is the same as for a sent code.
            await ctx?.context.internalAdapter.deleteVerificationByIdentifier(
              `${type}-otp-${email.toLowerCase()}`,
            );
            console.error(
              "staff sign-in code not sent",
              error instanceof Error ? error.message : error,
            );
          }
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // Closed sign-up: the first user bootstraps the deployment; later users need an invite,
          // accepted by the code sign-in only, unless AUTH_ALLOW_SIGNUP=true opens password and
          // Google sign-up.
          before: async (user, ctx) => {
            const row = await db
              .prepare("SELECT COUNT(*) AS n FROM core_user")
              .first<{ n: number }>();
            // The first user always gets in.
            if ((row?.n ?? 0) === 0) return { data: user };
            const byCode = ctx?.path === CODE_SIGN_IN_PATH;
            if (!byCode && !allowSignUp) return false;
            // A hosted plan's user limit (ADR 0211). No entitlements row: no limit.
            try {
              await assertUserCapacity(kysely, 1);
            } catch (error) {
              if (error instanceof PlanLimitError) {
                throw new APIError("FORBIDDEN", { message: error.message, code: error.code });
              }
              throw error;
            }
            if (!byCode) return { data: user };
            // The code sign-in makes an account only from an invite, whatever AUTH_ALLOW_SIGNUP
            // says, and the invite is accepted once.
            const grant = await acceptInvite(kysely, user.email, clock());
            if (!grant) return false;
            const columns = inviteColumns(grant);
            return {
              data: {
                ...user,
                role: columns.role,
                packRole: columns.pack_role,
                grantedPermissions: columns.granted_permissions,
              },
            };
          },
          after: async (user, ctx) => {
            if (ctx?.path !== CODE_SIGN_IN_PATH) return;
            const invite = await kysely
              .selectFrom("core_user_invite")
              .select("id")
              .where("email", "=", user.email.toLowerCase())
              .where("accepted_at", "is not", null)
              .where("accepted_user_id", "is", null)
              .orderBy("accepted_at", "desc")
              .executeTakeFirst();
            if (invite) await recordInviteAccount(kysely, invite.id, user.id);
          },
        },
      },
      session: {
        create: {
          // A deactivated person (user.deactivate) cannot sign in again.
          before: async (session) => {
            const row = await db
              .prepare("SELECT deactivated_at FROM core_user WHERE id = ?")
              .bind(session.userId)
              .first<{ deactivated_at: string | null }>();
            if (row?.deactivated_at) return false;
            return { data: session };
          },
        },
      },
    },
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;

export function betterAuthProvider(auth: BetterAuthInstance): IdentityProvider {
  return {
    kind: "better-auth",
    signInPath: "/sign-in",
    signOutUrl: null,
    async resolve(request): Promise<Principal | null> {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return null;
      return {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name,
        roles: [],
      };
    },
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (pathname !== BETTER_AUTH_BASE_PATH && !pathname.startsWith(`${BETTER_AUTH_BASE_PATH}/`)) {
        return null;
      }
      const route = pathname.slice(BETTER_AUTH_BASE_PATH.length);
      if (!codeRouteServed(route)) return new Response("Not found", { status: 404 });
      const response = await auth.handler(request);
      return route === CODE_SIGN_IN_PATH ? uniformCodeSignIn(response) : response;
    },
  };
}

/** Why a code request was refused before any code was made: not set up, or over a limit. */
export type CodeRequestRefusal =
  | { refused: "not_set_up"; message: string }
  | { refused: "rate_limited"; message: string; retryAfterSeconds: number };

/** Reads a code request's refusal from Better Auth's error. Null: not one of ours. */
export function codeRequestRefusal(error: unknown): CodeRequestRefusal | null {
  if (!(error instanceof APIError)) return null;
  const body = (error.body ?? {}) as {
    code?: string;
    message?: string;
    retryAfterSeconds?: number;
  };
  if (body.code === "SIGN_IN_NOT_SET_UP") {
    return { refused: "not_set_up", message: body.message ?? "Sign-in is not set up" };
  }
  if (error.statusCode === 429) {
    return {
      refused: "rate_limited",
      message: body.message ?? "Too many sign-in code requests",
      retryAfterSeconds: body.retryAfterSeconds ?? 60,
    };
  }
  return null;
}

/**
 * A native app asks for a staff code (ADR 0455): the same checks and the same answer as the
 * browser route, and no cookie. Throws Better Auth's error for a refusal (`codeRequestRefusal`).
 */
export async function requestStaffCode(
  auth: BetterAuthInstance,
  email: string,
  headers: Headers,
): Promise<void> {
  await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" }, headers });
}

/**
 * A native app signs a staff member in with their code (ADR 0455): Better Auth's code sign-in,
 * with its hooks (the invite, deactivation), then the cookie session it made is deleted at once,
 * so all the caller gets is who signed in, for a device session. Null for every refusal.
 */
export async function staffSignInWithCode(
  auth: BetterAuthInstance,
  db: D1Database,
  email: string,
  code: string,
  headers: Headers,
): Promise<{ userId: string } | null> {
  let result: { token: string; user: { id: string } };
  try {
    result = await auth.api.signInEmailOTP({ body: { email, otp: code }, headers });
  } catch (error) {
    if (error instanceof APIError) return null;
    throw error;
  }
  await db.prepare("DELETE FROM core_session WHERE token = ?").bind(result.token).run();
  return { userId: result.user.id };
}
