-- Migration 1412: which erases a booking-system suppression came from, and the salt it was keyed
-- with (stage 65 step 10, ADR 0926).
--
-- `core_outside_suppressed_erase`: one row per erase and suppressed hash, however many erases
-- suppressed the same ref or address, so a Person's consent to come back (erasure.allowAddress)
-- lifts exactly that erase's refs, never another erased Person's. `fingerprint`: a keyed hash of a
-- constant under the deployment's salt (never the salt), so a load, a link and an erase refuse,
-- loudly, when the salt the rows were keyed with is not the one in use (a restore that lost it),
-- rather than let every suppression stop matching and an erased Person come back. NULL on rows
-- written before (none outside tests: no list could be loaded before step 4).
ALTER TABLE core_outside_suppressed ADD COLUMN fingerprint TEXT;
CREATE TABLE core_outside_suppressed_erase (
  hash TEXT NOT NULL,
  erase_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ref', 'address')),
  PRIMARY KEY (hash, erase_id)
);
CREATE INDEX core_outside_suppressed_erase_by ON core_outside_suppressed_erase (erase_id);
