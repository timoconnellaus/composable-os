// The host's private calendar feeds' route (stage 62 step 1, ADR 0890; the staff feed's machine,
// ADR 0628, made one module both feeds use). A calendar app subscribes to a feed's address and
// polls it with no sign-in, so the token in the address is the only credential (a bearer secret).
//
// Each feed (the staff member's shifts, the customer's bookings) is a `FeedRoute`: its prefix, its
// two limits, its log line and how it reads a token's events. What holds for every feed is here:
// - Every path under the prefix is answered here, and nothing else is: a made-up, malformed,
//   rotated or revoked token, and one whose owner may no longer have a feed, all get one 404, with
//   the body of the HTTP surface's own for a missing route.
// - Limited per client address (hashed, before anything is looked up) and per token (keyed by its
//   hash): over either, 429 with Retry-After.
// - The token is never logged, audited, stored or put in an error by this code: the only log line
//   names the kind of failure. (Cloudflare's own request logs record a request's URL when Workers
//   Logs are on; see ADR 0628 and docs/deploying.md.)
// - The answer is private and never kept by a cache (`private, no-store`), not indexed, never read
//   as anything but a calendar, and sends no Referer anywhere.
// - The file is the shared calendar writer's (`@composable-os/calendar-file`): UTC instants, a
//   stable UID per event, `DTSTAMP` the event's own start, the same bytes for the same events.
import { addressKey } from "@composable-os/auth";
import { type CalendarEvent, writeCalendar } from "@composable-os/calendar-file";
import { type RateLimitBinding, rateLimit, sha256Hex } from "@composable-os/core";

/** One event as a feed reads it; the route writes it. */
export interface FeedEvent {
  /** The UID's part before `@<hostname>`: stable across every change of the event. */
  uid: string;
  title: string;
  place: string | null;
  startsAt: string;
  endsAt: string;
}

/** One feed's route. */
export interface FeedRoute {
  /** The prefix every path under which is answered here, without its trailing slash. */
  prefix: string;
  /** The calendar's PRODID. */
  prodId: string;
  /** The calendar's name, and the file's (`<file>.ics`). */
  name: string;
  file: string;
  /** Fetches per feed, keyed by a hash of the token. */
  tokenLimit: RateLimitBinding | undefined;
  /** Fetches per client address, hashed, before any lookup. */
  addressLimit: RateLimitBinding | undefined;
  /** The rate limit keys' prefixes (the staff feed's are `feed`, kept as they were). */
  keys: { token: string; address: string };
  /** Keys the client-address bucket's hash (as the sign-in limits do). */
  secret: string;
  /** The one log line on a failure: the kind of feed, never the token. */
  failure: string;
  /** The token's events at `now`, or null when it opens nothing (every null is one 404). */
  read: (token: string, now: Date) => Promise<FeedEvent[] | null>;
}

/** A token as written in the address: 43 base64url characters, then `.ics`. */
const TOKEN_PATH = /^([A-Za-z0-9_-]{43})\.ics$/;

/** Whether `pathname` is under `prefix` (every such path is answered by the feed). */
export function isFeedPath(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Headers on every answer of a feed's paths, found or not. */
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

/** Serves one request under `feed.prefix`. */
export async function serveFeed(
  request: Request,
  feed: FeedRoute,
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
        feed.addressLimit,
        `${feed.keys.address}:${await addressKey(address, feed.secret)}`,
      );
      if (!byAddress.ok) return limited(byAddress.retryAfterSeconds);
    }
    const rest = url.pathname.startsWith(`${feed.prefix}/`)
      ? url.pathname.slice(feed.prefix.length + 1)
      : "";
    const token = TOKEN_PATH.exec(rest)?.[1];
    if (!token) return notFound();
    // Per token, keyed by its hash (the same for a real or a made-up one).
    const byToken = await rateLimit(
      feed.tokenLimit,
      `${feed.keys.token}:${(await sha256Hex(token)).slice(0, 32)}`,
    );
    if (!byToken.ok) return limited(byToken.retryAfterSeconds);
    const events = await feed.read(token, now());
    if (!events) return notFound();
    const ics = writeCalendar({
      prodId: feed.prodId,
      method: "PUBLISH",
      name: feed.name,
      // A hint: each calendar app fetches on its own schedule (often hours apart).
      refresh: "PT1H",
      events: events.map(
        (e): CalendarEvent => ({
          // Stable across every change of the event, so a calendar app replaces, never duplicates.
          uid: `${e.uid}@${url.hostname}`,
          // Never the record's last change, which other writes can move (ADR 0628): the event's
          // own start, so DTSTAMP says nothing of anything but the event and the bytes stay the
          // same while the event does.
          stamp: e.startsAt,
          start: e.startsAt,
          end: e.endsAt,
          title: e.title,
          location: e.place ?? undefined,
        }),
      ),
    });
    const bytes = new TextEncoder().encode(ics);
    return new Response(request.method === "HEAD" ? null : bytes, {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `inline; filename="${feed.file}.ics"`,
        "content-length": String(bytes.byteLength),
        ...PRIVATE,
      },
    });
  } catch (error) {
    // Never the URL or anything that could hold the token: the kind of failure only.
    console.error(feed.failure, (error as Error)?.name ?? "error");
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
