-- Registry migration 0795: the operator's commands (stage 66 step 7, ADR 0617).
--
-- 1. A client's environment never changes (issue #523, F4). Live and staging are two deployments,
--    each with its own registry; a row moved to the other environment by an UPDATE would be served
--    by the other deployment with an empty database. There is no move between environments: a
--    client in staging and in live is two rows in two registries, added by two commands.
-- 2. `registry_operations`: one row per run of an operator's command that changes more than one
--    thing (add, update, export, import, remove), with where it has got to. A command that stops
--    part-way (a crash, a lost connection) leaves its row unfinished, and the next run of the same
--    command reads it and carries on or undoes, never starting a second one beside it. Nothing of a
--    client's records is here: its state is the steps done, the bookmarks taken, the clients paused.
--    The version stamp does not move with it: no host reads this table.

CREATE TRIGGER registry_clients_environment_fixed
BEFORE UPDATE OF environment ON registry_clients
WHEN NEW.environment IS NOT OLD.environment
BEGIN
  SELECT RAISE(ABORT, 'a client''s environment never changes');
END;

CREATE TABLE registry_operations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 8 AND 64),
  kind TEXT NOT NULL CHECK (kind IN ('add', 'update', 'export', 'import', 'remove')),
  -- The client it is for; null for an update, which is every client's.
  client TEXT,
  -- What it has done so far, as JSON the command reads back (`OperationState` in registry-writes.ts).
  state TEXT NOT NULL CHECK (json_valid(state)),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Set once, when the command finished (succeeded, or undone): an unfinished row is resumed.
  finished_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded', 'undone', 'failed'))
) WITHOUT ROWID;

-- At most one unfinished run of each kind for a client (and one unfinished update), so two
-- operators cannot run the same command side by side.
CREATE UNIQUE INDEX registry_operations_unfinished
  ON registry_operations (kind, coalesce(client, ''))
  WHERE finished_at IS NULL;
