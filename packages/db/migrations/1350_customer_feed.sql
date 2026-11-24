-- Migration 1350: a customer's private calendar feed (stage 62 step 1, ADR 0890).
--
-- A customer account's live bookings, and those of the children it is a live guardian of, as an
-- iCalendar feed a calendar app subscribes to with no sign-in: `GET /api/v1/me/feed/<token>.ics`.
-- The token is the only secret: 32 random bytes, shown to the customer once when they make it,
-- and stored here only as the SHA-256 of the token as written in the address (64 hex
-- characters), never the token. One feed per account: making a new one (rotating) replaces the
-- old, whose address then answers as any missing path does.
--
-- Made only by the customer themselves (`me.calendarFeed.rotate`); revoked by them, by staff
-- (`customer.revokeCalendarFeed`), and deleted when the account is disabled, deleted or erased (in
-- that change's batch, and by the cascade when the account row goes). The feed answers only while
-- the account is active and linked to its Person, whatever this table holds.
--
-- Its own table, apart from core_staff_feed: a staff token is never looked up on the customer's
-- route, nor the reverse. About an account, and a secret: in no rec_* view, export or search
-- index. No trigger.
CREATE TABLE core_customer_feed (
  -- The customer account whose bookings it shows (core_customer.id).
  customer_id TEXT PRIMARY KEY NOT NULL REFERENCES core_customer (id) ON DELETE CASCADE,
  -- SHA-256 of the token, lowercase hex. A lookup by it reads one row.
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL
) WITHOUT ROWID;
