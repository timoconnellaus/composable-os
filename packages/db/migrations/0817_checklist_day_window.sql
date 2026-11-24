-- Migration 0817: when a day's checklist may be ticked, and when it is missed (ADR 0651, amended
-- 2026-11-24 after the review of #383).
--
-- Migration 0816 holds who may tick or finish a day's checklist; the host alone held when. Now the
-- database does too, for every writer:
-- - a tick on a day run is made inside its day (`ticked_at` from its `opens` to before its
--   `closes`);
-- - a day run is closed as missed only once its day has ended (`closed_at` at or after its
--   `closes`), and by nobody: no closer, no person, no why (the minute cron's close).
-- The time judged is the one the writer records (`ticked_at`, `closed_at`), as every time in the
-- host is the caller's clock: a host bug or a script closing a run at noon, or ticking one
-- tomorrow, is refused; one that writes a false time is not, as for any other time it writes.

CREATE TRIGGER core_checklist_day_run_missed
BEFORE UPDATE ON core_checklist_run
WHEN OLD.object_type = 'checklist.day' AND OLD.state = 'open' AND NEW.state = 'missed'
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_window')
  WHERE NEW.closed_by IS NOT NULL OR NEW.account_id IS NOT NULL OR NEW.closed_why IS NOT NULL
    OR NEW.closed_at IS NULL OR strftime('%s', NEW.closed_at) IS NULL
    OR CAST(strftime('%s', NEW.closed_at) AS INTEGER) < OLD.closes;
END;

-- An open run only: a closed one's ticks are migration 0815's to refuse, whichever fires first.
CREATE TRIGGER core_checklist_day_tick_window
BEFORE INSERT ON core_checklist_tick
WHEN EXISTS (SELECT 1 FROM core_checklist_run r WHERE r.id = NEW.run_id
  AND r.object_type = 'checklist.day' AND r.state = 'open')
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_window')
  WHERE strftime('%s', NEW.ticked_at) IS NULL OR EXISTS (
    SELECT 1 FROM core_checklist_run r WHERE r.id = NEW.run_id
      AND (CAST(strftime('%s', NEW.ticked_at) AS INTEGER) < r.opens
        OR CAST(strftime('%s', NEW.ticked_at) AS INTEGER) >= r.closes));
END;
