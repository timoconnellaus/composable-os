// What the host's private calendar feeds share (stage 62 step 1, ADR 0890; the staff feed's
// machine, ADR 0628, made one module both feeds use): the token, its hash, its lookup in constant
// time, and the window a feed shows. Each feed keeps its tokens in its own table
// (`core_staff_feed`, `core_customer_feed`), so a token of one is never looked up on the other's
// route. The route's side (the limits, the headers, the one 404, the writer call) is
// apps/app/src/server/http/calendar-feed.ts.
//
// The token is the only secret (a bearer secret in an address): 32 random bytes, written
// base64url (43 characters), shown once to the person who makes it, stored only as its SHA-256,
// so nothing the host keeps (the database, the audit log, a tool run, a notice) can give it back.

/** A token as written in the address: 32 bytes, base64url, no padding. */
export const FEED_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** How far back a feed reaches. */
export const FEED_DAYS_BACK = 14;
/**
 * How far ahead: the longest horizon a pack's setting may make records for (Rostering's duty
 * horizon is at most 120 days; classes are made 56 days ahead), so one-off records made further
 * ahead than the weekly pattern show too.
 */
export const FEED_DAYS_AHEAD = 120;
/** The most events one fetch answers, soonest first (past the cap, the furthest drop off). */
export const FEED_MAX_EVENTS = 500;

/** The window a feed shows at `now`, in unix seconds: from 14 days back to 120 days ahead. */
export function feedWindow(now: Date): { from: number; to: number } {
  const seconds = Math.floor(now.getTime() / 1000);
  return { from: seconds - FEED_DAYS_BACK * 86_400, to: seconds + FEED_DAYS_AHEAD * 86_400 };
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
export function sameInConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The stored hash of `token` when `lookup` (a read of one feed table by hash) finds it, compared
 * again in constant time; null for a malformed token or one that opens nothing.
 */
export async function lookUpFeedToken<Row extends { token_hash: string }>(
  token: string,
  lookup: (hash: string) => Promise<Row | undefined>,
): Promise<Row | null> {
  if (!FEED_TOKEN_RE.test(token)) return null;
  const hash = await feedTokenHash(token);
  const row = await lookup(hash);
  if (!row || !sameInConstantTime(row.token_hash, hash)) return null;
  return row;
}
