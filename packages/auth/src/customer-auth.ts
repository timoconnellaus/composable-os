// Customer sign-in (stage 22, ADR 0402): a second Better Auth configuration, apart from the staff
// one in better-auth.ts in every way a request can reach.
//
// - Its own tables: core_customer, core_customer_session, core_customer_verification. A customer
//   is never a core_user and a customer session is never in core_session.
// - Its own cookie (`cos-customer.session_token`) and its own secret (CUSTOMER_AUTH_SECRET), so a
//   customer cookie is not a staff cookie by name, by signature or by table, and the reverse.
// - Sign-in by a one-time code sent by email (Better Auth's email OTP plugin), and nothing else:
//   no password, no social sign-in, no passkey. Codes are stored hashed.
// - Who may get a code is the host's rule (`customerCodeReason` in core): an erased address
//   never, an existing account while active, any other address when sign-up is open, staff
//   invited it, it bought (`buyers`, ADR 0458), or anyone starting a subscription may and a plan
//   is on sale (ADR 0459). The answer to a code request is the same either way, and nothing is
//   sent or stored when the rule says no.
// - At sign-in the account is linked to its Person (`linkCustomer` in core).
// - No client address is stored: Better Auth's IP and user-agent session fields are dropped
//   before a session is written, and the tables have no column for them.
//
// The HTTP routes that mount `handle` are stage 23's.
import {
  type CustomerPrincipal,
  customerCodeReason,
  customerMayGetCode,
  customerSignedInStatement,
  linkCustomer,
  loadCustomer,
  newId,
  type PublicPrincipal,
  type RateLimitBinding,
  rateLimit,
  reportCodeLimitReached,
  watchSubscriberSignup,
} from "@composable-os/core";
import { type CrmDb, createCrmDb } from "@composable-os/db";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins/email-otp";
import { beforeCodeRequest, randomId, uniformCodeSignIn } from "./better-auth.ts";

export const CUSTOMER_AUTH_BASE_PATH = "/api/customer-auth";
/** Customer cookies are `cos-customer.*`; staff cookies keep Better Auth's `better-auth.*`. */
export const CUSTOMER_COOKIE_PREFIX = "cos-customer";
/** A code is six digits, lives five minutes and allows three tries. */
export const CUSTOMER_CODE_LENGTH = 6;
export const CUSTOMER_CODE_TTL_SECONDS = 300;
export const CUSTOMER_CODE_ATTEMPTS = 3;

/** The routes customers may reach. Everything else Better Auth serves answers 404 here. */
const CUSTOMER_ROUTES: Readonly<Record<string, string>> = {
  "/email-otp/send-verification-otp": "POST",
  "/sign-in/email-otp": "POST",
  "/get-session": "GET",
  "/sign-out": "POST",
};

/** Sends one sign-in code. Built on the email-send gatekeeper (`sendCustomerCode` in core). */
export type SendCustomerCode = (message: { to: string; code: string }) => Promise<void>;

export interface CustomerAuthOptions {
  db: D1Database;
  /** CUSTOMER_AUTH_SECRET: signs customer sessions. Required, and never the staff secret. */
  secret: string;
  /** The client app's public origin. Inferred from the request when unset. */
  baseURL?: string | undefined;
  sendCode: SendCustomerCode;
  /** The time linking and sign-in bookkeeping use. Default: now. */
  clock?: () => Date;
  /**
   * Limits code requests per address asked for (`checkCodeRequestLimit`, keyed by the normalised
   * address, never the client's). Unset: not limited here (rateLimit's missing-binding rule).
   */
  codeRateLimit?: RateLimitBinding | undefined;
  /**
   * Limits code requests per client address (stage 23): keyed by a keyed hash of the address,
   * which is never stored. Unset: not limited here.
   */
  codeAddressRateLimit?: RateLimitBinding | undefined;
  /** What the address is keyed with (`clientAddressSecret`): one count for every kind of sign-in. */
  addressSecret?: string | undefined;
  /**
   * Limits codes sent host-wide to addresses that only "anyone starting a subscription" lets sign
   * in (ADR 0459): one key, `code-new`, for the whole host. Over it, nothing is sent, the answer
   * is the same as for a sent code, and admins are told once an hour. Unset: no such code is
   * sent at all (shut, not open); every other reason is unaffected.
   */
  codeNewRateLimit?: RateLimitBinding | undefined;
  /**
   * Whether codes can be sent at all: null when they can, or why not (no email connection is set
   * for customer mail). Asked before a code is made; the answer is the same for every address.
   */
  ready?: (() => Promise<string | null>) | undefined;
}

