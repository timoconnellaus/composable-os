-- Migration 1130: the enrolled device (stage 51 step 1, built with stage 44 step 6; ADR 0780).
-- Nothing here touches core_write_guard.
--
-- An enrolled device is a tablet (or another browser) a human admin enrolled as the business's
-- own, for one use:
--   signing  stage 44's desk signing: alone it may only show "Enter code" and claim a session a
--            person on the staff started (migration 0858);
--   role     a device role a pack declares (stage 51's check-in tablet; step 2 builds the calls);
--   till     stage 50's till: its credential only names the device on a staff member's calls.
-- One use per device; an admin changes it (`device.setUse`) or revokes it (`device.revoke`).
--
-- Enrolment: the admin's `device.enrol` makes the row with a single-use enrolment code (10
-- characters, 10 minutes), kept as its HMAC; typing it at the desk origin's /enrol
-- (`device.claim`) sets the device credential (256 random bits in a cookie), kept as its HMAC.
-- Every credential, code and token is an HMAC under an env secret (DESK_SECRET), never in the
-- clear. The credential rotates at least daily, and on every signing claim; the one rotated away
-- is accepted for 60 seconds after (the grace window), and presented later it revokes the device
-- as a clone. A device with no call for 30 days lapses.
--
-- The browser (user agent) and the network address at the claim and at each rotation describe
-- the business's own tablet and premises, not a member's device (stage 44, decision 3): a change
-- is flagged on the devices list (`flags`).
--
-- This table is not a record: no rec_* view reads it.

CREATE TABLE core_device (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  use TEXT NOT NULL CHECK (use IN ('signing', 'role', 'till')),
  -- The device role (`<pack>.<role>`) a device of use `role` holds; none for any other use.
  role TEXT CHECK (role IS NULL OR length(role) BETWEEN 3 AND 80),
  enrolled_by TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  -- The enrolment code until it is used or runs out.
  enrol_code_hash TEXT CHECK (enrol_code_hash IS NULL OR length(enrol_code_hash) = 64),
  enrol_expires_at TEXT NOT NULL,
  claimed_at TEXT,
  -- The credential, the next one the host has issued (`pending`: the current one stays good until
  -- the device presents the next, so an answer lost on the way never locks it out), the one
  -- rotated away (accepted until `rotated_at` + 60 seconds) and when.
  credential_hash TEXT CHECK (credential_hash IS NULL OR length(credential_hash) = 64),
  pending_credential_hash TEXT
    CHECK (pending_credential_hash IS NULL OR length(pending_credential_hash) = 64),
  previous_credential_hash TEXT
    CHECK (previous_credential_hash IS NULL OR length(previous_credential_hash) = 64),
  rotated_at TEXT,
  last_seen_at TEXT,
  claim_user_agent TEXT CHECK (claim_user_agent IS NULL OR length(claim_user_agent) <= 400),
  claim_address TEXT CHECK (claim_address IS NULL OR length(claim_address) <= 64),
  last_user_agent TEXT CHECK (last_user_agent IS NULL OR length(last_user_agent) <= 400),
  last_address TEXT CHECK (last_address IS NULL OR length(last_address) <= 64),
  -- What changed since the claim: a JSON list of { kind: browser | network, at }, newest last.
  flags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags) AND json_type(flags) = 'array'),
  -- Wrong desk codes typed on it: five in a minute lock it for five minutes.
  bad_codes INTEGER NOT NULL DEFAULT 0 CHECK (bad_codes >= 0),
  bad_codes_since TEXT,
  locked_until TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT CHECK (revoke_reason IN ('admin', 'clone', 'lapsed')),
  CHECK ((use = 'role') = (role IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK (claimed_at IS NOT NULL OR credential_hash IS NULL),
  CHECK (claimed_at IS NULL OR enrol_code_hash IS NULL)
);
CREATE INDEX core_device_credential_idx ON core_device (credential_hash)
  WHERE credential_hash IS NOT NULL;
CREATE INDEX core_device_previous_idx ON core_device (previous_credential_hash)
  WHERE previous_credential_hash IS NOT NULL;
CREATE INDEX core_device_pending_idx ON core_device (pending_credential_hash)
  WHERE pending_credential_hash IS NOT NULL;
CREATE INDEX core_device_enrol_idx ON core_device (enrol_code_hash)
  WHERE enrol_code_hash IS NOT NULL;
CREATE INDEX core_device_list_idx ON core_device (revoked_at, enrolled_at);

-- What may be inserted: a new device, not yet claimed or revoked, with its enrolment code.
CREATE TRIGGER core_device_new
BEFORE INSERT ON core_device
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_device d WHERE d.id = NEW.id)
      THEN RAISE(ABORT, 'core_device_fixed')
    WHEN NEW.claimed_at IS NOT NULL OR NEW.credential_hash IS NOT NULL
      OR NEW.previous_credential_hash IS NOT NULL OR NEW.pending_credential_hash IS NOT NULL
      OR NEW.revoked_at IS NOT NULL
      OR NEW.enrol_code_hash IS NULL
      THEN RAISE(ABORT, 'core_device_fixed')
  END;
