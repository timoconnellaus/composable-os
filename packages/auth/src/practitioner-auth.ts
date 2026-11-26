// Practitioner sign-in (stage 43 step 3, ADR 0581): a third Better Auth configuration, apart from
// the staff one (better-auth.ts) and the customer one (customer-auth.ts) in every way a request
// can reach.
//
// - Its own tables: core_practitioner, core_practitioner_session, core_practitioner_verification.
//   A practitioner is never a core_user or a core_customer, and a practitioner session is never in
//   core_session or core_customer_session, nor the reverse.
// - Its own cookie (`cos-practitioner.session_token`) and its own key: derived from
//   CUSTOMER_AUTH_SECRET with a fixed label (`practitionerSessionSecret`), so it differs from both
//   other keys without a new secret to provision, and stays env-only (ADR 0008). A practitioner
//   cookie is not a staff or customer cookie by name, by signature or by table, and the reverse.
// - Sign-in by a one-time code sent by email, and nothing else. Codes are stored hashed.
// - Only an invited or active account gets a code (`practitionerMayGetCode` in core); sign-up is
//   off, so no account is ever made here: an account is made only by `practitioner.invite`. The
//   answer to a code request is the same either way, and nothing is sent or kept when the rule
//   says no.
// - A session resolves to a practitioner only while the account is active
//   (`practitionerPrincipalFor`). The first sign-in makes an invited account active.
// - No client address is stored: Better Auth's IP and user-agent session fields are dropped before
//   a session is written, and the table has no column for them.
//
// One address may hold a staff, a customer and a practitioner account at once (decision 16): each
// is signed in on its own, with its own cookie, and nothing here reads the other two.
import {
  loadPractitioner,
  newId,
  type PractitionerPrincipal,
  practitionerMayGetCode,
  practitionerPrincipalFor,
  practitionerSignedInStatement,
  type RateLimitBinding,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import { beforeCodeRequest, cookieOptions, randomId, uniformCodeSignIn } from "./better-auth.ts";

export const PRACTITIONER_AUTH_BASE_PATH = "/api/practitioner-auth";
/** Practitioner cookies are `cos-practitioner.*`; customers' `cos-customer.*`; staff `better-auth.*`. */
export const PRACTITIONER_COOKIE_PREFIX = "cos-practitioner";
/** A code is six digits, lives five minutes and allows three tries, as a customer's. */
export const PRACTITIONER_CODE_LENGTH = 6;
export const PRACTITIONER_CODE_TTL_SECONDS = 300;
export const PRACTITIONER_CODE_ATTEMPTS = 3;

/** The routes practitioners may reach. Everything else Better Auth serves answers 404 here. */
const PRACTITIONER_ROUTES: Readonly<Record<string, string>> = {
  "/email-otp/send-verification-otp": "POST",
  "/sign-in/email-otp": "POST",
  "/get-session": "GET",
  "/sign-out": "POST",
};

const CODE_REQUEST_PATH = "/email-otp/send-verification-otp";
const SESSION_SECRET_LABEL = "cos-practitioner-sessions";

/**
 * The key practitioner sessions are signed with: HMAC-SHA256 of a fixed label under
 * CUSTOMER_AUTH_SECRET, hex. One secret in the env, two keys that never verify each other's
 * cookies; and CUSTOMER_AUTH_SECRET already must differ from BETTER_AUTH_SECRET.
 */
export async function practitionerSessionSecret(customerSecret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(customerSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(SESSION_SECRET_LABEL));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sends one sign-in code, as the host's sign-in mail. Throws unless it was sent. */
export type SendPractitionerCode = (message: { to: string; code: string }) => Promise<void>;

export interface PractitionerAuthOptions {
  db: D1Database;
  /** The key sessions are signed with (`practitionerSessionSecret`). Never another sign-in's. */
  secret: string;
  /** The business's web app, where practitioners sign in. Inferred from the request when unset. */
  baseURL?: string | undefined;
  sendCode: SendPractitionerCode;
  clock?: () => Date;
  /** Code requests per address asked for: one inbox, one limit, whichever hat asks. */
  codeRateLimit?: RateLimitBinding | undefined;
  /** Code requests per client address, keyed by a keyed hash of it. */
  codeAddressRateLimit?: RateLimitBinding | undefined;
  /** What the address is keyed with (`clientAddressSecret`): one count for every kind of sign-in. */
  addressSecret?: string | undefined;
  /** A many-client host: every cookie `__Host-` prefixed (`cookieOptions`, ADR 0616). */
  hostOnlyCookies?: boolean | undefined;
  /** Whether codes can be sent at all: null when they can, or why not. */
  ready?: (() => Promise<string | null>) | undefined;
}

const timestamps = { createdAt: "created_at", updatedAt: "updated_at" } as const;

export function createPractitionerAuth(options: PractitionerAuthOptions) {
  const crm = createCrmDb(options.db);
  const clock = options.clock ?? (() => new Date());
  return betterAuth({
    database: options.db,
    secret: options.secret,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    basePath: PRACTITIONER_AUTH_BASE_PATH,
    telemetry: { enabled: false },
    // As for customers: limited at the edge and per address asked for, not by Better Auth's own
    // in-memory limiter.
    rateLimit: { enabled: false },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== CODE_REQUEST_PATH) return;
        await beforeCodeRequest(ctx, {
          ready: options.ready,
          secret: options.secret,
          addressSecret: options.addressSecret,
          codeRateLimit: options.codeRateLimit,
          codeAddressRateLimit: options.codeAddressRateLimit,
          what: "Practitioner sign-in",
        });
      }),
    },
    emailAndPassword: { enabled: false },
    socialProviders: {},
    advanced: {
      ...cookieOptions(PRACTITIONER_COOKIE_PREFIX, options.hostOnlyCookies),
      ipAddress: { disableIpTracking: true },
      database: {
        // The tables are migration 0730's: no image, no session client address or user agent, no
        // account table. Better Auth's schema check would refuse them, so it is off.
        validateSchema: false,
        generateId: ({ model }) =>
          model === "user" || model === "core_practitioner" ? newId("practitioner") : randomId(),
      },
    },
    user: {
      modelName: "core_practitioner",
      fields: { emailVerified: "email_verified", ...timestamps },
    },
    session: {
      modelName: "core_practitioner_session",
      fields: { userId: "practitioner_id", expiresAt: "expires_at", ...timestamps },
    },
    // No linked accounts and no such table: any code path that would touch one fails.
    account: { modelName: "core_practitioner_account" },
    verification: {
      modelName: "core_practitioner_verification",
      fields: { expiresAt: "expires_at", ...timestamps },
    },
    plugins: [
      emailOTP({
        otpLength: PRACTITIONER_CODE_LENGTH,
        expiresIn: PRACTITIONER_CODE_TTL_SECONDS,
        allowedAttempts: PRACTITIONER_CODE_ATTEMPTS,
        storeOTP: "hashed",
        // An account is made only by an invite (practitioner.invite), never by signing in.
        disableSignUp: true,
        async sendVerificationOTP({ email, otp, type }, ctx) {
          const drop = () =>
            ctx?.context.internalAdapter.deleteVerificationByIdentifier(
              `${type}-otp-${email.toLowerCase()}`,
            );
          if (type !== "sign-in" || !(await practitionerMayGetCode(crm.query, email))) {
            // The same answer as a sent code, and nothing is kept.
            await drop();
            return;
          }
          try {
            await options.sendCode({ to: email, code: otp });
          } catch (error) {
            // Not sent (queued for review, or failed): removed, so a code nobody received never
            // works (ADR 0455). The answer is the same as for a sent code.
            await drop();
            console.error(
              "practitioner sign-in code not sent",
              error instanceof Error ? error.message : error,
            );
          }
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // Sign-up is off (above); this is the second lock: no account is ever made here.
          before: async () => {
            throw new APIError("BAD_REQUEST", { message: "Invalid code", code: "INVALID_OTP" });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const account = await loadPractitioner(crm.query, session.userId);
            if (account?.status !== "invited" && account?.status !== "active") {
              throw new APIError("FORBIDDEN", { message: "This account cannot sign in" });
            }
            // An invited account becomes active at its first sign-in.
            await crm.batch([
              practitionerSignedInStatement(crm.query, account.id, clock().toISOString()),
            ]);
            // No client address or user agent is stored for a practitioner session.
            return { data: { ...session, ipAddress: undefined, userAgent: undefined } };
          },
        },
      },
    },
  });
}

