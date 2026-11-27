// Sessions for native apps (stage 23, ADR 0403, ADR 0419). A phone or a TV exchanges its sign-in
// for an access token that lasts minutes and a refresh token. Both are random, and only their
// SHA-256 hashes are stored (core_device_session, migration 0411).
//
// - Every refresh rotates both. The refresh hashes already used are kept on the row; presenting
//   one again, or two refreshes racing with one token, ends the whole session. The one exception
//   (migration 1505): within REFRESH_GRACE_MS of a rotation, while its answer is unused and once
//   in a session's life, the token it rotated past gets the same answer again (a device whose
//   answer was lost), audited; the answer is kept sealed under that token, never as given.
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

/**
 * Starts a session for a sign-in the adapter verified. Its `created_at` is when that sign-in was
 * made: now for a code sign-in, or `signedInAt`, the browser session's own sign-in, when a session
 * is exchanged for tokens, so an exchange never makes an old sign-in recent (stage 48, ADR 0712:
 * a recent sign-in reads it). A refresh never changes it.
 */
export async function issueDeviceSession(
  db: CrmDb,
  subject: DeviceSubject,
  deviceName: string,
  now: Date,
  signedInAt?: Date,
): Promise<IssuedTokens> {
  const sessionId = newId("deviceSession");
  const t = await freshTokens(sessionId, now);
  const at = now.toISOString();
  const started =
    signedInAt && !Number.isNaN(signedInAt.getTime()) && signedInAt < now
      ? signedInAt.toISOString()
      : at;
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
      created_at: started,
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
 * How long after a rotation the refresh token it rotated past may still be answered again
 * (ADR 0419, amended 2026-11-27), and only while the answer is unused and only once a session:
 * long enough for a device whose answer was lost to try again (the client gives up on a refresh
 * after 15 seconds, then retries at once). A constant, not a setting: identity is not
 * configurable (AGENTS.md).
 */
export const REFRESH_GRACE_MS = 60_000;

/** The audit row of a refresh answered again (ADR 0419, amended 2026-11-27). */
export const DEVICE_REFRESH_REPLAYED_AUDIT = "deviceSession.refreshReplayed";

const bytes = (text: string) => new TextEncoder().encode(text);

/** The AES-GCM key a refresh token gives: HKDF-SHA256 over it, salted with its session's id. */
async function sealingKey(refreshToken: string, sessionId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", bytes(refreshToken), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytes(sessionId), info: bytes("cos refresh grace v2") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** What a seal is bound to besides its key: the session and the token it rotated past. */
const sealData = (sessionId: string, previousHash: string) =>
  bytes(`${sessionId}\n${previousHash}`);

const toBase64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The answer to a rotation, sealed so only the token it rotated past can open it. */
async function sealSuccessor(
  previous: string,
  previousHash: string,
  sessionId: string,
  answer: IssuedTokens,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sealingKey(previous, sessionId);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: sealData(sessionId, previousHash) },
    key,
    bytes(JSON.stringify(answer)),
  );
  const out = new Uint8Array(iv.length + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), iv.length);
  return toBase64(out);
}

async function openSuccessor(
  previous: string,
  previousHash: string,
  sessionId: string,
  sealed: string,
): Promise<IssuedTokens | null> {
  try {
    const all = fromBase64(sealed);
    const key = await sealingKey(previous, sessionId);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: all.slice(0, 12), additionalData: sealData(sessionId, previousHash) },
      key,
      all.slice(12),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as IssuedTokens;
  } catch {
    return null;
  }
}

interface GraceRow {
  audience: DeviceAudience;
  user_id: string | null;
  customer_id: string | null;
  previous_refresh_hash: string | null;
  previous_rotated_at: string | null;
  successor_sealed: string | null;
  grace_answered_at: string | null;
}

/**
 * The last rotation's answer again, once (ADR 0419, amended 2026-11-27), when all of these hold:
 * - `refreshToken` is the one that rotation rotated past;
 * - within `REFRESH_GRACE_MS` of it;
 * - its answer is unused: neither its access token nor its refresh token has been presented
 *   (either clears the seal);
 * - this session has never been answered again before.
 * Taking it clears the seal and audits the answer. Else null, and the token is treated as before:
 * reuse, which ends the session.
 */
