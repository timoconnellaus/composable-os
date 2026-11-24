-- Migration 1092: one client's booked shifts never overlap, refused at commit (stage 49 step 4,
-- ADR 0763, the review of PR #430).
--
-- A shift booked at free times (`staffed.open`, an appointment) names its client, and a
-- customer's or visitor's booking must not overlap another live one of theirs. A uniqueness
-- cannot express a range, and the host's read before the write cannot see a booking another
-- batch commits meanwhile, so the write's batch carries one guard statement: an insert here
-- whose `clashes` is the count, read inside the batch, of the client's other live shifts of the
-- object overlapping the new time. D1 runs one batch at a time, so of two bookings racing for the
-- same client the second batch sees the first and fails whole. The trigger refuses a count above
-- zero and otherwise drops the row: the table never holds one. No migration touches an x_* table:
-- the count's SQL names the object's table and is written by the host (core/src/staffing/free.ts).
CREATE TABLE core_client_guard (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  clashes INTEGER NOT NULL
);

CREATE TRIGGER core_client_guard_check
BEFORE INSERT ON core_client_guard
BEGIN
  SELECT CASE
    WHEN NEW.clashes > 0 THEN RAISE(ABORT, 'core_client_busy')
    ELSE RAISE(IGNORE)
  END;
END;