const CODE_REQUEST_PATH = "/email-otp/send-verification-otp";

const timestamps = { createdAt: "created_at", updatedAt: "updated_at" } as const;

export function createCustomerAuth(options: CustomerAuthOptions) {
  const crm = createCrmDb(options.db);
  const clock = options.clock ?? (() => new Date());
  return betterAuth({
    database: options.db,
    secret: options.secret,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    basePath: CUSTOMER_AUTH_BASE_PATH,
    telemetry: { enabled: false },
    // Code requests and sign-in attempts are limited per client address by Cloudflare's rate
    // limiting at the edge (stage 23), which stores no address. Better Auth's own limiter keys on
    // the address in memory, per isolate, so it is off rather than half on. Code requests are also
    // limited per address asked for, below.
    rateLimit: { enabled: false },
    // Code requests per address asked for, before a code is made or stored. Whether the address
    // may get one is not looked at here, so the refusal says nothing about who is a customer.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== CODE_REQUEST_PATH) return;
        // Not set up (stage 23): said before anything is made or counted, the same for everyone.
        await beforeCodeRequest(ctx, {
          ready: options.ready,
          secret: options.secret,
          addressSecret: options.addressSecret,
          codeRateLimit: options.codeRateLimit,
          codeAddressRateLimit: options.codeAddressRateLimit,
          what: "Customer sign-in",
        });
      }),
    },
    emailAndPassword: { enabled: false },
    socialProviders: {},
    advanced: {
      cookiePrefix: CUSTOMER_COOKIE_PREFIX,
      ipAddress: { disableIpTracking: true },
      database: {
        // The tables are migration 0401's, and leave out on purpose what Better Auth's default
        // schema has: a name and image (a customer's name is their Person's), the session's client
        // address and user agent, and an account table (no password, no social sign-in). Its
        // schema check would refuse them, so it is off; the fields are dropped in the hooks below.
        validateSchema: false,
        generateId: ({ model }) =>
          model === "user" || model === "core_customer" ? newId("customer") : randomId(),
      },
    },
    user: {
      modelName: "core_customer",
      fields: { emailVerified: "email_verified", ...timestamps },
    },
    session: {
      modelName: "core_customer_session",
      fields: { userId: "customer_id", expiresAt: "expires_at", ...timestamps },
    },
    // Customers have no linked accounts (no password, no social sign-in), and there is no such
    // table: any code path that would touch one fails instead of writing somewhere.
    account: { modelName: "core_customer_account" },
    verification: {
      modelName: "core_customer_verification",
      fields: { expiresAt: "expires_at", ...timestamps },
    },
    plugins: [
      emailOTP({
        otpLength: CUSTOMER_CODE_LENGTH,
        expiresIn: CUSTOMER_CODE_TTL_SECONDS,
        allowedAttempts: CUSTOMER_CODE_ATTEMPTS,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }, ctx) {
          const now = clock();
          // A code request may reuse a recent "is a plan on sale" (60 s, this isolate); the
          // recheck when the account is made does not (ADR 0459).
          const reason =
            type === "sign-in"
              ? await customerCodeReason(crm.query, email, now.toISOString(), { memo: true })
              : null;
          if (type === "sign-in" && reason !== "account") {
            // Admins hear once when a plan going on sale opened sign-up, or when the switch
            // cannot be answered. Never in the way of the answer.
            await watchSubscriberSignup(crm, now, { memo: true }).catch((error: unknown) =>
              console.error(
                "customer sign-in: could not watch the subscription sign-up",
                error instanceof Error ? error.message : error,
              ),
            );
          }
          // A new address that only "anyone starting a subscription" lets in (ADR 0459) is the one
          // reason a stranger can bring about for any address: such codes are also limited
          // host-wide, and without the limit's binding none is sent (shut, not open). Over it,
          // this address is answered as one that may not get a code, and admins are told.
          let allowed = reason !== null;
          if (reason === "subscription") {
            if (!options.codeNewRateLimit) {
              allowed = false;
              console.warn(
                "customer sign-in: CUSTOMER_CODE_NEW_RATE_LIMIT is not bound, so new addresses get no code",
              );
            } else {
              allowed = (await rateLimit(options.codeNewRateLimit, "code-new")).ok;
              if (!allowed) {
                console.warn(
                  "customer sign-in: codes to new addresses are over the host-wide limit",
                );
                await reportCodeLimitReached(crm, now).catch(() => {});
              }
            }
          }
          if (!allowed) {
            // The same answer as a sent code, and nothing is kept: the code just stored for this
            // address is removed, so it can never be guessed into an account.
            await ctx?.context.internalAdapter.deleteVerificationByIdentifier(
              `${type}-otp-${email.toLowerCase()}`,
            );
            return;
          }
          try {
            await options.sendCode({ to: email, code: otp });
          } catch (error) {
            // Not sent (queued for review, or failed): the code is removed, as for a refused
            // address, so a code nobody received never works. Queued, its text is in the
            // Approvals preview, where whoever approves it could otherwise sign in as this
            // address (ADR 0455). The answer is the same as for a sent code.
            await ctx?.context.internalAdapter.deleteVerificationByIdentifier(
              `${type}-otp-${email.toLowerCase()}`,
            );
            console.error(
              "customer sign-in code not sent",
              error instanceof Error ? error.message : error,
            );
          }
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // A code is only ever sent to an address that may sign up, so this is the second lock:
          // an account is never created for an erased, uninvited (invite only) address.
          before: async (user) => {
            if (!(await customerMayGetCode(crm.query, user.email))) {
              throw new APIError("BAD_REQUEST", { message: "Invalid code", code: "INVALID_OTP" });
            }
            // Better Auth's `name` and `image` are not stored: a customer's name is their Person's.
            return { data: { ...user, name: undefined, image: undefined } };
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const account = await loadCustomer(crm.query, session.userId);
            if (!account || !(await customerMayGetCode(crm.query, account.email))) {
              throw new APIError("FORBIDDEN", { message: "This account cannot sign in" });
            }
            const now = clock();
            try {
              await linkCustomer(crm, account.id, now);
            } catch (error) {
              // The session still starts; it resolves to no customer until a later sign-in links.
              console.error(
                "customer account not linked",
                error instanceof Error ? error.message : error,
              );
            }
            await crm.batch([customerSignedInStatement(crm.query, account.id, now.toISOString())]);
            // No client address or user agent is stored for a customer session.
            return { data: { ...session, ipAddress: undefined, userAgent: undefined } };
          },
        },
      },
    },
  });
}

