-- Migration 1270: time entries, the one record of time worked (stage 58 step 1, ADR 0850).
--
-- One stretch of time a staff member worked: a start and a finish as whole unix seconds (the
-- host's clock for a clocked entry, never the phone's), unpaid break minutes they entered, the
-- zone it was given in and its local date (of its start, in the organisation's zone: the pay
-- period it belongs to), and what it was against: a shift (a record of a `staffed` object), a
-- record of an object that declares `workedOn` (a job), or nothing (other work). How it was made
-- (clocked, entered, or entered by an approver, with why) and its state (open while clocked in,
-- waiting for an approver, approved, rejected). Approval (step 2) keeps the times as recorded
-- beside the approved ones.
--
-- Keyed by a staff account (core_user.id), text with no foreign key, as core_staff_time is.
-- About someone's working day: in no rec_* view, so no member's SQL, export, dashboard or the
-- assistant's record reads see it.
--
-- The database refuses two entries of one account that overlap, for every writer and statement
-- shape, as core_staff_time refuses two shifts: half-open ranges (09:00 to 12:00 and 12:00 to
-- 15:00 do not overlap), and an open entry runs on from its start (it overlaps everything after).
-- D1 runs with recursive triggers off, so the rows an INSERT OR REPLACE or an UPDATE OR REPLACE
-- deletes fire no delete trigger: the checks are BEFORE INSERT (a REPLACE and an upsert are
-- inserts first) and BEFORE UPDATE (an id update is an update), and each leaves out only the
-- row's own id, which such a statement replaces, so a REPLACE can only refuse more. An entry is
-- separate from the shift claim: it may run past its shift into another shift's rostered time.
--
-- One open entry per account (a partial unique index): of twenty starts at once, one lands. A
-- start retried with its idempotency key (`start_key`) finds the entry it made.
CREATE TABLE core_time_entry (
  -- NOT NULL: a rowid table's TEXT key would otherwise take a NULL, which no comparison matches.
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  starts INTEGER NOT NULL,
  -- Null while open (clocked in, not yet finished).
  ends INTEGER,
  break_minutes INTEGER NOT NULL DEFAULT 0 CHECK (break_minutes >= 0 AND break_minutes <= 1440),
  zone TEXT NOT NULL,
  local_date TEXT NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  -- What it was against: a shift or a workedOn record (its object's registry name and id), or
  -- both null for other work.
  against_object TEXT,
  against_record TEXT,
  how TEXT NOT NULL CHECK (how IN ('clocked', 'entered', 'by_approver')),
  -- Why an approver entered it for someone (`by_approver` only).
  how_why TEXT CHECK (how_why IS NULL OR length(how_why) <= 500),
  state TEXT NOT NULL CHECK (state IN ('open', 'waiting', 'approved', 'rejected')),
  -- The host found it open past its shift's end (or long after its start): the person is told to
  -- enter their finish. No finish is ever invented.
  finish_missing INTEGER NOT NULL DEFAULT 0 CHECK (finish_missing IN (0, 1)),
  -- The times as recorded, kept beside when an approver approves it changed (step 2).
  recorded_starts INTEGER,
  recorded_ends INTEGER,
  recorded_break_minutes INTEGER,
  -- An account, or 'host' when it matched the roster (step 2).
  approved_by TEXT,
  approved_at TEXT,
  rejected_why TEXT CHECK (rejected_why IS NULL OR length(rejected_why) <= 500),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  -- The idempotency key of the start that made it (a clocked entry), unique per account.
  start_key TEXT CHECK (start_key IS NULL OR length(start_key) BETWEEN 16 AND 128),
  -- Who made it: the person, or an approver for them.
  made_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'open') = (ends IS NULL)),
  CHECK (ends IS NULL OR ends > starts),
  CHECK (ends IS NULL OR break_minutes * 60 < ends - starts),
  CHECK ((against_object IS NULL) = (against_record IS NULL)),
  CHECK ((how = 'by_approver') = (how_why IS NOT NULL)),
  CHECK (finish_missing = 0 OR state = 'open'),
  CHECK ((recorded_starts IS NULL) = (recorded_ends IS NULL))
);

-- One open entry per account: a second start while one is open fails on this, however many race.
CREATE UNIQUE INDEX core_time_entry_open ON core_time_entry (account_id) WHERE ends IS NULL;

-- A retried start finds its entry; two starts with one key make one.
CREATE UNIQUE INDEX core_time_entry_start_key ON core_time_entry (account_id, start_key)
  WHERE start_key IS NOT NULL;

-- By account and end (an open entry's end read as the far future, the expression the overlap
-- triggers use): an overlap check reads only the entries that end after the new one starts, never
-- an account's history.
CREATE INDEX core_time_entry_account_end
  ON core_time_entry (account_id, ifnull(ends, 9223372036854775807), starts);

-- A person's timesheet and a pay period's entries: by account and local date.
CREATE INDEX core_time_entry_account_date ON core_time_entry (account_id, local_date);

-- A period's entries of everyone, and a shift's or a job's entries.
CREATE INDEX core_time_entry_date ON core_time_entry (local_date);
CREATE INDEX core_time_entry_against ON core_time_entry (against_object, against_record)
  WHERE against_object IS NOT NULL;

-- The open entries the minute cron looks at for a missing finish, oldest first.
CREATE INDEX core_time_entry_open_starts ON core_time_entry (starts)
  WHERE ends IS NULL AND finish_missing = 0;

CREATE TRIGGER core_time_entry_overlap_insert
BEFORE INSERT ON core_time_entry
BEGIN
  -- A second open entry (of twenty starts at once, all but one): said as such, before the overlap
  -- it also is.
  SELECT RAISE(ABORT, 'core_time_open')
  WHERE NEW.ends IS NULL AND EXISTS (
    SELECT 1 FROM core_time_entry e
    WHERE e.account_id = NEW.account_id
      AND e.id IS NOT NEW.id
      AND e.ends IS NULL
  );
  SELECT RAISE(ABORT, 'core_time_overlap')
  WHERE EXISTS (
    SELECT 1 FROM core_time_entry e
    WHERE e.account_id = NEW.account_id
      AND e.id IS NOT NEW.id
      AND ifnull(e.ends, 9223372036854775807) > NEW.starts
      AND e.starts < ifnull(NEW.ends, 9223372036854775807)
  );
END;

CREATE TRIGGER core_time_entry_overlap_update
BEFORE UPDATE ON core_time_entry
BEGIN
  -- A second open entry (of twenty starts at once, all but one): said as such, before the overlap
  -- it also is.
  SELECT RAISE(ABORT, 'core_time_open')
  WHERE NEW.ends IS NULL AND EXISTS (
    SELECT 1 FROM core_time_entry e
    WHERE e.account_id = NEW.account_id
      AND e.id IS NOT OLD.id
      AND e.id IS NOT NEW.id
      AND e.ends IS NULL
  );
  SELECT RAISE(ABORT, 'core_time_overlap')
  WHERE EXISTS (
    SELECT 1 FROM core_time_entry e
    WHERE e.account_id = NEW.account_id
      AND e.id IS NOT OLD.id
      AND e.id IS NOT NEW.id
      AND ifnull(e.ends, 9223372036854775807) > NEW.starts
      AND e.starts < ifnull(NEW.ends, 9223372036854775807)
  );
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1270'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1270;
