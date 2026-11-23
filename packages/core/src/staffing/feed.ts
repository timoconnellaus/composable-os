// A staff member's private calendar feed (stage 45 step 5, ADR 0628): their own shifts, as a
// calendar app polls them with no sign-in, at `GET /api/v1/staffing/feed/<token>.ics`.
//
// The token is the only secret (a bearer secret in an address):
// - 32 random bytes, written base64url (43 characters), made by `staffing.feed.rotate` for the
//   person themselves and shown to them once; stored only as its SHA-256 (`core_staff_feed`), so
//   nothing the host keeps (the database, the audit log, a tool run, a notice) can give it back.
// - Looked up by its hash, and the stored hash compared again in constant time.
// - One per account: a new one replaces the old. Revoked by the person, by an admin, when the
//   account is deactivated, and when a change of role, pack role or grants takes away the tool
//   that made it (`feedRevocations`, in that change's own batch).
// - It answers only while its account is an active person who may still call the tool that made
//   it; otherwise, and for a made-up, rotated or revoked token, exactly as a missing path does.
//
// What it shows (`readStaffFeed`): that account's own live shifts from 14 days back to 120 days
// ahead (soonest first: past the cap, the furthest drop off), each its kind of work (a class
// type's name, a duty's), its place, its start and end. Never when its record last changed, which
// other writes (a member's booking) could move. Nothing else: no title a business typed on a class (which could name
// a member), no notes, no other person's name, no class list, bookings or places, nothing of
// unavailability, offers or pay. A cancelled shift, one in the Trash and one now someone else's
// hold no time claim, so they drop out.
//
// Cost: read from the time claims by account and end (`core_staff_time_account`), so a request
// reads the account's claims that end after the window opens (never its history), at most
// `FEED_MAX_SHIFTS` shifts, then each object's rows by id, their kinds' and places' names.
import type { CoreDatabase } from "@composable-os/db";
import { type Compilable, CompiledQuery, type Kysely, sql } from "kysely";
import { objectTableOf, refreshSchemaRegistry } from "../extensions/schema.ts";
import { resolveExtensionOperation } from "../extensions/tools.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import {
  availablePackRoles,
  type HeldPackRole,
  loadStaffRights,
  type StaffRights,
  staffMayCall,
} from "../pack-roles.ts";
import type { Role } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import { isGrantActive, loadSupportGrant } from "../support.ts";
import { kindObjectOf } from "./kinds.ts";
import { titles } from "./week.ts";

