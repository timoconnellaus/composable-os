-- Migration 1271: leave types, leave requests and their days, the balance ledger, and the
-- unavailability row approved leave writes (stage 58 step 4, ADR 0853).
--
-- Leave is a request a person makes (or an approver makes for them) for time off of a type the
-- business sets; approved, the host writes the existing unavailability row for it
-- (`core_staff_away`, kind `leave`, naming the request), so every stage 45 rule about being away
-- holds unchanged. A balance is the sum of a ledger per person and type: entries a pay holder sets
-- or adjusts, and the host's own when leave is approved or an approved request cancelled. The host
-- never accrues. Amounts are integers in the type's unit: minutes for an hours type, hundredths of
-- a day for a days type. No money anywhere.
--
-- All of it is personal (a sick day is health information): in no rec_* view, so no member's SQL,
-- export, dashboard or the assistant's record reads reach it.
--
-- D1 runs with recursive triggers off, so an INSERT OR REPLACE deletes the rows it replaces
-- without firing a delete or update trigger: a request and a balance entry are never replaced (a
-- BEFORE INSERT trigger refuses an id that exists, before a REPLACE could delete it), as an offer
-- is (migration 0812). The lock of a pay period over leave (refusing every change to a request or
-- day dated in a locked period) is migration 1272's (stage 58 step 3).

