-- Migration 0812: offers and takes of shifts, and what the roster's notices and its uncovered
-- shifts read (stage 45 step 3, ADRs 0623 and 0624).
--
-- An offer is a shift (a record of an object that declares `staffed`) its person asks someone
-- else to take, or an uncovered shift a rosterer offers to everyone eligible. Exactly one take
-- wins: an offer moves out of `open` once, and the database refuses every later move, so of
-- twenty takes at once one commits and the rest fail whole (D1 runs one batch at a time). That
-- is the take's guard: the take's statement updates the offer by its id alone, and the trigger
-- below fails the batch when the offer is no longer open. No core_write_guard kind is needed.
--
-- D1 runs with recursive triggers off, so an INSERT OR REPLACE deletes the rows it replaces
-- without firing a delete or update trigger. An offer is therefore never replaced: a BEFORE
-- INSERT trigger refuses an id that exists, and a second open offer of one shift, before any
-- REPLACE could delete the first.
CREATE TABLE core_staff_offer (
  id TEXT PRIMARY KEY,
  -- The shift: its object's registry name and its record.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The shift's person when offered (core_user.id); null for an uncovered shift a rosterer offers.
  from_account TEXT,
  -- Who made it: the shift's person, or a rosterer.
  made_by TEXT NOT NULL,
  -- One named person it is offered to; null for everyone eligible.
  to_account TEXT,
  -- The shift's start (unix seconds), kept current while open: offers lapse in order of it.
  starts INTEGER NOT NULL,
  -- The shift's kind of work (its object and record), kept current while open: a taker's list
  -- reads only offers of the kinds they are qualified for (the take checks again).
  kind_object TEXT,
  kind_record TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'taken', 'withdrawn', 'cancelled', 'lapsed')),
  made_at TEXT NOT NULL,
  taken_by TEXT,
  taken_at TEXT,
  -- When and by whom it left `open` (the host's user for a lapse or a cancel), and why.
  ended_at TEXT,
  ended_by TEXT,
  why TEXT CHECK (why IS NULL OR length(why) <= 200),
  CHECK (state != 'taken' OR (taken_by IS NOT NULL AND taken_at IS NOT NULL)),
  CHECK (state = 'open' OR ended_at IS NOT NULL),
  CHECK (from_account IS NULL OR to_account IS NULL OR to_account != from_account),
  CHECK (from_account IS NULL OR taken_by IS NULL OR taken_by != from_account)
);

-- One open offer per shift; the open offers are read through it (the minute cron's lapse).
CREATE UNIQUE INDEX core_staff_offer_open ON core_staff_offer (object_type, record_id)
  WHERE state = 'open';
-- The open offers in order of their shift's start: the minute cron lapses the nearest first, and
-- takers' lists read the soonest, however many far ones are open.
CREATE INDEX core_staff_offer_due ON core_staff_offer (starts) WHERE state = 'open';
-- A person's open offers, from them and to them (theirs to see; cancelled when they leave).
CREATE INDEX core_staff_offer_from ON core_staff_offer (from_account) WHERE state = 'open';
CREATE INDEX core_staff_offer_to ON core_staff_offer (to_account) WHERE state = 'open';

CREATE TRIGGER core_staff_offer_insert
BEFORE INSERT ON core_staff_offer
BEGIN
  SELECT RAISE(ABORT, 'core_staff_offer_replaced')
  WHERE EXISTS (SELECT 1 FROM core_staff_offer WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'core_staff_offer_closed') WHERE NEW.state != 'open';
  SELECT RAISE(ABORT, 'core_staff_offer_open')
  WHERE EXISTS (
    SELECT 1 FROM core_staff_offer
    WHERE object_type = NEW.object_type AND record_id = NEW.record_id AND state = 'open'
  );
END;

-- An offer leaves `open` once (taken, withdrawn, cancelled or lapsed), and what it offers never
-- changes. The take's race is decided here.
CREATE TRIGGER core_staff_offer_update
BEFORE UPDATE ON core_staff_offer
BEGIN
  SELECT RAISE(ABORT, 'core_staff_offer_closed') WHERE OLD.state != 'open';
  SELECT RAISE(ABORT, 'core_staff_offer_fixed')
  WHERE NEW.id != OLD.id OR NEW.object_type != OLD.object_type OR NEW.record_id != OLD.record_id
    OR NEW.from_account IS NOT OLD.from_account OR NEW.to_account IS NOT OLD.to_account
    OR NEW.made_by != OLD.made_by OR NEW.made_at != OLD.made_at;
END;

-- A batch planned from a read of what it changes (a leaver's future shifts and patterns, ADR 0624)
-- carries how many rows it expects a statement to change, or how many rows of a kind it read; the
-- batch fails whole when that is no longer so (`core_staff_changed`), so what it records and marks
-- is exactly what it changed. Nothing is stored.
CREATE TABLE core_staff_guard (
  expected INTEGER NOT NULL,
  actual INTEGER NOT NULL
);

CREATE TRIGGER core_staff_guard_check
BEFORE INSERT ON core_staff_guard
BEGIN
  SELECT CASE
    WHEN NEW.actual != NEW.expected THEN RAISE(ABORT, 'core_staff_changed')
    ELSE RAISE(IGNORE)
  END;
END;

-- Who is qualified for one kind of work (the offer's eligible people), read by the kind.
CREATE INDEX core_staff_qualification_kind
  ON core_staff_qualification (kind_object, kind_record);

-- The roster's daily work (the uncovered notice): the local date each last ran, so it runs once a
-- day whatever the minute cron does.
CREATE TABLE core_staff_run (
  name TEXT PRIMARY KEY,
  last_date TEXT NOT NULL
) WITHOUT ROWID;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '812'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 812;
