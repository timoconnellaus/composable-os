-- Migration 0560: the `recurring` behaviour's bookkeeping (stage 31, ADR 0500).
--
-- A series (a record of an object that declares `recurring`) has one row here: when the host
-- next makes its records (the minute cron picks rows whose time has come; a write to the series
-- sets it to now) and up to which local date it has made them. Each record it made has one
-- occurrence row, keyed on the series and the local date: the idempotency key. A second run, or
-- two runs at once, cannot make a date twice, because the second insert of its key fails and with
-- it the whole batch that would have created the record. An occurrence edited by someone other
-- than the host is marked, and the series never writes to it again.
CREATE TABLE core_recurrence_series (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- When the host next makes this series' records (ISO instant).
  next_run_at TEXT NOT NULL,
  -- The last local date (YYYY-MM-DD) it has made records up to, or none yet.
  generated_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id)
) WITHOUT ROWID;
CREATE INDEX core_recurrence_series_due_idx ON core_recurrence_series (next_run_at);

CREATE TABLE core_recurrence_occurrence (
  series_object TEXT NOT NULL,
  series_id TEXT NOT NULL,
  -- The occurrence's local date in the series' zone (YYYY-MM-DD).
  local_date TEXT NOT NULL,
  -- The record made for it.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- Set when someone other than the host changed it: the series leaves it alone from then on.
  edited_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (series_object, series_id, local_date)
) WITHOUT ROWID;
CREATE UNIQUE INDEX core_recurrence_occurrence_record_idx
  ON core_recurrence_occurrence (object_type, record_id);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '560'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 560;
