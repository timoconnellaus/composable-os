// Native staff sign-in through the system browser (ADR 0455), for staff whose sign-in is
// browser-based (Google, Cloudflare Access). The app makes a PKCE verifier and opens
// /native/staff-sign-in with its S256 challenge in the system browser; signed in there, the
// host hands back a one-time code on the app's own redirect address; the app exchanges the code
// with the verifier for a device session (`issueDeviceSession`).
//
// - Only the code's SHA-256 hash is stored (core_native_handoff, migration 0490).
// - A code is deleted when it is presented, right or wrong, and lives 60 seconds.
// - It is bound to the challenge and to the redirect address it was sent to, which must be one
//   the deployment lists (NATIVE_REDIRECT_URIS).
import type { CrmDb } from "@composable-os/db";
import { base64url } from "../digest.ts";
import { ForbiddenError } from "../errors.ts";
import { tokenHash } from "./tokens.ts";

export const HANDOFF_TTL_MS = 60_000;
const HANDOFF_PREFIX = "cos_hc_";

/** The redirect addresses a deployment allows, from NATIVE_REDIRECT_URIS (comma separated). */
export function parseNativeRedirects(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Whether a code may be sent to `redirectUri`: it is one the deployment lists, exactly; or the
 * deployment lists a loopback address with no port (`http://127.0.0.1/cos-sign-in`) and this is
 * that address on any port, as a command-line tool listening on a port of its own asks
 * (RFC 8252, 7.3; ADR 0470). Only the IP literals 127.0.0.1 and [::1] over http, never a name
 * such as localhost, and the path must be the listed one.
 */
export function nativeRedirectAllowed(allowed: readonly string[], redirectUri: string): boolean {
  if (allowed.includes(redirectUri)) return true;
  let asked: URL;
  try {
    asked = new URL(redirectUri);
  } catch {
    return false;
  }
  if (asked.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(asked.hostname)) return false;
  if (asked.username || asked.password || asked.search || asked.hash || !asked.port) return false;
  return allowed.some((entry) => {
    try {
      const listed = new URL(entry);
      return (
        listed.protocol === "http:" &&
        listed.hostname === asked.hostname &&
        listed.port === "" &&
        !listed.search &&
        !listed.hash &&
        listed.pathname === asked.pathname
      );
    } catch {
      return false;
    }
  });
}

/** The S256 challenge of a verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** How long the native sign-in page's confirmation stays good (ADR 0457). */
export const SIGN_IN_CONFIRM_TTL_MS = 5 * 60 * 1000;

/** What a confirmation is bound to: the account and the request's parameters. */
export interface SignInConfirmBinding {
  userId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}

/**
 * Makes the one-time token of /native/staff-sign-in's confirm page (ADR 0457), bound to the
 * signed-in account and the request's redirect address, challenge and state. Only its hash is
 * stored.
 */
export async function issueSignInConfirmation(
  db: CrmDb,
  binding: SignInConfirmBinding,
  now: Date,
): Promise<string> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await db.batch([
    db.query.deleteFrom("core_native_sign_in_confirm").where("expires_at", "<=", now.toISOString()),
    db.query.insertInto("core_native_sign_in_confirm").values({
      token_hash: await tokenHash(token),
      user_id: binding.userId,
      redirect_uri: binding.redirectUri,
      challenge: binding.challenge,
      state: binding.state,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + SIGN_IN_CONFIRM_TTL_MS).toISOString(),
    }),
  ]);
  return token;
}

/**
 * Spends a confirmation: true only when it was issued for exactly this account and these
 * parameters, and has not expired. It is deleted when presented, right or wrong, so it works once.
 */
export async function redeemSignInConfirmation(
  db: CrmDb,
  token: string,
  binding: SignInConfirmBinding,
  now: Date,
): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const row = await db.query
    .deleteFrom("core_native_sign_in_confirm")
    .where("token_hash", "=", await tokenHash(token))
    .returningAll()
    .executeTakeFirst();
  if (!row) return false;
  return (
    Date.parse(row.expires_at) > now.getTime() &&
    row.user_id === binding.userId &&
    row.redirect_uri === binding.redirectUri &&
    row.challenge === binding.challenge &&
    row.state === binding.state
  );
}

/** The refusal every failed exchange gets: one answer, whatever was wrong. */
export function invalidCode(): ForbiddenError {
  return new ForbiddenError("That code is not valid. Ask for a new one.", {
    reason: "invalid_code",
    httpStatus: 401,
  });
}

/** Makes a one-time code for a signed-in staff user, to hand to the app on `redirectUri`. */
export async function issueNativeHandoff(
  db: CrmDb,
  input: { userId: string; challenge: string; redirectUri: string },
  now: Date,
): Promise<string> {
  const code = `${HANDOFF_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  await db.batch([
    db.query.insertInto("core_native_handoff").values({
      code_hash: await tokenHash(code),
      user_id: input.userId,
      challenge: input.challenge,
      redirect_uri: input.redirectUri,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + HANDOFF_TTL_MS).toISOString(),
    }),
  ]);
  return code;
}

/** Spends a code: the staff user it was made for, or `invalidCode()`. */
export async function redeemNativeHandoff(
  db: CrmDb,
  input: { code: string; codeVerifier: string; redirectUri: string },
  now: Date,
): Promise<string> {
  if (!input.code.startsWith(HANDOFF_PREFIX)) throw invalidCode();
  // Deleted first: a code is spent by being presented, so it cannot be tried twice.
  const row = await db.query
    .deleteFrom("core_native_handoff")
    .where("code_hash", "=", await tokenHash(input.code))
    .returningAll()
    .executeTakeFirst();
  if (!row) throw invalidCode();
  if (Date.parse(row.expires_at) <= now.getTime()) throw invalidCode();
  if (row.redirect_uri !== input.redirectUri) throw invalidCode();
  if ((await pkceChallenge(input.codeVerifier)) !== row.challenge) throw invalidCode();
  return row.user_id;
}
