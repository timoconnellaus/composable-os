-- Migration 0440: capacity counters and claims (stage 26, the `capacity` behaviour, ADR 0430).
--
-- A record of an object that declares `capacity` has one counter row: how many places it has
-- (NULL is unlimited), how many are held while someone pays and how many are taken. The record's
-- own number field is what staff edit; this row is the host's. A record may draw on one parent's
-- counter as well (its pool: a ticket type's event), named on the counter row. One level only.
--
-- The rule is in the database, not in a read before the write: a claim is a plain
-- `held = held + n` on the record's counter and on its pool's, in the same D1 batch as the write
-- that needs it. If either would go past its places, the statement fails, and with it the whole
-- batch (a batch is one transaction): the order or booking it belonged to is not created either.
-- D1 runs one statement at a time per database, so concurrent claims cannot both pass.
--
--   * core_capacity_within_places (CHECK) is the guarantee: no row can ever hold more than its
--     places, whatever writes it.
--   * core_capacity_refuse_* (BEFORE triggers, same condition) refuse first, with a message
--     carrying the numbers, so the host can say which record refused, what was asked and what was
--     left without reading anything (errors.ts parses `core_capacity_refused {json}`).
CREATE TABLE core_capacity (
  -- The record's object (as in core_stage_history.object_type) and id.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- How many places there are. NULL: unlimited (claims are still counted).
  places INTEGER CHECK (places IS NULL OR places >= 0),
  held INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
  taken INTEGER NOT NULL DEFAULT 0 CHECK (taken >= 0),
  -- The parent counter this record's claims also draw on, or none.
  pool_object_type TEXT,
  pool_record_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id),
  CONSTRAINT core_capacity_within_places CHECK (places IS NULL OR held + taken <= places),
  CHECK ((pool_object_type IS NULL) = (pool_record_id IS NULL)),
  CHECK (pool_object_type IS NULL OR NOT (pool_object_type = object_type AND pool_record_id = record_id)),
  FOREIGN KEY (pool_object_type, pool_record_id) REFERENCES core_capacity (object_type, record_id)
) WITHOUT ROWID;
CREATE INDEX core_capacity_pool_idx ON core_capacity (pool_object_type, pool_record_id);

-- A claim: places taken from a counter (and its pool) for a reason. `held` while paying,
-- `confirmed` once paid, `released` when given back. A hold has no clock of its own: what it was
-- taken for (`for_type`, `for_id`: an order line, later a booking) confirms or releases it in the
-- batch of its own write. The pool it drew on is copied from the counter when the claim is made,
-- so giving it back returns the places to the same pool.
CREATE TABLE core_capacity_claim (
  -- clm_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  pool_object_type TEXT,
  pool_record_id TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'confirmed', 'released')),
  for_type TEXT NOT NULL,
  for_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  released_at TEXT,
  -- A claim names a counter that exists: claiming on a record without one fails the batch.
  FOREIGN KEY (object_type, record_id) REFERENCES core_capacity (object_type, record_id),
  CHECK ((pool_object_type IS NULL) = (pool_record_id IS NULL))
);
CREATE INDEX core_capacity_claim_record_idx ON core_capacity_claim (object_type, record_id, state);
CREATE INDEX core_capacity_claim_for_idx ON core_capacity_claim (for_type, for_id);

-- Refuses a claim (held or taken going up) past the places, or places set below what is claimed,
-- with the numbers. Same condition as core_capacity_within_places.
CREATE TRIGGER core_capacity_refuse_update
BEFORE UPDATE OF places, held, taken ON core_capacity
WHEN NEW.places IS NOT NULL AND NEW.held + NEW.taken > NEW.places
BEGIN
  SELECT RAISE(ABORT, 'core_capacity_refused ' || json_object(
    'object', NEW.object_type,
    'record', NEW.record_id,
    'places', NEW.places,
    'held', OLD.held,
    'taken', OLD.taken,
    'asked', (NEW.held + NEW.taken) - (OLD.held + OLD.taken),
    'available', max(coalesce(OLD.places, NEW.places) - OLD.held - OLD.taken, 0)
  ));
END;

CREATE TRIGGER core_capacity_refuse_insert
BEFORE INSERT ON core_capacity
WHEN NEW.places IS NOT NULL AND NEW.held + NEW.taken > NEW.places
BEGIN
  SELECT RAISE(ABORT, 'core_capacity_refused ' || json_object(
    'object', NEW.object_type,
    'record', NEW.record_id,
    'places', NEW.places,
    'held', NEW.held,
    'taken', NEW.taken,
    'asked', 0,
    'available', 0
  ));
END;

UPDATE core_meta SET value = '440' WHERE key = 'schema_version';
