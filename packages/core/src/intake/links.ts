// Personal links (stage 29 step 5, ADR 0723): one named Person's one use of one form, optionally
// about one record (the class they came to), without signing in. The host alone makes them: the
// form-link slot of routine mail (routine-mail/index.ts) makes the link while preparing an email,
// and a token for each email that carries it. Nothing else makes a link or a token.
//
// A token is 32 random bytes (`crypto.getRandomValues`), sent once, in the one email it was made
// for; only its SHA-256 is kept (`core_intake_link_token`), as the stop links' (ADR 0675). There is
// no signing key, so nothing secret is stored and nothing is shared between the runner, which
// writes the email, and the host's door, which takes the answers.
//
// A link is used once, and the database keeps it so: the answer's batch sets `used_at` by the
// link's id alone, and migration 1010's trigger fails the whole batch when it is already set or
// the link has expired. Opening a link (reading its form) uses nothing, so a mail scanner that
// follows every link spends none. An unknown, used, expired or revoked token, a link whose Person
// was erased or whose form no longer takes answers by link, all get one answer (`linkRefused`).
import type { CoreDatabase } from "@composable-os/db";
import { PERSONAL_LINK_PARAM, PERSONAL_LINK_PATH } from "@composable-os/sdk";
import { type Compilable, CompiledQuery, type Kysely } from "kysely";
import { sha256Hex } from "../digest.ts";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { livePersonAfterMerges } from "../visibility/guardians.ts";

type Db = Kysely<CoreDatabase>;

/** What every refused link is told, whatever was wrong with it: nothing about the Person. */
export const LINK_REFUSED_WORDS =
  "This link cannot be used: it may have been used already or have expired";

/** The one refusal for a link that cannot be used now, for any reason. */
export function linkRefused(): OperationError {
  return new OperationError("not_found", LINK_REFUSED_WORDS, { rule: "personal_link" });
}

