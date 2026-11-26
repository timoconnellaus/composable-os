-- Migration 1413: the file source's age notices and its load guard (stage 65 step 4, ADR 0923).
--
-- The minute cron tells the holders of bookingSystem:manage when the current members list is 3
-- days from the largest age (`told_soon_at`) and when it passes it and stops counting for members'
-- prices and programs (`told_old_at`). Each is set in the batch that writes the notices, guarded by
-- `IS NULL`, so a list is told each thing once whatever the ticks do. A new list is a new row, so
-- it is told afresh. Times only: never a name or an address.
ALTER TABLE core_outside_list ADD COLUMN told_soon_at TEXT;
ALTER TABLE core_outside_list ADD COLUMN told_old_at TEXT;

-- The copy's version: what a load's plan read and must still hold when its batch commits (the
-- current lists, the erased people's suppressions, the erased-address list, every link and staff's
-- unlink decisions). Counts, rowids and times only, never a value. An erase, a link, an unlink, a
-- lift, a merge's or a purge's link change, or another load between a load's plan and its batch
-- changes it, and the guard below then fails the load's whole batch (stage 65 step 4's review, S3),
-- so the batch can never put back what an erase removed.
CREATE VIEW core_outside_version AS SELECT
  coalesce((SELECT group_concat(id, ',') FROM
    (SELECT id FROM core_outside_list WHERE state = 'current' ORDER BY id)), '')
  || '|' || (SELECT count(*) || ':' || coalesce(max(rowid), 0) FROM core_outside_suppressed)
  || '|' || (SELECT count(*) || ':' || coalesce(max(erased_at), '') FROM core_erased_address)
  || '|' || (SELECT count(*) || ':' || coalesce(max(linked_at), '') || ':'
      || coalesce(sum(length(person_id)), 0) FROM core_outside_person WHERE link_how IS NOT NULL)
  || '|' || (SELECT count(*) || ':' || coalesce(max(linked_at), '') || ':'
      || coalesce(sum(length(user_id)), 0) FROM core_outside_staff WHERE link_how IS NOT NULL)
  || '|' || (SELECT count(*) || ':' || coalesce(max(unlinked_at), '') FROM core_outside_unlinked)
  AS version;

-- The load's guard, the first statement of its batch: one row saying which version its plan read.
-- The trigger compares it with the version now and fails the batch (`core_outside_stale`) when it
-- moved, or drops the row (still true). Nothing is ever stored here. Its own table, not a
-- core_write_guard kind (stage 65's "no core_write_guard kind").
CREATE TABLE core_load_guard (
  expected TEXT NOT NULL
);

CREATE TRIGGER core_load_guard_check
BEFORE INSERT ON core_load_guard
BEGIN
  SELECT CASE
    WHEN (SELECT version FROM core_outside_version) IS NOT NEW.expected
      THEN RAISE(ABORT, 'core_outside_stale')
    ELSE RAISE(IGNORE)
  END;
END;
