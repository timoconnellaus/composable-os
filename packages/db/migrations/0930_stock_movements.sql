-- Migration 0930: the stock ledger (stage 37 step 1, the `stock` behaviour, ADR 0680).
--
-- A record of an object that declares `stock` keeps its count on capacity's counter
-- (core_capacity, migration 0440): `places` is every unit that came in less every unit that went
-- out by a movement other than a sale, `taken` every unit sold, `held` what unpaid orders hold.
-- On hand is places - taken; available is on hand - held. Nobody writes the counter's places for
-- a stock record: the host changes it only with a movement here, in the same batch, so the
-- ledger's sum for a record is always its on hand. A sale is capacity's claim (held while the
-- order is unpaid, refused by the database past what is available, taken when paid) and writes
-- its `sold` row here when it is taken.
--
-- Every row carries a place: always 'default' until stock is kept in several places (stage 37's
-- designed later step), so places can be added without rewriting history.
--
-- Nobody changes or deletes a movement, by any statement shape. D1 runs with recursive triggers
-- off, so the row an INSERT OR REPLACE deletes fires no delete trigger (issue #269): the table
-- refuses an insert over an existing id, an update and a delete, and has no unique index but its
-- key. A dropped object's movements stay: they name records and staff, never customers.
CREATE TABLE core_stock_movement (
  -- stm_… (ids.ts). A sale's row is named after its claim (stm_ + the claim's ULID).
  id TEXT PRIMARY KEY NOT NULL,
  -- The record whose stock moved: its object (as in core_capacity.object_type) and id.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  place TEXT NOT NULL DEFAULT 'default',
  -- Signed: what came in is positive, what went out negative.
  quantity INTEGER NOT NULL CHECK (quantity <> 0),
  kind TEXT NOT NULL CHECK (kind IN ('opening', 'received', 'sold', 'returned', 'written_off', 'counted', 'adjusted', 'used')),
  -- What moved it: an order line ('order_line', its id), a record (its object, its id), or a
  -- person's own correction ('user', their id).
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  -- The staff account that made it; NULL when the host did (a paid order's sale).
  by_user TEXT,
  at TEXT NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  -- The cost of one, in minor units, for what was received.
  unit_cost INTEGER CHECK (unit_cost IS NULL OR unit_cost >= 0),
  CHECK (kind <> 'sold' OR quantity < 0),
  CHECK (kind <> 'opening' OR quantity > 0)
);
CREATE INDEX core_stock_movement_record_idx ON core_stock_movement (object_type, record_id, at);
CREATE INDEX core_stock_movement_source_idx ON core_stock_movement (source_type, source_id);

CREATE TRIGGER core_stock_movement_new
BEFORE INSERT ON core_stock_movement
WHEN EXISTS (SELECT 1 FROM core_stock_movement m WHERE m.id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'core_stock_movement_immutable');
END;

-- Opening stock is a record's first stock, once: a second is refused (a correction is `adjusted`).
CREATE TRIGGER core_stock_opening_once
BEFORE INSERT ON core_stock_movement
WHEN NEW.kind = 'opening' AND EXISTS (
  SELECT 1 FROM core_stock_movement m
  WHERE m.object_type = NEW.object_type AND m.record_id = NEW.record_id AND m.kind = 'opening'
)
BEGIN
  SELECT RAISE(ABORT, 'core_stock_opening_exists');
END;

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

-- rec_stock_movement: the ledger, for query.sql and dashboards. It names order lines and staff,
-- never a customer.
CREATE VIEW rec_stock_movement AS
SELECT
  id,
  object_type,
  record_id,
  place,
  quantity,
  kind,
  source_type,
  source_id,
  by_user,
  at,
  note,
  unit_cost
FROM core_stock_movement;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '930'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 930;
