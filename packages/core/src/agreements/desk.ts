// Signing at the desk (stage 44 step 6, decision 22, ADR 0649): a member signs on the business's
// own enrolled tablet, in a session a person on the staff started for them.
//
// Two things together open a session, and neither does anything alone:
//   1. the tablet is an enrolled device of use `signing` (core_device, ADR 0780): its credential
//      alone shows "Enter code" and makes `desk.claim`, and reads nothing;
//   2. a person on the staff with agreements:desk starts a session for one named Person (and, for
//      a parent, the live dependants they sign for) on the device they choose
//      (`agreement.desk.start`). The host answers an 8-character code, single use, good for 2
//      minutes until claimed, kept as its HMAC.
// The tablet's claim binds the session to that device and answers a session token (256 bits, as
// its HMAC) in its own cookie. The token reaches exactly five calls (desk.claim, desk.documents,
// desk.accept, desk.heartbeat, desk.finish), each on that one session and with the device
// credential it was bound to; the desk origin's handler serves nothing else.
//
// Limits the host keeps from the session row, whatever the page does (`openSession`):
//   - idle: 3 minutes since the last activity (reading counts: the page sends desk.heartbeat while
//     the person touches or scrolls; a heartbeat less than 20 seconds after the last one does not
//     extend it);
//   - total: 20 minutes since the claim;
//   - a new claim on the device ends the session open on it.
// A call after either limit is refused and ends the session on the server.
//
// Claims (`claimSession`):
//   - wrong codes: five from one device in a minute lock it for five minutes;
//   - a claim from a device other than the one staff chose ends the session at once, and so does
//     a wrong code typed on that device while the session waits ("a failed claim on the expected
//     device"): staff see it on their screen;
//   - every claim rotates the device's credential; a retry within 60 seconds with the old
//     credential and the code gets the same new credential and the same token.
import type { CoreDatabase } from "@composable-os/db";
import { type Compilable, type CompiledQuery, type Kysely, sql } from "kysely";
import {
  type DeskHost,
  type DeskRequest,
  type ResolvedDevice,
  resolveDevice,
  runNow,
} from "../devices/devices.ts";
import { normaliseCode, secretHash, sessionToken } from "../devices/secret.ts";
import { ForbiddenError, ValidationError } from "../errors.ts";

type Db = Kysely<CoreDatabase>;

/** Unclaimed, a session's code runs out after this long. */
export const CODE_MS = 2 * 60_000;
/** Idle: refused this long after the last activity. */
export const IDLE_MS = 3 * 60_000;
/** Total: refused this long after the claim. */
export const TOTAL_MS = 20 * 60_000;
/** A heartbeat sooner than this after the last one does not extend the session. */
export const HEARTBEAT_MIN_MS = 20_000;
/** Wrong codes: this many in LOCK_WINDOW_MS lock the device for LOCK_MS. */
export const LOCK_TRIES = 5;
export const LOCK_WINDOW_MS = 60_000;
export const LOCK_MS = 5 * 60_000;

export type SessionRow = NonNullable<Awaited<ReturnType<typeof sessionById>>>;

export function sessionById(db: Db, id: string) {
  return db
    .selectFrom("core_agreement_desk_session")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
}

