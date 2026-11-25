-- Migration 1450: wrong guesses per client address (ADR 0940).
--
-- An operation that checks a code someone could guess (a promo code) reads, before it checks, how
-- many wrong codes this client address gave in the current hour, and refuses at 20; a wrong code
-- adds one. The Workers Rate Limiting binding cannot be read without counting, and a limit that
-- counts only wrong codes must also refuse the right one once it is reached, so the count is here.
--
-- `guess_key` is a SHA-256 of the address's key (itself a keyed hash the adapter made: no address
-- reaches the database), the group and the hour, so rows of different hours cannot be joined. The
-- daily maintenance run deletes a row once its hour has ended. No Person, account or audit row is
-- linked to one. Not in any rec_* view.
CREATE TABLE core_wrong_guess (
  guess_key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  wrong INTEGER NOT NULL DEFAULT 0 CHECK (wrong >= 0)
) WITHOUT ROWID;

CREATE INDEX core_wrong_guess_window ON core_wrong_guess (window_start);
