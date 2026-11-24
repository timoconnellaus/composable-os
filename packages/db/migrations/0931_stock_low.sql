-- Migration 0931: low stock, once per crossing (stage 37 step 2, ADR 0681).
--
-- When a write takes a stock record's on hand to or below its reorder level, the staff who keep
-- stock are told once, until it rises above the level again. A row here says the record is at or
-- below its level now: the host deletes it in the batch of a write that leaves the record above
-- (or with no level), and inserts it, keeping the one already there, in the batch of a write that
-- leaves it at or below. `crossing` names this time below the level (each notice's dedupe key is
-- built from it) and `told_at` says its notices were written, so every later write while the
-- record stays low tells nobody again, however long it stays (notices are purged after 90 days),
-- and the next fall after a rise makes a new crossing and new notices. Nothing reads it but the host's own
-- statements (stock/low.ts); a dropped object's rows go with its counters.
CREATE TABLE core_stock_low (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- stl_…: this crossing. A notice's dedupe key is 'stock_low:' || crossing.
  crossing TEXT NOT NULL,
  since TEXT NOT NULL,
  -- When its notices were written; NULL until the end of the batch that began it.
  told_at TEXT,
  PRIMARY KEY (object_type, record_id)
);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '931'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 931;
