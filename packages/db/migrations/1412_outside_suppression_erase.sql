-- Migration 1412: which erases considered each booking-system ref and address, and the salt a
-- suppression was keyed with (stage 65 step 10, ADR 0926).
--
-- `core_outside_suppressed_erase`: one row per erase and hash for every ref and address the erase
-- considered, suppressed or not (`suppressed`: 1 when this erase suppressed it; 0 for an address
-- it left because someone else holds it), however many erases met the same one. A Person's
-- consent to come back (erasure.allowAddress) reads the erases from here, so it lifts exactly that
-- erase's refs and suppression, never another erased Person's, and finds them even when the
-- address itself was shared and not suppressed. `fingerprint`: a keyed hash of a constant under
-- the deployment's salt (never the salt), so a load, a link and an erase refuse, loudly, when the
-- salt the rows were keyed with is not the one in use (a restore that lost it), rather than let
-- every suppression stop matching and an erased Person come back. NULL on rows written before
-- (none outside tests: no list could be loaded before step 4).
ALTER TABLE core_outside_suppressed ADD COLUMN fingerprint TEXT;
CREATE TABLE core_outside_suppressed_erase (
  hash TEXT NOT NULL,
  erase_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ref', 'address')),
  suppressed INTEGER NOT NULL DEFAULT 1 CHECK (suppressed IN (0, 1)),
  PRIMARY KEY (hash, erase_id)
);
CREATE INDEX core_outside_suppressed_erase_by ON core_outside_suppressed_erase (erase_id);
