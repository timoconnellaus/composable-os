-- Migration 0810: field-level exceptions in the `recurring` behaviour (stage 45 step 1, ADR 0620,
-- amending ADR 0500).
--
-- A record a series made, one of whose copied fields someone other than the host changed (a coach
-- swapped on one class), keeps that field as its own: one row here per record and field, with who
-- set it and when. The series never writes that field of that record again, and still writes the
-- others (a new room, new places). Removing the row (`recurring.follow`, or setting the field by
-- hand back to the series' value) makes the field follow the series again.
--
-- A record whose time, zone or state was changed by hand is still detached whole
-- (core_recurrence_occurrence.edited_at, migration 0560), as before. Nothing here changes a record
-- that is already detached: every occurrence with edited_at set stays detached whole, exactly as
-- it was read before this migration; a person makes one follow again with `recurring.follow`.
CREATE TABLE core_recurrence_exception (
  -- The generated record (the same pair as core_recurrence_occurrence's object_type, record_id).
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The generated object's field the record keeps as its own (a `copy` target).
  field TEXT NOT NULL,
  -- The staff account whose write made it the record's own, and when (ISO instant). Changed
  -- again by hand, both are the latest write's.
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id, field)
) WITHOUT ROWID;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '810'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 810;
