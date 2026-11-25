// The one-tap stop (stage 30 step 5, ADR 0675). The host alone makes stop links
// (`stopLink(person, channel, scope)`): an opaque token of 32 random bytes naming one Person, one
// channel and one scope, with no expiry, on the business's own site (the client web app's stop
// route, which calls `contact.stop` over the typed client). Only the token's SHA-256 is kept
// (`core_contact_stop_token`), so nothing secret is stored and nothing is shared between the
// runner, which writes a routine email, and the app, which takes the stop. A token can only turn
// that one scope off on that one channel, and `contact.stop` answers the same whether it is good
// or not. Journeys and the inbox use `stopLink`; they make no tokens of their own.
//
// A token's raw value is in the one message it was made for and nowhere else, so each stoppable
// message gets its own token; every one stays good until its Person is erased.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { sha256Hex } from "../digest.ts";
import type { ContactChannel } from "./register.ts";

type Db = Kysely<CoreDatabase>;

/** The route on the business's site a stop link opens (the client web app's stop page). */
export const STOP_PATH = "/stop";
/** The query parameter the token travels in. */
export const STOP_PARAM = "t";

/** A token as it travels: 43 base64url characters (32 bytes). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** What a stop link names. */
export interface StopScope {
  person: string;
  channel: ContactChannel;
  /** A routine kind (`bookings.reminder`), `follow_up` or `news_and_offers`. */
  scope: string;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Makes a token for one Person, channel and scope and keeps its hash: the statement is run
 * here, so the token is good as soon as it is returned. The Person must exist.
 */
export async function stopToken(db: Db, scope: StopScope, now = new Date().toISOString()) {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .insertInto("core_contact_stop_token")
    .values({
      token_hash: await sha256Hex(token),
      person_id: scope.person,
      channel: scope.channel,
      scope: scope.scope,
      created_at: now,
    })
    .execute();
  return token;
}

/** Rows per statement in `stopTokens`: five values each, and D1 binds at most 100. */
const TOKENS_PER_STATEMENT = 18;

/**
 * Makes a token for each of `scopes` and keeps their hashes, in one statement per 18: what a
 * send to many recipients asks for at once (ADR 0678). The tokens, in the order asked. Every
 * Person must exist.
 */
export async function stopTokens(
  db: Db,
  scopes: readonly StopScope[],
  now = new Date().toISOString(),
): Promise<string[]> {
  const tokens = scopes.map(() => base64url(crypto.getRandomValues(new Uint8Array(32))));
  for (let i = 0; i < scopes.length; i += TOKENS_PER_STATEMENT) {
    const rows = await Promise.all(
      scopes.slice(i, i + TOKENS_PER_STATEMENT).map(async (scope, j) => ({
        token_hash: await sha256Hex(tokens[i + j] as string),
        person_id: scope.person,
        channel: scope.channel,
        scope: scope.scope,
        created_at: now,
      })),
    );
    await db.insertInto("core_contact_stop_token").values(rows).execute();
  }
  return tokens;
}

/**
 * Takes back tokens made for a message that then did not go (ADR 0678): their rows are deleted,
 * so a refused, failed or retried send leaves none behind.
 */
export async function dropStopTokens(db: Db, tokens: readonly string[]): Promise<void> {
  const hashes = await Promise.all(tokens.map((t) => sha256Hex(t)));
  for (let i = 0; i < hashes.length; i += 90) {
    await db
      .deleteFrom("core_contact_stop_token")
      .where("token_hash", "in", hashes.slice(i, i + 90))
      .execute();
  }
}

/** The stop link at a token on the business's site (`https://gym.example`). */
export function stopUrl(siteOrigin: string, token: string): string {
  const url = new URL(STOP_PATH, siteOrigin);
  url.searchParams.set(STOP_PARAM, token);
  return url.toString();
}

/**
 * A new stop link for one Person, channel and scope on the business's site, or null when there
 * is no site. The host's alone: every stoppable message carries one.
 */
export async function stopLink(
  db: Db,
  siteOrigin: string | null,
  scope: StopScope,
  now?: string,
): Promise<string | null> {
  if (!siteOrigin) return null;
  return stopUrl(siteOrigin, await stopToken(db, scope, now));
}

/** What a token names, or null when it is not one the host made (whatever is wrong with it). */
export async function readStopToken(db: Db, token: string): Promise<StopScope | null> {
  // The same work whether or not it looks like a token, so how long it takes says little.
  const hash = await sha256Hex(TOKEN.test(token) ? token : `bad:${token.slice(0, 400)}`);
  const row = await db
    .selectFrom("core_contact_stop_token")
    .select(["person_id", "channel", "scope"])
    .where("token_hash", "=", hash)
    .executeTakeFirst();
  if (!row || !TOKEN.test(token)) return null;
  return { person: row.person_id, channel: row.channel, scope: row.scope };
}

/** The token in a stop link on `siteOrigin`'s stop route, or null when the link is not one. */
export function tokenOfLink(link: string, siteOrigin: string | null): string | null {
  if (!siteOrigin) return null;
  try {
    const url = new URL(link);
    if (url.origin !== siteOrigin || url.pathname !== STOP_PATH || url.hash) return null;
    const token = url.searchParams.get(STOP_PARAM) ?? "";
    return TOKEN.test(token) && url.search === `?${STOP_PARAM}=${token}` ? token : null;
  } catch {
    return null;
  }
}