-- A kind of leave the business offers (annual, personal, unpaid): none ship. `unit` is fixed once
-- anything is recorded in it (the amounts would mean something else). Never deleted once used:
-- a type no longer offered is made inactive.
CREATE TABLE core_leave_type (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  unit TEXT NOT NULL CHECK (unit IN ('hours', 'days')),
  -- 0: the type keeps no balance (unpaid leave, say); nothing is written to the ledger for it.
  keeps_balance INTEGER NOT NULL CHECK (keeps_balance IN (0, 1)),
  -- What approving leave that takes the balance below zero does (decision 9).
  below_zero TEXT NOT NULL CHECK (below_zero IN ('warn', 'refuse')),
  -- Whether it is paid leave: a label for the pay period's export only, never a rate.
  paid INTEGER NOT NULL CHECK (paid IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX core_leave_type_name ON core_leave_type (lower(name));

-- One ask for time off: whole local days from start_date to end_date, or one date with a local
-- start and end time, in `zone` (the organisation's when asked). `requested` moves once, to
-- `approved`, `declined` or `cancelled`; an approved one may later be `cancelled`. Nothing else
-- moves, and what it asks for never changes (cancel and ask again).
CREATE TABLE core_leave_request (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type_id TEXT NOT NULL REFERENCES core_leave_type (id),
  start_date TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  end_date TEXT NOT NULL CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  start_time TEXT CHECK (start_time IS NULL OR start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time TEXT CHECK (end_time IS NULL OR end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  zone TEXT NOT NULL,
  -- The range as instants (ISO), worked out from the dates and times in the zone when asked: what
  -- the unavailability row and the shifts it covers are read by.
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'approved', 'declined', 'cancelled')),
  -- May say why (a medical reason): redacted from the audit log, never in a notice or an error,
  -- kept from the assistant.
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  -- The person, or an approver asking for them.
  asked_by TEXT NOT NULL,
  asked_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  -- Why it was declined or cancelled.
  why TEXT CHECK (why IS NULL OR length(why) <= 200),
  updated_at TEXT NOT NULL,
  CHECK (end_date >= start_date),
  CHECK (ends_at > starts_at),
  CHECK ((start_time IS NULL) = (end_time IS NULL)),
  CHECK (start_time IS NULL OR (end_date = start_date AND end_time > start_time)),
  CHECK (state = 'requested' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

-- A person's requests by their end (their own list, and leaving's cancel of what still waits).
CREATE INDEX core_leave_request_account ON core_leave_request (account_id, end_date);
-- The requests waiting for an approver, soonest first; and every request by its dates (a pay
-- period's lock and leave lines read the period's only).
CREATE INDEX core_leave_request_waiting ON core_leave_request (start_date)
  WHERE state = 'requested';
CREATE INDEX core_leave_request_dates ON core_leave_request (start_date, end_date);

CREATE TRIGGER core_leave_request_insert
BEFORE INSERT ON core_leave_request
BEGIN
  SELECT RAISE(ABORT, 'core_leave_request_fixed')
  WHERE EXISTS (SELECT 1 FROM core_leave_request WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'core_leave_request_closed') WHERE NEW.state != 'requested';
END;

-- `requested` moves once; `approved` only to `cancelled`; a decided request never moves again. Of
-- two approvals at once the second fails whole here. Approved leave is cancelled only once its
-- unavailability row is gone and its ledger entry reversed (earlier in the same batch), so a write
-- planned while it waited (a cancel racing the approval) fails whole rather than leave it away for
-- good. What was asked never changes; its note may only be cleared (erasing a person's notes).
CREATE TRIGGER core_leave_request_update
BEFORE UPDATE ON core_leave_request
BEGIN
  SELECT RAISE(ABORT, 'core_leave_request_held')
  WHERE OLD.state = 'approved' AND NEW.state = 'cancelled' AND (
    EXISTS (SELECT 1 FROM core_staff_away WHERE leave_request = OLD.id)
    OR (EXISTS (SELECT 1 FROM core_leave_balance_entry WHERE request_id = OLD.id
          AND why = 'approved')
      AND NOT EXISTS (SELECT 1 FROM core_leave_balance_entry WHERE request_id = OLD.id
          AND why = 'cancelled')));
  SELECT RAISE(ABORT, 'core_leave_request_closed')
  WHERE NOT (
    (OLD.state = 'requested' AND NEW.state IN ('approved', 'declined', 'cancelled'))
    OR (OLD.state = 'approved' AND NEW.state = 'cancelled')
    OR (NEW.state = OLD.state AND NEW.note IS NULL AND OLD.note IS NOT NULL)
  );
  SELECT RAISE(ABORT, 'core_leave_request_fixed')
  WHERE NEW.id != OLD.id OR NEW.account_id != OLD.account_id OR NEW.type_id != OLD.type_id
    OR NEW.start_date != OLD.start_date OR NEW.end_date != OLD.end_date
    OR NEW.start_time IS NOT OLD.start_time OR NEW.end_time IS NOT OLD.end_time
    OR NEW.zone != OLD.zone OR NEW.starts_at != OLD.starts_at OR NEW.ends_at != OLD.ends_at
    OR NEW.asked_by != OLD.asked_by OR NEW.asked_at != OLD.asked_at
    OR (NEW.note IS NOT OLD.note AND NEW.note IS NOT NULL);
END;

-- Approved leave is a payroll record: never deleted.
CREATE TRIGGER core_leave_request_delete
BEFORE DELETE ON core_leave_request
BEGIN
  SELECT RAISE(ABORT, 'core_leave_request_fixed') WHERE OLD.state = 'approved';
END;

-- Each date of a request and its amount: asked (proposed by the host from the roster, changed by
-- the person), and approved (set by the approver at approval). Integers in the type's unit.
CREATE TABLE core_leave_day (
  request_id TEXT NOT NULL REFERENCES core_leave_request (id),
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  asked INTEGER NOT NULL CHECK (asked BETWEEN 0 AND 1440),
  approved INTEGER CHECK (approved IS NULL OR approved BETWEEN 0 AND 1440),
  PRIMARY KEY (request_id, date)
) WITHOUT ROWID;

-- A pay period's leave lines read its dates only.
CREATE INDEX core_leave_day_date ON core_leave_day (date);

-- A request's days change only while it waits (the approval writes their amounts before it moves
-- the request), and an approved request's days are never removed.
CREATE TRIGGER core_leave_day_insert
BEFORE INSERT ON core_leave_day
BEGIN
  SELECT RAISE(ABORT, 'core_leave_request_closed')
  WHERE NOT EXISTS (SELECT 1 FROM core_leave_request r WHERE r.id = NEW.request_id
    AND r.state = 'requested');
END;

CREATE TRIGGER core_leave_day_update
BEFORE UPDATE ON core_leave_day
BEGIN
  SELECT RAISE(ABORT, 'core_leave_request_closed')
  WHERE NOT EXISTS (SELECT 1 FROM core_leave_request r WHERE r.id = OLD.request_id
    AND r.state = 'requested');
  SELECT RAISE(ABORT, 'core_leave_request_fixed')
  WHERE NEW.request_id != OLD.request_id OR NEW.date != OLD.date;
END;

CREATE TRIGGER core_leave_day_delete
BEFORE DELETE ON core_leave_day
BEGIN
  SELECT RAISE(ABORT, 'core_leave_request_fixed')
  WHERE EXISTS (SELECT 1 FROM core_leave_request r WHERE r.id = OLD.request_id
    AND r.state = 'approved');
END;

-- The balance ledger: insert only, the balance is the sum. `set` and `adjust` are a pay holder's
-- (a set is written as the difference from the sum before it); `approved` and `cancelled` are the
-- host's, one each per request at most.
CREATE TABLE core_leave_balance_entry (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  type_id TEXT NOT NULL REFERENCES core_leave_type (id),
  amount INTEGER NOT NULL,
  why TEXT NOT NULL CHECK (why IN ('set', 'adjust', 'approved', 'cancelled')),
  request_id TEXT REFERENCES core_leave_request (id),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  made_by TEXT NOT NULL,
  made_at TEXT NOT NULL,
  CHECK ((why IN ('approved', 'cancelled')) = (request_id IS NOT NULL))
);

CREATE INDEX core_leave_balance_entry_account ON core_leave_balance_entry (account_id, type_id);
CREATE UNIQUE INDEX core_leave_balance_entry_request ON core_leave_balance_entry (request_id, why)
  WHERE request_id IS NOT NULL;

-- Never replaced, changed or removed. Approving leave of a type that refuses a balance below zero
-- is refused here when it would take the sum below zero, whatever was approved a moment before
-- (decision 9): of two approvals at once that together would, the second fails whole.
CREATE TRIGGER core_leave_balance_entry_insert
BEFORE INSERT ON core_leave_balance_entry
BEGIN
  SELECT RAISE(ABORT, 'core_leave_balance_fixed')
  WHERE EXISTS (SELECT 1 FROM core_leave_balance_entry WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'core_leave_below_zero')
  WHERE NEW.why = 'approved'
    AND EXISTS (SELECT 1 FROM core_leave_type t WHERE t.id = NEW.type_id
      AND t.below_zero = 'refuse')
    AND NEW.amount + coalesce((SELECT sum(e.amount) FROM core_leave_balance_entry e
      WHERE e.account_id = NEW.account_id AND e.type_id = NEW.type_id), 0) < 0;
END;

CREATE TRIGGER core_leave_balance_entry_update
BEFORE UPDATE ON core_leave_balance_entry
BEGIN
  SELECT RAISE(ABORT, 'core_leave_balance_fixed');
END;

CREATE TRIGGER core_leave_balance_entry_delete
BEFORE DELETE ON core_leave_balance_entry
BEGIN
  SELECT RAISE(ABORT, 'core_leave_balance_fixed');
END;

-- A type's unit never changes once a request or a balance entry is in it, and a type in use is
-- never removed.
CREATE TRIGGER core_leave_type_update
BEFORE UPDATE ON core_leave_type
BEGIN
  SELECT RAISE(ABORT, 'core_leave_type_used')
  WHERE (NEW.unit != OLD.unit OR NEW.id != OLD.id)
    AND (EXISTS (SELECT 1 FROM core_leave_request WHERE type_id = OLD.id)
      OR EXISTS (SELECT 1 FROM core_leave_balance_entry WHERE type_id = OLD.id));
END;

CREATE TRIGGER core_leave_type_delete
BEFORE DELETE ON core_leave_type
BEGIN
  SELECT RAISE(ABORT, 'core_leave_type_used')
  WHERE EXISTS (SELECT 1 FROM core_leave_request WHERE type_id = OLD.id)
    OR EXISTS (SELECT 1 FROM core_leave_balance_entry WHERE type_id = OLD.id);
END;

-- The unavailability approved leave wrote (amends ADR 0622): null for one a person said. At most
-- one row per request; `staffing.back` refuses to remove it (cancel the request instead).
ALTER TABLE core_staff_away ADD COLUMN leave_request TEXT;
CREATE UNIQUE INDEX core_staff_away_leave_request ON core_staff_away (leave_request)
  WHERE leave_request IS NOT NULL;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1271'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1271;
