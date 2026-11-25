-- Migration 1010: personal links (stage 29 step 5, ADR 0723). A personal link lets one named Person
-- answer one form (optionally about one record: the class they came to) without signing in, once.
-- It is made by the host alone (the form-link slot of routine mail, packages/core/src/intake/
-- links.ts) and read only there.
--
-- A link is one row; each email that carries it has its own token (a guardian's and the member's
-- app item reach the same link). A token is 32 random bytes of which only the SHA-256 is kept, as
-- the stop links' (ADR 0675): nothing here is secret, and knowing a hash makes no link.
--
-- Used once, by the database: the answer's batch sets `used_at` by the link's id alone, and the
-- trigger below fails the whole batch when it is already set, or when the link has expired. Of
-- two answers racing for one link, exactly one commits (D1 runs one batch at a time) and the other
-- keeps nothing. Deleted with its Person (erase, by the cascade); a merge moves it to the survivor.
CREATE TABLE core_intake_link (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  -- What is answered: a form object's registry name and its record; for a declared intake (no
  -- form record, stage 54) the object alone.
  form_object TEXT NOT NULL CHECK (length(form_object) BETWEEN 3 AND 81),
  form_id TEXT CHECK (form_id IS NULL OR length(form_id) BETWEEN 1 AND 64),
  -- The record it is about (a booking), whose submission is tied to it; null for none.
  record_object TEXT CHECK (record_object IS NULL OR length(record_object) BETWEEN 3 AND 81),
  record_id TEXT CHECK (record_id IS NULL OR length(record_id) BETWEEN 1 AND 64),
  -- What made it: a routine email's kind and the run its chain began with, so a retried step
  -- finds its own link and a later send about the same record makes none.
  made_for TEXT NOT NULL CHECK (length(made_for) BETWEEN 1 AND 200),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  submission_id TEXT,
  created_at TEXT NOT NULL,
  CHECK ((record_object IS NULL) = (record_id IS NULL)),
  CHECK ((used_at IS NULL) = (submission_id IS NULL)),
  CHECK (expires_at > created_at)
);

-- One link per Person, form and record it is about: a class attended is asked about once.
CREATE UNIQUE INDEX core_intake_link_about ON core_intake_link
  (form_object, ifnull(form_id, ''), person_id, record_object, record_id)
  WHERE record_id IS NOT NULL;
-- A Person's links by when they were made: the cool-down, and "Needs your attention".
CREATE INDEX core_intake_link_person ON core_intake_link (person_id, created_at);

CREATE TABLE core_intake_link_token (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  link_id TEXT NOT NULL REFERENCES core_intake_link (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX core_intake_link_token_link ON core_intake_link_token (link_id);

-- A link is made unused, and never replaced (D1 runs with recursive triggers off, so an INSERT OR
-- REPLACE would delete the row it replaces without firing the update trigger below).
CREATE TRIGGER core_intake_link_insert
BEFORE INSERT ON core_intake_link
BEGIN
  SELECT RAISE(ABORT, 'core_intake_link_fixed')
  WHERE EXISTS (SELECT 1 FROM core_intake_link WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'core_intake_link_fixed')
  WHERE NEW.used_at IS NOT NULL OR NEW.submission_id IS NOT NULL;
END;

-- Used once, before it expires; what it names never changes, but its Person may move to the one it
-- was merged into, and its expiry only come sooner (a link revoked is one that has expired).
CREATE TRIGGER core_intake_link_update
BEFORE UPDATE ON core_intake_link
BEGIN
  SELECT CASE
    WHEN OLD.used_at IS NOT NULL
      AND (NEW.used_at IS NOT OLD.used_at OR NEW.submission_id IS NOT OLD.submission_id)
      THEN RAISE(ABORT, 'core_intake_link_used')
    WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL AND NEW.used_at >= OLD.expires_at
      THEN RAISE(ABORT, 'core_intake_link_used')
    WHEN NEW.id IS NOT OLD.id OR NEW.form_object IS NOT OLD.form_object
      OR NEW.form_id IS NOT OLD.form_id OR NEW.record_object IS NOT OLD.record_object
      OR NEW.record_id IS NOT OLD.record_id OR NEW.made_for IS NOT OLD.made_for
      OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at > OLD.expires_at
      THEN RAISE(ABORT, 'core_intake_link_fixed')
    WHEN NEW.person_id IS NOT OLD.person_id AND NEW.person_id IS NOT (
        SELECT p.merged_into_id FROM core_person p WHERE p.id = OLD.person_id)
      THEN RAISE(ABORT, 'core_intake_link_fixed')
  END;
END;

-- A token names one link for good.
CREATE TRIGGER core_intake_link_token_fixed
BEFORE UPDATE ON core_intake_link_token
BEGIN
  SELECT RAISE(ABORT, 'core_intake_link_fixed');
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1010'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1010;
