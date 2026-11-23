-- Migration 0814: a staff member's private calendar feed (stage 45 step 5, ADR 0628).
--
-- A person's own shifts, as an iCalendar feed a calendar app subscribes to with no sign-in:
-- `GET /api/v1/staffing/feed/<token>.ics`. The token is the only secret: 32 random bytes, shown
-- to the person once when it is made, and stored here only as the SHA-256 of the token as written
-- in the address (64 hex characters), never the token. One feed per account: making a new one
-- (rotating) replaces the old, whose address then answers as any missing path does.
--
-- The feed answers only while its account is active and may still call the tool that made it
-- (`tool`, the extension tool's operation name, e.g. x.rostering.feedRotate): a person deactivated
-- or no longer holding the pack's permission gets nothing, whatever this table holds. Deactivation
-- and a change of role, pack role or grants that takes the tool away delete the row in their own
-- batch, so the address stays dead if the access comes back.
--
-- About a staff account, and a secret: in no rec_* view, so no member's SQL, export, dashboard or
-- the assistant's record reads see it. No trigger: nothing else is written from it.
CREATE TABLE core_staff_feed (
  -- The staff account whose shifts it shows (core_user.id).
  account_id TEXT PRIMARY KEY NOT NULL,
  -- SHA-256 of the token, lowercase hex. A lookup by it reads one row.
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  -- The tool that made it (x.<pack>.<tool>): the account must still be able to call it.
  tool TEXT NOT NULL CHECK (length(tool) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL
) WITHOUT ROWID;
