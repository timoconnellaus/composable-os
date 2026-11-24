-- Migration 1390: locations, a base record (stage 64 step 1, ADR 0910).
--
-- One place the business works from, inside the one organisation (ADR 0001): never a tenant.
-- A gym's second studio, later a trades business's depot. Its name (unique, whatever the case),
-- a short name for a badge, its address (the business's, not personal data), its time zone, whether
-- the public is shown it, its own drop-in price in minor units (empty: not set), open or closed,
-- and staff notes.
--
-- Every host has one location from the start: the main location, made here from the
-- organisation's name and zone (`org_name`, `org_timezone`, JSON strings in core_settings), or
-- "Main location" in UTC on a host the setup wizard has not named yet. It is the row with
-- `main = 1`, with the first id there can be (a ULID of time zero, so it sorts first); its zone
-- follows the organisation's (settings.update). Every statement is written to
-- run again without change: the table, its indexes, triggers and view only if missing, and the
-- main location only while there is none.
--
-- Nothing deletes a location: it is closed. The last open location cannot be closed, refused by
-- the database for every writer (two closes at once of the last two open ones: one lands).
CREATE TABLE IF NOT EXISTS core_location (
  -- NOT NULL: a rowid table's TEXT key would otherwise take a NULL, which no comparison matches.
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  short_name TEXT CHECK (short_name IS NULL OR length(short_name) BETWEEN 1 AND 16),
  address TEXT CHECK (address IS NULL OR length(address) <= 500),
  timezone TEXT NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  public INTEGER NOT NULL DEFAULT 1 CHECK (public IN (0, 1)),
  drop_in_price INTEGER CHECK (drop_in_price IS NULL OR drop_in_price >= 0),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 5000),
  main INTEGER NOT NULL DEFAULT 0 CHECK (main IN (0, 1)),
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS core_location_name_idx ON core_location (name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS core_location_main_idx ON core_location (main) WHERE main = 1;

CREATE TRIGGER IF NOT EXISTS core_location_last_open
BEFORE UPDATE OF state ON core_location
WHEN OLD.state = 'open' AND NEW.state <> 'open'
  AND NOT EXISTS (SELECT 1 FROM core_location WHERE state = 'open' AND id <> OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'core_location_last_open');
END;

CREATE TRIGGER IF NOT EXISTS core_location_main_kept
BEFORE UPDATE OF main ON core_location
WHEN OLD.main <> NEW.main
BEGIN
  SELECT RAISE(ABORT, 'core_location_main_kept');
END;

-- The locations, as staff list them. `listed` is what the public declaration tests (ADR 0916):
-- 'yes' only for a location shown to the public that is open.
CREATE VIEW IF NOT EXISTS rec_location AS
  SELECT id, name, short_name, address, timezone, public, drop_in_price, state, notes, main,
    CASE WHEN public = 1 AND state = 'open' THEN 'yes' ELSE 'no' END AS listed,
    created_at, created_by, updated_at, updated_by
  FROM core_location;

INSERT INTO core_location (id, name, timezone, main, created_at, updated_at)
SELECT 'loc_00000000000000000000000001',
  coalesce(
    nullif(trim((SELECT json_extract(value, '$') FROM core_settings
      WHERE key = 'org_name' AND json_type(value) = 'text')), ''),
    'Main location'
  ),
  coalesce(
    (SELECT json_extract(value, '$') FROM core_settings
      WHERE key = 'org_timezone' AND json_type(value) = 'text'),
    'UTC'
  ),
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM core_location WHERE main = 1);
