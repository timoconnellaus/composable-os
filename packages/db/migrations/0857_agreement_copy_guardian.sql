-- Migration 0857: a child's paper form copy goes to the parent or guardian staff pick (stage 44,
-- ADR 0648, amending ADR 0645). Nothing here touches core_write_guard. (0856 is claimed by another
-- branch of block AX, docs/parallel-work.md.)
--
-- Until now `agreement.copy.send` refused a minor's paper form, and the database allowed a paper
-- copy only to the Person's own linked sign-in address or one of their addresses. Now staff pick a
-- live guardian of the child, and the copy row records whom (`guardian_id`): its address must be
-- that guardian's own linked sign-in address or one of their addresses, the guardian must have a
-- live link to the child at the insert, and only for a paper acceptance. A paper copy with no
-- guardian is now refused for a Person who is a minor (marked, or with a live guardian link): it
-- never goes to the child, in the database too. Otherwise migration 0854's rule holds unchanged.
--
-- The row belongs to the child's acceptance but carries the guardian's address, so the address
-- goes with either of them: erasing the child erases the acceptance (migration 0855's trigger
-- clears the address and owes the scrub); erasing the guardian clears the address, the guardian's
-- id and any send not yet gone, and owes the scrub too, recorded as `guardian_erased_at`
-- (`agreements/people.ts`). A merge moves `guardian_id` to the survivor only.
--
-- A copy not yet gone goes only while the link is live (the review of PR #301). The moment the
-- link ends, or is deleted, or the guardian or the child goes to the Trash, every such copy still
-- open (queued, sending, or waiting for a person's approval) is cancelled: the address cleared,
-- recorded as `guardian_ended_at`, its pending approval turned down and redacted (so nobody can
-- release it), and the scrub owed if it ever reached the email gatekeeper. The sender checks the
-- link again before every send or re-ask (`agreements/copy.ts`).
--
-- A cancelled guardian copy that never reached the gatekeeper (no try made, nothing sent, no scrub
-- owed) may be asked for again, to a live guardian (`core_agreement_copy_reopen`): the same row,
-- the same first key, under the insert's rules. Nothing was ever sent under that key, so the
-- gatekeeper's first-send answer can only be for this one: exactly once still holds.
--
-- Every other guarantee is unchanged: no insert over an existing row (INSERT OR REPLACE and
-- upserts are refused, D1 runs with recursive_triggers off), the address never changes once
-- written except to nothing, a sent copy stays sent, the scrub rules of migration 0855.

-- The parent or guardian a child's paper form was sent to, picked by staff; null for every other
-- copy, and once that guardian is erased.
ALTER TABLE core_agreement_copy ADD COLUMN guardian_id TEXT;
-- When that guardian was erased: their address left the row then.
ALTER TABLE core_agreement_copy ADD COLUMN guardian_erased_at TEXT;
-- When the guardian's link to the child stopped being live before the copy went: it was cancelled
-- and its address cleared then.
ALTER TABLE core_agreement_copy ADD COLUMN guardian_ended_at TEXT;
CREATE INDEX core_agreement_copy_guardian_idx
  ON core_agreement_copy (guardian_id) WHERE guardian_id IS NOT NULL;

DROP TRIGGER core_agreement_copy_new;
CREATE TRIGGER core_agreement_copy_new
BEFORE INSERT ON core_agreement_copy
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_agreement_copy c WHERE c.acceptance_id = NEW.acceptance_id)
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.state != 'queued' OR NEW.attempts != 0 OR NEW.sent_at IS NOT NULL
      OR NEW.next_at IS NULL OR NEW.to_address IS NULL
      OR NEW.send_key != 'agreement-copy:' || NEW.acceptance_id
      OR NEW.guardian_erased_at IS NOT NULL OR NEW.guardian_ended_at IS NOT NULL
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    -- Migration 0854's rule: the acceptance's own address, or for paper the Person's, and for
    -- paper never a minor's (marked, or with a live guardian link: as the host reads a minor).
    WHEN NEW.guardian_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM core_agreement_acceptance a
      WHERE a.id = NEW.acceptance_id AND a.erased_at IS NULL AND a.person_id IS NOT NULL
        AND (
          (a.by != 'paper' AND a.email IS NOT NULL AND lower(a.email) = lower(NEW.to_address))
          OR (a.by = 'paper'
            AND NOT EXISTS (SELECT 1 FROM core_agreement_minor m WHERE m.person_id = a.person_id)
            AND NOT EXISTS (SELECT 1 FROM core_person_link l
              JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
              JOIN core_person d ON d.id = l.dependant_id AND d.deleted_at IS NULL
              WHERE l.dependant_id = a.person_id AND l.kind = 'guardian' AND l.ended_at IS NULL)
            AND (
              EXISTS (SELECT 1 FROM core_customer c WHERE c.person_id = a.person_id
                AND c.status = 'active' AND c.link_state = 'linked'
                AND lower(c.email) = lower(NEW.to_address))
              OR EXISTS (SELECT 1 FROM core_person_emails e WHERE e.person_id = a.person_id
                AND lower(e.email) = lower(NEW.to_address))))
        )
    )
      THEN RAISE(ABORT, 'core_agreement_copy_address')
    -- A child's paper form: to a live guardian of the Person it is for (the link not ended, both
    -- out of the Trash, as the seam reads it), at that guardian's own linked sign-in address or
    -- one of their addresses.
    WHEN NEW.guardian_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM core_agreement_acceptance a
      JOIN core_person d ON d.id = a.person_id AND d.deleted_at IS NULL
      JOIN core_person_link l ON l.dependant_id = a.person_id AND l.guardian_id = NEW.guardian_id
        AND l.kind = 'guardian' AND l.ended_at IS NULL
      JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
      WHERE a.id = NEW.acceptance_id AND a.erased_at IS NULL AND a.by = 'paper'
        AND (
          EXISTS (SELECT 1 FROM core_customer c WHERE c.person_id = g.id
            AND c.status = 'active' AND c.link_state = 'linked'
            AND lower(c.email) = lower(NEW.to_address))
          OR EXISTS (SELECT 1 FROM core_person_emails e WHERE e.person_id = g.id
            AND lower(e.email) = lower(NEW.to_address)))
    )
      THEN RAISE(ABORT, 'core_agreement_copy_address')
  END;
