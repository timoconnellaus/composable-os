// The one-tap stop (stage 30 step 5, ADR 0675). The host alone makes stop links
// (`stopLink(person, channel, scope)`): a token naming one Person, one channel and one scope,
// signed with the host's key, with no expiry, on the business's own site (the client web app's
// stop route, which calls `contact.stop` over the typed client). A token can only turn that one
// scope off on that one channel, and `contact.stop` answers the same whether it is good or not.
// Journeys and the inbox use `stopLink`; they make no tokens of their own.
//
// The key is made once per deployment by migration 0913 (`contact_stop_key` in core_settings) and
// read only here. It is not an env secret: the runner, which writes a routine email, and the app,
// which takes the stop, share no secret today (ADR 0675 says why, and how it moves to one).
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely } from "kysely";
import { CONTACT_CHANNELS, type ContactChannel, isKindScope, isPurposeScope } from "./register.ts";

type Db = Kysely<CoreDatabase>;

/** The route on the business's site a stop link opens (the client web app's stop page). */
export const STOP_PATH = "/stop";
/** The query parameter the token travels in. */
export const STOP_PARAM = "t";

const KEY_SETTING = "contact_stop_key";
const TOKEN = /^v1\.([A-Za-z0-9_-]{8,200})\.([A-Za-z0-9_-]{43})$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function fromBase64url(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Equal strings, compared in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const keys = new Map<string, Promise<CryptoKey>>();

/** The host's signing key, or null when the database has none (a restore without migration 0913). */
async function stopKey(db: Db): Promise<CryptoKey | null> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", KEY_SETTING)
    .executeTakeFirst();
  let hex = "";
  try {
    hex = row ? String(JSON.parse(row.value)) : "";
  } catch {}
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  let key = keys.get(hex);
  if (!key) {
    const raw = Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
    key = crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keys.set(hex, key);
  }
  return key;
}

const payloadOf = (s: StopScope) => `${s.person}\n${s.channel}\n${s.scope}`;

async function sign(key: CryptoKey, payload: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

/** A stop token for one Person, channel and scope, or null when the host has no key. */
export async function stopToken(db: Db, scope: StopScope): Promise<string | null> {
  const key = await stopKey(db);
  if (!key) return null;
  const payload = payloadOf(scope);
  return `v1.${base64url(encoder.encode(payload))}.${await sign(key, payload)}`;
}

/**
 * The stop link for one Person, channel and scope on the business's site (`https://gym.example`),
 * or null when there is no site or key. The host's alone: every stoppable message carries one.
 */
export async function stopLink(
  db: Db,
  siteOrigin: string | null,
  scope: StopScope,
): Promise<string | null> {
  if (!siteOrigin) return null;
  const token = await stopToken(db, scope);
  if (!token) return null;
  const url = new URL(STOP_PATH, siteOrigin);
  url.searchParams.set(STOP_PARAM, token);
  return url.toString();
}

/** What a token names, or null when it is not one the host signed (whatever is wrong with it). */
export async function readStopToken(db: Db, token: string): Promise<StopScope | null> {
  const match = TOKEN.exec(token);
  const key = await stopKey(db);
  // The same work whether or not the token parses, so how long it takes says little.
  const bytes = match ? fromBase64url(match[1] as string) : null;
  const payload = bytes ? decoder.decode(bytes) : "";
  const expected = key ? await sign(key, payload) : "";
  if (!match || !key || !bytes || !sameText(expected, match[2] as string)) return null;
  const [person, channel, scope, ...rest] = payload.split("\n");
  if (rest.length || !person || !channel || !scope) return null;
  if (!(CONTACT_CHANNELS as readonly string[]).includes(channel)) return null;
  if (!isPurposeScope(scope) && !isKindScope(scope)) return null;
  return { person, channel: channel as ContactChannel, scope };
}