END;

-- Who enrolled it and when never change; it is claimed once; a revoked device stays revoked and
-- holds no credential or code again.
CREATE TRIGGER core_device_no_update
BEFORE UPDATE ON core_device
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id OR NEW.enrolled_by IS NOT OLD.enrolled_by
      OR NEW.enrolled_at IS NOT OLD.enrolled_at OR NEW.enrol_expires_at IS NOT OLD.enrol_expires_at
      THEN RAISE(ABORT, 'core_device_fixed')
    WHEN OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS NOT OLD.claimed_at
      THEN RAISE(ABORT, 'core_device_fixed')
    WHEN NEW.enrol_code_hash IS NOT NULL AND NEW.enrol_code_hash IS NOT OLD.enrol_code_hash
      THEN RAISE(ABORT, 'core_device_fixed')
    WHEN OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at
        OR NEW.revoke_reason IS NOT OLD.revoke_reason OR NEW.revoked_by IS NOT OLD.revoked_by
        OR NEW.credential_hash IS NOT NULL OR NEW.previous_credential_hash IS NOT NULL
        OR NEW.pending_credential_hash IS NOT NULL OR NEW.enrol_code_hash IS NOT NULL)
      THEN RAISE(ABORT, 'core_device_fixed')
  END;
END;

-- A device is evidence for the desk acceptances made on it: it is never deleted.
CREATE TRIGGER core_device_no_delete
BEFORE DELETE ON core_device
BEGIN
  SELECT RAISE(ABORT, 'core_device_fixed');
END;

-- Revoked (by an admin, as a clone, or lapsed): every open signing session on it ends in the same
-- statement, whatever wrote the revocation.
CREATE TRIGGER core_device_revoked_ends_sessions
AFTER UPDATE OF revoked_at ON core_device
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  UPDATE core_agreement_desk_session
  SET ended_at = NEW.revoked_at, end_reason = 'revoked', code_hash = NULL, token_hash = NULL
  WHERE ended_at IS NULL AND (device_id = NEW.id OR claimed_device_id = NEW.id);
END;

-- Its use changed: a signing session open on it ends, in the same statement.
CREATE TRIGGER core_device_use_changed_ends_sessions
AFTER UPDATE OF use, role ON core_device
WHEN NEW.use IS NOT OLD.use OR NEW.role IS NOT OLD.role
BEGIN
  UPDATE core_agreement_desk_session
  SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), end_reason = 'device_changed',
    code_hash = NULL, token_hash = NULL
  WHERE ended_at IS NULL AND (device_id = NEW.id OR claimed_device_id = NEW.id);
END;

-- An enrolment claim's guard (after the review of PR #390): the claim's batch carries one row
-- here, and fails unless the device now holds the credential this claim set. Of two browsers
-- claiming one code at once, the one that lost is refused. Stores nothing.
CREATE TABLE core_device_guard (
  device_id TEXT NOT NULL,
  credential_hash TEXT NOT NULL
);

CREATE TRIGGER core_device_guard_check
BEFORE INSERT ON core_device_guard
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM core_device d WHERE d.id = NEW.device_id
        AND d.credential_hash = NEW.credential_hash AND d.revoked_at IS NULL)
      THEN RAISE(ABORT, 'core_device_claim_lost')
    ELSE RAISE(IGNORE)
  END;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1130'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1130;
