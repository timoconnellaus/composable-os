-- Registry migration 0794: a removed client's id is never used again (stage 66 step 4, hardening:
-- the second review of PR #512, S3; ADR 0615).
--
-- Every object of a client is named from its id (and, since this hardening, its secret
-- generation), its database is the object named by its id, and its parked messages carry its id.
-- A client removed and added again under the same id would find all of that waiting for it: the
-- old client's objects, its database, and messages parked for it in the last 7 days. So a removed
-- id is kept here, and adding a client with it is refused. The id of a client never changes
-- either (an UPDATE of it would be a removal and an add in one).
--
-- Nothing in the host or `cos` deletes from this table: an id once used stays used. Only an
-- operator who has deleted every object, database and parked message of the old client could
-- remove its row by hand, to use the id again.

CREATE TABLE registry_removed_clients (
  id TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL,
  -- The generation it had, so what was made for it can be told apart from anything later.
  secret_generation TEXT,
  removed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

-- Ids already removed before this migration are not known: none has been removed yet (the
-- registry's writer is stage 66 step 7).

CREATE TRIGGER registry_clients_removed AFTER DELETE ON registry_clients
BEGIN
  INSERT OR IGNORE INTO registry_removed_clients (id, environment, secret_generation)
  VALUES (OLD.id, OLD.environment, OLD.secret_generation);
END;

CREATE TRIGGER registry_clients_id_not_reused BEFORE INSERT ON registry_clients
WHEN EXISTS (SELECT 1 FROM registry_removed_clients WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'a removed client''s id is never used again');
END;

CREATE TRIGGER registry_clients_id_fixed BEFORE UPDATE OF id ON registry_clients
WHEN NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'a client''s id never changes');
END;
