// Identifying a person at a check-in tablet (stage 51 step 3, ADR 0783). Host code, never an
// operation: a device tool (Bookings' `doorNow`, step 4) calls it, and nothing it returns reaches
// the page but what that tool's output declares. It answers a Person id to host code only.
//
// Three ways in:
// - an app code: `<code id>.<8 digits>`, this 30-second step's value or the one before, from a
//   code whose sign-in is still live, whose account is still the Person's (or, for a dependant's
//   code, whose guardian's link is still live);
// - a card: its fixed code, compared by HMAC, while not revoked;
// - a full name and a PIN: the name compared case-folded, accents folded and spaces normalised
//   (the duplicate rules' name key, ADR 0247) against the Person's name as their record lists it
//   (their given and family names, unless staff gave them another display name), the PIN against
//   its slow hash; exactly one Person matching both.
// A Person in the Trash (or merged away) is never found. Every miss answers the same `not_found`.
//
// Lock-outs (core_identify_lockout, per device, never per Person):
// - five failed name-and-PIN tries from one device in a minute lock name entry there for five
//   minutes;
// - twenty unknown codes from one device in a minute lock code entry there for a minute;
// - ten wrong PINs for one Person in a day disable that PIN until the member sets it again.
// A locked entry answers `locked` without checking anything.
//
// The counters are written at once, not in the calling tool's batch: a failed try counts even
// when the tool then fails, and the calling tool is a read. Nothing typed is written anywhere.
//
// Cost: an app code is one read of the code, its sign-in and its account, one of the idle setting,
// and one of the link for a dependant's code; a card one read; a name at most `NAME_CANDIDATES`
// People with PINs by the indexed name key. Each try writes at most two rows.
import type { CoreDatabase } from "@composable-os/db";
import { type Kysely, sql } from "kysely";
import { personNameKey } from "../duplicates/normalise.ts";
import { loadDeviceSessionIdleDays } from "../http/tokens.ts";
import { fromBase64url } from "../records/stream.ts";
import { isLiveDependant } from "../visibility/guardians.ts";
import {
  appCodeStep,
  appCodeValue,
  normaliseCardCode,
  type PersonCodeKeys,
  parseAppPayload,
  pinHash,
  sameInConstantTime,
} from "./keys.ts";

/** What a tablet sends. */
export type IdentifyInput = { code: string } | { name: string; pin: string };

export type Identified =
  | {
      outcome: "found";
      personId: string;
      via: "app" | "card" | "pin";
      /**
       * The Person's own app code: their live dependants' bookings may be shown too. False for a
       * card, a PIN and a dependant's code shown on a guardian's app (ADR 0783).
       */
      family: boolean;
    }
  | { outcome: "not_found" }
  | { outcome: "locked"; entry: "name" | "code" };

/** Failed name-and-PIN tries from one device in a minute before name entry locks. */
export const NAME_TRIES_PER_MINUTE = 5;
/** How long name entry stays locked on that device. */
export const NAME_LOCK_MS = 5 * 60_000;
/** Unknown codes from one device in a minute before code entry locks. */
export const CODE_TRIES_PER_MINUTE = 20;
export const CODE_LOCK_MS = 60_000;
/** Wrong PINs for one Person in a day before the PIN is disabled. */
export const PIN_TRIES_PER_DAY = 10;
/** The most People with a PIN one name is checked against. */
export const NAME_CANDIDATES = 5;

const WINDOW_MS = 60_000;
const DAY_MS = 86_400_000;

const NOT_FOUND = { outcome: "not_found" } as const;

/**
 * Identifies who is at the tablet `deviceId`. `deviceId` is the enrolled device's id, from its
 * verified credential, never from input.
 */
export async function identifyPerson(
  db: Kysely<CoreDatabase>,
  keys: PersonCodeKeys,
  at: { deviceId: string; now: Date },
  input: IdentifyInput,
): Promise<Identified> {
  const entry = "code" in input ? "code" : "name";
  if (await locked(db, at, entry)) return { outcome: "locked", entry };
  const found =
    "code" in input
      ? await byCode(db, keys, at.now, input.code)
      : await byNameAndPin(db, keys, at.now, input.name, input.pin);
  if (!found) {
    await countFailure(db, at, entry);
    return NOT_FOUND;
  }
  return found;
}

