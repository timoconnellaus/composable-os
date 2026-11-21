// Sessions for native apps (stage 23, ADR 0403, ADR 0419). A phone or a TV exchanges its sign-in
// for an access token that lasts minutes and a refresh token. Both are random, and only their
// SHA-256 hashes are stored (core_device_session, migration 0411).
//
// - Every refresh rotates both. The refresh hashes already used are kept on the row; presenting
//   one again, or two refreshes racing with one token, ends the whole session.
// - A session unused for the `device_session_idle_days` setting (default 90, a human admin
//   changes it) ends when it is next presented.
// - A session is one audience's: a staff user's or a customer account's. A customer's token
//   resolves to that customer, and so is never accepted where only staff may call.
// - Ending a session deletes it. Erasing a person, or disabling a customer, ends theirs.
import type { CoreDatabase, CrmDb } from "@composable-os/db";
import type { Compilable, Kysely } from "kysely";
import { z } from "zod";
import { ForbiddenError } from "../errors.ts";
import { newId } from "../ids.ts";

/** How long an access token works. */
export const ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;
export const DEVICE_SESSION_IDLE_SETTING = "device_session_idle_days";
export const DEFAULT_DEVICE_SESSION_IDLE_DAYS = 90;
export const deviceSessionIdleDaysSchema = z.number().int().min(1).max(3650);
/** How many used refresh hashes a session remembers. */
const USED_KEPT = 50;

const ACCESS_PREFIX = "cos_at_";
const REFRESH_PREFIX = "cos_rt_";

export type DeviceAudience = "staff" | "customer";

export interface DeviceSubject {
  audience: DeviceAudience;
  /** The staff user (usr_…) or the customer account (cus_…). */
  subjectId: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  sessionId: string;
}

export interface ResolvedDevice extends DeviceSubject {
  sessionId: string;
}

/** The days a device session may go unused. A missing or unreadable setting is 90. */
export async function loadDeviceSessionIdleDays(db: Kysely<CoreDatabase>): Promise<number> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", DEVICE_SESSION_IDLE_SETTING)
    .executeTakeFirst();
  if (!row) return DEFAULT_DEVICE_SESSION_IDLE_DAYS;
  try {
    const parsed = deviceSessionIdleDaysSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : DEFAULT_DEVICE_SESSION_IDLE_DAYS;
  } catch {
    return DEFAULT_DEVICE_SESSION_IDLE_DAYS;
  }
}

function random(bytes = 32): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A refusal the client can act on: 401, with why. */
function refused(reason: string, message: string): ForbiddenError {
  return new ForbiddenError(message, { reason, httpStatus: 401 });
}

async function freshTokens(sessionId: string, now: Date) {
  const accessToken = `${ACCESS_PREFIX}${random()}`;
  // A dot cannot occur in base64url, so it cannot be confused with the random part.
  const refreshToken = `${REFRESH_PREFIX}${sessionId}.${random()}`;
  return {
    accessToken,
    refreshToken,
    accessHash: await tokenHash(accessToken),
    refreshHash: await tokenHash(refreshToken),
    accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString(),
  };
}

/** Starts a session for a sign-in the adapter verified. */
export async function issueDeviceSession(
  db: CrmDb,
  subject: DeviceSubject,
  deviceName: string,
  now: Date,
): Promise<IssuedTokens> {
  const sessionId = newId("deviceSession");
  const t = await freshTokens(sessionId, now);
  const at = now.toISOString();
  await db.batch([
    db.query.insertInto("core_device_session").values({
      id: sessionId,
      audience: subject.audience,
      user_id: subject.audience === "staff" ? subject.subjectId : null,
      customer_id: subject.audience === "customer" ? subject.subjectId : null,
      device_name: deviceName,
      access_hash: t.accessHash,
      access_expires_at: t.accessExpiresAt,
      refresh_hash: t.refreshHash,
      created_at: at,
      last_used_at: at,
    }),
  ]);
  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    accessExpiresAt: t.accessExpiresAt,
    sessionId,
  };
}

function idle(lastUsedAt: string, now: Date, idleDays: number): boolean {
  return Date.parse(lastUsedAt) + idleDays * 86_400_000 < now.getTime();
}

async function endSession(db: CrmDb, sessionId: string): Promise<void> {
  await db.batch([db.query.deleteFrom("core_device_session").where("id", "=", sessionId)]);
}

const sessionIdOf = (refreshToken: string): string | null => {
  if (!refreshToken.startsWith(REFRESH_PREFIX)) return null;
  const rest = refreshToken.slice(REFRESH_PREFIX.length);
  const cut = rest.indexOf(".");
  const id = cut > 0 ? rest.slice(0, cut) : "";
  return /^dvs_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? id : null;
};

