-- Migration 0857: a child's paper form copy goes to the parent or guardian staff pick (stage 44,
-- ADR 0648, amending ADR 0645). Nothing here touches core_write_guard. (0856 is claimed by another
-- branch of block AX, docs/parallel-work.md.)
--
-- Until now `agreement.copy.send` refused a minor's paper form, and the database allowed a paper
-- copy only to the Person's own linked sign-in address or one of their addresses. Now staff pick a
-- live guardian of the child, and the copy row records whom (`guardian_id`): its address must be
-- that guardian's own linked sign-in address or one of their addresses, the guardian must have a
-- live link to the child at the insert, and only for a paper acceptance. Nothing wider: with no
-- `guardian_id` every rule of migration 0854 holds unchanged.
--
-- The row belongs to the child's acceptance but carries the guardian's address, so the address
-- goes with either of them: erasing the child erases the acceptance (migration 0855's trigger
-- clears the address and owes the scrub); erasing the guardian clears the address, the guardian's
-- id and any send not yet gone, and owes the scrub too, recorded as `guardian_erased_at`
-- (`agreements/people.ts`). A merge moves `guardian_id` to the survivor only.
--
-- Every other guarantee is unchanged: no insert over an existing row (INSERT OR REPLACE and
-- upserts are refused, D1 runs with recursive_triggers off), the address never changes once
-- written except to nothing, a sent copy stays sent, the scrub rules of migration 0855.

-- The parent or guardian a child's paper form was sent to, picked by staff; null for every other
-- copy, and once that guardian is erased.
ALTER TABLE core_agreement_copy ADD COLUMN guardian_id TEXT;
-- When that guardian was erased: their address left the row then.
ALTER TABLE core_agreement_copy ADD COLUMN guardian_erased_at TEXT;
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
      OR NEW.guardian_erased_at IS NOT NULL
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    -- Migration 0854's rule, unchanged: the acceptance's own address, or for paper the Person's.
    WHEN NEW.guardian_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM core_agreement_acceptance a
      WHERE a.id = NEW.acceptance_id AND a.erased_at IS NULL AND a.person_id IS NOT NULL
        AND (
          (a.by != 'paper' AND a.email IS NOT NULL AND lower(a.email) = lower(NEW.to_address))
          OR (a.by = 'paper' AND (
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
-- with the address cleared; the address may then be cleared, and a scrub owed, as for an erased
-- acceptance.
DROP TRIGGER core_agreement_copy_no_update;
CREATE TRIGGER core_agreement_copy_no_update
BEFORE UPDATE ON core_agreement_copy
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
    WHEN NEW.to_address IS NOT OLD.to_address AND NOT (NEW.to_address IS NULL
        AND (NEW.guardian_erased_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM core_agreement_acceptance a
            WHERE a.id = OLD.acceptance_id AND a.erased_at IS NOT NULL)))
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN OLD.state = 'sent' AND NEW.state != 'sent'
      THEN RAISE(ABORT, 'core_agreement_copy_fixed')
    WHEN NEW.scrub_due_at IS NOT NULL AND NEW.guardian_erased_at IS NULL
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

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '857'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 857;
