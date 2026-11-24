-- Migration 1232: note kinds and their templates (stage 56 step 2, ADR 0833).
--
-- A note (an Activity of type `note`, migration 1230) has a kind: the business's kinds of note,
-- kept by people holding `notes:manage` in Settings → Notes. A kind carries a template (labelled
-- sections a person fills in: Worked on / How it went / Next time), the level a note of it starts
-- at and the lowest level one may have. A kind is never deleted: retired, it is no longer offered
-- and keeps its notes. Not personal: every staff account reads the list.
--
-- Its other columns are read by later steps of the stage and set from them: whether files may be
-- attached (record files, step 3), whether its notes are evidence an erase keeps for a while and
-- how many whole years its notes are kept (erase and retention, step 7). Until then they hold the
-- seeds' values and do nothing.
--
-- Four kinds ship. `note` is the kind of every note written without one (the assistant's drafts,
-- an import, the API) and of every note already held: it is never retired and stays at `staff`,
-- so a note written without a kind is read as notes always were. `session`, `sensitive` and
-- `from_client` are the stage's own; later steps find them by `key`. A business's own kinds have
-- no key.
CREATE TABLE core_note_kind (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT UNIQUE CHECK (key IS NULL OR key IN ('note', 'session', 'sensitive', 'from_client')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  default_level TEXT NOT NULL DEFAULT 'staff'
    CHECK (default_level IN ('staff', 'coaches', 'sensitive')),
  lowest_level TEXT NOT NULL DEFAULT 'staff'
    CHECK (lowest_level IN ('staff', 'coaches', 'sensitive')),
  -- The template: [{ key, label, hint, required }], at most 12 (the operation's limit).
  sections TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sections) AND json_type(sections) = 'array'),
  files_allowed INTEGER NOT NULL DEFAULT 0 CHECK (files_allowed IN (0, 1)),
  evidence INTEGER NOT NULL DEFAULT 0 CHECK (evidence IN (0, 1)),
  -- Whole years after the note; null keeps notes until a person deletes them (stage 56, decision 8).
  retention_years INTEGER CHECK (retention_years IS NULL OR retention_years BETWEEN 1 AND 100),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- Where it sits in the composer's list.
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  -- A note starts at or above the lowest level its kind allows.
  CHECK (
    (CASE default_level WHEN 'staff' THEN 0 WHEN 'coaches' THEN 1 ELSE 2 END) >=
    (CASE lowest_level WHEN 'staff' THEN 0 WHEN 'coaches' THEN 1 ELSE 2 END)
  ),
  -- The kind of a note written without one stays every staff account's, and in use.
  CHECK (key IS NOT 'note' OR (default_level = 'staff' AND lowest_level = 'staff' AND active = 1))
);
-- Two kinds of one name would be one choice in the composer.
CREATE UNIQUE INDEX core_note_kind_name_uq ON core_note_kind (lower(name));

INSERT INTO core_note_kind
  (id, key, name, default_level, lowest_level, sections, files_allowed, position, created_at,
   updated_at)
VALUES
  ('nkd_note', 'note', 'Note', 'staff', 'staff', '[]', 0, 0,
   '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z'),
  ('nkd_session', 'session', 'Session note', 'coaches', 'staff',
   '[{"key":"worked_on","label":"Worked on","hint":"What you worked on together","required":true},'
   || '{"key":"how_it_went","label":"How it went","hint":null,"required":false},'
   || '{"key":"next_time","label":"Next time","hint":null,"required":false}]',
   0, 1, '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z'),
  ('nkd_sensitive', 'sensitive', 'Sensitive', 'sensitive', 'sensitive', '[]', 0, 2,
   '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z'),
  ('nkd_from_client', 'from_client', 'From the client', 'coaches', 'staff', '[]', 1, 3,
   '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z');

-- Note's template never has a required section: a note written without a kind has a body only,
-- and a required section would refuse every one (the operation says why first).
CREATE TRIGGER core_note_kind_note_insert
BEFORE INSERT ON core_note_kind
WHEN NEW.key IS 'note'
  AND EXISTS (SELECT 1 FROM json_each(NEW.sections) s WHERE json_extract(s.value, '$.required') = 1)
BEGIN
  SELECT RAISE(ABORT, 'core_note_kind_default');
END;

CREATE TRIGGER core_note_kind_note_update
BEFORE UPDATE OF sections, key ON core_note_kind
WHEN NEW.key IS 'note'
  AND EXISTS (SELECT 1 FROM json_each(NEW.sections) s WHERE json_extract(s.value, '$.required') = 1)
BEGIN
  SELECT RAISE(ABORT, 'core_note_kind_default');
END;

-- Every note already held is a Note. Before the triggers below: it changes no level.
UPDATE core_activity SET kind_id = 'nkd_note' WHERE type = 'note' AND kind_id IS NULL;

-- A kind is only a note's, and a note is never below its kind's lowest level, for every writer:
-- the operations check it first and say why; this holds it against a kind changed meanwhile.
CREATE TRIGGER core_activity_kind_insert
BEFORE INSERT ON core_activity
WHEN NEW.kind_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.type != 'note' THEN RAISE(ABORT, 'core_activity_kind_not_note')
    WHEN NOT EXISTS (SELECT 1 FROM core_note_kind k WHERE k.id = NEW.kind_id)
      THEN RAISE(ABORT, 'core_activity_kind_unknown')
    WHEN (CASE NEW.level WHEN 'staff' THEN 0 WHEN 'coaches' THEN 1 ELSE 2 END) <
      (SELECT CASE k.lowest_level WHEN 'staff' THEN 0 WHEN 'coaches' THEN 1 ELSE 2 END
       FROM core_note_kind k WHERE k.id = NEW.kind_id)
      THEN RAISE(ABORT, 'core_note_below_kind')
  END;
END;

CREATE TRIGGER core_activity_kind_update
BEFORE UPDATE OF kind_id, level, type ON core_activity
WHEN NEW.kind_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.type != 'note' THEN RAISE(ABORT, 'core_activity_kind_not_note')
    WHEN NOT EXISTS (SELECT 1 FROM core_note_kind k WHERE k.id = NEW.kind_id)
      THEN RAISE(ABORT, 'core_activity_kind_unknown')
    WHEN (CASE NEW.level WHEN 'staff' THEN 0 WHEN 'coaches' THEN 1 ELSE 2 END) <
      (SELECT CASE k.lowest_level WHEN 'staff' THEN 0 WHEN 'coaches' THEN 1 ELSE 2 END
       FROM core_note_kind k WHERE k.id = NEW.kind_id)
      THEN RAISE(ABORT, 'core_note_below_kind')
  END;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1232'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1232;
