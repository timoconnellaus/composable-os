-- Migration 0858: signing at the desk (stage 44 step 6, ADR 0649). Nothing here touches
-- core_write_guard.
--
-- A desk signing session is one Person signing on the business's own enrolled tablet (core_device,
-- migration 1130, stage 51's shared piece): a person on the staff starts it for a named Person,
-- the device they chose and, for a parent, the live dependants they will sign for; the host
-- answers a short one-time code, typed on that tablet. The tablet holds no sign-in: the session
-- token it gets at the claim reaches only the desk calls of this one session, with the device's
-- own credential (ADR 0649).
--
-- What the session row holds is the evidence an acceptance made there points at: who started it
-- and when, the device it was meant for and the one that claimed it, and the address the copies
-- go to, pinned at the start. None of it changes once written, except: the claim (once), the
-- activity times, the end (once, and never undone), and erase clearing who it names. The code and
-- the token are kept only as HMACs under an env secret (DESK_SECRET), and cleared when the session
-- ends.
--
-- This table is not a record: no rec_* view reads it, so query.sql, dashboards, exports, search
-- and the assistant's bulk reads never see it.
--
-- core_device is made by migration 1130 (block BM), which runs after this one in name order;
-- nothing here names it, and 1130's triggers (which end a device's sessions when it is revoked)
-- name this table, which exists by then.

CREATE TABLE core_agreement_desk_session (
  id TEXT PRIMARY KEY,
  -- Who signs, and the live dependants (a JSON list of Person ids) they sign for. Cleared to null
  -- (and the list emptied of them) when the Person is erased; moved to the survivor on a merge.
  person_id TEXT,
  dependant_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dependant_ids)
    AND json_type(dependant_ids) = 'array'),
  -- The enrolled device staff chose, and the device a claim came from (the same, or one that tried
  -- and ended the session: `wrong_device`).
  device_id TEXT NOT NULL,
  claimed_device_id TEXT,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  -- Where the copies go (ADR 0645): the sign-in address of the Person's account, else their
  -- primary address, pinned at the start. Cleared on erase.
  email TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 320),
  -- The code (8 characters, 2 minutes) and the session token (256 bits), as HMACs only.
  code_hash TEXT CHECK (code_hash IS NULL OR length(code_hash) = 64),
  code_expires_at TEXT NOT NULL,
  token_hash TEXT CHECK (token_hash IS NULL OR length(token_hash) = 64),
  claimed_at TEXT,
  -- The host's limits (decision 22): 3 minutes since the last activity, 20 since the claim. A
  -- heartbeat moves `last_activity_at` only 20 seconds or more after the last one.
  last_activity_at TEXT,
  last_heartbeat_at TEXT,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('finished', 'staff', 'unclaimed', 'idle', 'limit',
    'replaced', 'wrong_device', 'failed_claim', 'revoked', 'device_changed', 'erased')),
  erased_at TEXT,
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (claimed_at IS NULL OR claimed_device_id IS NOT NULL),
  CHECK (ended_at IS NOT NULL OR person_id IS NOT NULL)
);
-- The device's open session (one at most: a claim ends the others in its batch), and the code's.
CREATE INDEX core_agreement_desk_session_device_idx
  ON core_agreement_desk_session (device_id, ended_at);
CREATE INDEX core_agreement_desk_session_code_idx
  ON core_agreement_desk_session (code_hash) WHERE code_hash IS NOT NULL;
