-- Migration 1095: the `occupies` behaviour's claim on a thing (stage 49 step 2, ADR 0765).
--
-- A record of an object that declares `occupies` takes a thing (a room, a chair, a hall) for its
-- time. Every live record holds one claim here per thing it names that is claimed (only things
-- marked as taking one booking at a time, when the declaration says so): the record, the thing,
-- and the record's time with its margins (minutes before and after) as whole unix seconds,
-- half-open (09:00 to 10:00 and 10:00 to 11:00 do not clash). The database refuses a claim that
-- overlaps another on the same thing, whatever object holds it (an appointment and a class in one
-- private room), whoever writes and however many write at once: D1 runs one batch at a time, so
-- of two batches that would put two records in one room at once, the second fails whole.
--
-- The claims are kept by triggers the schema reconciler builds on each declaring object's table,
-- on the thing's table (its flag changing) and on the table its margins are read from
-- (core/src/occupies/sql.ts), as core_staff_time's are (migration 0811). No migration touches an
-- x_* table. D1 runs with recursive triggers off, so the rows an INSERT OR REPLACE or an UPDATE OR
-- REPLACE deletes fire no delete trigger: the checks below are BEFORE INSERT and BEFORE UPDATE on
-- every column (a REPLACE and an upsert are inserts first, and an id update is an update), and
-- each leaves out only the row's own key, which such a statement replaces. A claim left behind by
-- a row a REPLACE deleted can only refuse more, never let two occupants through.
CREATE TABLE core_thing_time (
  -- The occupant: its object's registry name and its record.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The thing: its object's registry name and its record (a room).
  thing_object TEXT NOT NULL,
  thing_record TEXT NOT NULL,
  -- The occupant's time with its margins, unix seconds.
  starts INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  PRIMARY KEY (object_type, record_id, thing_object, thing_record),
  CHECK (ends > starts)
) WITHOUT ROWID;

-- By thing and end: an overlap check reads only the claims that end after the new one starts (a
-- room's past bookings are never read), however long its history.
CREATE INDEX core_thing_time_thing ON core_thing_time (thing_object, thing_record, ends, starts);

CREATE TRIGGER core_thing_time_insert
BEFORE INSERT ON core_thing_time
BEGIN
  SELECT RAISE(ABORT, 'core_thing_double_booked')
  WHERE EXISTS (
    SELECT 1 FROM core_thing_time c
    WHERE c.thing_object = NEW.thing_object AND c.thing_record = NEW.thing_record
      AND NOT (c.object_type = NEW.object_type AND c.record_id = NEW.record_id)
      AND c.ends > NEW.starts AND c.starts < NEW.ends
  );
END;

CREATE TRIGGER core_thing_time_update
BEFORE UPDATE ON core_thing_time
BEGIN
  SELECT RAISE(ABORT, 'core_thing_double_booked')
  WHERE EXISTS (
    SELECT 1 FROM core_thing_time c
    WHERE c.thing_object = NEW.thing_object AND c.thing_record = NEW.thing_record
      AND NOT (c.object_type = OLD.object_type AND c.record_id = OLD.record_id
        AND c.thing_object = OLD.thing_object AND c.thing_record = OLD.thing_record)
      AND NOT (c.object_type = NEW.object_type AND c.record_id = NEW.record_id)
      AND c.ends > NEW.starts AND c.starts < NEW.ends
  );
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1095'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1095;
