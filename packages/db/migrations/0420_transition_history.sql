-- Migration 0420: one history table for the transition engine (stage 25, ADR 0425).
--
-- `stages` (ADR 0100) and `states` are two declarations on one engine, and the engine keeps one
-- history: a row per position a record has been in, with the times it entered and left.
-- `core_stage_history` becomes that table. It gains:
--   form        which declaration the row belongs to: 'stages' or 'states';
--   entered_as  who made the move: 'staff', 'customer' or 'host' (platform code).
-- For a state-driven object `stage_id` holds the state's value (there is no stage record),
-- `group_id` is NULL and `stage_type` is 'open' or 'final'.
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt. Every existing row
-- is copied with its id: all of them are stage rows, entered by staff (nothing else could move a
-- record before this migration).
CREATE TABLE core_stage_history_0420 (
  id TEXT PRIMARY KEY NOT NULL,
  -- Registry name of the object: `deals.deal`.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  form TEXT NOT NULL DEFAULT 'stages' CHECK (form IN ('stages', 'states')),
  -- The position entered: a stage record's id, or a state's value.
  stage_id TEXT NOT NULL,
  -- The stage's group (pipeline) when the record entered it, if the behaviour has groups.
  group_id TEXT,
  -- Stages: the stage type when the record entered it (open, won, lost).
  -- States: 'final' when the state ends the lifecycle, else 'open'.
  stage_type TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  left_at TEXT,
  entered_by TEXT,
  entered_as TEXT NOT NULL DEFAULT 'staff' CHECK (entered_as IN ('staff', 'customer', 'host')),
  CHECK (
    (form = 'stages' AND stage_type IN ('open', 'won', 'lost'))
    OR (form = 'states' AND stage_type IN ('open', 'final'))
  )
);

INSERT INTO core_stage_history_0420
  (id, object_type, record_id, form, stage_id, group_id, stage_type, entered_at, left_at,
   entered_by, entered_as)
SELECT id, object_type, record_id, 'stages', stage_id, group_id, stage_type, entered_at, left_at,
  entered_by, 'staff'
FROM core_stage_history;

DROP VIEW rec_stage_history;
DROP TABLE core_stage_history;
ALTER TABLE core_stage_history_0420 RENAME TO core_stage_history;

-- The indexes of migration 0100, unchanged. An object has one lifecycle (stages or states, never
-- both), so a record still has at most one current row.
CREATE INDEX core_stage_history_record_idx
  ON core_stage_history (object_type, record_id, entered_at);
CREATE UNIQUE INDEX core_stage_history_current_idx
  ON core_stage_history (object_type, record_id) WHERE left_at IS NULL;
CREATE INDEX core_stage_history_stage_idx ON core_stage_history (stage_id, entered_at);

-- Stage-driven objects: the name, columns and numbers the view has had since 0100 and 0380.
CREATE VIEW rec_stage_history AS
SELECT
  id,
  object_type,
  record_id,
  stage_id,
  group_id,
  stage_type,
  entered_at,
  left_at,
  left_at IS NULL AS is_current,
  round(
    julianday(coalesce(left_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) - julianday(entered_at),
    4
  ) AS days_in_stage,
  entered_by
FROM core_stage_history
WHERE form = 'stages';

-- State-driven objects. `days_in_state` runs to now for the current state.
CREATE VIEW rec_state_history AS
SELECT
  id,
  object_type,
  record_id,
  stage_id AS state,
  stage_type = 'final' AS is_final,
  entered_at,
  left_at,
  left_at IS NULL AS is_current,
  round(
    julianday(coalesce(left_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) - julianday(entered_at),
    4
  ) AS days_in_state,
  entered_by,
  entered_as
FROM core_stage_history
WHERE form = 'states';

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '420'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 420;