async function takeGraceAnswer(
  db: CrmDb,
  row: GraceRow,
  refreshToken: string,
  hash: string,
  sessionId: string,
  now: Date,
): Promise<IssuedTokens | null> {
  const sealed = row.successor_sealed;
  if (!sealed || !row.previous_rotated_at || row.grace_answered_at) return null;
  if (hash !== row.previous_refresh_hash) return null;
  const since = now.getTime() - Date.parse(row.previous_rotated_at);
  if (!(since >= 0 && since <= REFRESH_GRACE_MS)) return null;
  const answer = await openSuccessor(refreshToken, hash, sessionId, sealed);
  if (!answer) return null;
  // Once: only the request that clears this seal gets the answer.
  const taken = await db.query
    .updateTable("core_device_session")
    .set({ successor_sealed: null, grace_answered_at: now.toISOString() })
    .where("id", "=", sessionId)
    .where("successor_sealed", "=", sealed)
    .where("grace_answered_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!taken) return null;
  await db.batch([
    db.query.insertInto("core_audit").values({
      id: newId("audit"),
      at: now.toISOString(),
      operation: DEVICE_REFRESH_REPLAYED_AUDIT,
      risk: "write",
      actor: row.audience === "staff" ? "human" : "customer",
      user_id: row.audience === "staff" ? row.user_id : row.customer_id,
      origin: JSON.stringify({ surface: "client", sessionId }),
      input: JSON.stringify({ sessionId }),
      result: JSON.stringify({
        answeredAgain: true,
        rotatedAt: row.previous_rotated_at,
        secondsAfter: Math.round(since / 1000),
      }),
      gate_decision: "auto",
      outcome: "ok",
      error: null,
    }),
  ]);
  return answer;
}

/**
 * Rotates a session's tokens. A refresh token used before ends the session; so does one that
 * lost a race with another refresh of the same token. The one exception (ADR 0419, amended
 * 2026-11-27): within `REFRESH_GRACE_MS` of a rotation, while its answer is unused and once in a
 * session's life, the token it rotated past is answered with the same tokens again, for a device
 * whose answer was lost; never a second rotation, and always audited.
 */
export async function refreshDeviceSession(
  db: CrmDb,
  refreshToken: string,
  now: Date,
): Promise<IssuedTokens> {
  const sessionId = sessionIdOf(refreshToken);
  const ended = () => refused("session_ended", "This session has ended: sign in again");
  if (!sessionId) throw refused("token_invalid", "Not a refresh token");
  const read = () =>
    db.query
      .selectFrom("core_device_session")
      .select([
        "id",
        "audience",
        "user_id",
        "customer_id",
        "refresh_hash",
        "used_refresh_hashes",
        "last_used_at",
        "previous_refresh_hash",
        "previous_rotated_at",
        "successor_sealed",
        "grace_answered_at",
      ])
      .where("id", "=", sessionId)
      .executeTakeFirst();
  const row = await read();
  if (!row) throw ended();
  const hash = await tokenHash(refreshToken);
  const again = await takeGraceAnswer(db, row, refreshToken, hash, sessionId, now);
  if (again) return again;
  const used = JSON.parse(row.used_refresh_hashes) as string[];
  if (used.includes(hash)) {
    // A token already rotated past: someone else holds this session. End it for both (and the
    // seal with it).
    await endSession(db, sessionId);
    throw refused("refresh_reused", "This sign-in was used on another device: sign in again");
  }
  if (hash !== row.refresh_hash) throw refused("token_invalid", "Not this session's token");
  if (idle(row.last_used_at, now, await loadDeviceSessionIdleDays(db.query))) {
    await endSession(db, sessionId);
    throw refused("session_idle", "This session was unused too long: sign in again");
  }
  const t = await freshTokens(sessionId, now);
  const answer: IssuedTokens = {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    accessExpiresAt: t.accessExpiresAt,
    sessionId,
  };
  const rotated = await db.query
    .updateTable("core_device_session")
    .set({
      access_hash: t.accessHash,
      access_expires_at: t.accessExpiresAt,
      refresh_hash: t.refreshHash,
      used_refresh_hashes: JSON.stringify([...used, hash].slice(-USED_KEPT)),
      last_used_at: now.toISOString(),
      // The answer again, for this token only, while unused, for REFRESH_GRACE_MS: sealed under
      // it. None once the session has been answered again: the grace is once a session.
      previous_refresh_hash: hash,
      previous_rotated_at: now.toISOString(),
      successor_sealed: row.grace_answered_at
        ? null
        : await sealSuccessor(refreshToken, hash, sessionId, answer),
    })
    .where("id", "=", sessionId)
    .where("refresh_hash", "=", hash)
    .returning("id")
    .executeTakeFirst();
  if (!rotated) {
    // Another refresh with this same token got there first. Its answer is this token's to have
    // again on the grace's terms (the same request sent twice); anything else is the token used
    // twice.
    const latest = await read();
    const same = latest && (await takeGraceAnswer(db, latest, refreshToken, hash, sessionId, now));
    if (same) return same;
    await endSession(db, sessionId);
    throw refused("refresh_reused", "This sign-in was used twice at once: sign in again");
  }
  return answer;
}

/**
 * Who an access token is for, or a refusal saying why it is not accepted. The first use of a
 * rotation's access token clears that rotation's sealed answer (the answer was not lost, so no
 * grace is due): one write per rotation, only while the row it already reads shows the seal.
 */
export async function resolveAccessToken(
  db: CrmDb,
  accessToken: string,
  now: Date,
): Promise<ResolvedDevice> {
  if (!accessToken.startsWith(ACCESS_PREFIX)) throw refused("token_invalid", "Not an access token");
  const row = await db.query
    .selectFrom("core_device_session")
    .select([
      "id",
      "audience",
      "user_id",
      "customer_id",
      "access_expires_at",
      "last_used_at",
      "successor_sealed",
    ])
    .where("access_hash", "=", await tokenHash(accessToken))
    .executeTakeFirst();
  if (!row) throw refused("token_invalid", "This access token is not valid: sign in again");
  if (idle(row.last_used_at, now, await loadDeviceSessionIdleDays(db.query))) {
    await endSession(db, row.id);
    throw refused("session_idle", "This session was unused too long: sign in again");
  }
  if (row.successor_sealed) {
    await db.batch([
      db.query
        .updateTable("core_device_session")
        .set({ successor_sealed: null })
        .where("id", "=", row.id)
        .where("successor_sealed", "is not", null),
    ]);
  }
  if (Date.parse(row.access_expires_at) <= now.getTime()) {
    throw refused("token_expired", "This access token has expired: refresh it");
  }
  const subjectId = (row.audience === "staff" ? row.user_id : row.customer_id) as string;
  return { audience: row.audience, subjectId, sessionId: row.id };
}

/**
 * Clears every sealed answer past its window (the daily maintenance run): one a device never came
 * back for. Each is useless after the window (the grace is refused), and a copy of the database
 * with the previous token could open it until then. Returns how many were cleared.
 */
export async function clearStaleGraceSeals(db: CrmDb, now: Date): Promise<number> {
  const before = new Date(now.getTime() - REFRESH_GRACE_MS).toISOString();
  const cleared = await db.query
    .updateTable("core_device_session")
    .set({ successor_sealed: null })
    .where("successor_sealed", "is not", null)
    .where("previous_rotated_at", "<", before)
    .returning("id")
    .execute();
  return cleared.length;
}

/** The audit row's operation name for a device session ending itself (ADR 0455). */
export const DEVICE_SIGN_OUT_AUDIT = "deviceSession.signOut";

/**
 * Ends the device session a refresh token belongs to, from that token alone (ADR 0455): an
 * account that may call no operation to sign out (a door account) can still end its own session.
 * The token is spent either way. A token that was this session's, current or already rotated
 * past, ends it; any other ends nothing. True when a session ended. Audited as a sign-out.
 */
export async function signOutDeviceSession(
  db: CrmDb,
  refreshToken: string,
  now: Date,
  /** End it only when it is this customer's own session (a sign-in replacing its own). */
  only?: { customerId: string },
): Promise<boolean> {
  const sessionId = sessionIdOf(refreshToken);
  if (!sessionId) return false;
  const row = await db.query
    .selectFrom("core_device_session")
    .select(["id", "audience", "user_id", "customer_id", "refresh_hash", "used_refresh_hashes"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  if (!row) return false;
  if (only && (row.audience !== "customer" || row.customer_id !== only.customerId)) return false;
  const hash = await tokenHash(refreshToken);
  const used = JSON.parse(row.used_refresh_hashes) as string[];
  if (hash !== row.refresh_hash && !used.includes(hash)) return false;
  const at = now.toISOString();
  await db.batch([
    db.query.deleteFrom("core_device_session").where("id", "=", sessionId),
    db.query.insertInto("core_audit").values({
      id: newId("audit"),
      at,
      operation: DEVICE_SIGN_OUT_AUDIT,
      risk: "write",
      actor: row.audience === "staff" ? "human" : "customer",
      user_id: row.audience === "staff" ? row.user_id : row.customer_id,
      origin: JSON.stringify({ surface: "client", sessionId }),
      input: JSON.stringify({ sessionId }),
      result: JSON.stringify({ ended: true }),
      gate_decision: "auto",
      outcome: "ok",
      error: null,
    }),
  ]);
  return true;
}

/** Statements ending every device session of a customer account (disable, delete, merge). */
export function endCustomerDeviceSessions(
  db: Kysely<CoreDatabase>,
  customerIds: readonly string[],
): Compilable[] {
  if (!customerIds.length) return [];
  return [db.deleteFrom("core_device_session").where("customer_id", "in", [...customerIds])];
}
