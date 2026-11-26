-- Migration 1412: which erase a booking-system suppression came from, and the salt it was keyed
-- with (stage 65 step 10, ADR 0926).
--
-- `erase_id`: the erase that wrote the row, so a Person's consent to come back
-- (erasure.allowAddress) lifts the refs of that erase with the address. `fingerprint`: a keyed
-- hash of a constant under the deployment's salt (never the salt), so a load refuses, loudly,
-- when the salt the rows were keyed with is not the one in use (a restore that lost it), rather
-- than let every suppression stop matching and an erased Person come back. Both are NULL on rows
-- written before (none outside tests: no list could be loaded before step 4).
ALTER TABLE core_outside_suppressed ADD COLUMN erase_id TEXT;
ALTER TABLE core_outside_suppressed ADD COLUMN fingerprint TEXT;
CREATE INDEX core_outside_suppressed_erase ON core_outside_suppressed (erase_id)
  WHERE erase_id IS NOT NULL;
