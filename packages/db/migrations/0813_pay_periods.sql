-- Migration 0813: pay periods (stage 45 step 6, ADR 0627). Who is counted for pay, the mark that
-- a shift was not worked, and each locked pay period with its lines. No rates and no money are
-- held anywhere (decision 14): hours (as whole minutes) and counts only; payroll applies the rates.
--
-- All of it is about staff accounts and their pay: core tables in no rec_* view, so no dashboard,
-- query.sql, export.csv or the assistant's record reads reach them. They are read only through
-- the host's tool-only operations, by a person holding the pay permission (`rostering:pay`).
--
-- A locked period never changes, for every writer. The triggers below refuse it here; the
-- triggers the schema reconciler builds on each staffed object's own table refuse a change of the
-- person, times, kind or liveness of a shift inside a locked period (staffing/sql.ts). D1 runs
-- with recursive triggers off, so the rows an INSERT OR REPLACE or an UPDATE OR REPLACE deletes
-- fire no delete trigger: each table's BEFORE INSERT also refuses replacing a row it protects,
-- and its BEFORE UPDATE refuses every change it does not allow (a replace is one of them).

-- Who is counted (ADR 0627): `by_time`, `by_class` or `not_counted` (no row at all is not
-- counted), from a local date on, so a period totalled again uses the basis in force on each
-- shift's own date. Set by a person holding the pay permission.
CREATE TABLE core_staff_pay_basis (
  account_id TEXT NOT NULL,
  -- In force from this local date (the organisation's zone) until the next row's.
  from_date TEXT NOT NULL CHECK (from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  basis TEXT NOT NULL CHECK (basis IN ('by_time', 'by_class', 'not_counted')),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  PRIMARY KEY (account_id, from_date)
) WITHOUT ROWID;

-- A shift marked not worked (ADR 0627): it counts for nothing, with why. Set by a rosterer after
-- the shift started. `starts` is the shift's start when marked (unix seconds), read by the lock.
CREATE TABLE core_staff_not_worked (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  starts INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  marked_by TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id)
) WITHOUT ROWID;

-- One version of one pay period (ADR 0627). Locking writes it `locking`, its lines, then
-- `locked`, in one batch; a locked version is reopened (with why) and never changed again;
-- locking that period again writes the next version and keeps the old. The dates are local in
-- `zone`; `starts` and `ends` are their local midnights as unix seconds (half-open), which the
-- shifts' locks read.
CREATE TABLE core_pay_period (
  id TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  zone TEXT NOT NULL,
  starts INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN ('locking', 'locked', 'reopened')),
  locked_by TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  reopened_by TEXT,
  reopened_at TEXT,
  reopen_reason TEXT CHECK (reopen_reason IS NULL OR length(reopen_reason) BETWEEN 1 AND 500),
  CHECK (end_date >= start_date),
  CHECK (ends > starts),
  CHECK ((state = 'reopened') = (reopened_by IS NOT NULL AND reopened_at IS NOT NULL
    AND reopen_reason IS NOT NULL)),
  UNIQUE (start_date, version)
);

-- At most one version of a period is locked (or being locked) at a time.
CREATE UNIQUE INDEX core_pay_period_held ON core_pay_period (start_date)
  WHERE state IN ('locking', 'locked');
-- What a shift's lock reads: the locked periods by end, so a write reads only the periods that
-- end after its shift starts (never every past period: the review of PR #287).
CREATE INDEX core_pay_period_state ON core_pay_period (state, ends, starts);

-- One line per shift counted in a locked period (ADR 0627): who, on what basis, the shift as it
-- was, the minutes counted (its own minutes plus the kind's before and after minutes, or none
-- when marked not worked), and its evidence. The person's name and email are kept as they were:
-- the business's payroll records, which it may have to keep.
CREATE TABLE core_pay_line (
  period_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('by_time', 'by_class')),
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  kind_object TEXT,
  kind_record TEXT,
  kind_name TEXT NOT NULL,
  title TEXT NOT NULL,
  place TEXT,
  -- The shift's own time, unix seconds, and the local date and times in the period's zone.
  starts INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  local_start TEXT NOT NULL,
  local_end TEXT NOT NULL,
  shift_minutes INTEGER NOT NULL CHECK (shift_minutes >= 0),
  before_minutes INTEGER NOT NULL CHECK (before_minutes >= 0),
  after_minutes INTEGER NOT NULL CHECK (after_minutes >= 0),
  -- 0 when marked not worked; else shift + before + after.
  counted_minutes INTEGER NOT NULL CHECK (counted_minutes >= 0),
  -- 1, or 0 when marked not worked.
  counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
  not_worked_reason TEXT,
  -- Evidence: whether its list was taken (null: the kind of shift keeps none), who took it (names,
  -- comma separated), and whether someone other than its person did (for review).
  list_taken INTEGER CHECK (list_taken IS NULL OR list_taken IN (0, 1)),
  marked_by TEXT,
  flagged INTEGER NOT NULL CHECK (flagged IN (0, 1)),
  PRIMARY KEY (period_id, n)
) WITHOUT ROWID;

CREATE INDEX core_pay_line_account ON core_pay_line (period_id, account_id);

