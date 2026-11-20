-- Migration 0400: the audit log accepts the actors `customer` and `public` (stage 22, ADR 0402,
-- ADR 0412).
--
-- A customer's write is audited like any write, with actor `customer` and the customer account's
-- id (cus_…) in user_id. A call with no account has actor `public` and no user_id. Successful
-- reads by either are counted in core_audit_read_counts, as for non-human staff callers
-- (ADR 0090).
--
-- SQLite cannot alter a CHECK constraint, so both tables are rebuilt with the same rows, as
-- migration 0020 did for the `extension` actor. core_audit's children (core_audit_changes,
-- core_audit_redactions) reference it by name; foreign keys are deferred so the swap is checked
-- once, at commit. The two triggers on core_audit_redactions that name core_audit (one writes
-- it, one reads it) are dropped first and recreated after, so the rename sees a consistent
-- schema. The append-only triggers on core_audit go with the table. All are recreated exactly as
-- migration 0061 left them.
PRAGMA defer_foreign_keys = ON;

DROP TRIGGER core_audit_redactions_apply_audit;
DROP TRIGGER core_audit_redactions_no_delete;

CREATE TABLE core_audit_next (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  operation TEXT NOT NULL,
  risk TEXT NOT NULL
    CHECK (risk IN ('read', 'write', 'bulk-write', 'destructive', 'schema', 'extension', 'outbound')),
  actor TEXT NOT NULL
    CHECK (actor IN ('human', 'assistant', 'mcp', 'automation', 'extension', 'customer', 'public')),
  -- The staff user (usr_…), the customer account (cus_…) for actor `customer`, or null.
  user_id TEXT,
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  input TEXT NOT NULL CHECK (json_valid(input)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  gate_decision TEXT NOT NULL CHECK (gate_decision IN ('auto', 'review', 'deny')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'forbidden', 'denied', 'review', 'error')),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  -- Migration 0010: the pending action an audit row queued or applied.
  pending_action_id TEXT
);

INSERT INTO core_audit_next
  (id, at, operation, risk, actor, user_id, origin, input, result, gate_decision, outcome, error,
   pending_action_id)
SELECT id, at, operation, risk, actor, user_id, origin, input, result, gate_decision, outcome, error,
  pending_action_id
FROM core_audit;

DROP TABLE core_audit;
ALTER TABLE core_audit_next RENAME TO core_audit;

CREATE INDEX core_audit_at_idx ON core_audit (at, id);
CREATE INDEX core_audit_user_idx ON core_audit (user_id, at);
CREATE INDEX core_audit_operation_idx ON core_audit (operation, at);
CREATE INDEX core_audit_actor_idx ON core_audit (actor, at);
CREATE INDEX core_audit_pending_action_idx ON core_audit (pending_action_id)
  WHERE pending_action_id IS NOT NULL;

CREATE TRIGGER core_audit_no_update BEFORE UPDATE ON core_audit
WHEN NOT (
  EXISTS (SELECT 1 FROM core_audit_redactions r WHERE r.audit_id = OLD.id)
  AND NEW.id IS OLD.id
  AND NEW.at IS OLD.at
  AND NEW.operation IS OLD.operation
  AND NEW.risk IS OLD.risk
  AND NEW.actor IS OLD.actor
  AND NEW.user_id IS OLD.user_id
  AND NEW.origin IS OLD.origin
  AND NEW.gate_decision IS OLD.gate_decision
  AND NEW.outcome IS OLD.outcome
  AND NEW.input IS '"[erased]"'
  AND NEW.result IS (CASE WHEN OLD.result IS NULL THEN NULL ELSE '"[erased]"' END)
  AND NEW.error IS (CASE WHEN OLD.error IS NULL THEN NULL
    ELSE json_object('code', json_extract(OLD.error, '$.code'), 'message', '[erased]') END)
)
BEGIN
  SELECT RAISE(ABORT, 'core_audit is append-only');
END;

CREATE TRIGGER core_audit_no_delete BEFORE DELETE ON core_audit
WHEN NOT (
  (SELECT json_extract(value, '$.years') FROM core_settings WHERE key = 'audit_retention')
    IS NOT NULL
  AND OLD.at < coalesce((SELECT max(cutoff) FROM core_audit_purges), '')
)
BEGIN
  SELECT RAISE(ABORT, 'core_audit is append-only');
END;

CREATE TRIGGER core_audit_redactions_apply_audit AFTER INSERT ON core_audit_redactions
WHEN NEW.audit_id IS NOT NULL
BEGIN
  UPDATE core_audit SET
    input = '"[erased]"',
    result = CASE WHEN result IS NULL THEN NULL ELSE '"[erased]"' END,
    error = CASE WHEN error IS NULL THEN NULL
      ELSE json_object('code', json_extract(error, '$.code'), 'message', '[erased]') END
  WHERE id = NEW.audit_id;
END;

CREATE TRIGGER core_audit_redactions_no_delete BEFORE DELETE ON core_audit_redactions
WHEN NOT (
  (SELECT json_extract(value, '$.years') FROM core_settings WHERE key = 'audit_retention')
    IS NOT NULL
  AND coalesce(
    (SELECT a.at FROM core_audit a WHERE a.id = OLD.audit_id),
    (SELECT c.at FROM core_audit_changes c WHERE c.id = OLD.change_id)
  ) < coalesce((SELECT max(cutoff) FROM core_audit_purges), '')
)
BEGIN
  SELECT RAISE(ABORT, 'core_audit_redactions is append-only');
END;

-- Read counts: the same two actors.
CREATE TABLE core_audit_read_counts_next (
  -- The UTC hour, 'YYYY-MM-DDTHH:00:00.000Z'.
  hour TEXT NOT NULL,
  actor TEXT NOT NULL
    CHECK (actor IN ('human', 'assistant', 'mcp', 'automation', 'extension', 'customer', 'public')),
  -- The staff user, the customer account (cus_…) for actor `customer`, '' for actor `public`.
  user_id TEXT NOT NULL,
  -- Who exactly, within the actor: the connected app (cap_…) for MCP, the extension id, the
  -- automation id, else the MCP client id, else ''.
  caller TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  -- How many of them saw the session's simulated pending changes (ADR 0032).
  simulated INTEGER NOT NULL DEFAULT 0,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (hour, actor, user_id, caller, operation)
) WITHOUT ROWID;

INSERT INTO core_audit_read_counts_next
  (hour, actor, user_id, caller, operation, count, simulated, first_at, last_at)
SELECT hour, actor, user_id, caller, operation, count, simulated, first_at, last_at
FROM core_audit_read_counts;

DROP TABLE core_audit_read_counts;
ALTER TABLE core_audit_read_counts_next RENAME TO core_audit_read_counts;

CREATE INDEX core_audit_read_counts_user_idx ON core_audit_read_counts (user_id, hour);
