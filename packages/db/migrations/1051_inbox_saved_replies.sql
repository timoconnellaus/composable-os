-- Migration 1051: saved replies (stage 36 step 3, ADR 0749).
--
-- A saved reply is a staff member's ready text for a reply: a title, its words, the channels it
-- fits, and whose it is: a staff member's own (owner_id set, read and changed by them alone) or
-- shared by the whole inbox (owner_id null, changed by those holding inbox:manage). Its words hold
-- fixed slots only (the person's first name, the staff member's first name, the business's name),
-- never a free merge field: `slots` lists those it uses. Archived ones are kept, and no longer
-- offered in the reply box.
--
-- Drafts (one per conversation per staff user, stage 36 step 6) are not here: that step adds its
-- own migration.

CREATE TABLE core_saved_reply (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  -- The channels it fits, a JSON list of `email` and `chat`.
  channels TEXT NOT NULL CHECK (json_valid(channels) AND json_array_length(channels) > 0),
  -- A staff member's own (their core_user id), or null: shared. A personal reply goes with its
  -- owner's account; it never becomes a shared one by a deleted owner.
  owner_id TEXT REFERENCES core_user (id) ON DELETE CASCADE,
  -- The fixed slots its words use, a JSON list (`person.firstName`, `staff.firstName`,
  -- `business.name`).
  slots TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(slots)),
  archived_at TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Every update sets version to the one it read plus one: a write from an older read fails.
  version INTEGER NOT NULL DEFAULT 0
);
-- The list's order (by title): a page walks it and stops at its limit.
CREATE INDEX core_saved_reply_title_idx ON core_saved_reply (title COLLATE NOCASE, id);
-- A staff member's own replies, and the cascade when their account goes.
CREATE INDEX core_saved_reply_owner_idx ON core_saved_reply (owner_id) WHERE owner_id IS NOT NULL;

CREATE TRIGGER core_saved_reply_stale
BEFORE UPDATE ON core_saved_reply
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'core_saved_reply_stale');
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1051'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1051;
