-- Migration 1231: who looks after whom (stage 56 step 1, ADR 0831).
--
-- A staff account that looks after a Person (a client's coach) reads the Person's notes kept to
-- their coaches (level `coaches`, migration 1230). Staff with `people:link` set it on the
-- Person's page, a person only (`carer.set`, `carer.end`); a coach does not add themselves. It is
-- chosen, never worked out from bookings: one covered class must not open a member's notes to a
-- casual coach (stage 56, decision 3).
--
-- An ended row is kept, with who ended it and when, as the record of who could read whose notes;
-- it gives nothing. One live row per Person and account. Ending it takes effect on the next read:
-- nothing caches it.
--
-- An erase (a hard delete of the Person) removes their rows by the foreign key; so does removing
-- the account.
CREATE TABLE core_person_carer (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  -- The staff account (usr_…) that set it, and when it started.
  set_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  -- Set when it ends; it never starts again (a new row is made instead).
  ended_at TEXT,
  ended_by TEXT
);
CREATE UNIQUE INDEX core_person_carer_live_uq
  ON core_person_carer (person_id, user_id) WHERE ended_at IS NULL;
-- The seam asks "does this account look after this Person now" on every restricted note it reads.
CREATE INDEX core_person_carer_user_idx ON core_person_carer (user_id, person_id, ended_at);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1231'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1231;
