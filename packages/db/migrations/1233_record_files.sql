-- Migration 1233: record files (stage 56 step 3, ADR 0834).
--
-- core_record_file: a photo or a PDF attached to a note (an Activity of type `note`), kept
-- privately in the deployment's R2 bucket under its own prefix, `files/<id>`, never under the
-- media library's `media/`. Its readers are exactly its note's, at every moment: the file
-- operations read the note through the visibility seam on every serve. Not a record of its own:
-- no view, no search, no embedding, no SQL, nothing an AI reads but the name and type of a file
-- on a note it may read.
--
-- An upload is kept, unattached (note_id null), until its uploader saves the note it goes with;
-- the daily purge deletes one left unattached for a day. sha256 is the stored bytes' digest, for
-- integrity only: nothing looks a file up by it, and nothing is deduplicated.
--
-- Nothing here names core_activity: migration 1430 remakes that table on a fresh database, and a
-- foreign key would cascade its drop into this table, a trigger or view naming it would break
-- its rename. The operations that hard-delete notes (the Trash purge, erase) delete their files
-- in the same batch instead.
CREATE TABLE core_record_file (
  id TEXT PRIMARY KEY NOT NULL,
  -- The note it is attached to; null while it waits for its note to be saved.
  note_id TEXT,
  key TEXT NOT NULL UNIQUE CHECK (key = 'files/' || id),
  -- The name it was uploaded with, shown to the note's readers; never in an audit row or a log.
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type TEXT NOT NULL
    CHECK (type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  -- The stored size, after its metadata was removed.
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  width INTEGER,
  height INTEGER,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  -- The staff account that uploaded it (a customer's upload is stage 56 step 6).
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attached_at TEXT,
  CHECK ((note_id IS NULL) = (attached_at IS NULL))
) WITHOUT ROWID;

-- A note's files, for its readers.
CREATE INDEX core_record_file_note_idx ON core_record_file (note_id, created_at)
  WHERE note_id IS NOT NULL;
-- Uploads waiting for their note: an uploader's own (the limit, attaching), and the purge's.
CREATE INDEX core_record_file_staged_idx ON core_record_file (uploaded_by, created_at)
  WHERE note_id IS NULL;
CREATE INDEX core_record_file_staged_age_idx ON core_record_file (created_at)
  WHERE note_id IS NULL;
-- The storage total, from the index alone.
CREATE INDEX core_record_file_bytes_idx ON core_record_file (bytes);

-- A file's R2 object goes when its row does, whatever deleted it (the purge, erase, a person
-- removing it): queued in the same batch and drained after the commit and by the 10-minute cron
-- (core_blob_deletion, migration 0330).
CREATE TRIGGER core_record_file_ad AFTER DELETE ON core_record_file
BEGIN
  INSERT OR IGNORE INTO core_blob_deletion (key, queued_at)
  VALUES (OLD.key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- A file once attached stays with its note: it is never moved to another, nor its bytes changed.
CREATE TRIGGER core_record_file_fixed BEFORE UPDATE ON core_record_file
WHEN OLD.note_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'core_record_file_fixed');
END;

-- An upload's limits held at commit, whatever another upload did meanwhile: a note's room, the
-- account's uploads waiting for their note, the storage cap; and that the uploads a note takes
-- still wait for it. A row is never kept: `ok` is the
-- limit's answer, and a false one fails the batch whole, naming the limit.
CREATE TABLE core_record_file_guard (
  rule TEXT NOT NULL,
  ok INTEGER NOT NULL
);

CREATE TRIGGER core_record_file_guard_check
BEFORE INSERT ON core_record_file_guard
BEGIN
  SELECT CASE
    WHEN NEW.ok = 1 THEN RAISE(IGNORE)
    WHEN NEW.rule = 'cap' THEN RAISE(ABORT, 'core_file_cap')
    WHEN NEW.rule = 'note' THEN RAISE(ABORT, 'core_file_note_full')
    WHEN NEW.rule = 'attach' THEN RAISE(ABORT, 'core_file_changed')
    ELSE RAISE(ABORT, 'core_file_staged_full')
  END;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1233'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1233;