END;

-- Migration 0855's rules, plus: whom a child's paper copy went to changes only to a merge's
-- survivor, or to nothing once that Person is gone (erased), recorded once in guardian_erased_at
-- with the address cleared; an open copy whose guardian's link is no longer live is cancelled,
-- recorded once in guardian_ended_at with the address cleared; in either case the address may be
-- cleared, and a scrub owed, as for an erased acceptance. A cancelled copy coming back is the
-- reopen trigger's alone.
DROP TRIGGER core_agreement_copy_no_update;
CREATE TRIGGER core_agreement_copy_no_update
BEFORE UPDATE ON core_agreement_copy
WHEN NOT (OLD.state = 'cancelled' AND NEW.state != 'cancelled')
BEGIN
  SELECT CASE
    WHEN NEW.acceptance_id IS NOT OLD.acceptance_id
      OR NEW.queued_at IS NOT OLD.queued_at OR NEW.requested_by IS NOT OLD.requested_by
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.guardian_id IS NOT OLD.guardian_id AND NOT (
        (OLD.guardian_id IS NOT NULL AND NEW.guardian_id IS NOT NULL
          AND NEW.guardian_id IS (
            SELECT p.merged_into_id FROM core_person p WHERE p.id = OLD.guardian_id))
        OR (OLD.guardian_id IS NOT NULL AND NEW.guardian_id IS NULL
          AND NEW.guardian_erased_at IS NOT NULL AND NEW.to_address IS NULL
          AND NOT EXISTS (SELECT 1 FROM core_person p WHERE p.id = OLD.guardian_id)))
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.guardian_erased_at IS NOT OLD.guardian_erased_at AND NOT (
        OLD.guardian_erased_at IS NULL AND OLD.guardian_id IS NOT NULL AND NEW.guardian_id IS NULL)
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    -- Set once, on a copy not yet gone, cancelled with its address cleared, only when the
    -- guardian's link to the child is no longer live.
    WHEN NEW.guardian_ended_at IS NOT OLD.guardian_ended_at AND NOT (
        OLD.guardian_ended_at IS NULL AND OLD.guardian_id IS NOT NULL
        AND OLD.state IN ('queued', 'sending', 'waiting') AND NEW.state = 'cancelled'
        AND NEW.to_address IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM core_agreement_acceptance a
          JOIN core_person d ON d.id = a.person_id AND d.deleted_at IS NULL
          JOIN core_person_link l ON l.dependant_id = a.person_id
            AND l.guardian_id = OLD.guardian_id AND l.kind = 'guardian' AND l.ended_at IS NULL
          JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
          WHERE a.id = OLD.acceptance_id))
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.to_address IS NOT OLD.to_address AND NOT (NEW.to_address IS NULL
        AND (NEW.guardian_erased_at IS NOT NULL OR NEW.guardian_ended_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM core_agreement_acceptance a
            WHERE a.id = OLD.acceptance_id AND a.erased_at IS NOT NULL)))
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN OLD.state = 'sent' AND NEW.state != 'sent'
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.scrub_due_at IS NOT NULL AND NEW.guardian_erased_at IS NULL
      AND NEW.guardian_ended_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM core_agreement_acceptance a
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