-- A period's rows: made `locking` with a version no other holds and dates that overlap no
-- locked period; never replaced (a REPLACE would delete a locked one without a trigger).
CREATE TRIGGER core_pay_period_insert
BEFORE INSERT ON core_pay_period
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_fixed')
  WHERE NEW.state != 'locking'
    OR EXISTS (SELECT 1 FROM core_pay_period p WHERE p.id = NEW.id);
  -- Two locks of one period at once: the second finds the first's version (it is held).
  SELECT RAISE(ABORT, 'core_pay_period_held')
  WHERE EXISTS (SELECT 1 FROM core_pay_period p
    WHERE p.start_date = NEW.start_date AND p.version = NEW.version);
  SELECT RAISE(ABORT, 'core_pay_period_overlap')
  WHERE EXISTS (SELECT 1 FROM core_pay_period p WHERE p.state IN ('locking', 'locked')
    AND p.starts < NEW.ends AND p.ends > NEW.starts);
END;

-- Only `locking` to `locked`, and `locked` to `reopened` with who, when and why; nothing else
-- ever changes, and a reopened version never changes again.
CREATE TRIGGER core_pay_period_update
BEFORE UPDATE ON core_pay_period
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_fixed')
  WHERE NEW.id IS NOT OLD.id OR NEW.start_date IS NOT OLD.start_date
    OR NEW.end_date IS NOT OLD.end_date OR NEW.zone IS NOT OLD.zone
    OR NEW.starts IS NOT OLD.starts OR NEW.ends IS NOT OLD.ends
    OR NEW.version IS NOT OLD.version OR NEW.locked_by IS NOT OLD.locked_by
    OR NEW.locked_at IS NOT OLD.locked_at
    OR NOT ((OLD.state = 'locking' AND NEW.state = 'locked' AND NEW.reopened_by IS NULL)
      OR (OLD.state = 'locked' AND NEW.state = 'reopened'));
END;

CREATE TRIGGER core_pay_period_delete
BEFORE DELETE ON core_pay_period
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_fixed');
END;

-- Lines are written only into a version being locked (in its own batch), and never changed or
-- removed: a locked period's lines are its totals for good.
CREATE TRIGGER core_pay_line_insert
BEFORE INSERT ON core_pay_line
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_fixed')
  WHERE NOT EXISTS (SELECT 1 FROM core_pay_period p WHERE p.id = NEW.period_id
      AND p.state = 'locking')
    OR EXISTS (SELECT 1 FROM core_pay_line l WHERE l.period_id = NEW.period_id AND l.n = NEW.n);
END;

CREATE TRIGGER core_pay_line_update
BEFORE UPDATE ON core_pay_line
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_fixed');
END;

CREATE TRIGGER core_pay_line_delete
BEFORE DELETE ON core_pay_line
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_fixed');
END;

-- Who is counted cannot change for a date inside a locked period: a basis from a date on or
-- before a locked period's last date would change what that period totals.
CREATE TRIGGER core_staff_pay_basis_insert
BEFORE INSERT ON core_staff_pay_basis
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_locked')
  WHERE EXISTS (SELECT 1 FROM core_pay_period p WHERE p.state IN ('locking', 'locked')
    AND p.end_date >= NEW.from_date);
END;

CREATE TRIGGER core_staff_pay_basis_update
BEFORE UPDATE ON core_staff_pay_basis
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_locked')
  WHERE EXISTS (SELECT 1 FROM core_pay_period p WHERE p.state IN ('locking', 'locked')
    AND (p.end_date >= NEW.from_date OR p.end_date >= OLD.from_date));
END;

CREATE TRIGGER core_staff_pay_basis_delete
BEFORE DELETE ON core_staff_pay_basis
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_locked')
  WHERE EXISTS (SELECT 1 FROM core_pay_period p WHERE p.state IN ('locking', 'locked')
    AND p.end_date >= OLD.from_date);
END;

-- A shift inside a locked period is not marked or unmarked (a REPLACE of a mark is an insert,
-- and the row it would replace is checked too).
CREATE TRIGGER core_staff_not_worked_insert
BEFORE INSERT ON core_staff_not_worked
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_locked')
  WHERE EXISTS (SELECT 1 FROM core_pay_period p WHERE p.state IN ('locking', 'locked')
    AND (
      (p.ends > NEW.starts AND p.starts <= NEW.starts)
      OR EXISTS (SELECT 1 FROM core_staff_not_worked m WHERE m.object_type = NEW.object_type
        AND m.record_id = NEW.record_id AND p.ends > m.starts AND p.starts <= m.starts)
    ));
END;

CREATE TRIGGER core_staff_not_worked_update
BEFORE UPDATE ON core_staff_not_worked
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_locked')
  WHERE EXISTS (SELECT 1 FROM core_pay_period p WHERE p.state IN ('locking', 'locked')
    AND ((p.ends > NEW.starts AND p.starts <= NEW.starts)
      OR (p.ends > OLD.starts AND p.starts <= OLD.starts)
      OR EXISTS (SELECT 1 FROM core_staff_not_worked m WHERE m.object_type = NEW.object_type
        AND m.record_id = NEW.record_id AND p.ends > m.starts AND p.starts <= m.starts)));
END;

CREATE TRIGGER core_staff_not_worked_delete
BEFORE DELETE ON core_staff_not_worked
BEGIN
  SELECT RAISE(ABORT, 'core_pay_period_locked')
  WHERE EXISTS (SELECT 1 FROM core_pay_period p WHERE p.state IN ('locking', 'locked')
    AND p.ends > OLD.starts AND p.starts <= OLD.starts);
END;

-- A period's marks, read by their shifts' start (a period's totals and the lock's guard).
CREATE INDEX core_staff_not_worked_starts ON core_staff_not_worked (starts);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '813'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 813;
