-- Migration 0855: erase, merge and retention for agreements (stage 44 step 8, ADR 0646). Nothing
-- here touches core_write_guard.
--
-- An erased Person's acceptances are kept, detached, as the business's evidence for the retention
-- period (decision 15: `agreement_retention` in core_settings, `{"years": n}`, default 7), counted
-- from the erase, then the host's purge deletes them. Migration 0851's triggers allowed no delete of
-- a kept acceptance; this migration extends them by the same pattern (each delete tied to what
-- makes it true, for every writer) and weakens nothing:
--   - a kept acceptance, its signature, answers and copy row may be deleted once it was erased
--     longer ago than the retention period, unless a person put it on hold (core_agreement_hold),
--     and the acceptance itself only after the rows beside it are gone;
--   - a buyer's acceptance on a paid order nobody settled may be marked erased once erase cleared
--     the order's address (it can never settle to anyone after that);
--   - a copy that ever reached the email gatekeeper owes a scrub of the gatekeeper's storage
--     (`scrub_due_at`), which the host clears only by recording that it was done.
--
-- The cutoff is worked out in SQL from the setting: missing, 7 years; a value that is not a whole
-- number of years from 1 to 50 deletes nothing (a broken setting never deletes evidence early).

-- A person on the staff with agreements:manage holds a kept acceptance for a dispute or a claim:
-- the purge passes it by until the hold is released. Who and when only: no free text.
CREATE TABLE core_agreement_hold (
  acceptance_id TEXT PRIMARY KEY,
  held_by TEXT NOT NULL,
  held_at TEXT NOT NULL
);

CREATE TRIGGER core_agreement_hold_new
BEFORE INSERT ON core_agreement_hold
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_agreement_hold h WHERE h.acceptance_id = NEW.acceptance_id)
      THEN RAISE(ABORT, 'core_agreement_hold_fixed')
    WHEN NOT EXISTS (SELECT 1 FROM core_agreement_acceptance a
        WHERE a.id = NEW.acceptance_id AND a.erased_at IS NOT NULL)
      THEN RAISE(ABORT, 'core_agreement_hold_not_kept')
  END;
END;

CREATE TRIGGER core_agreement_hold_no_update
BEFORE UPDATE ON core_agreement_hold
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_hold_fixed');
END;

-- The purge reads erased acceptances oldest first.
CREATE INDEX core_agreement_acceptance_erased_idx
  ON core_agreement_acceptance (erased_at) WHERE erased_at IS NOT NULL;