/**
 * Rotates a session's tokens. A refresh token used before ends the session; so does one that
 * lost a race with another refresh of the same token.
 */
export async function refreshDeviceSession(
  db: CrmDb,
  refreshToken: string,
  now: Date,
): Promise<IssuedTokens> {
  const sessionId = sessionIdOf(refreshToken);
  const ended = () => refused("session_ended", "This session has ended: sign in again");
  if (!sessionId) throw refused("token_invalid", "Not a refresh token");
  const row = await db.query
    .selectFrom("core_device_session")
    .select(["id", "refresh_hash", "used_refresh_hashes", "last_used_at"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  if (!row) throw ended();
  const hash = await tokenHash(refreshToken);
  const used = JSON.parse(row.used_refresh_hashes) as string[];
  if (used.includes(hash)) {
    // A token already rotated past: someone else holds this session. End it for both.
    await endSession(db, sessionId);
    throw refused("refresh_reused", "This sign-in was used on another device: sign in again");
  }
  if (hash !== row.refresh_hash) throw refused("token_invalid", "Not this session's token");
  if (idle(row.last_used_at, now, await loadDeviceSessionIdleDays(db.query))) {
    await endSession(db, sessionId);
    throw refused("session_idle", "This session was unused too long: sign in again");
  }
  const t = await freshTokens(sessionId, now);
  const rotated = await db.query
    .updateTable("core_device_session")
    .set({
      access_hash: t.accessHash,
      access_expires_at: t.accessExpiresAt,
      refresh_hash: t.refreshHash,
      used_refresh_hashes: JSON.stringify([...used, hash].slice(-USED_KEPT)),
      last_used_at: now.toISOString(),
    })
    .where("id", "=", sessionId)
    .where("refresh_hash", "=", hash)
    .returning("id")
    .executeTakeFirst();
  if (!rotated) {
    // Another refresh with this same token got there first: the token was used twice.
    await endSession(db, sessionId);
    throw refused("refresh_reused", "This sign-in was used twice at once: sign in again");
  }
  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    accessExpiresAt: t.accessExpiresAt,
    sessionId,
  };
}

/**
 * Ends the session a refresh token belongs to (`POST /api/v1/auth/sign-out`, ADR 0451): signing
 * out needs no operation, so a pack role, which may call nothing else, can still sign out. Only
 * the session's current refresh token ends it; any other answers as if it had (nothing to say).
 */
export async function endDeviceSessionByRefreshToken(
  db: CrmDb,
  refreshToken: string,
): Promise<{ ended: boolean }> {
  const sessionId = sessionIdOf(refreshToken);
  if (!sessionId) return { ended: false };
  const removed = await db.query
    .deleteFrom("core_device_session")
    .where("id", "=", sessionId)
    .where("refresh_hash", "=", await tokenHash(refreshToken))
    .returning("id")
    .executeTakeFirst();
  return { ended: Boolean(removed) };
}

/** Who an access token is for, or a refusal saying why it is not accepted. */
export async function resolveAccessToken(
  db: CrmDb,
  accessToken: string,
  now: Date,
): Promise<ResolvedDevice> {
  if (!accessToken.startsWith(ACCESS_PREFIX)) throw refused("token_invalid", "Not an access token");
  const row = await db.query
    .selectFrom("core_device_session")
    .select(["id", "audience", "user_id", "customer_id", "access_expires_at", "last_used_at"])
    .where("access_hash", "=", await tokenHash(accessToken))
    .executeTakeFirst();
  if (!row) throw refused("token_invalid", "This access token is not valid: sign in again");
  if (idle(row.last_used_at, now, await loadDeviceSessionIdleDays(db.query))) {
    await endSession(db, row.id);
    throw refused("session_idle", "This session was unused too long: sign in again");
  }
  if (Date.parse(row.access_expires_at) <= now.getTime()) {
    throw refused("token_expired", "This access token has expired: refresh it");
  }
  const subjectId = (row.audience === "staff" ? row.user_id : row.customer_id) as string;
  return { audience: row.audience, subjectId, sessionId: row.id };
}

/** Statements ending every device session of a customer account (disable, delete, merge). */
export function endCustomerDeviceSessions(
  db: Kysely<CoreDatabase>,
  customerIds: readonly string[],
): Compilable[] {
  if (!customerIds.length) return [];
  return [db.deleteFrom("core_device_session").where("customer_id", "in", [...customerIds])];
}
