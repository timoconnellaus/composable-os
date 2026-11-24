-- Migration 0935: the stock ledger (stage 37 step 1, the `stock` behaviour, ADR 0682).
--
-- A record of an object that declares `stock` keeps its counter on capacity's engine
-- (core_capacity, migration 0440): `places` is every unit that came in, less every unit that
-- went out other than by a sale; `taken` is every unit sold; `held` is what unpaid orders hold.
-- On hand is places - taken; available is on hand - held. The database refuses a hold past what
-- is available and a removal below what is held, as it refuses a claim past the places.
--
-- Nobody types on hand: it changes only with a movement, a row here written in the same batch as
-- the counter's change. Each has a kind, a signed quantity, the place it happened at (one default
-- place, 'default', until stock in several places is built: the column means no history is
-- rewritten then), what it came from, who made it and why.
--
-- A movement is never changed or deleted, by any statement shape. D1 runs with recursive
-- triggers off, so the row an INSERT OR REPLACE deletes fires no delete trigger: the insert
-- trigger also refuses an id that already exists (issue #269's lesson, as migration 0850 does).
CREATE TABLE core_stock_movement (
  -- smv_… (ids.ts). A sale's movement takes its claim's ULID, so a claim is sold at most once.
  id TEXT PRIMARY KEY NOT NULL,
  -- The record's object (as in core_capacity.object_type) and id.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- Where it happened. One place per business in this stage.
  place_id TEXT NOT NULL DEFAULT 'default',
  -- Signed: what came in is positive, what went out negative.
  quantity INTEGER NOT NULL CHECK (quantity != 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'opening', 'received', 'sold', 'returned', 'written_off', 'counted', 'adjusted', 'used'
  )),
  -- What it came from: an order line ('order_line', its id), a record ('<object>', its id), or
  -- nothing (a person's adjustment). Never a customer: an order's line id only.
  source_type TEXT,
  source_id TEXT,
  -- Who made it: a staff account (core_users.id) as 'staff', or the platform as 'host'.
  made_by TEXT,
  made_as TEXT NOT NULL CHECK (made_as IN ('staff', 'host')),
  -- Why (an adjustment's reason).
  note TEXT,
  -- What one unit cost, in minor units, on a receipt only.
  unit_cost INTEGER CHECK (unit_cost IS NULL OR (unit_cost >= 0 AND kind = 'received')),
  created_at TEXT NOT NULL,
  CHECK ((source_type IS NULL) = (source_id IS NULL)),
  CHECK (made_as = 'host' OR made_by IS NOT NULL)
);
CREATE INDEX core_stock_movement_record_idx
  ON core_stock_movement (object_type, record_id, created_at);
CREATE INDEX core_stock_movement_source_idx ON core_stock_movement (source_type, source_id);
-- One opening stock per record and place: a second is an adjustment.
CREATE UNIQUE INDEX core_stock_movement_opening
  ON core_stock_movement (object_type, record_id, place_id) WHERE kind = 'opening';

CREATE TRIGGER core_stock_movement_no_update
BEFORE UPDATE ON core_stock_movement
BEGIN
  SELECT RAISE(ABORT, 'core_stock_movement_immutable');
END;

CREATE TRIGGER core_stock_movement_no_delete
BEFORE DELETE ON core_stock_movement
BEGIN
  SELECT RAISE(ABORT, 'core_stock_movement_immutable');
END;

CREATE TRIGGER core_stock_movement_no_replace
BEFORE INSERT ON core_stock_movement
WHEN EXISTS (SELECT 1 FROM core_stock_movement m WHERE m.id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'core_stock_movement_immutable');
END;

-- rec_stock_movement: every movement, for query.sql and dashboards. It names staff accounts and
-- order lines, never a customer.
CREATE VIEW rec_stock_movement AS
SELECT
  id,
  object_type,
  record_id,
  place_id,
  quantity,
  kind,
  source_type,
  source_id,
  made_by,
  made_as,
  note,
  unit_cost,
  created_at
FROM core_stock_movement;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '935'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 935;
