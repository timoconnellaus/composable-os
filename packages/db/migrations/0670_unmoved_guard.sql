-- Migration 0670: a guard that the record a write is for has not moved meanwhile (stage 31a
-- step 7, ADR 0550).
--
-- A booking is made only while its class is scheduled (`states.create.closed`, ADR 0507): the
-- check reads the class when the write is planned. A class cancelled between that read and the
-- booking's commit would otherwise be left with a booking its cancel never saw (the cancel moves
-- the bookings it reads, in its own batch). So a write judged against a `closed` flag queues a
-- guard on the record the flag is read through: the number of moves in its state history
-- (core_transition_history, ADR 0425) must still be what was read. A move in between adds a row,
-- and the write's batch fails whole (`core_moved_meanwhile`, answered as a conflict).
--
-- core_write_guard stores nothing, so it is made again with the new kind (SQLite cannot change a
-- CHECK in place), as migrations 0560 and 0610 did.
DROP TRIGGER core_write_guard_check;
DROP TABLE core_write_guard;

-- As migration 0610's, with kind 'unmoved': the record's state history has `expected` rows.
CREATE TABLE core_write_guard (
  kind TEXT NOT NULL CHECK (kind IN ('claimed', 'claimant', 'series', 'full', 'unmoved')),
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  expected INTEGER NOT NULL
);

CREATE TRIGGER core_write_guard_check
BEFORE INSERT ON core_write_guard
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'claimed' AND coalesce((SELECT held + taken FROM core_capacity
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id), 0) != NEW.expected
      THEN RAISE(ABORT, 'core_recurrence_stale')
    WHEN NEW.kind = 'series' AND coalesce((SELECT version FROM core_recurrence_series
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id), 0) != NEW.expected
      THEN RAISE(ABORT, 'core_recurrence_stale')
    WHEN NEW.kind = 'claimant' AND (SELECT count(*) FROM core_capacity_claim
        WHERE for_type = NEW.object_type AND for_id = NEW.record_id
          AND state IN ('held', 'confirmed')) != NEW.expected
      THEN RAISE(ABORT, 'core_claim_live')
    WHEN NEW.kind = 'full' AND NOT EXISTS (SELECT 1 FROM core_capacity
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id
          AND places IS NOT NULL AND held + taken >= places)
      THEN RAISE(ABORT, 'core_waitlist_not_full')
    WHEN NEW.kind = 'unmoved' AND (SELECT count(*) FROM core_transition_history
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id) != NEW.expected
      THEN RAISE(ABORT, 'core_moved_meanwhile')
    ELSE RAISE(IGNORE)
  END;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '670'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 670;
