import type { RateLimitBinding } from "@composable-os/core";
import { perClientMissing } from "@composable-os/db/client-entries";
import { parseFirstAdmin } from "@composable-os/db/registry";
import {
  type BetterAuthInstance,
  betterAuthProvider,
  clientAddressSecret,
  createBetterAuth,
  humanCount,
  type StaffCodes,
} from "./better-auth.ts";
import { cloudflareAccessProvider } from "./cloudflare-access.ts";
import {
  type CustomerIdentity,
  createCustomerAuth,
  customerIdentity,
  type SendCustomerCode,
} from "./customer-auth.ts";
import {
  createPractitionerAuth,
  type PractitionerIdentity,
  practitionerIdentity,
  practitionerSessionSecret,
  type SendPractitionerCode,
} from "./practitioner-auth.ts";
import type { IdentityProvider, IdentityProviderKind } from "./principal.ts";

export {
  addressKey,
  BETTER_AUTH_BASE_PATH,
  type BetterAuthInstance,
  type BetterAuthOptions,
  betterAuthProvider,
  type CodeRequestRefusal,
  clientAddressBucket,
  clientAddressSecret,
  codeRequestRefusal,
  createBetterAuth,
  FIRST_ADMIN_HEADER,
  type FirstAdmin,
  firstAdminMaySignUp,
  hostOnlyCookies,
  isSessionCookie,
  requestStaffCode,
  STAFF_CODE_ATTEMPTS,
  STAFF_CODE_LENGTH,
  STAFF_CODE_TTL_SECONDS,
  type StaffCodes,
  staffSignInWithCode,
  validClientAddress,
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
export {
  createPractitionerAuth,
  PRACTITIONER_AUTH_BASE_PATH,
  PRACTITIONER_CODE_ATTEMPTS,
  PRACTITIONER_CODE_LENGTH,
  PRACTITIONER_CODE_TTL_SECONDS,
  PRACTITIONER_COOKIE_PREFIX,
  type PractitionerAuthInstance,
  type PractitionerAuthOptions,
  type PractitionerIdentity,
  practitionerIdentity,
  practitionerSessionSecret,
  type SendPractitionerCode,
} from "./practitioner-auth.ts";
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
  /** Set in a client's environment on a host of many clients (ADR 0616): `__Host-` cookies. */
  COS_CLIENT_ID?: string;
  /**
   * A many-client host's client setting (stage 66 step 9): who may make its first account, by
   * the operator's setup link (`@composable-os/db/registry` `firstAdminValue`).
   */
  COS_FIRST_ADMIN?: string;
  /** A many-client host's derived key for client addresses (ADR 0616). */
  CLIENT_ADDRESS_SECRET?: string;
  /** Code requests per address asked for: staff and customers share it (ADR 0455). */
  CUSTOMER_CODE_RATE_LIMIT?: RateLimitBinding;
  /** Code requests per client address, keyed by a hash of it. */
  CUSTOMER_CODE_ADDRESS_RATE_LIMIT?: RateLimitBinding;
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
const staffCodes = new WeakMap<object, StaffCodes>();

/**
 * How the host sends staff sign-in codes for this env (ADR 0455). cos-app gives it on every
 * request, before any route; without it, a staff code request answers that sign-in by code is
 * not set up, the same for every address.
 */
export function provideStaffCodes(env: object, codes: StaffCodes): void {
  staffCodes.set(env, codes);
}

/** Better Auth for this env, built once per isolate. Null when another adapter is active. */
export function getBetterAuth(env: IdentityEnv): BetterAuthInstance | null {
  if (identityProviderKind(env) !== "better-auth") return null;
  let auth = betterAuthCache.get(env);
  if (!auth) {
    if (!env.BETTER_AUTH_SECRET) {
      // A client's environment on a many-client host has none until stage 66 step 6.
      throw new IdentityConfigError(
        perClientMissing(env, "BETTER_AUTH_SECRET") ?? "BETTER_AUTH_SECRET is not set",
      );
    }
    auth = createBetterAuth({
      db: env.DB,
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL || undefined,
      google:
        env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
          : undefined,
      allowSignUp: env.AUTH_ALLOW_SIGNUP === "true",
      codes: () => staffCodes.get(env) ?? null,
      codeRateLimit: env.CUSTOMER_CODE_RATE_LIMIT,
      codeAddressRateLimit: env.CUSTOMER_CODE_ADDRESS_RATE_LIMIT,
      addressSecret: clientAddressSecret(env),
      hostOnlyCookies: Boolean(env.COS_CLIENT_ID),
      // A client of a many-client host: only its named first admin makes its first account
      // (stage 66 step 9). A single-client deployment: the first person, as before.
      ...(env.COS_CLIENT_ID ? { firstAdmin: parseFirstAdmin(env.COS_FIRST_ADMIN) } : {}),
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
 * True until the deployment has its first person (an installed pack's principal is not one),
 * who becomes its admin, so the sign-in page offers to create that account: anyone on a
 * single-client deployment, the named first admin by the operator's setup link on a host of many
 * clients (better-auth.ts).
 */
export async function awaitingFirstUser(db: D1Database): Promise<boolean> {
  return (await humanCount(db)) === 0;
}

/**
 * Whether the first account is made only by the operator's setup link (stage 66 step 9): on a
 * host of many clients. Safe to send to the browser.
 */
export function firstAdminByLink(env: object): boolean {
  return Boolean((env as Pick<IdentityEnv, "COS_CLIENT_ID">).COS_CLIENT_ID);
}

/** Which sign-in methods the UI should offer. Safe to send to the browser. */
export function signInMethods(env: IdentityEnv) {
  const kind = identityProviderKind(env);
  return {
    kind,
    email: kind === "better-auth",
    /** Sign-in by an emailed code (invited staff, verified accounts; ADR 0455). */
    code: kind === "better-auth",
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
  /** Set in a client's environment on a host of many clients (ADR 0616): `__Host-` cookies. */
  COS_CLIENT_ID?: string;
  /** A many-client host's derived key for client addresses (ADR 0616). */
  CLIENT_ADDRESS_SECRET?: string;
  /** Code requests per address asked for. Declared with the HTTP surface (stage 23). */
  CUSTOMER_CODE_RATE_LIMIT?: RateLimitBinding;
  /** Code requests per client address, keyed by a hash of it (stage 23). */
  CUSTOMER_CODE_ADDRESS_RATE_LIMIT?: RateLimitBinding;
  /**
   * Codes sent host-wide to new addresses that only "anyone starting a subscription" lets sign
   * in (ADR 0459), one key for the whole host.
   */
  CUSTOMER_CODE_NEW_RATE_LIMIT?: RateLimitBinding;
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
    if (!secret) {
      throw new IdentityConfigError(
        perClientMissing(env, "CUSTOMER_AUTH_SECRET") ?? "CUSTOMER_AUTH_SECRET is not set",
      );
    }
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
      addressSecret: clientAddressSecret(env),
      hostOnlyCookies: Boolean(env.COS_CLIENT_ID),
      codeNewRateLimit: env.CUSTOMER_CODE_NEW_RATE_LIMIT,
      ready,
    });
    identity = customerIdentity(auth, env.DB);
    customerIdentityCache.set(env, identity);
  }
  return identity;
}

const practitionerIdentityCache = new WeakMap<object, PractitionerIdentity>();

/**
 * Practitioner sign-in for this env (stage 43, ADR 0581), built once per isolate. Its sessions
 * are signed with a key derived from CUSTOMER_AUTH_SECRET (`practitionerSessionSecret`), so it
 * needs no secret of its own; it fails closed as customer sign-in does: without that secret, and
 * when that secret is the staff one.
 */
export function getPractitionerIdentity(
  env: CustomerIdentityEnv,
  sendCode: SendPractitionerCode,
  /** Why codes cannot be sent yet, or null. */
  ready?: () => Promise<string | null>,
): PractitionerIdentity {
  let identity = practitionerIdentityCache.get(env);
  if (!identity) {
    const secret = env.CUSTOMER_AUTH_SECRET;
    if (!secret) {
      throw new IdentityConfigError(
        perClientMissing(env, "CUSTOMER_AUTH_SECRET") ?? "CUSTOMER_AUTH_SECRET is not set",
      );
    }
    if (secret === env.BETTER_AUTH_SECRET) {
      throw new IdentityConfigError("CUSTOMER_AUTH_SECRET must differ from BETTER_AUTH_SECRET");
    }
    const auth = practitionerSessionSecret(secret).then((key) =>
      createPractitionerAuth({
        db: env.DB,
        secret: key,
        baseURL: env.CUSTOMER_AUTH_URL || undefined,
        sendCode,
        codeRateLimit: env.CUSTOMER_CODE_RATE_LIMIT,
        codeAddressRateLimit: env.CUSTOMER_CODE_ADDRESS_RATE_LIMIT,
        addressSecret: clientAddressSecret(env),
        hostOnlyCookies: Boolean(env.COS_CLIENT_ID),
        ready,
      }),
    );
    identity = practitionerIdentity(auth, env.DB);
    practitionerIdentityCache.set(env, identity);
  }
  return identity;
}
