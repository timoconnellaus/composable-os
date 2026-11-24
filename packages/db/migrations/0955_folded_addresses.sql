-- Migration 0955: one person per folded address (stage 34, build step 2, ADR 0692, issue #225).
--
-- An address's folded form is the address with its `+tag` dropped (`a+1@x` and `a+2@x` are both
-- `a@x`), on every domain; dots are not folded (`a.b@x` and `ab@x` stay two). It is used only to
-- decide "the same person" for the one-per-Person rules: a free trial (ADR 0489), something sold
-- once per Person (an intro offer, ADR 0512), and later a per-person code, a new-customer check
-- and a referral. Never an identity: the Person, the account and the address mailed stay as typed.
--
-- The folded form is an expression over `core_person_emails.email` (stored lower-cased and
-- trimmed), indexed, and never stored: nothing is written when an address is, so adding one costs
-- what it did. `foldedSql` in packages/core/src/customers/accounts.ts writes the same expression
-- (it must match this one for the index to serve it) and `foldAddress` the same rule in code; a
-- test holds the three together.
--
-- Every address row counts, a Person in the Trash's too (their trial and intro offer stay theirs
-- and still count while they could be restored). A merged Person's addresses are deleted, and
-- their rows moved to the survivor; an erased Person's go with them.
CREATE INDEX core_person_emails_folded_idx ON core_person_emails (
  CASE
    WHEN instr(email, '+') > 1 AND instr(email, '+') < instr(email, '@')
    THEN substr(email, 1, instr(email, '+') - 1) || substr(email, instr(email, '@'))
    ELSE email
  END
);

-- The database's backstop for two starts at once by two People who are one person: as migration
-- 0581's unique index (one Person) and 0531's trigger (one Person) refuse the second hold, these
-- refuse a hold while another Person sharing a folded address has one held or used on the same
-- object. A pass given by hand by a person on the staff (`source = 'by_hand'`, ADR 0513) is not
-- refused here: it is the staff's deliberate override (a family sharing one mailbox), and it
-- still counts against the others.
CREATE TRIGGER core_sellable_once_folded
BEFORE INSERT ON core_sellable_once
WHEN NEW.state IN ('held', 'used') AND NEW.source = 'order' AND EXISTS (
  SELECT 1 FROM core_person_emails mine
  JOIN core_person_emails theirs ON (
    CASE
      WHEN instr(theirs.email, '+') > 1 AND instr(theirs.email, '+') < instr(theirs.email, '@')
      THEN substr(theirs.email, 1, instr(theirs.email, '+') - 1)
        || substr(theirs.email, instr(theirs.email, '@'))
      ELSE theirs.email
    END
  ) = (
    CASE
      WHEN instr(mine.email, '+') > 1 AND instr(mine.email, '+') < instr(mine.email, '@')
      THEN substr(mine.email, 1, instr(mine.email, '+') - 1)
        || substr(mine.email, instr(mine.email, '@'))
      ELSE mine.email
    END
  )
  JOIN core_sellable_once o ON o.person_id = theirs.person_id
  WHERE mine.person_id = NEW.person_id
    AND theirs.person_id <> NEW.person_id
    AND o.object_type = NEW.object_type
    AND o.state IN ('held', 'used')
)
BEGIN
  SELECT RAISE(ABORT, 'core_sellable_once_folded');
END;

CREATE TRIGGER core_subscription_trial_folded
BEFORE INSERT ON core_subscription_trial
WHEN EXISTS (
  SELECT 1 FROM core_person_emails mine
  JOIN core_person_emails theirs ON (
    CASE
      WHEN instr(theirs.email, '+') > 1 AND instr(theirs.email, '+') < instr(theirs.email, '@')
      THEN substr(theirs.email, 1, instr(theirs.email, '+') - 1)
        || substr(theirs.email, instr(theirs.email, '@'))
      ELSE theirs.email
    END
  ) = (
    CASE
      WHEN instr(mine.email, '+') > 1 AND instr(mine.email, '+') < instr(mine.email, '@')
      THEN substr(mine.email, 1, instr(mine.email, '+') - 1)
        || substr(mine.email, instr(mine.email, '@'))
      ELSE mine.email
    END
  )
  JOIN core_subscription_trial t ON t.holder_person_id = theirs.person_id
  WHERE mine.person_id = NEW.holder_person_id
    AND theirs.person_id <> NEW.holder_person_id
    AND t.plan_object = NEW.plan_object
    AND (t.used_at IS NOT NULL OR t.released_at IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'core_subscription_trial_taken');
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '955'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 955;