-- Erase of a buyer's acceptance nobody settled: once erase cleared its paid order's address and
-- the order has no Person, the order can never be settled (order.setPerson takes only a Person
-- with the order's address), so the acceptance is kept detached like any other (`erased_at`),
-- and purged after the retention period. Every other rule is migration 0851's, unchanged.
DROP TRIGGER core_agreement_acceptance_no_update;
CREATE TRIGGER core_agreement_acceptance_no_update
BEFORE UPDATE ON core_agreement_acceptance
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id OR NEW.document_id IS NOT OLD.document_id
      OR NEW.version_id IS NOT OLD.version_id OR NEW.shown_hash IS NOT OLD.shown_hash
      OR NEW.context IS NOT OLD.context OR NEW.by IS NOT OLD.by
      OR NEW.order_id IS NOT OLD.order_id
      OR NEW.subscription_checkout IS NOT OLD.subscription_checkout
      OR NEW.how IS NOT OLD.how OR NEW.email IS NOT OLD.email
      OR NEW.channel IS NOT OLD.channel OR NEW.desk_session_id IS NOT OLD.desk_session_id
      OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.signed_on IS NOT OLD.signed_on
      OR NEW.recorded_by IS NOT OLD.recorded_by
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    -- erased_at: set once, and only as part of one of the three erasures.
    WHEN NOT (NEW.erased_at IS OLD.erased_at
        OR (OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL AND (
          (OLD.person_id IS NOT NULL AND NEW.person_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM core_person p WHERE p.id = OLD.person_id))
          OR (OLD.by = 'guardian' AND OLD.agent_person_id IS NOT NULL
            AND NEW.agent_person_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM core_person p WHERE p.id = OLD.agent_person_id))
          OR (OLD.by = 'guest' AND OLD.person_id IS NULL AND NEW.person_id IS NULL
            AND EXISTS (SELECT 1 FROM core_order o WHERE o.id = OLD.order_id
              AND o.person_id IS NULL AND o.email IS NULL AND o.paid > 0)))))
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT (NEW.person_id IS OLD.person_id
        OR (OLD.person_id IS NULL AND NEW.person_id IS NOT NULL AND OLD.by = 'guest'
          AND OLD.erased_at IS NULL AND NEW.erased_at IS NULL AND (
            NEW.person_id IS (SELECT o.person_id FROM core_order o WHERE o.id = OLD.order_id)
            OR EXISTS (SELECT 1 FROM core_subscription_checkout c
              WHERE c.id = OLD.subscription_checkout
                AND NEW.person_id IN (c.payer_person_id, c.holder_person_id))))
        OR (OLD.person_id IS NOT NULL AND NEW.person_id IS NULL AND NEW.erased_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM core_person p WHERE p.id = OLD.person_id))
        OR (OLD.person_id IS NOT NULL AND NEW.person_id IS NOT NULL AND NEW.person_id IS (
          SELECT p.merged_into_id FROM core_person p WHERE p.id = OLD.person_id)))
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT (NEW.agent_person_id IS OLD.agent_person_id
        OR (OLD.agent_person_id IS NOT NULL AND NEW.agent_person_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM core_person p WHERE p.id = OLD.agent_person_id))
        OR (OLD.agent_person_id IS NOT NULL AND NEW.agent_person_id IS NOT NULL
          AND NEW.agent_person_id IS (
            SELECT p.merged_into_id FROM core_person p WHERE p.id = OLD.agent_person_id)))
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT (NEW.account_id IS OLD.account_id
        OR (NEW.account_id IS NULL AND NEW.erased_at IS NOT NULL))
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    WHEN NOT (NEW.typed_name IS OLD.typed_name
        OR (NEW.typed_name IS NULL AND OLD.by = 'guardian' AND NEW.agent_person_id IS NULL
          AND NEW.erased_at IS NOT NULL))
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
    -- A paper form's free text (who signed it, the note staff typed) may name a guardian: erase
    -- of a guardian clears both on their dependants' paper forms (coordinator decision of
    -- 2026-11-23, owner to confirm). Only ever to nothing, both together, and only on paper.
    WHEN (NEW.signed_by IS NOT OLD.signed_by OR NEW.note IS NOT OLD.note) AND NOT (
        OLD.by = 'paper' AND NEW.signed_by IS NULL AND NEW.note IS NULL)
      THEN RAISE(ABORT, 'core_agreement_acceptance_immutable')
  END;
END;

-- Deleted only with a buyer's unpaid order (step 3), or by the purge: kept longer than the
-- retention period since its erase, not on hold, and nothing left beside it (its signature,
-- answers and copy row go first, so nothing personal is ever left without its acceptance).
DROP TRIGGER core_agreement_acceptance_no_delete;
CREATE TRIGGER core_agreement_acceptance_no_delete
BEFORE DELETE ON core_agreement_acceptance
WHEN NOT (
  (OLD.by = 'guest' AND OLD.person_id IS NULL AND OLD.erased_at IS NULL)
  OR (OLD.erased_at IS NOT NULL
    AND coalesce(OLD.erased_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || coalesce((
      SELECT CASE WHEN json_type(s.value, '$.years') = 'integer'
          AND json_extract(s.value, '$.years') BETWEEN 1 AND 50
        THEN json_extract(s.value, '$.years') ELSE 1000 END
      FROM core_settings s WHERE s.key = 'agreement_retention'), 7) || ' years'), 0)
    AND NOT EXISTS (SELECT 1 FROM core_agreement_hold h WHERE h.acceptance_id = OLD.id)
    AND NOT EXISTS (SELECT 1 FROM core_agreement_signature s WHERE s.acceptance_id = OLD.id)
    AND NOT EXISTS (SELECT 1 FROM core_agreement_answer n WHERE n.acceptance_id = OLD.id)
    AND NOT EXISTS (SELECT 1 FROM core_agreement_copy c WHERE c.acceptance_id = OLD.id))
)
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_acceptance_immutable');
END;

