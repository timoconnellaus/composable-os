-- Migration 1175: journey signals (stage 53 step 2, ADR 0802).
--
-- The last time each Person had each journey signal a shipped pack declares (`journeySignals` in
-- its manifest: `memberships.started`, `bookings.attended`): one row per Person and signal,
-- written by the host only, in the batch of the write that made it (the pipeline, over the
-- write's recorded changes). A later write of the same signal replaces the row, so the table holds
-- one row per Person per signal however often it happens; an earlier time never replaces a later
-- one. `object_type` and `record_id` name the record that made it (the membership, the booking);
-- `standing` is who stood behind that write, as value marks say it (ADR 0590: `person`,
-- `customer`, `public`, `host`, `ai`), so a journey can hold what an AI's unapproved change
-- started; `bulk` is 1 when the write was a bulk one (an import, a change to many records), which
-- enters nobody unless a journey says so.
--
-- The index on (signal, last_at) is the daily scan's: "no `bookings.attended` for 14 days" reads
-- one signal's rows by time. Signals are a visit history by another name: they are in no `rec_*`
-- view, export or dashboard. Erase deletes a Person's rows; a merge keeps the later of each.
CREATE TABLE core_person_signal (
  person_id TEXT NOT NULL,
  signal TEXT NOT NULL,
  last_at TEXT NOT NULL,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  standing TEXT NOT NULL
    CHECK (standing IN ('person', 'customer', 'public', 'default', 'host', 'ai')),
  bulk INTEGER NOT NULL DEFAULT 0 CHECK (bulk IN (0, 1)),
  PRIMARY KEY (person_id, signal)
) WITHOUT ROWID;

CREATE INDEX core_person_signal_scan_idx ON core_person_signal (signal, last_at);