/** A token as it travels: 43 base64url characters (32 bytes). */
export const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A link the host found live: unused, not expired, its Person live. */
export interface LiveLink {
  id: string;
  personId: string;
  formObject: string;
  formId: string | null;
  recordObject: string | null;
  recordId: string | null;
  expiresAt: string;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

type LinkRow = CoreDatabase["core_intake_link"];

function liveOf(row: LinkRow | undefined, now: string): LiveLink | null {
  if (!row || row.used_at !== null || row.expires_at <= now) return null;
  return {
    id: row.id,
    personId: row.person_id,
    formObject: row.form_object,
    formId: row.form_id,
    recordObject: row.record_object,
    recordId: row.record_id,
    expiresAt: row.expires_at,
  };
}

/** Whether the link's Person is live now (not erased, not in the Trash, not merged away). */
async function personLive(db: Db, link: LiveLink): Promise<boolean> {
  return (await livePersonAfterMerges(db, link.personId)) === link.personId;
}

/**
 * The live link a token names, or null whatever is wrong (not a token, not one the host made,
 * used, expired, its Person gone). The same work whether or not it looks like a token.
 */
export async function liveLinkByToken(db: Db, token: string, now: string) {
  const hash = await sha256Hex(LINK_TOKEN.test(token) ? token : `bad:${token.slice(0, 400)}`);
  const row = await db
    .selectFrom("core_intake_link_token as t")
    .innerJoin("core_intake_link as l", "l.id", "t.link_id")
    .selectAll("l")
    .where("t.token_hash", "=", hash)
    .executeTakeFirst();
  const live = LINK_TOKEN.test(token) ? liveOf(row, now) : null;
  return live && (await personLive(db, live)) ? live : null;
}

/** The live link `id`, or null. For a signed-in customer's app item: whose it is is checked after. */
export async function liveLinkById(db: Db, id: string, now: string) {
  const row = await db
    .selectFrom("core_intake_link")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  const live = liveOf(row, now);
  return live && (await personLive(db, live)) ? live : null;
}

/** What a link is made for. */
export interface LinkFor {
  personId: string;
  formObject: string;
  formId: string;
  recordObject: string;
  recordId: string;
  /** What asked for it: a routine email's kind and the run its chain began with. */
  madeFor: string;
  days: number;
  now: string;
}

/**
 * The link for one Person, form and record, made now if there is none (ADR 0723). Null when one
 * was made before by something else (an earlier email about the same record): a record is asked
 * about once. The same `madeFor` (a retried step) finds its own link, live or not.
 */
export async function ensureLink(
  db: Db,
  want: LinkFor,
): Promise<{ id: string; expiresAt: string; live: boolean } | null> {
  const existing = () =>
    db
      .selectFrom("core_intake_link")
      .select(["id", "made_for", "expires_at", "used_at"])
      .where("form_object", "=", want.formObject)
      .where("form_id", "=", want.formId)
      .where("person_id", "=", want.personId)
      .where("record_object", "=", want.recordObject)
      .where("record_id", "=", want.recordId)
      .executeTakeFirst();
  const found = await existing();
  const answer = (row: { id: string; made_for: string; expires_at: string; used_at: unknown }) =>
    row.made_for === want.madeFor
      ? {
          id: row.id,
          expiresAt: row.expires_at,
          live: row.used_at === null && row.expires_at > want.now,
        }
      : null;
  if (found) return answer(found);
  const expiresAt = new Date(Date.parse(want.now) + want.days * 86_400_000).toISOString();
  const id = newId("intakeLink");
  await db
    .insertInto("core_intake_link")
    .values({
      id,
      person_id: want.personId,
      form_object: want.formObject,
      form_id: want.formId,
      record_object: want.recordObject,
      record_id: want.recordId,
      made_for: want.madeFor,
      expires_at: expiresAt,
      used_at: null,
      submission_id: null,
      created_at: want.now,
    })
    // Two sends about one record at once: the unique index keeps one; the other reads it.
    .onConflict((oc) => oc.doNothing())
    .execute();
  const made = await existing();
  return made ? answer(made) : null;
}

/**
 * Whether the Person was sent a link to this form, about any other record, since `since` (the
 * slot's `once`: feedback at most once a month).
 */
export async function linkedSince(
  db: Db,
  want: Pick<LinkFor, "personId" | "formObject" | "formId" | "recordObject" | "recordId">,
  since: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("core_intake_link")
    .select("id")
    .where("person_id", "=", want.personId)
    .where("created_at", ">", since)
    .where("form_object", "=", want.formObject)
    .where("form_id", "=", want.formId)
    .where((eb) =>
      eb.or([
        eb("record_object", "is", null),
        eb("record_object", "!=", want.recordObject),
        eb("record_id", "!=", want.recordId),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

/** A new token for `linkId`, kept as its hash: good as soon as it is returned. */
export async function linkToken(db: Db, linkId: string, now: string): Promise<string> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .insertInto("core_intake_link_token")
    .values({ token_hash: await sha256Hex(token), link_id: linkId, created_at: now })
    .execute();
  return token;
}

/** A personal link's address on the business's site (`https://gym.example`). */
export function personalLinkUrl(siteOrigin: string, token: string): string {
  const url = new URL(PERSONAL_LINK_PATH, siteOrigin);
  url.searchParams.set(PERSONAL_LINK_PARAM, token);
  return url.toString();
}

/**
 * The statement that uses the link up, for the answer's own batch: by its id alone, so migration
 * 1010's trigger decides a race (a second use, or a use after it expired, fails the batch whole).
 */
export function useLinkStatement(
  db: Db,
  linkId: string,
  submissionId: string,
  now: string,
): Compilable {
  return db
    .updateTable("core_intake_link")
    .set({ used_at: now, submission_id: submissionId })
    .where("id", "=", linkId);
}

/**
 * A merge (person.merge) moves the duplicate's links to the survivor, in the merge's batch, after
 * `merged_into_id` is set (the trigger checks it). A link both had about the same record stays
 * with the duplicate, which is no longer live, so it is used by neither.
 */
export function mergeLinkStatement(survivorId: string, mergedId: string): CompiledQuery {
  return CompiledQuery.raw(
    "UPDATE OR IGNORE core_intake_link SET person_id = ? WHERE person_id = ?",
    [survivorId, mergedId],
  );
}

/** The live links of these People, soonest to expire first (at most `limit`). */
export async function liveLinksOf(
  db: Db,
  personIds: readonly string[],
  now: string,
  limit = 20,
): Promise<LiveLink[]> {
  if (!personIds.length) return [];
  const rows = await db
    .selectFrom("core_intake_link")
    .selectAll()
    .where("person_id", "in", personIds.slice(0, 90))
    .where("used_at", "is", null)
    .where("expires_at", ">", now)
    .orderBy("expires_at")
    .orderBy("id")
    .limit(limit)
    .execute();
  return rows.flatMap((row) => {
    const live = liveOf(row, now);
    return live ? [live] : [];
  });
}

/** Whether a database failure is migration 1010's refusal of a second use, or a late one. */
export function isLinkUsedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("core_intake_link_used");
}