-- A signature goes with a guardian who is erased, a buyer's unpaid acceptance, or the purge.
DROP TRIGGER core_agreement_signature_no_delete;
CREATE TRIGGER core_agreement_signature_no_delete
BEFORE DELETE ON core_agreement_signature
WHEN EXISTS (SELECT 1 FROM core_agreement_acceptance a WHERE a.id = OLD.acceptance_id
  AND NOT (a.by = 'guardian' AND a.erased_at IS NOT NULL AND a.agent_person_id IS NULL)
  AND NOT (a.by = 'guest' AND a.person_id IS NULL AND a.erased_at IS NULL)
  AND NOT (a.erased_at IS NOT NULL
    AND coalesce(a.erased_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || coalesce((
      SELECT CASE WHEN json_type(s.value, '$.years') = 'integer'
          AND json_extract(s.value, '$.years') BETWEEN 1 AND 50
        THEN json_extract(s.value, '$.years') ELSE 1000 END
      FROM core_settings s WHERE s.key = 'agreement_retention'), 7) || ' years'), 0)
    AND NOT EXISTS (SELECT 1 FROM core_agreement_hold h WHERE h.acceptance_id = a.id)))
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_acceptance_immutable');
END;

-- Health answers go when the Person they are about is erased, with a buyer's unpaid acceptance,
-- or with the purge (a child's answers on an acceptance whose guardian was erased, kept until
-- then with it).
DROP TRIGGER core_agreement_answer_no_delete;
CREATE TRIGGER core_agreement_answer_no_delete
BEFORE DELETE ON core_agreement_answer
WHEN EXISTS (SELECT 1 FROM core_agreement_acceptance a WHERE a.id = OLD.acceptance_id
  AND NOT (a.erased_at IS NOT NULL AND a.person_id IS NULL)
  AND NOT (a.by = 'guest' AND a.person_id IS NULL AND a.erased_at IS NULL)
  AND NOT (a.erased_at IS NOT NULL
    AND coalesce(a.erased_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || coalesce((
      SELECT CASE WHEN json_type(s.value, '$.years') = 'integer'
          AND json_extract(s.value, '$.years') BETWEEN 1 AND 50
        THEN json_extract(s.value, '$.years') ELSE 1000 END
      FROM core_settings s WHERE s.key = 'agreement_retention'), 7) || ' years'), 0)
    AND NOT EXISTS (SELECT 1 FROM core_agreement_hold h WHERE h.acceptance_id = a.id)))
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_acceptance_immutable');
END;

-- The copy: what the email gatekeeper still holds of an erased acceptance's copy. Each send is
-- recorded with the gatekeeper it reached (`via`: a JSON list of `<connection> <resource>`), so
-- the scrub goes to the gatekeeper that holds it, not whichever channel is current. A copy that
-- reached one owes a scrub (`scrub_due_at`, owed since `scrub_owed_since`): the host asks each
-- gatekeeper, as its own agreements mail, to drop the copy's sends and wipe their recipients and
-- subject from its history; every gatekeeper is asked each time, whatever another answered, and
-- those done are recorded (`scrub_done`). The row is scrubbed (`scrubbed_at`) only when all are.
-- What is left is recorded (`scrub_error`): `unreachable` when every gatekeeper left is gone (its
-- connection removed, or its sender no longer bound), `inactive` when one still exists but cannot
-- be used now (it needs re-authorising), `failed` otherwise; each is asked again. Only once every
-- gatekeeper left has been gone for 30 days (`scrub_gone_since`) may the purge delete the row at
-- the end of the retention period anyway (and its audit names the gatekeepers left). A sender whose send was in
-- flight during the erase marks it owed again once its call returns, so a scrub follows the last
-- send.
ALTER TABLE core_agreement_copy ADD COLUMN via TEXT CHECK (via IS NULL OR json_valid(via));
ALTER TABLE core_agreement_copy ADD COLUMN scrub_due_at TEXT;
ALTER TABLE core_agreement_copy ADD COLUMN scrub_owed_since TEXT;
ALTER TABLE core_agreement_copy ADD COLUMN scrub_error TEXT
  CHECK (scrub_error IS NULL OR scrub_error IN ('unreachable', 'inactive', 'failed'));
ALTER TABLE core_agreement_copy ADD COLUMN scrub_done TEXT
  CHECK (scrub_done IS NULL OR json_valid(scrub_done));
