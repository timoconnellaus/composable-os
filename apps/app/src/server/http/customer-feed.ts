// A customer's private calendar feed (stage 62 step 1, ADR 0890): their own live bookings, and
// those of the children they are a live guardian of, as an iCalendar file a calendar app
// subscribes to and polls with no sign-in.
//
//   GET /api/v1/me/feed/<token>.ics    (HEAD too; offered as webcal:// by the screens)
//
// The token in the address is the only credential (a bearer secret): 32 random bytes, which the
// host keeps only as a hash (`core_customer_feed`), made by the customer's own
// `me.calendarFeed.rotate`. The path sits under the HTTP surface's `/api/v1/*`, which Cloudflare
// Access bypasses (src/server/access-layout.ts): a calendar app cannot sign in. It is served here,
// before the surface, through the shared feed module (calendar-feed.ts): every path under
// `/api/v1/me/feed/` is answered there, a token that opens nothing gets the surface's own 404,
// limited per client address (`CUSTOMER_FEED_ADDRESS_RATE_LIMIT`) and per token
// (`CUSTOMER_FEED_RATE_LIMIT`), private, never cached, never logged. A staff feed's token opens
// nothing here (the tables are separate), nor a customer's on the staff route.
//
// What it shows is `readCustomerFeed`'s, read as the customer through the visibility seam
// (packages/core/src/customers/calendar-feed.ts): each record a shipped pack declares a
// `calendarEntry` on, its public title and place and its times in UTC, nothing else.
import { type RateLimitBinding, readCustomerFeed } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { feedSecret, isFeedPath, serveFeed } from "./calendar-feed.ts";

export interface CustomerFeedEnv {
  DB: D1Database;
  /** Keys the client-address bucket's hash (as the sign-in limits do). */
  BETTER_AUTH_SECRET?: string;
  /** Fetches per feed (Workers Rate Limiting). */
  CUSTOMER_FEED_RATE_LIMIT?: RateLimitBinding;
  /** Fetches per client address, hashed. */
  CUSTOMER_FEED_ADDRESS_RATE_LIMIT?: RateLimitBinding;
}

const PREFIX = "/api/v1/me/feed";

/** Whether `pathname` is under the feed's prefix (every such path is answered here). */
export function isCustomerFeedPath(pathname: string): boolean {
  return isFeedPath(PREFIX, pathname);
}

/** Serves one request under the feed's prefix. */
export function handleCustomerFeed(
  request: Request,
  env: CustomerFeedEnv,
  now: () => Date = () => new Date(),
): Promise<Response> {
  return serveFeed(
    request,
    {
      prefix: PREFIX,
      prodId: "-//Composable OS//Customer calendar feed//EN",
      name: "Bookings",
      file: "bookings",
      tokenLimit: env.CUSTOMER_FEED_RATE_LIMIT,
      addressLimit: env.CUSTOMER_FEED_ADDRESS_RATE_LIMIT,
      keys: { token: "cfeed", address: "cfeed-from" },
      secret: feedSecret(env),
      failure: "customer calendar feed could not be served",
      async read(token, at) {
        const feed = await readCustomerFeed(createCrmDb(env.DB).query, token, at);
        return feed
          ? feed.events.map((e) => ({
              // `<object>.<id>`: unique across every object a pack declares.
              uid: `${e.object}.${e.id}`,
              title: e.title,
              place: e.place,
              startsAt: e.startsAt,
              endsAt: e.endsAt,
            }))
          : null;
      },
    },
    now,
  );
}
