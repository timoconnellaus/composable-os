-- Migration 0851: acceptances, signatures, health answers, the minor mark, and the write guard's
-- `agreements` kind (stage 44 step 2, ADRs 0642 and 0643).
--
-- An acceptance is one record that a person agreed to one published version: by themselves, by a
-- guardian for a dependant, by a guest with an order (step 3), or recorded from paper by staff.
-- Nobody changes what it says. The database refuses every update except setting its Person
-- (a guest's at settlement, or a merged Person's survivor) and clearing who it names (erase), for
-- every statement shape: D1 runs with recursive triggers off, so the rows an INSERT OR REPLACE or
-- an UPDATE OR REPLACE deletes fire no delete trigger. So every table here refuses an insert over
-- an existing key (a REPLACE and an upsert are inserts first), refuses any change of key, and has
-- no unique index but its key (an UPDATE OR REPLACE of an allowed column can then delete nothing).
--
-- None of these tables is a record: no rec_* view reads them, so query.sql, dashboards, exports,
-- search, embeddings and the assistant's bulk reads never see them. Health answers have their own
-- table, read by one operation for a person holding agreements:health, every read audited.

CREATE TABLE core_agreement_acceptance (
  id TEXT PRIMARY KEY,
  -- What was shown: the version, and the hash of what the screen showed (the version's hash; a
  -- care consent's filled-in values are stage 43's, step 9: until then `context` is always null).
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  shown_hash TEXT NOT NULL CHECK (length(shown_hash) = 64),
  context TEXT,
  -- Whom it is for. Null only for a guest's acceptance before settlement, or once erased.
  person_id TEXT,
  by TEXT NOT NULL CHECK (by IN ('self', 'guardian', 'guest', 'paper')),
  -- Who agreed: a guardian's Person; the customer account that agreed (their own or the
  -- guardian's). Null for a guest and for paper.
  agent_person_id TEXT,
  account_id TEXT,
  -- What a guest's acceptance was taken with (step 3).
  order_id TEXT,
  subscription_checkout TEXT,
  -- Where the copy goes (step 4): the account's sign-in address, or null.
  email TEXT,
  how TEXT NOT NULL CHECK (how IN ('typed', 'drawn', 'paper')),
  typed_name TEXT NOT NULL CHECK (length(typed_name) BETWEEN 1 AND 200),
  channel TEXT NOT NULL CHECK (channel IN ('web', 'app', 'paper', 'desk')),
  desk_session_id TEXT,
  -- The host's clock at commit.
  accepted_at TEXT NOT NULL,
  -- Paper only: the date on the form, the staff user who recorded it, who signed it (a parent
  -- for a child), and an optional note.
  signed_on TEXT,
  recorded_by TEXT,
  signed_by TEXT,
  note TEXT,
  -- Set once when the Person is erased (step 8 keeps it detached for the retention period).
  erased_at TEXT,
  CHECK ((by = 'paper') = (how = 'paper')),
  CHECK ((by = 'paper') = (channel = 'paper')),
  CHECK (by != 'paper' OR (signed_on IS NOT NULL AND recorded_by IS NOT NULL)),
  CHECK (by = 'paper' OR (signed_on IS NULL AND recorded_by IS NULL AND signed_by IS NULL)),
  -- Only a guardian's names an agent (the insert trigger checks the link; an erased guardian is
  -- cleared to null later, and the acceptance stays the dependant's).
  CHECK (by = 'guardian' OR agent_person_id IS NULL),
  CHECK (by != 'guest' OR order_id IS NOT NULL OR subscription_checkout IS NOT NULL)
);
CREATE INDEX core_agreement_acceptance_person_idx
  ON core_agreement_acceptance (person_id, document_id, accepted_at);
CREATE INDEX core_agreement_acceptance_document_idx
  ON core_agreement_acceptance (document_id, accepted_at);
CREATE INDEX core_agreement_acceptance_agent_idx
  ON core_agreement_acceptance (agent_person_id) WHERE agent_person_id IS NOT NULL;