export type CustomerAuthInstance = ReturnType<typeof createCustomerAuth>;

const PUBLIC: PublicPrincipal = Object.freeze({ kind: "public" });

/** What a customer request resolves to: a customer, or the public. Never staff. */
export type CustomerRequestPrincipal = CustomerPrincipal | PublicPrincipal;

export interface CustomerIdentity {
  /**
   * The caller of a client-app request: the customer whose session cookie it carries, or the
   * public. A disabled account, one not linked to a Person, or one waiting for staff to merge
   * people resolves to the public. A staff cookie is never read: it has another name, another
   * secret and another table.
   */
  resolve(request: Request): Promise<CustomerRequestPrincipal>;
  /**
   * As `resolve`, with the session the cookie names (its id), for the HTTP surface: it records
   * which session a call came from, and exchanges a session for a native app's tokens. And when
   * that session was signed in (its row's `createdAt`, written once at the code sign-in): a
   * native app's session exchanged from it starts then, so the exchange never makes an old
   * sign-in recent (stage 48, ADR 0712).
   */
  resolveSession(request: Request): Promise<{
    principal: CustomerRequestPrincipal;
    sessionId: string | null;
    signedInAt?: Date | undefined;
  }>;
  /**
   * Serves the customer sign-in routes under CUSTOMER_AUTH_BASE_PATH. Returns null when the
   * request is not for one. A route outside the customer list answers 404.
   */
  handle(request: Request): Promise<Response | null>;
  /**
   * A native app asks for a code (ADR 0455): the browser route's checks and answer, no cookie.
   * Throws Better Auth's error for a refusal (`codeRequestRefusal`).
   */
  requestCode(email: string, headers: Headers): Promise<void>;
  /**
   * A native app signs in with the code (ADR 0455): Better Auth's sign-in and its hooks, then
   * the cookie session it made is deleted at once. The account, for a device session, or null
   * for every refusal.
   */
  signInWithCode(
    email: string,
    code: string,
    headers: Headers,
  ): Promise<{ customerId: string; account: "ready" | "needs_attention" } | null>;
}

