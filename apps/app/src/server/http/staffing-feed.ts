// A staff member's private calendar feed (stage 45 step 5, ADR 0628): their own shifts as an
// iCalendar file a calendar app subscribes to and polls with no sign-in.
//
//   GET /api/v1/staffing/feed/<token>.ics    (HEAD too; offered as webcal:// by the screens)
//
// The token in the address is the only credential (a bearer secret): 32 random bytes, which the
// host keeps only as a hash (`core_staff_feed`). The path sits under the HTTP surface's
// `/api/v1/*`, which Cloudflare Access bypasses (src/server/access-layout.ts): a calendar app
// cannot sign in. It is served here, before the surface, and nothing else is: any other path
// under `/api/v1/staffing/feed/` is answered as the surface answers a missing route.
//
// What holds here:
// - A made-up, malformed, rotated or revoked token, another person's revoked one, and a token of
//   a deactivated account or one no longer holding the pack's permission all get one 404, with
//   the body of the surface's own for a missing route: nobody learns which tokens exist or whose
//   they are.
// - Limited per client address (hashed, before anything is looked up) and per token
//   (`STAFF_FEED_ADDRESS_RATE_LIMIT`, `STAFF_FEED_RATE_LIMIT`): over either, 429 with Retry-After.
// - The token is never logged, audited, stored or put in an error by this code: the only log line
//   names the kind of failure. (Cloudflare's own request logs record a request's URL when Workers
//   Logs are on; see ADR 0628 and docs/deploying.md.)
// - The answer is private and never kept by a cache (`private, no-store`), not indexed, never read
//   as anything but a calendar, and sends no Referer anywhere.
// - What it shows is `readStaffFeed`'s: the person's own shifts, their kind of work, place and
//   times in UTC, nothing else (packages/core/src/staffing/feed.ts).
import { addressKey } from "@composable-os/auth";
import { writeCalendar } from "@composable-os/calendar-file";
import { type RateLimitBinding, rateLimit, readStaffFeed } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";

export interface StaffFeedEnv {
  DB: D1Database;
  /** Keys the client-address bucket's hash (as the sign-in limits do). */
  BETTER_AUTH_SECRET?: string;
  /** Fetches per feed (Workers Rate Limiting). */
  STAFF_FEED_RATE_LIMIT?: RateLimitBinding;
  /** Fetches per client address, hashed. */
  STAFF_FEED_ADDRESS_RATE_LIMIT?: RateLimitBinding;
}

/** The feed's address: the token, 43 base64url characters, then `.ics`. */
const FEED = /^\/api\/v1\/staffing\/feed\/([A-Za-z0-9_-]{43})\.ics$/;

/** Whether `pathname` is under the feed's prefix (every such path is answered here). */
export function isStaffFeedPath(pathname: string): boolean {
  return pathname === "/api/v1/staffing/feed" || pathname.startsWith("/api/v1/staffing/feed/");
}

/** Headers on every answer of the feed's paths, found or not. */
const PRIVATE: Record<string, string> = {
  // Personal: never kept by a shared or a browser cache.
  "cache-control": "private, no-store",
  // Never in a search engine's index.
  "x-robots-tag": "noindex, nofollow, noarchive",
  // Never read as anything but what it says.
  "x-content-type-options": "nosniff",
  // A page that somehow rendered it could load nothing and send no Referer with the address.
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; sandbox",
};

/** The surface's own answer to a missing route: its body; the headers are the feed's. */
function notFound(): Response {
  return new Response(JSON.stringify({ error: { code: "not_found", message: "No such route" } }), {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8", ...PRIVATE },
  });
}

function limited(seconds: number): Response {
  return new Response(
    JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } }),
    {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(seconds),
        ...PRIVATE,
      },
    },
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Serves one request under the feed's prefix. */
export async function handleStaffFeed(
  request: Request,
  env: StaffFeedEnv,
  now: () => Date = () => new Date(),
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: { code: "invalid_input", message: "Use GET" } }), {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        allow: "GET, HEAD",
        ...PRIVATE,
      },
    });
  }
  try {
    // Per client address first, before anything is looked up: guessing costs the guesser.
    const address = request.headers.get("cf-connecting-ip");
    if (address) {
      const byAddress = await rateLimit(
        env.STAFF_FEED_ADDRESS_RATE_LIMIT,
        `feed-from:${await addressKey(address, env.BETTER_AUTH_SECRET ?? "")}`,
      );
      if (!byAddress.ok) return limited(byAddress.retryAfterSeconds);
    }
    const token = FEED.exec(url.pathname)?.[1];
    if (!token) return notFound();
    // Per token, keyed by its hash (the same for a real or a made-up one).
    const byToken = await rateLimit(
      env.STAFF_FEED_RATE_LIMIT,
      `feed:${(await sha256Hex(token)).slice(0, 32)}`,
    );
    if (!byToken.ok) return limited(byToken.retryAfterSeconds);
    const feed = await readStaffFeed(createCrmDb(env.DB).query, token, now());
    if (!feed) return notFound();
    const ics = writeCalendar({
      prodId: "-//Composable OS//Staff calendar feed//EN",
      method: "PUBLISH",
      name: "Shifts",
      // A hint: each calendar app fetches on its own schedule (often hours apart).
      refresh: "PT1H",
      events: feed.shifts.map((s) => ({
        // Stable across every change of the shift, so a calendar app replaces, never duplicates.
        uid: `${s.id}@${url.hostname}`,
        // Never the record's last change, which other writes can move (ADR 0628): the shift's own
        // start, so DTSTAMP says nothing of anything but the shift and the bytes stay the same
        // while the shift does.
        stamp: s.startsAt,
        start: s.startsAt,
        end: s.endsAt,
        title: s.title,
        location: s.place ?? undefined,
      })),
    });
    const bytes = new TextEncoder().encode(ics);
    return new Response(request.method === "HEAD" ? null : bytes, {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'inline; filename="shifts.ics"',
        "content-length": String(bytes.byteLength),
        ...PRIVATE,
      },
    });
  } catch (error) {
    // Never the URL or anything that could hold the token: the kind of failure only.
    console.error("staff calendar feed could not be served", (error as Error)?.name ?? "error");
    return new Response(
      JSON.stringify({ error: { code: "unavailable", message: "Try again later" } }),
      {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": "60",
          ...PRIVATE,
        },
      },
    );
  }
}
