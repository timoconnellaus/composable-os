-- Migration 0533: allowances (stage 32b, the `allowance` behaviour, ADRs 0493 and 0494).
--
-- A holder (a pass, a membership: a record of an object that declares `allowance.holds`) grants a
-- number of uses per total, week or month, or unlimited uses. A spender (a booking, a visit)
-- spends one when it enters a state its object declares, and gives it back on entering another.
--
-- The rule is in the database, as capacity's is (migration 0440): a spend is a fixed set of
-- statements in the spender's own batch, with no read of the count first, and the database
-- refuses one past the limit, so the whole batch (the booking with it) is not applied. D1 runs one
-- statement at a time per database, so concurrent spends cannot both take the last use.
--
--   * core_allowance: the holder's terms, as the host keeps them from the record's own fields in
--     the batch of every write to it (who it is for, how many, per what, from and until, whether
--     its state lets it be spent, whether it is in the Trash).
--   * core_allowance_period: one counter per holder per period the holder has been spent in
--     (`total`, `week:<Monday's local date>`, `month:<YYYY-MM>`), with the limit copied from the
--     terms when the period's first use is spent. core_allowance_within_uses (CHECK) is the
--     guarantee; core_allowance_refuse_spend (a BEFORE trigger, same condition) refuses first
--     with the numbers (errors.ts parses `core_allowance_refused {json}`).
--   * core_allowance_use: one row per use, spent and perhaps given back. A BEFORE trigger refuses
--     a use the holder cannot pay at the spender's time: it is not theirs, not live, not yet
--     valid or ended. One unreturned use per spender (a partial unique index).
CREATE TABLE core_allowance (
  -- The holder's object (as in core_transition_history.object_type) and id.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The Person whose uses they are (the holder, not the payer: ADR 0487).
  person_id TEXT,
  -- Uses per period. NULL: unlimited (uses are still written and counted).
  uses INTEGER CHECK (uses IS NULL OR uses >= 0),
  per TEXT NOT NULL CHECK (per IN ('total', 'week', 'month')),
  -- The IANA zone weeks, months and dates are counted in.
  zone TEXT NOT NULL,
  -- ISO instants (toISOString), or NULL: open. A spender's time must be >= from and < until.
  valid_from TEXT,
  valid_until TEXT,
  -- 1 when the record's state is one its object declares live (or it has no states).
  live INTEGER NOT NULL CHECK (live IN (0, 1)),
  -- 1 while the record is in the Trash.
  trashed INTEGER NOT NULL DEFAULT 0 CHECK (trashed IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id)
) WITHOUT ROWID;
CREATE INDEX core_allowance_person_idx ON core_allowance (person_id);

CREATE TABLE core_allowance_period (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  period TEXT NOT NULL,
  per TEXT NOT NULL CHECK (per IN ('total', 'week', 'month')),
  -- The period's bounds, ISO instants: [starts_at, ends_at).
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  -- The limit for this period, from the terms. NULL: unlimited.
  uses INTEGER CHECK (uses IS NULL OR uses >= 0),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id, period),
  CONSTRAINT core_allowance_within_uses CHECK (uses IS NULL OR used <= uses),
  FOREIGN KEY (object_type, record_id) REFERENCES core_allowance (object_type, record_id)
    ON DELETE CASCADE
) WITHOUT ROWID;

-- Refuses a spend past the period's uses, with the numbers. Only a spend (used going up) is
-- refused: a limit lowered below what was spent keeps what was spent (ADR 0494).
CREATE TRIGGER core_allowance_refuse_spend
BEFORE UPDATE OF used ON core_allowance_period
WHEN NEW.uses IS NOT NULL AND NEW.used > NEW.uses AND NEW.used > OLD.used
BEGIN
  SELECT RAISE(ABORT, 'core_allowance_refused ' || json_object(
    'reason', 'no_uses_left',
    'object', NEW.object_type,
    'record', NEW.record_id,
    'period', NEW.period,
    'uses', NEW.uses,
    'used', OLD.used,
    'asked', NEW.used - OLD.used
  ));
END;

