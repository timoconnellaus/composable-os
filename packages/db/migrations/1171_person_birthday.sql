-- Migration 1171: a birthday on Person (stage 53 step 7, ADR 0803).
--
-- Day and month only (decision 6 of the stage's spec): the host keeps no year and no date of
-- birth, so a birthday tells nobody a member's age, and a minor stays what the family link or the
-- Minor mark says (stage 44). Optional, both null or both set, and a day the month has (29
-- February is a birthday; a birthday journey keeps it on 28 February in other years). Set by staff
-- (`person.setBirthday`) or by the member for themselves (`me.birthday.set`), with a value mark
-- like any field (the pipeline, ADR 0590). In no `rec_*` view, so in no export or dashboard; erase
-- deletes it with the Person's row, and a merge keeps the survivor's unless it has none.
--
-- `core_birthday_guard` stores nothing: a birthday write's batch carries one row with the value the
-- write was planned from, and fails (`core_birthday_changed`) unless the Person still has it, so a
-- birthday set meanwhile (the member's own, while an AI's write was planned) is never overwritten
-- unseen.
--
-- The partial index is the birthday entry rule's: the People with a birthday on one day, read by
-- (month, day) in one indexed query.
ALTER TABLE core_person ADD COLUMN birth_day INTEGER
  CHECK (birth_day IS NULL OR birth_day BETWEEN 1 AND 31);
ALTER TABLE core_person ADD COLUMN birth_month INTEGER
  CHECK (
    CASE
      WHEN birth_month IS NULL THEN birth_day IS NULL
      ELSE birth_month BETWEEN 1 AND 12
        AND birth_day IS NOT NULL
        AND birth_day <= CASE
          WHEN birth_month = 2 THEN 29
          WHEN birth_month IN (4, 6, 9, 11) THEN 30
          ELSE 31
        END
    END
  );

CREATE INDEX core_person_birthday_idx ON core_person (birth_month, birth_day, id)
  WHERE birth_month IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE core_birthday_guard (
  person_id TEXT NOT NULL,
  birth_day INTEGER,
  birth_month INTEGER
);

CREATE TRIGGER core_birthday_guard_check
BEFORE INSERT ON core_birthday_guard
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM core_person p WHERE p.id = NEW.person_id
        AND p.birth_day IS NEW.birth_day AND p.birth_month IS NEW.birth_month)
      THEN RAISE(ABORT, 'core_birthday_changed')
    ELSE RAISE(IGNORE)
  END;
END;