/** The feed's address, before the token: the host's HTTP surface's version, outside Access's sign-in. */
export const FEED_PATH_PREFIX = "/api/v1/staffing/feed/";
/** A token as written in the address: 32 bytes, base64url, no padding. */
export const FEED_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** How far back the feed reaches (the spec's 14 days). */
export const FEED_DAYS_BACK = 14;
/**
 * How far ahead: the longest horizon a pack's setting may make shifts for (Rostering's duty
 * horizon is at most 120 days; classes are made 56 days ahead), so one-off shifts made further
 * ahead than the weekly pattern show too.
 */
export const FEED_DAYS_AHEAD = 120;
/** The most shifts one fetch answers, soonest first. */
export const FEED_MAX_SHIFTS = 500;

/** The feed's address for a token: the path; the screen puts the host's own origin before it. */
export function feedPath(token: string): string {
  return `${FEED_PATH_PREFIX}${token}.ics`;
}

/** A new token: 32 random bytes, base64url. */
export function newFeedToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 of the token, lowercase hex: all the host keeps of it. */
export async function feedTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Two strings of the same length compared in time that does not depend on where they differ. */
function sameInConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** What an account may hold after a change of its role, pack role or grants (or as it is). */
export interface AccessAfter {
  role?: Role;
  /** The pack role it will hold (`<pack>.<role>`), or null for none. */
  packRole?: string | null;
  grants?: readonly string[];
}

/**
 * Whether `account` (an active person) may call `tool` (an extension tool's operation name), as it
 * holds now or as `after` says it will. An installed, active, shipped pack's tool only.
 */
export async function mayHoldFeed(
  db: Kysely<CoreDatabase>,
  account: string,
  tool: string,
  after: AccessAfter = {},
): Promise<boolean> {
  const user = await db
    .selectFrom("core_user")
    .select(["role", "kind", "deactivated_at", "support_grant_id"])
    .where("id", "=", account)
    .executeTakeFirst();
  if (!user || user.kind !== "human" || user.deactivated_at) return false;
  // A support user (ADR 0212) holds what it holds only while its grant is approved and unexpired,
  // as at sign-in on every request.
  if (user.support_grant_id) {
    if (!isGrantActive(await loadSupportGrant(db, user.support_grant_id))) return false;
  }
  const extension = /^x\.([a-z][a-z0-9]*)\./.exec(tool)?.[1];
  if (!extension) return false;
  const installed = await db
    .selectFrom("core_extensions")
    .select(["status", "source"])
    .where("id", "=", extension)
    .executeTakeFirst();
  if (installed?.status !== "active" || installed.source !== "shipped") return false;
  const op = await resolveExtensionOperation(db, tool);
  if (!op) return false;
  // A person's own call (the tool's actors allow one), by what the account holds.
  if (op.actors && !op.actors.includes("human")) return false;
  const now = await loadStaffRights(db, account);
  let packRole: HeldPackRole | null = now.packRole;
  if (after.packRole !== undefined) {
    const name = after.packRole;
    packRole =
      name === null
        ? null
        : ((await availablePackRoles(db)).find((r) => r.name === name) ??
          // Fail closed: a role that cannot be found holds nothing.
          Object.freeze({ name, extension: "", label: name, permissions: [], read: [] }));
  }
  const rights: StaffRights = { packRole, grants: after.grants ?? now.grants };
  return staffMayCall({ role: after.role ?? (user.role as Role) }, rights, op, {});
}

/**
 * The statement revoking `account`'s feed when what it will hold after a change (`after`) no
 * longer lets it call the tool that made the feed; none when it still may, or it has no feed.
 * Written in the change's own batch, so the address is dead before anyone could use it again.
 */
export async function feedRevocations(
  db: Kysely<CoreDatabase>,
  account: string,
  after: AccessAfter,
): Promise<(Compilable | CompiledQuery)[]> {
  const row = await db
    .selectFrom("core_staff_feed")
    .select(["tool"])
    .where("account_id", "=", account)
    .executeTakeFirst();
  // A feed made (or rotated by another tool) after this read fails the change whole, so a rotate
  // racing it never leaves a feed the change would have revoked (the review of PR #295).
  const guard = CompiledQuery.raw(
    "INSERT INTO core_staff_guard (expected, actual) SELECT ?, count(*) FROM core_staff_feed WHERE account_id = ? AND tool IS ?",
    [row ? 1 : 0, account, row?.tool ?? null],
  );
  if (!row) {
    // No feed now: one made meanwhile is refused by the guard (the tool is null, so count 0 only
    // while there is none).
    return [
      CompiledQuery.raw(
        "INSERT INTO core_staff_guard (expected, actual) SELECT 0, count(*) FROM core_staff_feed WHERE account_id = ?",
        [account],
      ),
    ];
  }
  if (await mayHoldFeed(db, account, row.tool, after)) return [guard];
  return [guard, revokeFeed(db, account)];
}

/**
 * A guard the rotate writes before its row (the review of PR #295): the account as read
 * (active, its role, pack role and grants) must be what it is when the batch commits, so a rotate
 * racing a deactivation or a change of what the account holds fails whole rather than leaving a
 * feed the change would have revoked.
 */
export async function feedAccessGuard(
  db: Kysely<CoreDatabase>,
  account: string,
): Promise<CompiledQuery> {
  const user = await db
    .selectFrom("core_user")
    .select(["role", "pack_role", "granted_permissions", "support_grant_id"])
    .where("id", "=", account)
    .where("deactivated_at", "is", null)
    .executeTakeFirst();
  return CompiledQuery.raw(
    "INSERT INTO core_staff_guard (expected, actual) SELECT 1, count(*) FROM core_user WHERE id = ? AND deactivated_at IS NULL AND role IS ? AND pack_role IS ? AND granted_permissions IS ? AND support_grant_id IS ?",
    [
      account,
      user?.role ?? "__gone__",
      user?.pack_role ?? null,
      user?.granted_permissions ?? null,
      user?.support_grant_id ?? null,
    ],
  );
}

/** The statement deleting `account`'s feed (its address then answers as a missing path). */
export function revokeFeed(db: Kysely<CoreDatabase>, account: string): Compilable {
  return db.deleteFrom("core_staff_feed").where("account_id", "=", account);
}

/** One shift as the feed shows it. */
export interface FeedShift {
  /** The shift's object and record: its event's UID, stable across every change. */
  object: string;
  id: string;
  /** Its kind of work (a class type, a duty), or its object's label when it has none. */
  title: string;
  place: string | null;
  startsAt: string;
  endsAt: string;
}

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = Kysely<any>;

const column = (object: ObjectDefinition, field: string | undefined) =>
  (field && object.fields.find((f) => f.name === field)?.column) || null;
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/**
 * The shifts the feed of `token` shows at `now`, or null when the token opens nothing (unknown,
 * rotated, revoked, malformed) or its account may no longer have one (deactivated, the pack's
 * permission gone, the pack not installed). Every null is the same answer to the caller.
 */
export async function readStaffFeed(
  db: Kysely<CoreDatabase>,
  token: string,
  now: Date,
): Promise<{ account: string; shifts: FeedShift[] } | null> {
  if (!FEED_TOKEN_RE.test(token)) return null;
  const hash = await feedTokenHash(token);
  const row = await db
    .selectFrom("core_staff_feed")
    .select(["account_id", "token_hash", "tool"])
    .where("token_hash", "=", hash)
    .executeTakeFirst();
  if (!row || !sameInConstantTime(row.token_hash, hash)) return null;
  if (!(await mayHoldFeed(db, row.account_id, row.tool))) return null;
  // The staffed objects' definitions (classes, duty shifts), as every invocation loads them.
  await refreshSchemaRegistry(db);
  return { account: row.account_id, shifts: await feedShifts(db, row.account_id, now) };
}

/** `account`'s live shifts in the feed's window, soonest first: a bounded read. */
export async function feedShifts(
  db: Kysely<CoreDatabase>,
  account: string,
  now: Date,
): Promise<FeedShift[]> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const from = nowSeconds - FEED_DAYS_BACK * 86_400;
  const to = nowSeconds + FEED_DAYS_AHEAD * 86_400;
  // The claims: one per live, covered shift of the account (ADR 0621), by account and end.
  const claims = await db
    .selectFrom("core_staff_time")
    .select(["object_type", "record_id", "starts", "ends"])
    .where("account_id", "=", account)
    .where("ends", ">", from)
    .where("starts", "<", to)
    .orderBy("starts")
    .orderBy("record_id")
    .limit(FEED_MAX_SHIFTS)
    .execute();
  const out: FeedShift[] = [];
  const byObject = new Map<string, typeof claims>();
  for (const c of claims) byObject.set(c.object_type, [...(byObject.get(c.object_type) ?? []), c]);
  for (const [objectName, rows] of byObject) {
    const object = getObject(objectName);
    const def = object?.staffed;
    const table = objectTableOf(objectName);
    const state = object ? column(object, object.states?.field) : null;
    if (!object || !def || !table || !state) continue;
    const kindCol = column(object, def.kind);
    const [placeField, placeOf] = (def.place ?? "").split(".") as [string, string | undefined];
    const placeCol = def.place ? column(object, placeField) : null;
    const records = await sql<{
      id: string;
      kind: string | null;
      place: string | null;
    }>`SELECT id, ${kindCol ? sql.ref(kindCol) : sql`NULL`} AS kind,
        ${placeCol ? sql.ref(placeCol) : sql`NULL`} AS place
      FROM ${sql.table(table)}
      WHERE id IN ${jsonList(rows.map((r) => r.record_id))}
        AND deleted_at IS NULL
        AND ${sql.ref(state)} IN (${sql.join(def.live.map((s) => sql`${s}`))})`.execute(
      db as AnyDb,
    );
    const byId = new Map(records.rows.map((r) => [r.id, r]));
    const kindObject = kindObjectOf(object);
    const kindNames = kindObject
      ? await titles(
          { db },
          kindObject,
          records.rows.map((r) => r.kind).filter((k): k is string => !!k),
        )
      : new Map<string, string>();
    const placeTarget = placeOf
      ? object.fields.find((f) => f.name === placeField)?.options?.to
      : undefined;
    const placeNames =
      placeTarget && placeOf
        ? await titles(
            { db },
            placeTarget,
            records.rows.map((r) => r.place).filter((p): p is string => !!p),
            placeOf,
          )
        : new Map<string, string>();
    for (const claim of rows) {
      const r = byId.get(claim.record_id);
      if (!r) continue;
      out.push({
        object: objectName,
        id: r.id,
        title: (r.kind ? kindNames.get(r.kind) : undefined) || object.label,
        place: placeOf ? (r.place ? (placeNames.get(r.place) ?? null) : null) : text(r.place),
        // The claim's instants are the shift's own (the claim is written from the row).
        startsAt: new Date(claim.starts * 1000).toISOString(),
        endsAt: new Date(claim.ends * 1000).toISOString(),
      });
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
}