export const parseIds = (text: string): string[] => {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

/** Ends one open session now: its code and token answer nothing again. */
export function endStatement(
  db: Db,
  sessionId: string,
  reason: NonNullable<SessionRow["end_reason"]>,
  now: string,
  claimedDeviceId?: string,
): Compilable {
  return db
    .updateTable("core_agreement_desk_session")
    .set({
      ended_at: now,
      end_reason: reason,
      code_hash: null,
      token_hash: null,
      ...(claimedDeviceId ? { claimed_device_id: claimedDeviceId } : {}),
    })
    .where("id", "=", sessionId)
    .where("ended_at", "is", null);
}

/** The one answer for a session that is not there to use: ended, run out, or never claimed. */
export function sessionEnded(): ForbiddenError {
  return new ForbiddenError("This session has ended. Hand the device back to the desk.", {
    rule: "desk_session_ended",
    httpStatus: 401,
  });
}

/** The device must be one enrolled for desk signing (not a check-in tablet, not a till). */
function requireSigning(resolved: ResolvedDevice): void {
  if (resolved.device.use !== "signing") {
    throw new ForbiddenError("This device is not enrolled for signing at the desk.", {
      rule: "device_use",
    });
  }
}

/** Which limit, if any, a claimed session has passed at `now`. */
export function limitPassed(session: SessionRow, now: string): "idle" | "limit" | null {
  const at = Date.parse(now);
  if (!session.claimed_at) return null;
  if (at - Date.parse(session.claimed_at) >= TOTAL_MS) return "limit";
  if (at - Date.parse(session.last_activity_at ?? session.claimed_at) >= IDLE_MS) return "idle";
  return null;
}

export interface ClaimResult {
  session: SessionRow;
  device: ResolvedDevice["device"];
  statements: Compilable[];
}

/**
 * `desk.claim`: the tablet types the code staff were given. Returns the statements of a claim
 * (or, for a retry within the grace window, none to add), or refuses, after writing what a
 * refusal must (`runNow`): a wrong code counted, a lock-out, the session ended.
 */
export async function claimSession(
  db: Db,
  desk: DeskHost,
  request: DeskRequest,
  typed: string,
  now: string,
): Promise<ClaimResult> {
  const resolved = await resolveDevice(db, desk, request, now, { rotate: true });
  requireSigning(resolved);
  const device = resolved.device;
  const at = Date.parse(now);
  if (device.locked_until && Date.parse(device.locked_until) > at) {
    throw new ForbiddenError(
      "Too many wrong codes on this device. Wait five minutes, then ask the desk for a new code.",
      { rule: "desk_locked", lockedUntil: device.locked_until },
    );
  }
  const code = normaliseCode(typed);
  const hash = await secretHash(desk.secret, "code", code);
  const session = await db
    .selectFrom("core_agreement_desk_session")
    .selectAll()
    .where("code_hash", "=", hash)
    .executeTakeFirst();

  // A retry of this device's own claim within the grace window: the same token again. The token
  // is derived from the credential the claim was made with, so only that browser gets it.
  if (
    session &&
    !session.ended_at &&
    session.claimed_at &&
    session.claimed_device_id === device.id &&
    at - Date.parse(session.claimed_at) <= 60_000 &&
    request.credential
  ) {
    const token = await sessionToken(desk.secret, session.id, request.credential);
    if ((await secretHash(desk.secret, "token", token)) === session.token_hash) {
      request.issue({ token });
      return { session, device, statements: resolved.statements };
    }
  }

  const unclaimed =
    session && !session.ended_at && !session.claimed_at && Date.parse(session.code_expires_at) > at;
  if (!unclaimed) {
    await wrongCode(db, device, session ?? null, now);
    throw new ValidationError(
      "That code is not right, or it has run out. Ask the desk for a new one.",
      {
        rule: "desk_code",
      },
    );
  }
  if (session.device_id !== device.id) {
    // Claimed on a device other than the one staff chose: the session ends, and staff see which.
    await runNow(db, [endStatement(db, session.id, "wrong_device", now, device.id)]);
    throw new ForbiddenError(
      "This code was started for another device. Ask the desk to start again on this one.",
      { rule: "desk_wrong_device" },
    );
  }
  if (!request.credential) throw new ForbiddenError("This device is not enrolled.");
  const token = await sessionToken(desk.secret, session.id, request.credential);
  request.issue({ token });
  return {
    session,
    device,
    statements: [
      // One session per device: a claim ends any other open on it, in the claim's batch.
      db
        .updateTable("core_agreement_desk_session")
        .set({ ended_at: now, end_reason: "replaced", code_hash: null, token_hash: null })
        .where("ended_at", "is", null)
        .where("id", "!=", session.id)
        .where((eb) =>
          eb.or([eb("device_id", "=", device.id), eb("claimed_device_id", "=", device.id)]),
        )
        .where("claimed_at", "is not", null),
      db
        .updateTable("core_agreement_desk_session")
        .set({
          claimed_at: now,
          claimed_device_id: device.id,
          token_hash: await secretHash(desk.secret, "token", token),
          last_activity_at: now,
          last_heartbeat_at: now,
        })
        .where("id", "=", session.id)
        .where("claimed_at", "is", null)
        .where("ended_at", "is", null),
      // The batch fails unless this claim is the one that holds the session at commit: of two
      // claims at once, or a claim racing the session's end, the loser is refused (migration
      // 0858's guard), never answered with a token that matches nothing.
      db.insertInto("core_agreement_desk_guard").values({
        session_id: session.id,
        device_id: device.id,
      }),
      ...resolved.statements,
      db
        .updateTable("core_device")
        .set({ bad_codes: 0, bad_codes_since: null })
        .where("id", "=", device.id),
    ],
  };
}

/**
 * A wrong (or used, or run-out) code on this device: counted, and the lock-out when due. One
 * statement that reads the row's own count (after the review of PR #390: a read then a write let
 * wrong codes sent at once count once), so every wrong code counts whatever else runs.
 */
async function wrongCode(
  db: Db,
  device: ResolvedDevice["device"],
  session: SessionRow | null,
  now: string,
): Promise<void> {
  const at = Date.parse(now);
  const windowStart = new Date(at - LOCK_WINDOW_MS).toISOString();
  const lockEnd = new Date(at + LOCK_MS).toISOString();
  // SQLite evaluates every expression of a SET against the row as it was: `fresh` and `tries`
  // below read the count before this statement.
  const fresh = sql`(bad_codes_since IS NULL OR bad_codes_since < ${windowStart})`;
  const tries = sql`(CASE WHEN ${fresh} THEN 1 ELSE bad_codes + 1 END)`;
  const statements: (Compilable | CompiledQuery)[] = [
    sql`UPDATE core_device SET
        bad_codes = CASE WHEN ${tries} >= ${LOCK_TRIES} THEN 0 ELSE ${tries} END,
        bad_codes_since = CASE WHEN ${tries} >= ${LOCK_TRIES} THEN NULL
          WHEN ${fresh} THEN ${now} ELSE bad_codes_since END,
        locked_until = CASE WHEN ${tries} >= ${LOCK_TRIES} THEN ${lockEnd} ELSE locked_until END
      WHERE id = ${device.id}`.compile(db),
    // A session waiting for this very device ends on a failed claim on it (decision 22).
    db
      .updateTable("core_agreement_desk_session")
      .set({ ended_at: now, end_reason: "failed_claim", code_hash: null, token_hash: null })
      .where("device_id", "=", device.id)
      .where("claimed_at", "is", null)
      .where("ended_at", "is", null),
  ];
  // A code that ran out unclaimed ends its session as such.
  if (session && !session.ended_at && !session.claimed_at) {
    statements.unshift(endStatement(db, session.id, "unclaimed", now));
  }
  await runNow(db, statements);
}

export interface OpenSession {
  session: SessionRow;
  device: ResolvedDevice["device"];
  /** The call's own statements: the device seen, the session's activity. */
  statements: Compilable[];
  /** Whether this call moved the session's last activity to now. */
  active: boolean;
}

/**
 * The session a desk call is for: the token's, on the device it was claimed on, open and within
 * its limits; or refused (ending it on the server when a limit has passed). `activity`: this call
 * counts as activity (`heartbeat`: only 20 seconds or more after the last heartbeat).
 */
export async function openSession(
  db: Db,
  desk: DeskHost,
  request: DeskRequest,
  now: string,
  activity: "activity" | "heartbeat" | "none",
): Promise<OpenSession> {
  const resolved = await resolveDevice(db, desk, request, now);
  requireSigning(resolved);
  if (!request.token || request.token.length > 200) throw sessionEnded();
  const session = await db
    .selectFrom("core_agreement_desk_session")
    .selectAll()
    .where("token_hash", "=", await secretHash(desk.secret, "token", request.token))
    .executeTakeFirst();
  // The same token with another device's credential is refused (and the session is not theirs).
  if (!session || session.ended_at || session.claimed_device_id !== resolved.device.id) {
    throw sessionEnded();
  }
  const passed = limitPassed(session, now);
  if (passed) {
    await runNow(db, [endStatement(db, session.id, passed, now)]);
    throw sessionEnded();
  }
  const statements: Compilable[] = [...resolved.statements];
  const at = Date.parse(now);
  const beat =
    activity === "heartbeat" &&
    at - Date.parse(session.last_heartbeat_at ?? session.claimed_at ?? now) >= HEARTBEAT_MIN_MS;
  if (activity === "activity" || beat) {
    statements.push(
      db
        .updateTable("core_agreement_desk_session")
        .set({ last_activity_at: now, ...(beat ? { last_heartbeat_at: now } : {}) })
        .where("id", "=", session.id)
        .where("ended_at", "is", null),
    );
  }
  return { session, device: resolved.device, statements, active: activity === "activity" || beat };
}

/** When the session is refused next, at the latest: idle or total, whichever is first. */
export function endsAt(session: SessionRow, lastActivity: string): string {
  const claimed = Date.parse(session.claimed_at ?? lastActivity);
  return new Date(Math.min(claimed + TOTAL_MS, Date.parse(lastActivity) + IDLE_MS)).toISOString();
}

/** "s•••@e•••.com": where the copy goes, as the tablet may show it. */
export function maskedAddress(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}•••@${host.slice(0, 1)}•••${tld}`;
}

/** What an acceptance made at the desk says of how it was made: exactly what the records hold. */
export interface DeskEvidence {
  device: string;
  enrolledBy: string;
  /** The day the device was enrolled (UTC). */
  enrolledOn: string;
  startedBy: string;
  /** When the session was started (ISO). */
  startedAt: string;
}

export async function deskEvidence(db: Db, sessionId: string | null): Promise<DeskEvidence | null> {
  if (!sessionId) return null;
  const row = await db
    .selectFrom("core_agreement_desk_session as s")
    .leftJoin("core_device as d", "d.id", "s.claimed_device_id")
    .leftJoin("core_user as e", "e.id", "d.enrolled_by")
    .leftJoin("core_user as u", "u.id", "s.started_by")
    .select([
      "d.name as device",
      "d.enrolled_at",
      "e.name as enrolled_by",
      "u.name as started_by",
      "s.started_at",
    ])
    .where("s.id", "=", sessionId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    device: row.device ?? "a device",
    enrolledBy: row.enrolled_by ?? "an admin",
    enrolledOn: (row.enrolled_at ?? "").slice(0, 10),
    startedBy: row.started_by ?? "a member of staff",
    startedAt: row.started_at,
  };
}

/**
 * "Agreed at the desk on the device enrolled as [name] by [admin] on [date]; session started by
 * [staff] at [time]": never "in person" (the host cannot know who held the device), and never
 * paper. `time` formats the start as the business's local time.
 */
export function deskWords(evidence: DeskEvidence, time: (iso: string) => string): string {
  return (
    `Agreed at the desk on the device enrolled as ${evidence.device} by ${evidence.enrolledBy} ` +
    `on ${evidence.enrolledOn}; session started by ${evidence.startedBy} at ${time(evidence.startedAt)}`
  );
}
