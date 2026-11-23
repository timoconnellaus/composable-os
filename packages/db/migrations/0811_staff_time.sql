-- Migration 0811: the `staffed` behaviour's time claim, and what its warnings read (stage 45
-- step 2, ADRs 0621 and 0622).
--
-- A record of an object that declares `staffed` is a shift: a time someone works. Every live,
-- covered shift whose person has a staff account holds one claim here: the account, the record,
-- and the shift's own time as whole unix seconds, half-open (06:00 to 07:00 and 07:00 to 08:00 do
-- not clash). The database refuses a claim that overlaps another of the same account's, so one
-- person is never on two overlapping shifts, whoever writes and however many write at once: D1
-- runs one batch at a time, so of two batches that would double-book one person, the second
-- fails whole.
--
-- The claims are kept by triggers the schema reconciler builds on each staffed object's own table
-- (and on the table holding the account, a class's coach profile), so every statement that writes
-- a shift writes its claim in the same statement: a create, an edit, a move, a cancel, the Trash
-- and a restore, an erase, a merge, a series' generation and changes. No migration touches an
-- x_* table. D1 runs with recursive triggers off, so the rows an INSERT OR REPLACE or an UPDATE OR
-- REPLACE deletes fire no delete trigger: the checks below are BEFORE INSERT and BEFORE UPDATE on
-- every column (a REPLACE and an upsert are inserts first, and an id update is an update), and
-- each leaves out only the row's own key, which such a statement replaces. A claim left behind by
-- a row a REPLACE deleted can only refuse more, never let a double-booking through.
CREATE TABLE core_staff_time (
  -- The shift: its object's registry name and its record.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The staff account working it (core_user.id).
  account_id TEXT NOT NULL,
  -- Its own time, unix seconds; preparation and pack-down never count here (pay only).
  starts INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  PRIMARY KEY (object_type, record_id),
  CHECK (ends > starts)
) WITHOUT ROWID;

-- By account and end: an overlap check reads only the claims that end after the new one starts
-- (an account's past shifts are never read), however long its history.
CREATE INDEX core_staff_time_account ON core_staff_time (account_id, ends, starts);

CREATE TRIGGER core_staff_time_insert
BEFORE INSERT ON core_staff_time
BEGIN
  SELECT RAISE(ABORT, 'core_staff_double_booked')
  WHERE EXISTS (
    SELECT 1 FROM core_staff_time c
    WHERE c.account_id = NEW.account_id
      AND NOT (c.object_type = NEW.object_type AND c.record_id = NEW.record_id)
      AND c.ends > NEW.starts AND c.starts < NEW.ends
  );
END;

CREATE TRIGGER core_staff_time_update
BEFORE UPDATE ON core_staff_time
BEGIN
  SELECT RAISE(ABORT, 'core_staff_double_booked')
  WHERE EXISTS (
    SELECT 1 FROM core_staff_time c
    WHERE c.account_id = NEW.account_id
      AND NOT (c.object_type = OLD.object_type AND c.record_id = OLD.record_id)
      AND NOT (c.object_type = NEW.object_type AND c.record_id = NEW.record_id)
      AND c.ends > NEW.starts AND c.starts < NEW.ends
  );
END;

-- Who may do which kind of work (ADR 0622): an account, and a kind record (a class type, a duty).
-- Nobody is qualified by default; a shift whose person is not qualified for its kind is made with
-- a `not_qualified` warning. Set by a rosterer (stage 45 step 3, `staffing.qualify`). About staff
-- accounts: in no rec_* view, so no member's SQL, export or the assistant's record reads see it.
CREATE TABLE core_staff_qualification (
  account_id TEXT NOT NULL,
  kind_object TEXT NOT NULL,
  kind_record TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  PRIMARY KEY (account_id, kind_object, kind_record)
) WITHOUT ROWID;

-- When someone said they cannot work (ADR 0622): one-off (leave, or other) as a range of instants,
-- with the zone it was given in; or regular (every Wednesday afternoon) as weekdays and a local
-- start and end time in a zone, from a date and until one (empty: ongoing), checked by wall clock
-- on the fly, so 13:00 is 13:00 on both sides of a clock change. An end at or before the start is
-- the next day's (an overnight rule). Made by the person or a rosterer (step 3, `staffing.away`);
-- read for the `unavailable` warning. Personal: in no rec_* view.
CREATE TABLE core_staff_away (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('leave', 'regular', 'other')),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  starts_at TEXT,
  ends_at TEXT,
  -- Weekdays as a comma list of mon … sun.
  weekdays TEXT,
  start_time TEXT CHECK (start_time IS NULL OR start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time TEXT CHECK (end_time IS NULL OR end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  from_date TEXT,
  until_date TEXT,
  zone TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  CHECK (kind != 'regular' OR (weekdays IS NOT NULL AND start_time IS NOT NULL
    AND end_time IS NOT NULL AND from_date IS NOT NULL AND starts_at IS NULL AND ends_at IS NULL)),
  CHECK (kind = 'regular' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at
    AND weekdays IS NULL AND start_time IS NULL AND end_time IS NULL)),
  CHECK (until_date IS NULL OR from_date IS NULL OR until_date >= from_date)
);

CREATE INDEX core_staff_away_account ON core_staff_away (account_id);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '811'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 811;