ALTER TABLE core_agreement_copy ADD COLUMN scrub_gone_since TEXT;
ALTER TABLE core_agreement_copy ADD COLUMN scrubbed_at TEXT;
CREATE INDEX core_agreement_copy_scrub_idx
  ON core_agreement_copy (scrub_due_at) WHERE scrub_due_at IS NOT NULL;

DROP TRIGGER core_agreement_copy_on_erase;
CREATE TRIGGER core_agreement_copy_on_erase
AFTER UPDATE OF erased_at ON core_agreement_acceptance
WHEN OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
BEGIN
  UPDATE core_agreement_copy
  SET to_address = NULL, next_at = NULL, error = NULL, pending_action_id = NULL,
    state = CASE WHEN state IN ('sent', 'failed') THEN state ELSE 'cancelled' END,
    scrub_due_at = CASE WHEN attempts > 0 THEN NEW.erased_at ELSE scrub_due_at END,
    scrub_owed_since = CASE WHEN attempts > 0 THEN coalesce(scrub_owed_since, NEW.erased_at)
      ELSE scrub_owed_since END
  WHERE acceptance_id = NEW.id;
END;

-- Migration 0854's rules, plus: a scrub is owed only for an erased acceptance, is cleared only by
-- recording that it was done, and when it was first owed never changes; where a send went is only
-- ever added to.
DROP TRIGGER core_agreement_copy_no_update;
CREATE TRIGGER core_agreement_copy_no_update
BEFORE UPDATE ON core_agreement_copy
BEGIN
  SELECT CASE
    WHEN NEW.acceptance_id IS NOT OLD.acceptance_id
      OR NEW.queued_at IS NOT OLD.queued_at OR NEW.requested_by IS NOT OLD.requested_by
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.to_address IS NOT OLD.to_address AND NOT (NEW.to_address IS NULL
        AND EXISTS (SELECT 1 FROM core_agreement_acceptance a
          WHERE a.id = OLD.acceptance_id AND a.erased_at IS NOT NULL))
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN OLD.state = 'sent' AND NEW.state != 'sent'
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.scrub_due_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core_agreement_acceptance a
        WHERE a.id = OLD.acceptance_id AND a.erased_at IS NOT NULL)
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN OLD.scrub_due_at IS NOT NULL AND NEW.scrub_due_at IS NULL
      AND NEW.scrubbed_at IS OLD.scrubbed_at
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN OLD.scrub_owed_since IS NOT NULL AND NEW.scrub_owed_since IS NOT OLD.scrub_owed_since
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.scrub_due_at IS NOT NULL AND NEW.scrub_owed_since IS NULL
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN OLD.via IS NOT NULL AND (NEW.via IS NULL OR EXISTS (
        SELECT 1 FROM json_each(OLD.via) o
        WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.via) n WHERE n.value = o.value)))
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
  END;
END;

-- A copy row is deleted only by the purge, with its acceptance, and never while a scrub is owed,
-- unless every gatekeeper left has been gone for 30 days (a gatekeeper that no longer exists must
-- not keep a record past its retention period; the purge audits it). One that exists but needs
-- re-authorising never starts that clock.
CREATE TRIGGER core_agreement_copy_no_delete
BEFORE DELETE ON core_agreement_copy
WHEN (OLD.scrub_due_at IS NOT NULL AND NOT (OLD.scrub_error IS 'unreachable' AND coalesce(
    OLD.scrub_gone_since < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days'), 0)))
  OR NOT EXISTS (
  SELECT 1 FROM core_agreement_acceptance a WHERE a.id = OLD.acceptance_id
    AND a.erased_at IS NOT NULL
    AND coalesce(a.erased_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || coalesce((
      SELECT CASE WHEN json_type(s.value, '$.years') = 'integer'
          AND json_extract(s.value, '$.years') BETWEEN 1 AND 50
        THEN json_extract(s.value, '$.years') ELSE 1000 END
      FROM core_settings s WHERE s.key = 'agreement_retention'), 7) || ' years'), 0)
    AND NOT EXISTS (SELECT 1 FROM core_agreement_hold h WHERE h.acceptance_id = a.id))
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_copy_fixed');
END;

-- A subscription checkout whose Person (payer or holder) or address was erased before the
-- provider confirmed it: closed (`erased_at`), its address cleared. A confirmation that arrives
-- later makes no subscription; staff are told to cancel it with the provider.
ALTER TABLE core_subscription_checkout ADD COLUMN erased_at TEXT;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '855'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 855;
