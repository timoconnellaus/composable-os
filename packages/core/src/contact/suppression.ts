// The suppression list (stage 30 step 5, ADR 0675): a salted hash of each address and number that
// asked to stop (a STOP reply to a text; a provider's "unsubscribed" for an email), tied to no
// Person and kept after erase, so it is never sent to again whoever it is entered on. START from
// the number takes its row off. Only hashes: never the address or the number.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { mailboxKey } from "../customers/limits.ts";
import { sha256Hex } from "../digest.ts";

type Db = Kysely<CoreDatabase>;

/** The salt numbers and addresses are hashed with (migration 0911), made once per deployment. */
const SALT = "text_number_salt";

/**
 * The salted hash a value is kept as (a number's caps key, a suppression), never the value. Not a
 * secret against someone who reads the database (numbers are few enough to try): it keeps one
 * deployment's hashes from matching another's.
 */
export async function saltedHash(db: Db, value: string): Promise<string> {
  let row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", SALT)
    .executeTakeFirst();
  if (!row) {
    // Migration 0911 makes it; a database restored without it gets one now, once.
    const salt = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await db
      .insertInto("core_settings")
      .values({ key: SALT, value: JSON.stringify(salt), updated_at: new Date().toISOString() })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
    row = await db
      .selectFrom("core_settings")
      .select("value")
      .where("key", "=", SALT)
      .executeTakeFirstOrThrow();
  }
  let salt = "";
  try {
    salt = String(JSON.parse(row.value));
  } catch {}
  return sha256Hex(`${salt}:${value}`);
}

/**
 * The hash an email address is kept as on the list: the mailbox it reaches (case, a `+tag` and
 * Gmail's dots folded), so one stop covers every spelling of it.
 */
export function addressHash(db: Db, address: string): Promise<string> {
  return saltedHash(db, `email:${mailboxKey(address.trim().toLowerCase())}`);
}

/** Whether the address or number hashed as `hash` is on the list for `channel`. One statement. */
export async function suppressed(
  db: Db,
  channel: "email" | "text",
  hash: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("core_contact_suppression")
    .select("at")
    .where("channel", "=", channel)
    .where("value_hash", "=", hash)
    .executeTakeFirst();
  return row !== undefined;
}

/** Puts a hash on the list (again: the latest moment is kept). */
export async function suppress(
  db: Db,
  channel: "email" | "text",
  hash: string,
  how: "stop_reply" | "provider_unsubscribed",
  at: string,
): Promise<void> {
  await db
    .insertInto("core_contact_suppression")
    .values({ channel, value_hash: hash, how, at })
    .onConflict((oc) => oc.columns(["channel", "value_hash"]).doUpdateSet({ at, how }))
    .execute();
}

/** Takes a hash off the list (START from the number). */
export async function unsuppress(db: Db, channel: "email" | "text", hash: string): Promise<void> {
  await db
    .deleteFrom("core_contact_suppression")
    .where("channel", "=", channel)
    .where("value_hash", "=", hash)
    .execute();
}