-- A cancelled copy asked for again (`agreement.copy.send`): only a guardian copy cancelled because
-- its guardian was erased or their link ended, that never reached the email gatekeeper (no try,
-- nothing sent, no scrub owed or done) and whose acceptance is not erased; back to its first
-- state, with its first key, to a live guardian's own address under the insert's rule. Any other
-- move out of `cancelled` is refused.
CREATE TRIGGER core_agreement_copy_reopen
BEFORE UPDATE ON core_agreement_copy
WHEN OLD.state = 'cancelled' AND NEW.state != 'cancelled'
BEGIN
  SELECT CASE
    WHEN NOT (OLD.attempts = 0 AND OLD.sent_at IS NULL AND OLD.to_address IS NULL
        AND OLD.scrub_due_at IS NULL AND OLD.scrub_owed_since IS NULL AND OLD.scrubbed_at IS NULL
        AND OLD.pending_action_id IS NULL
        AND (OLD.guardian_ended_at IS NOT NULL OR OLD.guardian_erased_at IS NOT NULL))
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.acceptance_id IS NOT OLD.acceptance_id OR NEW.state != 'queued'
      OR NEW.attempts != 0 OR NEW.sent_at IS NOT NULL OR NEW.next_at IS NULL
      OR NEW.claimed_at IS NOT NULL OR NEW.to_address IS NULL OR NEW.requested_by IS NULL
      OR NEW.send_key != 'agreement-copy:' || OLD.acceptance_id
      OR NEW.guardian_id IS NULL OR NEW.guardian_ended_at IS NOT NULL
      OR NEW.guardian_erased_at IS NOT NULL OR NEW.pending_action_id IS NOT NULL
      OR NEW.scrub_due_at IS NOT NULL OR NEW.scrub_owed_since IS NOT NULL
      OR NEW.scrub_error IS NOT NULL OR NEW.scrub_done IS NOT NULL
      OR NEW.scrub_gone_since IS NOT NULL OR NEW.scrubbed_at IS NOT NULL
      OR NEW.via IS NOT OLD.via
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NOT EXISTS (
      SELECT 1 FROM core_agreement_acceptance a
      JOIN core_person d ON d.id = a.person_id AND d.deleted_at IS NULL
      JOIN core_person_link l ON l.dependant_id = a.person_id AND l.guardian_id = NEW.guardian_id
        AND l.kind = 'guardian' AND l.ended_at IS NULL
      JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
      WHERE a.id = OLD.acceptance_id AND a.erased_at IS NULL AND a.by = 'paper'
        AND (
          EXISTS (SELECT 1 FROM core_customer c WHERE c.person_id = g.id
            AND c.status = 'active' AND c.link_state = 'linked'
            AND lower(c.email) = lower(NEW.to_address))
          OR EXISTS (SELECT 1 FROM core_person_emails e WHERE e.person_id = g.id
            AND lower(e.email) = lower(NEW.to_address)))
    )
      THEN RAISE(ABORT, 'core_agreement_copy_address')
  END;
