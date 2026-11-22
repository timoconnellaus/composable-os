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
--   * core_allowance: the holder's terms, derived by the host in SQL from the stored record in the
--     batch of every write to it (so two writes to different fields cannot leave a stale row), and
--     for every record by the reconciler when the declaration is installed or changed.
--   * core_allowance_period: one counter per holder per period the holder has been spent in
--     (`total`, `week:<Monday's local date>`, `month:<YYYY-MM>`), with the period's real limit. A
--     period may sit above a limit lowered after its uses were spent; it then takes no spend until
--     it is back under. core_allowance_refuse_spend (a BEFORE trigger) is the guarantee: it refuses
--     any change that takes `used` up past the limit, whoever writes it, with the numbers
--     (errors.ts parses `core_allowance_refused {json}`). The one exception is a re-keying after a
--     change of period or zone (`rekeyed` goes up with `used`): uses already spent move to their
--     new period even past its limit, as a lowered limit leaves them.
--   * core_allowance_use: one row per use, spent and perhaps given back. A BEFORE trigger refuses
--     a use the holder cannot pay at the spender's time: it is not theirs, not live, its Person is
--     in the Trash, it is not yet valid or has ended. One open use per spender (a partial unique
--     index).
CREATE TABLE core_allowance (
  -- The holder's object (as in core_transition_history.object_type) and id.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The Person whose uses they are (the holder, not the payer: ADR 0487).
  person_id TEXT,
  -- Uses per period. NULL: unlimited (only where the object declares an empty field so).
  uses INTEGER CHECK (uses IS NULL OR uses >= 0),
  per TEXT NOT NULL CHECK (per IN ('total', 'week', 'month')),
  -- The IANA zone weeks, months and dates are counted in: the holder's own field, else the
  -- organisation's when the holder was first written (ADR 0494: it does not follow the setting).
  zone TEXT NOT NULL,
  -- A datetime `from` / `until`, as ISO instants: a spender's time must be >= from and < until.
  valid_from TEXT,
  valid_until TEXT,
  -- A date `from` / `until` (YYYY-MM-DD in `zone`): the spender's local date must be in them.
  from_date TEXT,
  until_date TEXT,
  -- 1 when the record's state is one its object declares live (or it has no states).
  live INTEGER NOT NULL CHECK (live IN (0, 1)),
  -- 1 while the record is in the Trash.
  trashed INTEGER NOT NULL DEFAULT 0 CHECK (trashed IN (0, 1)),
  -- A change of period or zone applies from the end of the period running when it was made
  -- (ADR 0494): before `applies_from`, spends are counted by `prev_per` in `prev_zone`.
  prev_per TEXT CHECK (prev_per IS NULL OR prev_per IN ('total', 'week', 'month')),
  prev_zone TEXT,
  applies_from TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id)
) WITHOUT ROWID;
-- What a spend reads: the Person's holders of the objects that may pay for it.
CREATE INDEX core_allowance_person_idx ON core_allowance (person_id, object_type);

CREATE TABLE core_allowance_period (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  period TEXT NOT NULL,
  per TEXT NOT NULL CHECK (per IN ('total', 'week', 'month')),
  zone TEXT NOT NULL,
  -- The period's bounds, ISO instants: [starts_at, ends_at).
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  -- The limit for this period, from the terms (followed by current and future periods when the
  -- terms change). NULL: unlimited.
  uses INTEGER CHECK (uses IS NULL OR uses >= 0),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  -- Uses moved here by a re-keying (a change of period or zone): see the header.
  rekeyed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  -- Keyed with its keying (per and zone), so a holder's periods under an old keying never mix
  -- with those under the new one.
  PRIMARY KEY (object_type, record_id, period, zone),
  FOREIGN KEY (object_type, record_id) REFERENCES core_allowance (object_type, record_id)
    ON DELETE CASCADE
) WITHOUT ROWID;