CREATE INDEX core_agreement_desk_session_token_idx
  ON core_agreement_desk_session (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX core_agreement_desk_session_person_idx
  ON core_agreement_desk_session (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX core_agreement_desk_session_started_idx
  ON core_agreement_desk_session (started_by, started_at);

-- What may be inserted: never over an existing id, never already claimed or ended, always with a
-- code and for a Person who is there.
CREATE TRIGGER core_agreement_desk_session_new
BEFORE INSERT ON core_agreement_desk_session
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_agreement_desk_session s WHERE s.id = NEW.id)
      THEN RAISE(ABORT, 'core_agreement_desk_session_fixed')
    WHEN NEW.claimed_at IS NOT NULL OR NEW.ended_at IS NOT NULL OR NEW.token_hash IS NOT NULL
      OR NEW.code_hash IS NULL OR NEW.erased_at IS NOT NULL OR NEW.claimed_device_id IS NOT NULL
      THEN RAISE(ABORT, 'core_agreement_desk_session_fixed')
    WHEN NOT EXISTS (SELECT 1 FROM core_person p WHERE p.id = NEW.person_id
        AND p.deleted_at IS NULL)
      THEN RAISE(ABORT, 'core_agreement_desk_session_person')
  END;
END;

-- What never changes: who started it, when, for which device and Person (but erase and merge),
-- the dependants (but erase and merge), when the code ran out, the pinned address (but erase).
-- A claim is made once; an end is final; an ended session answers nothing, so its code and token
-- may only be cleared.
CREATE TRIGGER core_agreement_desk_session_no_update
BEFORE UPDATE ON core_agreement_desk_session
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id OR NEW.device_id IS NOT OLD.device_id
      OR NEW.started_by IS NOT OLD.started_by OR NEW.started_at IS NOT OLD.started_at
      OR NEW.code_expires_at IS NOT OLD.code_expires_at
      THEN RAISE(ABORT, 'core_agreement_desk_session_fixed')
    WHEN NOT (NEW.person_id IS OLD.person_id
        OR (NEW.person_id IS NULL AND NEW.erased_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM core_person p WHERE p.id = OLD.person_id))
        OR (NEW.person_id IS NOT NULL AND NEW.person_id IS (
          SELECT p.merged_into_id FROM core_person p WHERE p.id = OLD.person_id)))
      THEN RAISE(ABORT, 'core_agreement_desk_session_fixed')
    WHEN NEW.email IS NOT OLD.email AND NOT (NEW.email IS NULL AND NEW.erased_at IS NOT NULL)
      THEN RAISE(ABORT, 'core_agreement_desk_session_fixed')
    WHEN NEW.dependant_ids IS NOT OLD.dependant_ids
      AND json_array_length(NEW.dependant_ids) > json_array_length(OLD.dependant_ids)
      THEN RAISE(ABORT, 'core_agreement_desk_session_fixed')
    WHEN OLD.claimed_at IS NOT NULL AND (NEW.claimed_at IS NOT OLD.claimed_at
        OR NEW.claimed_device_id IS NOT OLD.claimed_device_id)
      THEN RAISE(ABORT, 'core_agreement_desk_session_fixed')
    WHEN OLD.ended_at IS NOT NULL AND (NEW.ended_at IS NOT OLD.ended_at
        OR NEW.end_reason IS NOT OLD.end_reason OR NEW.claimed_at IS NOT OLD.claimed_at
        OR NEW.last_activity_at IS NOT OLD.last_activity_at
        OR (NEW.token_hash IS NOT NULL AND NEW.token_hash IS NOT OLD.token_hash)
        OR (NEW.code_hash IS NOT NULL AND NEW.code_hash IS NOT OLD.code_hash))
      THEN RAISE(ABORT, 'core_agreement_desk_session_fixed')
    WHEN NEW.erased_at IS NOT OLD.erased_at AND OLD.erased_at IS NOT NULL
      THEN RAISE(ABORT, 'core_agreement_desk_session_fixed')
  END;
END;

-- A session is evidence for the acceptances it made: it is never deleted.
CREATE TRIGGER core_agreement_desk_session_no_delete
BEFORE DELETE ON core_agreement_desk_session
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_desk_session_fixed');
END;

-- An acceptance made at the desk names its session, and only one: claimed, not ended, and for
-- the Person signing (`self`) or one of the dependants listed (`guardian`, the signer the agent).
-- Any other channel names none. Every writer is held to it, host code included.
CREATE TRIGGER core_agreement_acceptance_desk
BEFORE INSERT ON core_agreement_acceptance
BEGIN
  SELECT CASE
    WHEN NEW.channel != 'desk' AND NEW.desk_session_id IS NOT NULL
      THEN RAISE(ABORT, 'core_agreement_acceptance_desk')
    WHEN NEW.channel = 'desk' AND NOT EXISTS (
      SELECT 1 FROM core_agreement_desk_session s
      WHERE s.id = NEW.desk_session_id AND s.claimed_at IS NOT NULL AND s.ended_at IS NULL
        AND s.person_id IS NOT NULL AND NEW.account_id IS NULL
        AND ((NEW.by = 'self' AND NEW.person_id = s.person_id)
          OR (NEW.by = 'guardian' AND NEW.agent_person_id = s.person_id
            AND EXISTS (SELECT 1 FROM json_each(s.dependant_ids) d WHERE d.value = NEW.person_id)))
    )
      THEN RAISE(ABORT, 'core_agreement_acceptance_desk')
  END;
END;

-- A claim's guard (after the review of PR #390): the claim's batch carries one row here, and fails
-- unless the session it claimed is now claimed by that device and still open. Of two claims made
-- at once (or a claim racing the session's end) the one that lost is refused, never answered with
-- a token that matches nothing. Stores nothing.
CREATE TABLE core_agreement_desk_guard (
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL
);

CREATE TRIGGER core_agreement_desk_guard_check
BEFORE INSERT ON core_agreement_desk_guard
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM core_agreement_desk_session s
        WHERE s.id = NEW.session_id AND s.claimed_device_id = NEW.device_id
          AND s.claimed_at IS NOT NULL AND s.ended_at IS NULL)
      THEN RAISE(ABORT, 'core_agreement_desk_claim_lost')
    ELSE RAISE(IGNORE)
  END;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '858'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 858;
