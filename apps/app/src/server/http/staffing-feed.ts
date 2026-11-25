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
//
// All of that but what it shows is the shared feed module's (calendar-feed.ts, ADR 0890), which
// the customer's feed uses too; this file says only what is the staff feed's own, and its answers
// are byte for byte what they were before the module was shared.
import { type RateLimitBinding, readStaffFeed } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { isFeedPath, serveFeed } from "./calendar-feed.ts";

export interface StaffFeedEnv {
  DB: D1Database;
  /** Keys the client-address bucket's hash (as the sign-in limits do). */
  BETTER_AUTH_SECRET?: string;
  /** Fetches per feed (Workers Rate Limiting). */
  STAFF_FEED_RATE_LIMIT?: RateLimitBinding;
  /** Fetches per client address, hashed. */
  STAFF_FEED_ADDRESS_RATE_LIMIT?: RateLimitBinding;
}

const PREFIX = "/api/v1/staffing/feed";

/** Whether `pathname` is under the feed's prefix (every such path is answered here). */
export function isStaffFeedPath(pathname: string): boolean {
  return isFeedPath(PREFIX, pathname);
}

/** Serves one request under the feed's prefix. */
export function handleStaffFeed(
  request: Request,
  env: StaffFeedEnv,
  now: () => Date = () => new Date(),
): Promise<Response> {
  return serveFeed(
    request,
    {
      prefix: PREFIX,
      prodId: "-//Composable OS//Staff calendar feed//EN",
      name: "Shifts",
      file: "shifts",
      tokenLimit: env.STAFF_FEED_RATE_LIMIT,
      addressLimit: env.STAFF_FEED_ADDRESS_RATE_LIMIT,
      keys: { token: "feed", address: "feed-from" },
      secret: env.BETTER_AUTH_SECRET ?? "",
      failure: "staff calendar feed could not be served",
      async read(token, at) {
        const feed = await readStaffFeed(createCrmDb(env.DB).query, token, at);
        return feed
          ? feed.shifts.map((s) => ({
              uid: s.id,
              title: s.title,
              place: s.place,
              startsAt: s.startsAt,
              endsAt: s.endsAt,
            }))
          : null;
      },
    },
    now,
  );
}
