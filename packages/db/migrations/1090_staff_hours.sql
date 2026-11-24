-- Migration 1090: open hours, when someone takes appointments (stage 49 step 3, ADR 0762).
--
-- Beside core_staff_away and read the same way: a weekly rule (weekdays, a local start and end
-- time in a zone, from a date and until one, empty: ongoing), checked by wall clock on the fly, so
-- 09:00 is 09:00 on both sides of a clock change; an end at or before the start is the next day's
-- (overnight hours). Or extra hours: a one-off range of instants, with the zone it was given in.
-- Optionally for some kinds of work only (`only_for`, a JSON list of {object, id}, the shift's kind:
-- a coach who does assessments only on Saturdays); empty: every kind. A one-off "not open" is time
-- off (core_staff_away), never a row here: one place for "not working".
--
-- Keyed by an account id (a staff account today; a practitioner account from stage 49 step 7),
-- text with no foreign key, as core_staff_time is. Set by the person or a rosterer
-- (`staffing.hours.set`); removed when they leave. About someone's working week: in no rec_* view,
-- so no member's SQL, export or the assistant's record reads see it.
CREATE TABLE core_staff_hours (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('weekly', 'extra')),
  -- Weekdays as a comma list of mon … sun.
  weekdays TEXT,
  start_time TEXT CHECK (start_time IS NULL OR start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time TEXT CHECK (end_time IS NULL OR end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  from_date TEXT,
  until_date TEXT,
  starts_at TEXT,
  ends_at TEXT,
  zone TEXT NOT NULL,
  only_for TEXT CHECK (only_for IS NULL OR (json_valid(only_for) AND json_type(only_for) = 'array')),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  CHECK (kind != 'weekly' OR (weekdays IS NOT NULL AND start_time IS NOT NULL
    AND end_time IS NOT NULL AND from_date IS NOT NULL AND starts_at IS NULL AND ends_at IS NULL)),
  CHECK (kind != 'extra' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at
    AND weekdays IS NULL AND start_time IS NULL AND end_time IS NULL AND from_date IS NULL
    AND until_date IS NULL)),
  CHECK (until_date IS NULL OR from_date IS NULL OR until_date >= from_date)
);

CREATE INDEX core_staff_hours_account ON core_staff_hours (account_id);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1090'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1090;
