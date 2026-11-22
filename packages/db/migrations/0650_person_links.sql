-- Migration 0650: the family link (stage 31a step 6, ADR 0540).
--
-- A link between two People: a guardian and a dependant (a parent and a child). While it is live
-- (not ended), the visibility seam lets the guardian, signed in as a customer, read the
-- dependant's records of every object whose customer declaration opts in (`guardians`), and
-- write them where it says so (book a class for a child). Nothing else reads it to decide access.
--
-- Staff make and end links, a person only (`person.link.add` and `person.link.end`, permission
-- `people:link`). An ended link is kept, with who ended it and when, as the audit of who could act
-- for whom; it gives nothing. A dependant may have several guardians and a guardian several
-- dependants; one live link per pair. A link from a Person to themselves cannot exist.
--
-- Both people are core_person rows: an erase (a hard delete) removes their links with them by the
-- foreign keys; a merge re-points them to the survivor in its batch (person.merge).
CREATE TABLE core_person_link (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'guardian' CHECK (kind IN ('guardian')),
  guardian_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  dependant_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  -- Why staff made it (optional): "mother", "guardian by court order".
  note TEXT,
  -- The staff account (usr_…) that made it, and when.
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Set when it ends; it never starts again (a new link is made instead).
  ended_at TEXT,
  ended_by TEXT,
  end_reason TEXT,
  CHECK (guardian_id != dependant_id)
);
-- One live link per pair and kind; the guardian's dependants are what the seam reads.
CREATE UNIQUE INDEX core_person_link_live_uq
  ON core_person_link (guardian_id, dependant_id, kind) WHERE ended_at IS NULL;
CREATE INDEX core_person_link_dependant_idx ON core_person_link (dependant_id, ended_at);

-- The guard a guardian's write carries in its own batch (ADR 0540): one row saying "this guardian
-- acts for this dependant". The trigger lets it through (and drops it: nothing is stored) only
-- while the link is live and both People are out of the Trash; otherwise the whole batch fails,
-- so a link ended a moment before cannot be written through.
CREATE TABLE core_person_link_guard (
  guardian_id TEXT NOT NULL,
  dependant_id TEXT NOT NULL
);

CREATE TRIGGER core_person_link_guard_check
BEFORE INSERT ON core_person_link_guard
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM core_person_link l
      JOIN core_person d ON d.id = l.dependant_id AND d.deleted_at IS NULL
      JOIN core_person g ON g.id = l.guardian_id AND g.deleted_at IS NULL
      WHERE l.guardian_id = NEW.guardian_id AND l.dependant_id = NEW.dependant_id
        AND l.kind = 'guardian' AND l.ended_at IS NULL
    )
      THEN RAISE(ABORT, 'core_person_link_not_live')
    ELSE RAISE(IGNORE)
  END;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '650'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 650;
