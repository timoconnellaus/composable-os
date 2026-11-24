-- Migration 1135: a person's code and PIN (stage 51 step 3, ADR 0783).
--
-- What identifies a Person at a check-in tablet, kept in the host and never shown to the device:
--
-- - core_person_code: an `app` code or a `card`.
--   - An app code is a secret for a rotating 30-second code (RFC 6238, 8 digits), made for one
--     sign-in: a native app's device session or a browser's customer session. Its row goes when
--     that sign-in ends (the foreign keys), so a code never outlives the sign-in that showed it.
--     The secret is kept encrypted under a key derived from the host's auth secret (the host must
--     check a rotating code, so a hash would not do). `guardian_id` is set for a dependant's code
--     shown on a guardian's app: it identifies the dependant only while that link is live.
--   - A card is a fixed long code the business gives a member (a card or key tag), kept only as an
--     HMAC under that key, with a label and who issued it. Revoked, it identifies no one; one live
--     card per code.
-- - core_person_pin: a 4-digit PIN the member set in their app, kept as a slow hash (PBKDF2 over
--   the PIN keyed by the same derived key, with a salt of its own). Wrong tries are counted per
--   Person over a day; ten disable it until the member sets it again.
-- - core_identify_lockout: per device and entry (`name` for name and PIN, `code` for codes), the
--   failed tries in the current minute and when entry is locked until. No Person, nothing typed.
--   The device id is text with no foreign key: the enrolled device is stage 51 step 1's.
--
-- Nothing here is in a rec_* view, search, an export or an embedding. Erasing a Person deletes
-- their codes, cards and PIN, and the dependant codes they hold (people-codes/people.ts; the
-- foreign keys would too). A merge moves codes and cards to the survivor and keeps the survivor's
-- PIN.
CREATE TABLE core_person_code (
  -- pc_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('app', 'card')),
  -- A card: the HMAC of its normalised code, its label, who issued it.
  code_hmac TEXT,
  label TEXT,
  issued_by TEXT,
  -- An app code: its secret, encrypted (AES-GCM, base64url iv.ciphertext), and the sign-in.
  secret_enc TEXT,
  device_session_id TEXT REFERENCES core_device_session (id) ON DELETE CASCADE,
  customer_session_id TEXT REFERENCES core_customer_session (id) ON DELETE CASCADE,
  -- A dependant's app code, shown on this guardian's sign-in; null: the Person's own.
  guardian_id TEXT REFERENCES core_person (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  CHECK (kind != 'card' OR (code_hmac IS NOT NULL AND label IS NOT NULL AND issued_by IS NOT NULL
    AND secret_enc IS NULL AND device_session_id IS NULL AND customer_session_id IS NULL
    AND guardian_id IS NULL)),
  CHECK (kind != 'app' OR (secret_enc IS NOT NULL AND code_hmac IS NULL
    AND ((device_session_id IS NULL) != (customer_session_id IS NULL)))),
  CHECK (guardian_id IS NULL OR guardian_id != person_id)
);
CREATE INDEX core_person_code_person ON core_person_code (person_id);
CREATE INDEX core_person_code_guardian ON core_person_code (guardian_id) WHERE guardian_id IS NOT NULL;
-- One live card per code.
CREATE UNIQUE INDEX core_person_code_card_uq ON core_person_code (code_hmac)
  WHERE kind = 'card' AND revoked_at IS NULL;
-- One app code per Person per sign-in.
CREATE UNIQUE INDEX core_person_code_device_uq ON core_person_code (device_session_id, person_id)
  WHERE device_session_id IS NOT NULL;
CREATE UNIQUE INDEX core_person_code_session_uq ON core_person_code (customer_session_id, person_id)
  WHERE customer_session_id IS NOT NULL;

CREATE TABLE core_person_pin (
  person_id TEXT PRIMARY KEY NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  -- PBKDF2-SHA256, base64url; its salt, base64url; its iterations.
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  set_at TEXT NOT NULL,
  -- Wrong tries since `failed_since` (a day's window), and when ten disabled it.
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  failed_since TEXT,
  disabled_at TEXT
);

CREATE TABLE core_identify_lockout (
  device_id TEXT NOT NULL,
  entry TEXT NOT NULL CHECK (entry IN ('name', 'code')),
  window_started_at TEXT NOT NULL,
  failures INTEGER NOT NULL CHECK (failures >= 0),
  locked_until TEXT,
  PRIMARY KEY (device_id, entry)
);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1135'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1135;