-- What may be inserted: never over an existing id; only of a version of a live document that is
-- current or scheduled at commit, showing that version's hash; for a minor (a Person staff marked,
-- or a live dependant) never their own; a guardian's only over a live link; and a new row is
-- nobody's erased one.
CREATE TRIGGER core_agreement_acceptance_new
BEFORE INSERT ON core_agreement_acceptance
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_agreement_acceptance a WHERE a.id = NEW.id)
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NEW.erased_at IS NOT NULL OR NEW.context IS NOT NULL
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NEW.person_id IS NULL AND NEW.by != 'guest'
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT EXISTS (
      SELECT 1 FROM core_agreement_version v
      JOIN core_agreement_document d ON d.id = v.document_id
      WHERE v.id = NEW.version_id AND v.document_id = NEW.document_id
        AND v.hash = NEW.shown_hash AND d.state = 'live' AND d.current_version_id IS NOT NULL
        AND v.number >= (SELECT c.number FROM core_agreement_version c
          WHERE c.id = d.current_version_id)
    )
      THEN RAISE(ABORT, 'core_agreement_version_not_open')
    WHEN NEW.by = 'self' AND (
      EXISTS (SELECT 1 FROM core_agreement_minor m WHERE m.person_id = NEW.person_id)
      OR EXISTS (
        SELECT 1 FROM core_person_link l
        JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
        JOIN core_person p ON p.id = l.dependant_id AND p.deleted_at IS NULL
        WHERE l.dependant_id = NEW.person_id AND l.kind = 'guardian' AND l.ended_at IS NULL
      )
    )
      THEN RAISE(ABORT, 'core_agreement_minor_self')
    WHEN NEW.by = 'guardian' AND NOT EXISTS (
      SELECT 1 FROM core_person_link l
      JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
      JOIN core_person p ON p.id = l.dependant_id AND p.deleted_at IS NULL
      WHERE l.guardian_id = NEW.agent_person_id AND l.dependant_id = NEW.person_id
        AND l.kind = 'guardian' AND l.ended_at IS NULL
    )
      THEN RAISE(ABORT, 'core_person_link_not_live')
  END;
END;

-- Nothing an acceptance says ever changes. The only updates: its Person set where it was a
-- guest's and null (settlement), or moved from a merged Person to the survivor (merge); who it
-- names cleared to null when they are erased (the Person, with `erased_at` set once; a guardian;
-- the account; the address). Nothing is set back, and an erased one is nobody's again.
CREATE TRIGGER core_agreement_acceptance_no_update
BEFORE UPDATE ON core_agreement_acceptance
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id OR NEW.document_id IS NOT OLD.document_id
      OR NEW.version_id IS NOT OLD.version_id OR NEW.shown_hash IS NOT OLD.shown_hash
      OR NEW.context IS NOT OLD.context OR NEW.by IS NOT OLD.by
      OR NEW.order_id IS NOT OLD.order_id
      OR NEW.subscription_checkout IS NOT OLD.subscription_checkout
      OR NEW.how IS NOT OLD.how OR NEW.typed_name IS NOT OLD.typed_name
      OR NEW.channel IS NOT OLD.channel OR NEW.desk_session_id IS NOT OLD.desk_session_id
      OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.signed_on IS NOT OLD.signed_on
      OR NEW.recorded_by IS NOT OLD.recorded_by OR NEW.signed_by IS NOT OLD.signed_by
      OR NEW.note IS NOT OLD.note
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT (NEW.erased_at IS OLD.erased_at
        OR (OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL AND NEW.person_id IS NULL))
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT (NEW.person_id IS OLD.person_id
        OR (OLD.person_id IS NULL AND NEW.person_id IS NOT NULL AND OLD.by = 'guest'
          AND OLD.erased_at IS NULL)
        OR (OLD.person_id IS NOT NULL AND NEW.person_id IS NULL AND NEW.erased_at IS NOT NULL)
        OR (OLD.person_id IS NOT NULL AND NEW.person_id IS NOT NULL AND NEW.person_id IS (
          SELECT p.merged_into_id FROM core_person p WHERE p.id = OLD.person_id)))
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT (NEW.agent_person_id IS OLD.agent_person_id
        OR (OLD.agent_person_id IS NOT NULL AND NEW.agent_person_id IS NULL)
        OR (OLD.agent_person_id IS NOT NULL AND NEW.agent_person_id IS NOT NULL
          AND NEW.agent_person_id IS (
            SELECT p.merged_into_id FROM core_person p WHERE p.id = OLD.agent_person_id)))
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT (NEW.account_id IS OLD.account_id OR NEW.account_id IS NULL)
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT (NEW.email IS OLD.email OR NEW.email IS NULL)
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
  END;
END;

-- Deleted only by the retention purge of an erased one (step 8), or with a guest's unpaid order
-- (step 3). No operation deletes one.
CREATE TRIGGER core_agreement_acceptance_no_delete
BEFORE DELETE ON core_agreement_acceptance
WHEN OLD.erased_at IS NULL AND NOT (OLD.by = 'guest' AND OLD.person_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_acceptance_immutable');
END;

-- A drawn signature, as its strokes (a small checked JSON document, never an image), kept beside
-- its acceptance so it is read only where it is shown. Personal data: never to an AI actor.
CREATE TABLE core_agreement_signature (
  acceptance_id TEXT PRIMARY KEY,
  strokes TEXT NOT NULL CHECK (length(strokes) <= 32768)
);

CREATE TRIGGER core_agreement_signature_new
BEFORE INSERT ON core_agreement_signature
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_agreement_signature s WHERE s.acceptance_id = NEW.acceptance_id)
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT EXISTS (SELECT 1 FROM core_agreement_acceptance a
        WHERE a.id = NEW.acceptance_id AND a.how = 'drawn' AND a.erased_at IS NULL)
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
  END;
END;