-- Refuses a spend that would take a period past its limit, with the real limit. A period over a
-- lowered limit takes no spend; giving uses back (used going down) is never refused.
CREATE TRIGGER core_allowance_refuse_spend
BEFORE UPDATE OF used ON core_allowance_period
WHEN NEW.uses IS NOT NULL AND NEW.used > NEW.uses AND NEW.used > OLD.used
  AND NEW.rekeyed = OLD.rekeyed
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
  -- The holder spent from, and the period (with its zone) the use counts in.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  period TEXT NOT NULL,
  zone TEXT NOT NULL,
  -- The spender's record.
  spender_type TEXT NOT NULL,
  spender_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  -- The spender's time (a class's start), an ISO instant, and its local date in the holder's
  -- zone: the period is the one containing it.
  at TEXT NOT NULL,
  at_date TEXT NOT NULL,
  spent_at TEXT NOT NULL,
  -- Who made the move that spent it: staff, customer or host.
  spent_by TEXT NOT NULL CHECK (spent_by IN ('staff', 'customer', 'host')),
  returned_at TEXT,
  returned_by TEXT CHECK (returned_by IS NULL OR returned_by IN ('staff', 'customer', 'host')),
  -- The use this one took over, when a spender was moved to another, or re-spent after what it
  -- points at changed (ADR 0493).
  moved_from TEXT,
  FOREIGN KEY (object_type, record_id, period, zone)
    REFERENCES core_allowance_period (object_type, record_id, period, zone) ON DELETE CASCADE,
  CHECK ((returned_at IS NULL) = (returned_by IS NULL))
);
CREATE INDEX core_allowance_use_holder_idx ON core_allowance_use (object_type, record_id, period);
CREATE INDEX core_allowance_use_person_idx ON core_allowance_use (person_id);
-- A spender holds at most one use at a time (and its open use is found by this index).
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
    AND (a.from_date IS NULL OR a.from_date <= NEW.at_date)
    AND (a.until_date IS NULL OR NEW.at_date <= a.until_date)
) OR NOT EXISTS (
  SELECT 1 FROM core_person p WHERE p.id = NEW.person_id AND p.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'core_allowance_refused ' || json_object(
    'reason', coalesce((
      SELECT CASE
        WHEN a.person_id IS NOT NEW.person_id THEN 'not_theirs'
        WHEN NOT EXISTS (
          SELECT 1 FROM core_person p WHERE p.id = NEW.person_id AND p.deleted_at IS NULL
        ) THEN 'not_live'
        WHEN a.live = 0 OR a.trashed = 1 THEN 'not_live'
        WHEN (a.valid_from IS NOT NULL AND NEW.at < a.valid_from)
          OR (a.from_date IS NOT NULL AND NEW.at_date < a.from_date) THEN 'not_yet_valid'
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
-- can be spent now: 0 when it cannot be spent now, NULL when unlimited). A date `from` / `until`
-- is compared with today's date in UTC here (the host's own answers use the holder's zone).
-- rec_allowance_period: every period a holder was spent in, with its numbers.
-- rec_allowance_use: every use, spent or given back.
CREATE VIEW rec_allowance AS
WITH c AS (
  SELECT
    a.*,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now_at,
    CASE WHEN a.applies_from IS NOT NULL AND a.applies_from > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      THEN a.prev_per ELSE a.per END AS cur_per,
    CASE WHEN a.applies_from IS NOT NULL AND a.applies_from > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      THEN a.prev_zone ELSE a.zone END AS cur_zone
  FROM core_allowance a
), n AS (
  SELECT
    c.*,
    coalesce((
      SELECT p.used FROM core_allowance_period p
      WHERE p.object_type = c.object_type AND p.record_id = c.record_id
        AND p.per = c.cur_per AND p.zone = c.cur_zone
        AND p.starts_at <= c.now_at AND p.ends_at > c.now_at
    ), 0) AS cur_used
  FROM c
)
SELECT
  object_type,
  record_id,
  person_id,
  uses,
  per,
  zone,
  valid_from,
  valid_until,
  from_date,
  until_date,
  live,
  trashed,
  cur_used AS used,
  CASE
    WHEN live = 0 OR trashed = 1
      OR (valid_from IS NOT NULL AND valid_from > now_at)
      OR (valid_until IS NOT NULL AND valid_until <= now_at)
      OR (from_date IS NOT NULL AND from_date > date('now'))
      OR (until_date IS NOT NULL AND until_date < date('now'))
      THEN 0
    WHEN uses IS NULL THEN NULL
    ELSE max(uses - cur_used, 0)
  END AS "left",
  updated_at
FROM n;

CREATE VIEW rec_allowance_period AS
SELECT
  object_type,
  record_id,
  period,
  per,
  zone,
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
  zone,
  spender_type,
  spender_id,
  person_id,
  at,
  at_date,
  spent_at,
  spent_by,
  returned_at,
  returned_by,
  moved_from
FROM core_allowance_use;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '533'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 533;
