import type { RateLimitBinding } from "@composable-os/core";
import { type BetterAuthInstance, betterAuthProvider, createBetterAuth } from "./better-auth.ts";
import { cloudflareAccessProvider } from "./cloudflare-access.ts";
import {
  type CustomerIdentity,
  createCustomerAuth,
  customerIdentity,
  type SendCustomerCode,
} from "./customer-auth.ts";
import type { IdentityProvider, IdentityProviderKind } from "./principal.ts";

export {
  BETTER_AUTH_BASE_PATH,
  type BetterAuthInstance,
  type BetterAuthOptions,
  betterAuthProvider,
  createBetterAuth,
} from "./better-auth.ts";
export {
  ACCESS_JWT_HEADER,
  type CloudflareAccessOptions,
  cloudflareAccessProvider,
  normaliseTeamDomain,
} from "./cloudflare-access.ts";
export {
  CUSTOMER_AUTH_BASE_PATH,
  CUSTOMER_CODE_ATTEMPTS,
  CUSTOMER_CODE_LENGTH,
  CUSTOMER_CODE_TTL_SECONDS,
  CUSTOMER_COOKIE_PREFIX,
  type CustomerAuthInstance,
  type CustomerAuthOptions,
  type CustomerIdentity,
  type CustomerRequestPrincipal,
  createCustomerAuth,
  customerIdentity,
  type SendCustomerCode,
} from "./customer-auth.ts";
export type { IdentityProvider, IdentityProviderKind, Principal } from "./principal.ts";

/** The env vars and bindings identity reads. All auth secrets are env-only (ADR 0008). */
export interface IdentityEnv {
  DB: D1Database;
  IDENTITY_PROVIDER?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  AUTH_ALLOW_SIGNUP?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}

export class IdentityConfigError extends Error {
  override name = "IdentityConfigError";
}

export function identityProviderKind(
  env: Pick<IdentityEnv, "IDENTITY_PROVIDER">,
): IdentityProviderKind {
  const kind = env.IDENTITY_PROVIDER?.trim() || "better-auth";
  if (kind === "better-auth" || kind === "cloudflare-access") return kind;
  // Fail closed: an unknown adapter name must never fall back to something permissive.
  throw new IdentityConfigError(`Unknown IDENTITY_PROVIDER "${kind}"`);
}

const betterAuthCache = new WeakMap<object, BetterAuthInstance>();

/** Better Auth for this env, built once per isolate. Null when another adapter is active. */
export function getBetterAuth(env: IdentityEnv): BetterAuthInstance | null {
  if (identityProviderKind(env) !== "better-auth") return null;
  let auth = betterAuthCache.get(env);
  if (!auth) {
    if (!env.BETTER_AUTH_SECRET) throw new IdentityConfigError("BETTER_AUTH_SECRET is not set");
    auth = createBetterAuth({
      db: env.DB,
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL || undefined,
      google:
        env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
          : undefined,
      allowSignUp: env.AUTH_ALLOW_SIGNUP === "true",
    });
    betterAuthCache.set(env, auth);
  }
  return auth;
}

/** Builds the identity adapter selected by IDENTITY_PROVIDER (default `better-auth`). */
export function createIdentityProvider(env: IdentityEnv): IdentityProvider {
  const kind = identityProviderKind(env);
  if (kind === "cloudflare-access") {
    if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
      throw new IdentityConfigError(
        "IDENTITY_PROVIDER=cloudflare-access needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD",
      );
    }
    return cloudflareAccessProvider({
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
      audience: env.CF_ACCESS_AUD,
    });
  }
  const auth = getBetterAuth(env);
  if (!auth) throw new IdentityConfigError("Better Auth is not active");
  return betterAuthProvider(auth);
}

/**
 * True until the deployment has its first user, who may always sign up (better-auth.ts) and
 * becomes its admin, so the sign-in page offers to create that account.
 */
export async function awaitingFirstUser(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM core_user").first<{ n: number }>();
  return (row?.n ?? 0) === 0;
}

/** Which sign-in methods the UI should offer. Safe to send to the browser. */
export function signInMethods(env: IdentityEnv) {
  const kind = identityProviderKind(env);
  return {
    kind,
    email: kind === "better-auth",
    google: kind === "better-auth" && Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  };
}

/** The env customer sign-in reads (stage 22, ADR 0402). Its secret is env-only (ADR 0008). */
export interface CustomerIdentityEnv {
  DB: D1Database;
  /** Signs customer sessions. Must differ from BETTER_AUTH_SECRET. */
  CUSTOMER_AUTH_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  /** The client app's public origin. */
  CUSTOMER_AUTH_URL?: string;
  /** Code requests per address asked for. Declared with the HTTP surface (stage 23). */
  CUSTOMER_CODE_RATE_LIMIT?: RateLimitBinding;
  /** Code requests per client address, keyed by a hash of it (stage 23). */
  CUSTOMER_CODE_ADDRESS_RATE_LIMIT?: RateLimitBinding;
}

const customerIdentityCache = new WeakMap<object, CustomerIdentity>();

/**
 * Customer sign-in for this env, built once per isolate. Fails closed without its own secret, and
 * when that secret is the staff one: the two kinds of session must never verify each other.
 */
export function getCustomerIdentity(
  env: CustomerIdentityEnv,
  sendCode: SendCustomerCode,
  /** Why codes cannot be sent yet, or null (see CustomerAuthOptions.ready). */
  ready?: () => Promise<string | null>,
): CustomerIdentity {
  let identity = customerIdentityCache.get(env);
  if (!identity) {
    const secret = env.CUSTOMER_AUTH_SECRET;
    if (!secret) throw new IdentityConfigError("CUSTOMER_AUTH_SECRET is not set");
    if (secret === env.BETTER_AUTH_SECRET) {
      throw new IdentityConfigError("CUSTOMER_AUTH_SECRET must differ from BETTER_AUTH_SECRET");
    }
    const auth = createCustomerAuth({
      db: env.DB,
      secret,
      baseURL: env.CUSTOMER_AUTH_URL || undefined,
      sendCode,
      codeRateLimit: env.CUSTOMER_CODE_RATE_LIMIT,
      codeAddressRateLimit: env.CUSTOMER_CODE_ADDRESS_RATE_LIMIT,
      ready,
    });
    identity = customerIdentity(auth, env.DB);
    customerIdentityCache.set(env, identity);
  }
  return identity;
}