/** Whether a signed-in account is ready, or waits for staff to merge people. */
async function accountState(db: CrmDb, customerId: string): Promise<"ready" | "needs_attention"> {
  const account = await loadCustomer(db.query, customerId);
  return account?.personId && account.linkState === "linked" ? "ready" : "needs_attention";
}

export function customerIdentity(auth: CustomerAuthInstance, d1: D1Database): CustomerIdentity {
  const crm = createCrmDb(d1);
  const identity: CustomerIdentity = {
    async resolve(request) {
      return (await identity.resolveSession(request)).principal;
    },
    async resolveSession(request) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return { principal: PUBLIC, sessionId: null };
      const account = await loadCustomer(crm.query, session.user.id);
      if (account?.status !== "active" || account.linkState !== "linked" || !account.personId) {
        return { principal: PUBLIC, sessionId: null };
      }
      return {
        principal: Object.freeze({
          kind: "customer",
          customerId: account.id,
          personId: account.personId,
        }),
        sessionId: session.session.id,
        signedInAt: new Date(session.session.createdAt),
      };
    },
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (
        pathname !== CUSTOMER_AUTH_BASE_PATH &&
        !pathname.startsWith(`${CUSTOMER_AUTH_BASE_PATH}/`)
      ) {
        return null;
      }
      const route = pathname.slice(CUSTOMER_AUTH_BASE_PATH.length);
      if (CUSTOMER_ROUTES[route] !== request.method) {
        return new Response("Not found", { status: 404 });
      }
      const response = await auth.handler(request);
      if (route !== "/sign-in/email-otp") return response;
      // One answer for every failed sign-in: "expired" or "too many tries" would say a code was
      // sent to the address (ADR 0455).
      if (!response.ok) return uniformCodeSignIn(response);
      // Signed in: say whether the account is ready or needs a moment (staff are merging people).
      const body = (await response.json()) as { user?: { id?: unknown } } & Record<string, unknown>;
      const customerId = typeof body.user?.id === "string" ? body.user.id : null;
      const account = customerId ? await accountState(crm, customerId) : "needs_attention";
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(JSON.stringify({ ...body, account }), {
        status: response.status,
        headers,
      });
    },
    async requestCode(email, headers) {
      await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" }, headers });
    },
    async signInWithCode(email, code, headers) {
      let result: { token: string; user: { id: string } };
      try {
        result = await auth.api.signInEmailOTP({ body: { email, otp: code }, headers });
      } catch (error) {
        if (error instanceof APIError) return null;
        throw error;
      }
      await d1
        .prepare("DELETE FROM core_customer_session WHERE token = ?")
        .bind(result.token)
        .run();
      return { customerId: result.user.id, account: await accountState(crm, result.user.id) };
    },
  };
  return identity;
}
