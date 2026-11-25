-- Migration 1450: wrong promo codes (ADR 0940).
--
-- An operation that checks a code someone could guess counts wrong codes per caller: a signed-in
-- customer's account, a guest's order, or a guest's client address when they name no order. A
-- check reserves its guess before the code is looked up (`wrong = wrong + 1 ... RETURNING`, so
-- parallel guesses cannot overshoot) and gives it back when the code was right. Counted in fixed
-- quarter-hour windows; over the limit, `locked_until` refuses that caller's codes for 15 minutes,
-- right or wrong. One row per group and hour also counts wrong codes host-wide (`host\n...` keys),
-- the backstop against guessing from many addresses at once. The rate limiting binding cannot be
-- read without counting, so these counts are here.
--
-- `guess_key` is a SHA-256 of who (an account id, or an address's key: itself a keyed hash the
-- adapter made, so no address reaches the database), the order and the group. The daily
-- maintenance run deletes a row once its window and lock have passed. No Person, account or audit
-- row is linked to one. Not in any rec_* view.
CREATE TABLE core_wrong_guess (
  guess_key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  wrong INTEGER NOT NULL DEFAULT 0 CHECK (wrong >= 0),
  locked_until TEXT
) WITHOUT ROWID;

CREATE INDEX core_wrong_guess_window ON core_wrong_guess (window_start);