END;

-- The moment a guardian's link stops being live (ended, deleted, or either Person to the Trash):
-- every guardian copy still open whose link is no longer live is cancelled, its pending approval
-- turned down and redacted first (so nobody can release the held send), and the scrub owed if it
-- reached the email gatekeeper. The same two statements in each trigger, and in the sender
-- (`cancelUnlinkedGuardianCopies`).
CREATE TRIGGER core_agreement_copy_link_end
AFTER UPDATE OF ended_at ON core_person_link
WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
BEGIN
  UPDATE core_pending_action SET
    input = '"[erased]"', reason = '[erased]', preview = '[]',
    simulated = '{"output":null,"records":[]}',
    status_reason = CASE WHEN status = 'pending'
      THEN 'Rejected: the parent or guardian it was for is no longer linked to the child'
      ELSE status_reason END,
    decided_at = CASE WHEN status = 'pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE decided_at END,
    status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END
  WHERE id IN (SELECT c.pending_action_id FROM core_agreement_copy c
    JOIN core_agreement_acceptance a ON a.id = c.acceptance_id
    WHERE c.guardian_id IS NOT NULL AND c.pending_action_id IS NOT NULL
      AND c.state IN ('queued', 'sending', 'waiting')
      AND NOT EXISTS (SELECT 1 FROM core_person_link l
        JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
        JOIN core_person d ON d.id = l.dependant_id AND d.deleted_at IS NULL
        WHERE l.guardian_id = c.guardian_id AND l.dependant_id = a.person_id
          AND l.kind = 'guardian' AND l.ended_at IS NULL));
  UPDATE core_agreement_copy SET
    scrub_due_at = CASE WHEN attempts > 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE scrub_due_at END,
    scrub_owed_since = CASE WHEN attempts > 0
      THEN coalesce(scrub_owed_since, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ELSE scrub_owed_since END,
    to_address = NULL, next_at = NULL, error = NULL, pending_action_id = NULL,
    state = 'cancelled', guardian_ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE guardian_id IS NOT NULL AND state IN ('queued', 'sending', 'waiting')
    AND NOT EXISTS (SELECT 1 FROM core_agreement_acceptance a
      JOIN core_person_link l ON l.dependant_id = a.person_id
        AND l.guardian_id = core_agreement_copy.guardian_id
        AND l.kind = 'guardian' AND l.ended_at IS NULL
      JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
      JOIN core_person d ON d.id = l.dependant_id AND d.deleted_at IS NULL
      WHERE a.id = core_agreement_copy.acceptance_id);
END;

CREATE TRIGGER core_agreement_copy_link_delete
AFTER DELETE ON core_person_link
BEGIN
  UPDATE core_pending_action SET
    input = '"[erased]"', reason = '[erased]', preview = '[]',
    simulated = '{"output":null,"records":[]}',
    status_reason = CASE WHEN status = 'pending'
      THEN 'Rejected: the parent or guardian it was for is no longer linked to the child'
      ELSE status_reason END,
    decided_at = CASE WHEN status = 'pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE decided_at END,
    status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END
  WHERE id IN (SELECT c.pending_action_id FROM core_agreement_copy c
    JOIN core_agreement_acceptance a ON a.id = c.acceptance_id
    WHERE c.guardian_id IS NOT NULL AND c.pending_action_id IS NOT NULL
      AND c.state IN ('queued', 'sending', 'waiting')
      AND NOT EXISTS (SELECT 1 FROM core_person_link l
        JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
        JOIN core_person d ON d.id = l.dependant_id AND d.deleted_at IS NULL
        WHERE l.guardian_id = c.guardian_id AND l.dependant_id = a.person_id
          AND l.kind = 'guardian' AND l.ended_at IS NULL));
  UPDATE core_agreement_copy SET
    scrub_due_at = CASE WHEN attempts > 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE scrub_due_at END,
    scrub_owed_since = CASE WHEN attempts > 0
      THEN coalesce(scrub_owed_since, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ELSE scrub_owed_since END,
    to_address = NULL, next_at = NULL, error = NULL, pending_action_id = NULL,
    state = 'cancelled', guardian_ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE guardian_id IS NOT NULL AND state IN ('queued', 'sending', 'waiting')
    AND NOT EXISTS (SELECT 1 FROM core_agreement_acceptance a
      JOIN core_person_link l ON l.dependant_id = a.person_id
        AND l.guardian_id = core_agreement_copy.guardian_id
        AND l.kind = 'guardian' AND l.ended_at IS NULL
      JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
      JOIN core_person d ON d.id = l.dependant_id AND d.deleted_at IS NULL
      WHERE a.id = core_agreement_copy.acceptance_id);
END;

CREATE TRIGGER core_agreement_copy_person_trash
AFTER UPDATE OF deleted_at ON core_person
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE core_pending_action SET
    input = '"[erased]"', reason = '[erased]', preview = '[]',
    simulated = '{"output":null,"records":[]}',
    status_reason = CASE WHEN status = 'pending'
      THEN 'Rejected: the parent or guardian it was for is no longer linked to the child'
      ELSE status_reason END,
    decided_at = CASE WHEN status = 'pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE decided_at END,
    status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END
  WHERE id IN (SELECT c.pending_action_id FROM core_agreement_copy c
    JOIN core_agreement_acceptance a ON a.id = c.acceptance_id
    WHERE c.guardian_id IS NOT NULL AND c.pending_action_id IS NOT NULL
      AND c.state IN ('queued', 'sending', 'waiting')
      AND NOT EXISTS (SELECT 1 FROM core_person_link l
        JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
        JOIN core_person d ON d.id = l.dependant_id AND d.deleted_at IS NULL
        WHERE l.guardian_id = c.guardian_id AND l.dependant_id = a.person_id
          AND l.kind = 'guardian' AND l.ended_at IS NULL));
  UPDATE core_agreement_copy SET
    scrub_due_at = CASE WHEN attempts > 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ELSE scrub_due_at END,
    scrub_owed_since = CASE WHEN attempts > 0
      THEN coalesce(scrub_owed_since, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ELSE scrub_owed_since END,
    to_address = NULL, next_at = NULL, error = NULL, pending_action_id = NULL,
    state = 'cancelled', guardian_ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE guardian_id IS NOT NULL AND state IN ('queued', 'sending', 'waiting')
    AND NOT EXISTS (SELECT 1 FROM core_agreement_acceptance a
      JOIN core_person_link l ON l.dependant_id = a.person_id
        AND l.guardian_id = core_agreement_copy.guardian_id
        AND l.kind = 'guardian' AND l.ended_at IS NULL
      JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
      JOIN core_person d ON d.id = l.dependant_id AND d.deleted_at IS NULL
      WHERE a.id = core_agreement_copy.acceptance_id);
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '857'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 857;