async function locked(
  db: Kysely<CoreDatabase>,
  at: { deviceId: string; now: Date },
  entry: "name" | "code",
): Promise<boolean> {
  const row = await db
    .selectFrom("core_identify_lockout")
    .select("locked_until")
    .where("device_id", "=", at.deviceId)
    .where("entry", "=", entry)
    .executeTakeFirst();
  return Boolean(row?.locked_until && row.locked_until > at.now.toISOString());
}

/** One failed try on the device: a minute's window, locking the entry at its limit. */
async function countFailure(
  db: Kysely<CoreDatabase>,
  at: { deviceId: string; now: Date },
  entry: "name" | "code",
): Promise<void> {
  const now = at.now.toISOString();
  const windowOpen = new Date(at.now.getTime() - WINDOW_MS).toISOString();
  const limit = entry === "name" ? NAME_TRIES_PER_MINUTE : CODE_TRIES_PER_MINUTE;
  const until = new Date(at.now.getTime() + (entry === "name" ? NAME_LOCK_MS : CODE_LOCK_MS));
  // Every SET reads the row as it was: a window older than a minute starts again at one.
  const failures = sql`CASE WHEN window_started_at <= ${windowOpen} THEN 1 ELSE failures + 1 END`;
  await sql`INSERT INTO core_identify_lockout (device_id, entry, window_started_at, failures, locked_until)
    VALUES (${at.deviceId}, ${entry}, ${now}, 1, ${limit <= 1 ? until.toISOString() : null})
    ON CONFLICT (device_id, entry) DO UPDATE SET
      locked_until = CASE WHEN ${failures} >= ${limit} THEN ${until.toISOString()} ELSE locked_until END,
      failures = ${failures},
      window_started_at = CASE WHEN window_started_at <= ${windowOpen} THEN ${now} ELSE window_started_at END`.execute(
    db,
  );
}

async function byCode(
  db: Kysely<CoreDatabase>,
  keys: PersonCodeKeys,
  now: Date,
  code: string,
): Promise<Identified | null> {
  const app = parseAppPayload(code);
  if (app) return byAppCode(db, keys, now, app);
  const normalised = normaliseCardCode(code);
  if (normalised.length < 8 || normalised.length > 128) return null;
  const row = await db
    .selectFrom("core_person_code as c")
    .innerJoin("core_person as p", "p.id", "c.person_id")
    .select(["c.id", "c.person_id"])
    .where("c.kind", "=", "card")
    .where("c.code_hmac", "=", await keys.cardHmac(normalised))
    .where("c.revoked_at", "is", null)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  await used(db, row.id, now);
  return { outcome: "found", personId: row.person_id, via: "card", family: false };
}

