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

-- Each occurrence's version: bumped by a write by hand to its record (an exception set or cleared,
-- the record detached, `recurring.follow`) and by a change of its series. Existing rows start at 0.
ALTER TABLE core_recurrence_occurrence ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- Guards for a batch planned from a read of occurrences (as core_write_guard is for series and
-- places, migration 0560; a table of its own so that one, which other builds rebuild, is not
-- touched). A statement inserts what it read; the trigger compares it with what is there now, in
-- the batch, and either drops the row (still true) or fails the whole batch. Nothing is stored.
--   kind 'occurrence':  one record's occurrence version is still `expected` (a hand edit: a series
--                       change that touched it meanwhile fails the edit)
--   kind 'occurrences': the sum of a series' occurrence versions from `from_date` on is still
--                       `expected` (a series change: a hand edit of one of them meanwhile fails it)
-- Edits of different records of one series do not contend, and neither contends with a run.
CREATE TABLE core_recurrence_guard (
  kind TEXT NOT NULL CHECK (kind IN ('occurrence', 'occurrences')),
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  from_date TEXT,
  expected INTEGER NOT NULL
);

CREATE TRIGGER core_recurrence_guard_check
BEFORE INSERT ON core_recurrence_guard
BEGIN
  SELECT CASE
    -- A missing occurrence (its date removed by a series change meanwhile) is stale too.
    WHEN NEW.kind = 'occurrence' AND coalesce((SELECT version FROM core_recurrence_occurrence
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id), -1) != NEW.expected
      THEN RAISE(ABORT, 'core_recurrence_stale')
    WHEN NEW.kind = 'occurrences' AND coalesce((SELECT sum(version) FROM core_recurrence_occurrence
        WHERE series_object = NEW.object_type AND series_id = NEW.record_id
          AND local_date >= NEW.from_date), 0) != NEW.expected
      THEN RAISE(ABORT, 'core_recurrence_stale')
    ELSE RAISE(IGNORE)
  END;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '810'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 810;
