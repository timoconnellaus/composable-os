-- Migration 0913: consent to be contacted (stage 30 step 5, ADR 0675). The consent register, the
-- suppression list, and the stop links' tokens (only their hashes). Journeys, the shared inbox
-- and Reviews read and write these only through packages/core/src/contact/ (`contactDecision`,
-- `stopLink`), never on their own.

-- The register: a Person's contact choices, one row per choice made, never changed afterwards.
-- The latest row (by `at`, then `seq`) for (Person, channel, scope) is the one in force; the
-- earlier ones are its history. `scope` is a purpose (`follow_up`, `news_and_offers`) or a
-- routine message kind (`bookings.reminder`); `value` is `on` or `off`, and for `news_and_offers`
-- `yes` or `no`. `how` says where the choice came from, `by_id` who made it (a staff user or a
-- customer account; null for a stop link or a text reply), `reason` why staff recorded it, and
-- `wording` the words the person was shown when they said yes. Deleted with the Person (erase,
-- by the cascade); a merge moves the rows to the survivor (person_id is the only column that may
-- change, and only to the Person it was merged into).
CREATE TABLE core_contact_choice (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  person_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'text', 'push')),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 80),
  value TEXT NOT NULL CHECK (value IN ('on', 'off', 'yes', 'no')),
  at TEXT NOT NULL,
  how TEXT NOT NULL CHECK (how IN ('member', 'staff_on_request', 'staff_from_paper', 'form',
    'checkout', 'stop_link', 'stop_reply', 'start_reply', 'import', 'merge')),
  by_id TEXT,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  wording TEXT CHECK (wording IS NULL OR length(wording) <= 1000),
  -- A yes to news and offers carries the words the person was shown; nothing else says yes.
  CHECK ((scope = 'news_and_offers') = (value IN ('yes', 'no'))),
  CHECK (value != 'yes' OR wording IS NOT NULL)
);
CREATE INDEX core_contact_choice_person_idx ON core_contact_choice (person_id, channel, scope, at);

-- Append-only: a choice is never rewritten, only followed by a later one. A merge moves rows to
-- the survivor: person_id may change only to the Person the old one was merged into (as ADR
-- 0642's acceptances). A row goes only with its Person (the erase's cascade, which deletes the
-- Person first), never on its own.
CREATE TRIGGER core_contact_choice_no_update
BEFORE UPDATE ON core_contact_choice
BEGIN
  SELECT CASE
    WHEN NEW.seq IS NOT OLD.seq OR NEW.id IS NOT OLD.id OR NEW.channel IS NOT OLD.channel
      OR NEW.scope IS NOT OLD.scope OR NEW.value IS NOT OLD.value OR NEW.at IS NOT OLD.at
      OR NEW.how IS NOT OLD.how OR NEW.by_id IS NOT OLD.by_id OR NEW.reason IS NOT OLD.reason
      OR NEW.wording IS NOT OLD.wording
      THEN RAISE(ABORT, 'core_contact_choice_append_only')
    WHEN NEW.person_id IS NOT OLD.person_id AND NEW.person_id IS NOT (
        SELECT p.merged_into_id FROM core_person p WHERE p.id = OLD.person_id)
      THEN RAISE(ABORT, 'core_contact_choice_append_only')
  END;
END;

CREATE TRIGGER core_contact_choice_no_delete
BEFORE DELETE ON core_contact_choice
WHEN EXISTS (SELECT 1 FROM core_person p WHERE p.id = OLD.person_id)
BEGIN
  SELECT RAISE(ABORT, 'core_contact_choice_append_only');
END;

-- The one-tap stop's tokens: 32 random bytes each, of which only the SHA-256 is kept, naming one
-- Person, one channel and one scope. Nothing here is secret: a token is the link in one email,
-- and knowing a hash makes no link. A stop link minted for a stoppable message stays good (no
-- expiry) until its Person is erased; a merge moves its rows to the survivor.
CREATE TABLE core_contact_stop_token (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  person_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'text', 'push')),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL
);
CREATE INDEX core_contact_stop_token_person_idx ON core_contact_stop_token (person_id);

-- The suppression list: a salted hash of each address and number that asked to stop (a STOP
-- reply; a provider's "unsubscribed"), tied to no Person and kept after erase, so an address or
-- a number entered again, on anyone, is not sent to. START from the number deletes its row. The
-- salt is the host's (`text_number_salt`, migration 0911).
CREATE TABLE core_contact_suppression (
  channel TEXT NOT NULL CHECK (channel IN ('email', 'text')),
  value_hash TEXT NOT NULL,
  how TEXT NOT NULL CHECK (how IN ('stop_reply', 'provider_unsubscribed')),
  at TEXT NOT NULL,
  PRIMARY KEY (channel, value_hash)
);

-- The numbers that replied STOP so far (migration 0911's core_text_stop) are the list's texts.
INSERT INTO core_contact_suppression (channel, value_hash, how, at)
SELECT 'text', number_hash, how, at FROM core_text_stop;
DROP TABLE core_text_stop;

-- A held routine message is asked again when a person approves it (a stop taken while it waited
-- skips it): found by its pending action, without reading the log.
CREATE INDEX core_routine_mail_pending_idx ON core_routine_mail (pending_action_id)
  WHERE pending_action_id IS NOT NULL;