async function byAppCode(
  db: Kysely<CoreDatabase>,
  keys: PersonCodeKeys,
  now: Date,
  app: { codeId: string; value: string },
): Promise<Identified | null> {
  // The code, its Person live, and its sign-in still live and still its account's.
  const row = await db
    .selectFrom("core_person_code as c")
    .innerJoin("core_person as p", "p.id", "c.person_id")
    .leftJoin("core_device_session as d", "d.id", "c.device_session_id")
    .leftJoin("core_customer_session as s", "s.id", "c.customer_session_id")
    .innerJoin("core_customer as a", (join) =>
      join.on((eb) =>
        eb.or([eb("a.id", "=", eb.ref("d.customer_id")), eb("a.id", "=", eb.ref("s.customer_id"))]),
      ),
    )
    .select([
      "c.id",
      "c.person_id",
      "c.guardian_id",
      "c.secret_enc",
      "a.person_id as account_person_id",
      "a.status",
      "a.link_state",
      "d.last_used_at as device_used_at",
      "s.expires_at as session_expires_at",
    ])
    .where("c.id", "=", app.codeId)
    .where("c.kind", "=", "app")
    .where("c.revoked_at", "is", null)
    .where("p.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row?.secret_enc) return null;
  if (row.status !== "active" || row.link_state !== "linked") return null;
  // Whose sign-in it is: the Person's own, or, for a dependant's code, their guardian's.
  if (row.account_person_id !== (row.guardian_id ?? row.person_id)) return null;
  if (row.session_expires_at !== null && expiryMs(row.session_expires_at) <= now.getTime()) {
    return null;
  }
  if (row.device_used_at !== null) {
    const idleDays = await loadDeviceSessionIdleDays(db);
    if (Date.parse(row.device_used_at) + idleDays * DAY_MS < now.getTime()) return null;
  }
  if (row.guardian_id && !(await isLiveDependant(db, row.guardian_id, row.person_id))) return null;
  let secret: Uint8Array;
  try {
    secret = await keys.decrypt(row.secret_enc);
  } catch {
    // Sealed under another auth secret: the code was made before it changed.
    return null;
  }
  const step = appCodeStep(now);
  let match = false;
  for (const s of [step, step - 1]) {
    if (sameInConstantTime(await appCodeValue(secret, s), app.value)) match = true;
  }
  if (!match) return null;
  await used(db, row.id, now);
  return {
    outcome: "found",
    personId: row.person_id,
    via: "app",
    family: row.guardian_id === null,
  };
}

/** A Better Auth session's expiry as stored (an ISO date, or epoch milliseconds). */
function expiryMs(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const text = String(value);
  return /^\d+$/.test(text) ? Number(text) : Date.parse(text);
}

async function used(db: Kysely<CoreDatabase>, codeId: string, now: Date): Promise<void> {
  await db
    .updateTable("core_person_code")
    .set({ last_used_at: now.toISOString() })
    .where("id", "=", codeId)
    .execute();
}

async function byNameAndPin(
  db: Kysely<CoreDatabase>,
  keys: PersonCodeKeys,
  now: Date,
  name: string,
  pin: string,
): Promise<Identified | null> {
  const key = personNameKey(name);
  if (!key || !/^\d{4}$/.test(pin)) return null;
  // People with a PIN whose name, as their record lists it, has the same key (indexed).
  const named = await db
    .selectFrom("core_person as p")
    .innerJoin("core_person_pin as n", "n.person_id", "p.id")
    .select(["p.id", "n.hash", "n.salt", "n.iterations"])
    .where("p.name_key", "=", key)
    .where("p.deleted_at", "is", null)
    .where("n.disabled_at", "is", null)
    .orderBy("p.id")
    .limit(NAME_CANDIDATES)
    .execute();
  if (!named.length) return null;
  const matched: string[] = [];
  const wrong: string[] = [];
  for (const row of named) {
    const hash = await pinHash(keys, pin, fromBase64url(row.salt), row.iterations);
    (sameInConstantTime(hash, row.hash) ? matched : wrong).push(row.id);
  }
  const at = now.toISOString();
  if (matched.length === 1) {
    await db
      .updateTable("core_person_pin")
      .set({ failed_count: 0, failed_since: null })
      .where("person_id", "=", matched[0] as string)
      .execute();
    return { outcome: "found", personId: matched[0] as string, via: "pin", family: false };
  }
  // Two People of the same name with the same PIN: neither is found, and neither PIN was wrong.
  if (!matched.length && wrong.length) {
    const dayOpen = new Date(now.getTime() - DAY_MS).toISOString();
    const fresh = sql<boolean>`failed_since IS NULL OR failed_since <= ${dayOpen}`;
    const count = sql<number>`CASE WHEN ${fresh} THEN 1 ELSE failed_count + 1 END`;
    await db
      .updateTable("core_person_pin")
      .set({
        disabled_at: sql`CASE WHEN ${count} >= ${PIN_TRIES_PER_DAY} THEN ${at} ELSE disabled_at END`,
        failed_count: count,
        failed_since: sql`CASE WHEN ${fresh} THEN ${at} ELSE failed_since END`,
      })
      .where("person_id", "in", wrong)
      .where("disabled_at", "is", null)
      .execute();
  }
  return null;
}