CREATE TABLE core_allowance_use (
  -- alu_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  -- The holder spent from, and the period the use counts in.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  period TEXT NOT NULL,
  -- The spender's record.
  spender_type TEXT NOT NULL,
  spender_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  -- The spender's time (a class's start), an ISO instant: the period is the one containing it.
  at TEXT NOT NULL,
  spent_at TEXT NOT NULL,
  -- Who made the move that spent it: staff, customer or host.
  spent_by TEXT NOT NULL CHECK (spent_by IN ('staff', 'customer', 'host')),
  returned_at TEXT,
  returned_by TEXT CHECK (returned_by IS NULL OR returned_by IN ('staff', 'customer', 'host')),
  -- The use this one took over, when a spender was moved to another (ADR 0493).
  moved_from TEXT,
  FOREIGN KEY (object_type, record_id, period)
    REFERENCES core_allowance_period (object_type, record_id, period) ON DELETE CASCADE,
  CHECK ((returned_at IS NULL) = (returned_by IS NULL))
);
CREATE INDEX core_allowance_use_holder_idx ON core_allowance_use (object_type, record_id, period);
CREATE INDEX core_allowance_use_person_idx ON core_allowance_use (person_id);
-- A spender holds at most one use at a time.
CREATE UNIQUE INDEX core_allowance_use_open_idx ON core_allowance_use (spender_type, spender_id)
  WHERE returned_at IS NULL;

-- Refuses a use the holder cannot pay at the spender's time, saying why.
CREATE TRIGGER core_allowance_refuse_use
BEFORE INSERT ON core_allowance_use
WHEN NOT EXISTS (
  SELECT 1 FROM core_allowance a
  WHERE a.object_type = NEW.object_type AND a.record_id = NEW.record_id
    AND a.person_id = NEW.person_id AND a.live = 1 AND a.trashed = 0
    AND (a.valid_from IS NULL OR a.valid_from <= NEW.at)
    AND (a.valid_until IS NULL OR NEW.at < a.valid_until)
)
BEGIN
  SELECT RAISE(ABORT, 'core_allowance_refused ' || json_object(
    'reason', coalesce((
      SELECT CASE
        WHEN a.person_id IS NOT NEW.person_id THEN 'not_theirs'
        WHEN a.live = 0 OR a.trashed = 1 THEN 'not_live'
        WHEN a.valid_from IS NOT NULL AND NEW.at < a.valid_from THEN 'not_yet_valid'
        ELSE 'ended'
      END
      FROM core_allowance a
      WHERE a.object_type = NEW.object_type AND a.record_id = NEW.record_id
    ), 'no_holder'),
    'object', NEW.object_type,
    'record', NEW.record_id,
    'at', NEW.at
  ));
END;

-- The read views, for query.sql and dashboards.
--
-- rec_allowance: one row per holder, its terms and the current period's numbers (`left` is what
-- can be spent now: 0 when it cannot be spent now, NULL when unlimited).
-- rec_allowance_period: every period a holder was spent in, with its numbers.
-- rec_allowance_use: every use, spent or given back.
CREATE VIEW rec_allowance AS
SELECT
  a.object_type,
  a.record_id,
  a.person_id,
  a.uses,
  a.per,
  a.zone,
  a.valid_from,
  a.valid_until,
  a.live,
  a.trashed,
  coalesce((
    SELECT p.used FROM core_allowance_period p
    WHERE p.object_type = a.object_type AND p.record_id = a.record_id AND p.per = a.per
      AND p.starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND p.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    LIMIT 1
  ), 0) AS used,
  CASE
    WHEN a.live = 0 OR a.trashed = 1
      OR (a.valid_from IS NOT NULL AND a.valid_from > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      OR (a.valid_until IS NOT NULL AND a.valid_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      THEN 0
    WHEN a.uses IS NULL THEN NULL
    ELSE max(a.uses - coalesce((
      SELECT p.used FROM core_allowance_period p
      WHERE p.object_type = a.object_type AND p.record_id = a.record_id AND p.per = a.per
        AND p.starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND p.ends_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      LIMIT 1
    ), 0), 0)
  END AS "left",
  a.updated_at
FROM core_allowance a;

CREATE VIEW rec_allowance_period AS
SELECT
  object_type,
  record_id,
  period,
  per,
  starts_at,
  ends_at,
  uses,
  used,
  CASE WHEN uses IS NULL THEN NULL ELSE max(uses - used, 0) END AS "left",
  updated_at
FROM core_allowance_period;

CREATE VIEW rec_allowance_use AS
SELECT
  id,
  object_type,
  record_id,
  period,
  spender_type,
  spender_id,
  person_id,
  at,
  spent_at,
  spent_by,
  returned_at,
  returned_by,
  moved_from
FROM core_allowance_use;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '533'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 533;
