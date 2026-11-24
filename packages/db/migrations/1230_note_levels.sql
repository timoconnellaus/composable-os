-- Migration 1230: note levels (stage 56 step 1, ADR 0830).
--
-- A note gains a level: who may read it. `staff` (every existing note, and the default) is read by
-- every staff account as today. `coaches` is read by its author, the staff who look after the one
-- Person it is about (core_person_carer, migration 1231), admins and holders of `notes:clients`.
-- `sensitive` is read by its author, admins and holders of `notes:sensitive`, each opening
-- audited. Only a `note` takes a level other than `staff`; emails, calls, meetings and system
-- activities stay `staff`.
--
-- Levels 2 and 3 are out of every bulk path, as a private synced email is (migration 0111, ADR
-- 0112): not in core_base_activities, and so not in rec_activity (the reconciler rebuilds it over
-- core_base_activities), query.sql, dashboards or exports; not in rec_activity_link; not in the
-- search index. The host reads them only through the seam's note scope (visibility/notes.ts).
--
-- The other columns are the note's, filled by later steps of the stage: its kind (core_note_kind,
-- step 2; no foreign key until that table exists), when and by whom it was shared with the client
-- (step 5), the customer account that sent it (step 6), whether it is evidence (copied from its
-- kind at write, step 7) and its template's filled sections as JSON (step 2).

ALTER TABLE core_activity ADD COLUMN level TEXT NOT NULL DEFAULT 'staff'
  CHECK (level IN ('staff', 'coaches', 'sensitive'));
ALTER TABLE core_activity ADD COLUMN kind_id TEXT;
ALTER TABLE core_activity ADD COLUMN shared_at TEXT;
ALTER TABLE core_activity ADD COLUMN shared_by TEXT;
ALTER TABLE core_activity ADD COLUMN from_customer TEXT;
ALTER TABLE core_activity ADD COLUMN evidence INTEGER NOT NULL DEFAULT 0 CHECK (evidence IN (0, 1));
ALTER TABLE core_activity ADD COLUMN sections TEXT CHECK (sections IS NULL OR json_valid(sections));

-- Only a note is kept from the staff: every other type stays `staff`, for every writer.
CREATE TRIGGER core_activity_level_note_insert
BEFORE INSERT ON core_activity
WHEN NEW.level != 'staff' AND NEW.type != 'note'
BEGIN
  SELECT RAISE(ABORT, 'core_activity_level_not_note');
END;

CREATE TRIGGER core_activity_level_note_update
BEFORE UPDATE OF level, type ON core_activity
WHEN NEW.level != 'staff' AND NEW.type != 'note'
BEGIN
  SELECT RAISE(ABORT, 'core_activity_level_not_note');
END;

-- The base view keeps only `staff` rows. rec_activity reads it by name, so it follows.
DROP VIEW core_base_activities;
CREATE VIEW core_base_activities AS
SELECT
  activity.id,
  activity.type,
  activity.subject,
  activity.body,
  activity.payload,
  activity.occurred_at,
  activity.author_user_id,
  activity.author_actor,
  activity.created_at,
  activity.updated_at
FROM core_activity activity
WHERE activity.deleted_at IS NULL AND activity.private_to IS NULL AND activity.level = 'staff';

DROP VIEW rec_activity_link;
CREATE VIEW rec_activity_link AS
SELECT l.activity_id, l.object_type, l.record_id
FROM core_activity_links l
JOIN core_activity a ON a.id = l.activity_id AND a.deleted_at IS NULL AND a.private_to IS NULL
  AND a.level = 'staff';

-- Search holds only `staff` rows: raising a note's level takes it out, lowering puts it back.
DROP TRIGGER core_activity_search_ai;
CREATE TRIGGER core_activity_search_ai AFTER INSERT ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a
  WHERE a.id = NEW.id AND a.deleted_at IS NULL AND a.private_to IS NULL AND a.level = 'staff';
END;

DROP TRIGGER core_activity_search_au;
CREATE TRIGGER core_activity_search_au AFTER UPDATE OF subject, body, deleted_at, private_to, level
  ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a
  WHERE a.id = NEW.id AND a.deleted_at IS NULL AND a.private_to IS NULL AND a.level = 'staff';
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1230'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1230;
