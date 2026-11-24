-- Migration 0955: one person per folded address (stage 34, build step 2, ADR 0692, issue #225).
--
-- An address's folded form is the address with its `+tag` dropped (`a+1@x` and `a+2@x` are both
-- `a@x`), on every domain; dots are not folded (`a.b@x` and `ab@x` stay two). It is used only to
-- decide "the same person" for the one-per-Person rules: a free trial (ADR 0489), something sold
-- once per Person (an intro offer, ADR 0512), and later a per-person code, a new-customer check
-- and a referral. Never an identity: the Person, the account and the address mailed stay as typed.
--
-- `core_person_emails.folded` is kept by triggers from `email` (stored lower-cased and trimmed),
-- so no writer of addresses has to know about it; `foldAddress` in
-- packages/core/src/customers/accounts.ts is the same rule in code, and a test holds the two
-- together. The index serves "every live Person sharing a folded address with this one".
ALTER TABLE core_person_emails ADD COLUMN folded TEXT;

UPDATE core_person_emails SET folded = CASE
  WHEN instr(email, '+') > 1 AND instr(email, '+') < instr(email, '@')
  THEN substr(email, 1, instr(email, '+') - 1) || substr(email, instr(email, '@'))
  ELSE email END;

CREATE TRIGGER core_person_emails_fold_on_insert
AFTER INSERT ON core_person_emails
BEGIN
  UPDATE core_person_emails SET folded = CASE
    WHEN instr(NEW.email, '+') > 1 AND instr(NEW.email, '+') < instr(NEW.email, '@')
    THEN substr(NEW.email, 1, instr(NEW.email, '+') - 1) || substr(NEW.email, instr(NEW.email, '@'))
    ELSE NEW.email END
  WHERE id = NEW.id;
END;

CREATE TRIGGER core_person_emails_fold_on_update
AFTER UPDATE OF email, folded ON core_person_emails
WHEN NEW.folded IS NOT CASE
    WHEN instr(NEW.email, '+') > 1 AND instr(NEW.email, '+') < instr(NEW.email, '@')
    THEN substr(NEW.email, 1, instr(NEW.email, '+') - 1) || substr(NEW.email, instr(NEW.email, '@'))
    ELSE NEW.email END
BEGIN
  UPDATE core_person_emails SET folded = CASE
    WHEN instr(NEW.email, '+') > 1 AND instr(NEW.email, '+') < instr(NEW.email, '@')
    THEN substr(NEW.email, 1, instr(NEW.email, '+') - 1) || substr(NEW.email, instr(NEW.email, '@'))
    ELSE NEW.email END
  WHERE id = NEW.id;
END;

CREATE INDEX core_person_emails_folded_idx ON core_person_emails (folded) WHERE live = 1;

-- The database's backstop for two starts at once by two People who are one person: as migration
-- 0581's unique index (one Person) and 0531's trigger (one Person) refuse the second hold, these
-- refuse a hold while another live Person sharing a folded address has one held or used on the
-- same object. A pass given by hand by a person on the staff (`source = 'by_hand'`, ADR 0513) is
-- not refused here: it is the staff's deliberate override (a family sharing one mailbox), and it
-- still counts against the others.
CREATE TRIGGER core_sellable_once_folded
BEFORE INSERT ON core_sellable_once
WHEN NEW.state IN ('held', 'used') AND NEW.source = 'order' AND EXISTS (
  SELECT 1 FROM core_person_emails mine
  JOIN core_person_emails theirs ON theirs.folded = mine.folded AND theirs.live = 1
  JOIN core_sellable_once o ON o.person_id = theirs.person_id
  WHERE mine.person_id = NEW.person_id
    AND mine.live = 1
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
  JOIN core_person_emails theirs ON theirs.folded = mine.folded AND theirs.live = 1
  JOIN core_subscription_trial t ON t.holder_person_id = theirs.person_id
  WHERE mine.person_id = NEW.holder_person_id
    AND mine.live = 1
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
