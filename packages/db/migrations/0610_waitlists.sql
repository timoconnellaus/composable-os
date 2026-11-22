-- Migration 0610: waitlists on capacity claimants (stage 31a step 5, ADR 0520).
--
-- A claimant that declares a waitlist (a booking waiting for a full class) holds no place while it
-- waits. Until its cut-off, a place given back while anyone waits is handed to the waitlist in the
-- statements that give it back: a claim of its own on the class's counter, `for_type = 'waitlist'`
-- and `for_id` the claimant object, held. Nobody booking directly can take it, because the counter
-- counts it. The host promotes the first waiter from a current read; the promotion's batch gives
-- one waitlist hold back and claims the waiter's place, so the counter never goes past its places
-- and two promotions for one hold cannot both succeed (the second finds the class full).
--
-- Nothing new is stored beyond those claims; this migration adds:
--   * an index for the minute cron's sweep of waitlist holds;
--   * a guard kind for a waiter's join: the class must be full when the join commits, so nobody
--     waits behind a free place. core_write_guard stores nothing, so it is made again with the
--     new kind (SQLite cannot change a CHECK in place).
CREATE INDEX core_capacity_claim_waitlist_idx ON core_capacity_claim (for_type, state, object_type, record_id)
  WHERE for_type = 'waitlist';

DROP TRIGGER core_write_guard_check;
DROP TABLE core_write_guard;

-- As migration 0560's, with kind 'full': the counter has places and they are all held or taken.
CREATE TABLE core_write_guard (
  kind TEXT NOT NULL CHECK (kind IN ('claimed', 'claimant', 'series', 'full')),
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
    ELSE RAISE(IGNORE)
  END;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '610'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 610;