export type PractitionerAuthInstance = ReturnType<typeof createPractitionerAuth>;

export interface PractitionerIdentity {
  /**
   * The practitioner whose session cookie the request carries, or null: no cookie, a forged,
   * signed-out or deleted session, or an account that is not active. A staff or customer cookie
   * is never read: they have other names, other keys and other tables.
   */
  resolve(request: Request): Promise<PractitionerPrincipal | null>;
  /** As `resolve`, with the session the cookie names (its id), for the HTTP surface. */
  resolveSession(
    request: Request,
  ): Promise<{ principal: PractitionerPrincipal | null; sessionId: string | null }>;
  /**
   * Serves the practitioner sign-in routes under PRACTITIONER_AUTH_BASE_PATH. Returns null when
   * the request is not for one. A route outside the list answers 404.
   */
  handle(request: Request): Promise<Response | null>;
}

export function practitionerIdentity(
  auth: PractitionerAuthInstance | Promise<PractitionerAuthInstance>,
  d1: D1Database,
): PractitionerIdentity {
  const crm = createCrmDb(d1);
  const identity: PractitionerIdentity = {
    async resolve(request) {
      return (await identity.resolveSession(request)).principal;
    },
    async resolveSession(request) {
      const session = await (await auth).api.getSession({ headers: request.headers });
      if (!session) return { principal: null, sessionId: null };
      const principal = await practitionerPrincipalFor(crm.query, session.user.id);
      if (!principal) return { principal: null, sessionId: null };
      return { principal, sessionId: session.session.id };
    },
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (
        pathname !== PRACTITIONER_AUTH_BASE_PATH &&
        !pathname.startsWith(`${PRACTITIONER_AUTH_BASE_PATH}/`)
      ) {
        return null;
      }
      const route = pathname.slice(PRACTITIONER_AUTH_BASE_PATH.length);
      if (PRACTITIONER_ROUTES[route] !== request.method) {
        return new Response("Not found", { status: 404 });
      }
      const response = await (await auth).handler(request);
      // One answer for every failed sign-in (ADR 0455).
      if (route === "/sign-in/email-otp" && !response.ok) return uniformCodeSignIn(response);
      return response;
    },
  };
  return identity;
}