CREATE TRIGGER core_agreement_signature_no_update
BEFORE UPDATE ON core_agreement_signature
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_acceptance_immutable');
END;

CREATE TRIGGER core_agreement_signature_no_delete
BEFORE DELETE ON core_agreement_signature
WHEN EXISTS (SELECT 1 FROM core_agreement_acceptance a WHERE a.id = OLD.acceptance_id
  AND a.erased_at IS NULL AND NOT (a.by = 'guest' AND a.person_id IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_acceptance_immutable');
END;

-- A health form's answers (decision 5): health information. One row per acceptance of a health
-- document; `any_yes` is the one fact the coach's list shows (a mark, no content). `entered_by`
-- is the staff user who typed in a paper form's answers (null when the person answered).
CREATE TABLE core_agreement_answer (
  acceptance_id TEXT PRIMARY KEY,
  answers TEXT NOT NULL CHECK (length(answers) <= 65536),
  any_yes INTEGER NOT NULL CHECK (any_yes IN (0, 1)),
  entered_by TEXT
);

CREATE TRIGGER core_agreement_answer_new
BEFORE INSERT ON core_agreement_answer
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_agreement_answer s WHERE s.acceptance_id = NEW.acceptance_id)
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT EXISTS (SELECT 1 FROM core_agreement_acceptance a
        JOIN core_agreement_document d ON d.id = a.document_id
        WHERE a.id = NEW.acceptance_id AND d.kind = 'health' AND a.erased_at IS NULL)
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
  END;
END;

CREATE TRIGGER core_agreement_answer_no_update
BEFORE UPDATE ON core_agreement_answer
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_acceptance_immutable');
END;

-- Health answers are deleted at once when their Person is erased (decision 15): the erase detaches
-- the acceptance first, in the same batch.
CREATE TRIGGER core_agreement_answer_no_delete
BEFORE DELETE ON core_agreement_answer
WHEN EXISTS (SELECT 1 FROM core_agreement_acceptance a WHERE a.id = OLD.acceptance_id
  AND a.erased_at IS NULL AND NOT (a.by = 'guest' AND a.person_id IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_acceptance_immutable');
END;

-- The minor mark (decision 20): staff with people:link mark a Person whom a parent or guardian
-- agrees for. The host holds no date of birth and never works out an age; staff clear the mark.
CREATE TABLE core_agreement_minor (
  person_id TEXT PRIMARY KEY,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);

-- The write guard's `agreements` kind (stage 44, ADR 0641 as amended): a batch planned from a read
-- of what is due carries the counter it read (core_agreement_rev); a publish, a version taking
-- effect, an attach, a detach or a retire committed in between bumps it, and the batch fails
-- (`core_agreements_changed`). core_write_guard stores nothing, so it is made again with the new
-- kind, as migrations 0560, 0610, 0670 and 0690 did; every earlier kind is carried forward as
-- migration 0690 left it.
DROP TRIGGER core_write_guard_check;
DROP TABLE core_write_guard;

CREATE TABLE core_write_guard (
  kind TEXT NOT NULL
    CHECK (kind IN ('claimed', 'claimant', 'series', 'full', 'unmoved', 'held_cap', 'agreements')),
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  expected INTEGER NOT NULL
);

CREATE TRIGGER core_write_guard_check
BEFORE INSERT ON core_write_guard
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'claimed' AND coalesce((SELECT held + taken FROM core_capacity
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id), 0) != NEW.expected
      THEN RAISE(ABORT, 'core_recurrence_stale')
    WHEN NEW.kind = 'series' AND coalesce((SELECT version FROM core_recurrence_series
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id), 0) != NEW.expected
      THEN RAISE(ABORT, 'core_recurrence_stale')
    WHEN NEW.kind = 'claimant' AND (SELECT count(*) FROM core_capacity_claim
        WHERE for_type = NEW.object_type AND for_id = NEW.record_id
          AND state IN ('held', 'confirmed')) != NEW.expected
      THEN RAISE(ABORT, 'core_claim_live')
    WHEN NEW.kind = 'full' AND NOT EXISTS (SELECT 1 FROM core_capacity
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id
          AND places IS NOT NULL AND held + taken >= places)
      THEN RAISE(ABORT, 'core_waitlist_not_full')
    WHEN NEW.kind = 'unmoved' AND (SELECT count(*) FROM core_transition_history
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id) != NEW.expected
      THEN RAISE(ABORT, 'core_moved_meanwhile')
    WHEN NEW.kind = 'held_cap' AND (SELECT count(*) FROM core_capacity_claim
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id
          AND state = 'held' AND for_type != 'waitlist') > NEW.expected
      THEN RAISE(ABORT, 'core_holds_capped')
    WHEN NEW.kind = 'agreements' AND coalesce((SELECT rev FROM core_agreement_rev
        WHERE id = 1), 0) != NEW.expected
      THEN RAISE(ABORT, 'core_agreements_changed')
    ELSE RAISE(IGNORE)
  END;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '851'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 851;
