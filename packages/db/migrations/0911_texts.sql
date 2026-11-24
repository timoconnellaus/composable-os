-- Migration 0911: texts (stage 30 step 3, ADRs 0672 and 0673). What the host keeps to send a
-- routine message by text: the month's spend against the text limit, the numbers checked by a
-- code, and the numbers that replied STOP. Never the words, and never a number in the log (a
-- salted hash for the caps and the stops).

-- The salt the host hashes numbers with (a text row's `recipient_key`, a stop): made once, here,
-- for this deployment. Not a secret against someone who reads this database (numbers are few
-- enough to try them all); it keeps one deployment's hashes from matching another's.
INSERT INTO core_settings (key, value, updated_at)
VALUES ('text_number_salt', json_quote(lower(hex(randomblob(16)))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT (key) DO NOTHING;

-- The month's spend on texts (ADR 0672): one row per month (`YYYY-MM` in the business's zone),
-- counted in the statement that claims a text (`estimated_minor`, segments times the price the
-- admin entered) and corrected by what the provider reports (`reported_minor`). A text claimed
-- that would take `estimated_minor` past the limit is `over_limit` instead. A checking code and
-- HELP's answer count too.
CREATE TABLE core_text_spend (
  month TEXT PRIMARY KEY NOT NULL,
  segments INTEGER NOT NULL DEFAULT 0,
  estimated_minor INTEGER NOT NULL DEFAULT 0,
  reported_minor INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- A code sent to a Person's number, and whether it was typed back (ADR 0673). `number` is the
-- international form; the code itself is the provider's and never reaches the host. A number
-- checked by one Person is never texted for another (`number_hash`, issue #302's rule for
-- numbers). The member asks for at most 3 codes a day, and a number gets at most 3 a day
-- whoever asks (counted from `started_at`). Deleted with the Person.
CREATE TABLE core_phone_check (
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  number_hash TEXT NOT NULL,
  how TEXT NOT NULL DEFAULT 'code' CHECK (how IN ('code')),
  started_at TEXT NOT NULL,
  checked_at TEXT,
  -- Tries at typing this code back: three, whatever the provider allows.
  tries INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX core_phone_check_person_idx ON core_phone_check (person_id, started_at);
CREATE INDEX core_phone_check_number_idx ON core_phone_check (number_hash, started_at);

-- Numbers that replied STOP (ADR 0672): a salted hash of each, never the number, kept after the
-- Person is erased so a number entered again (on anyone) is not texted. START from the number
-- deletes it. Stage 30's consent register (step 5) reads it as its suppression list for texts.
CREATE TABLE core_text_stop (
  number_hash TEXT PRIMARY KEY NOT NULL,
  how TEXT NOT NULL CHECK (how IN ('stop_reply')),
  at TEXT NOT NULL
);

-- The texts ready to go (just prepared, released at the end of quiet hours, or back after a full
-- pending pool), and the held ones not yet put to a person: the minute cron's send step.
CREATE INDEX core_routine_mail_texts_idx ON core_routine_mail (status, updated_at)
  WHERE channel = 'text' AND status IN ('ready', 'held');
-- Texts left `sending` by a host that stopped before it settled them: tried again after a while.
CREATE INDEX core_routine_mail_texts_sending_idx ON core_routine_mail (updated_at)
  WHERE channel = 'text' AND status = 'sending';
