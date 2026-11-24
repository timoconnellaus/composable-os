-- Stage 38 step 3 (ADR 0702): read and understood. A publishable object that declares
-- `acknowledge` asks the staff who must read a record to confirm its current version.
--
-- Each version of such a record says whether it asks everyone again (`read_again` 1) or is a
-- small fix (0); the first version always asks. A scheduled publish carries the choice to the
-- version the minute cron makes. Other objects' versions leave it NULL. Only
-- packages/core/src/records/publish.ts writes either table.
ALTER TABLE core_publish_version ADD COLUMN read_again INTEGER
  CHECK (read_again IS NULL OR read_again IN (0, 1));
ALTER TABLE core_publish_schedule ADD COLUMN read_again INTEGER
  CHECK (read_again IS NULL OR read_again IN (0, 1));

-- A confirmation: one staff account saying it has read and understood one published version.
-- Only the account itself makes one, by a person's tap (`ack.confirm`, `actors: ["human"]`);
-- `how` has no other value. Not in any `rec_*` view: dashboards, query.sql, exports and the
-- assistant's record reads never reach it.
CREATE TABLE core_publish_ack (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  -- The staff account (core_user) that confirmed.
  account_id TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  how TEXT NOT NULL DEFAULT 'self' CHECK (how = 'self'),
  PRIMARY KEY (object_type, record_id, version, account_id)
) WITHOUT ROWID;
CREATE INDEX core_publish_ack_account_idx ON core_publish_ack (account_id);

-- Only the record's current version is confirmed, and only by a live person's account. A second
-- confirmation of one version fails on the key.
CREATE TRIGGER core_publish_ack_new
BEFORE INSERT ON core_publish_ack
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM core_publish_version v
        WHERE v.object_type = NEW.object_type AND v.record_id = NEW.record_id
          AND v.version = NEW.version AND v.current = 1)
      THEN RAISE(ABORT, 'core_publish_ack_not_current')
    WHEN NOT EXISTS (SELECT 1 FROM core_user u
        WHERE u.id = NEW.account_id AND u.kind = 'human' AND u.deactivated_at IS NULL)
      THEN RAISE(ABORT, 'core_publish_ack_not_a_person')
  END;
END;

-- Nothing a confirmation says ever changes, by anyone, host code included.
CREATE TRIGGER core_publish_ack_no_update
BEFORE UPDATE ON core_publish_ack
BEGIN
  SELECT RAISE(ABORT, 'core_publish_ack_immutable');
END;

-- Kept for good, through deactivation and unpublishing. It goes only with what it is about: once
-- the account is gone (erased) or the version it confirms is gone (the record purged).
CREATE TRIGGER core_publish_ack_no_delete
BEFORE DELETE ON core_publish_ack
WHEN EXISTS (SELECT 1 FROM core_user u WHERE u.id = OLD.account_id)
  AND EXISTS (SELECT 1 FROM core_publish_version v
    WHERE v.object_type = OLD.object_type AND v.record_id = OLD.record_id
      AND v.version = OLD.version)
BEGIN
  SELECT RAISE(ABORT, 'core_publish_ack_immutable');
END;
