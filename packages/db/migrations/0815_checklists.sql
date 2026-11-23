-- Migration 0815: checklists (stage 45 step 4b, ADR 0650).
--
-- A checklist is a list of steps a business writes once (a close-down clean, opening up) and
-- picks on something that happens (a duty, through a `checklist` field). Each record that is live
-- with one gets a **run**: the steps copied as they were when the run was made, so a template
-- changed later changes no run already made. Its person ticks each step (done, or not done with
-- why, and a note where the step asks for one); someone who rosters may tick for them, with a
-- reason, and the tick keeps both accounts. A run marked done never changes again; one not done by
-- its close and grace is closed by the host as missed.
--
-- About staff, and what they did: in no rec_* view, so no SQL, export, dashboard or the
-- assistant's record reads see it. Read only through the host's operations, which give a run to
-- its person and to those who roster.
--
-- **A closed run never changes**, for every writer and every statement shape. D1 runs with
-- recursive_triggers off, so a REPLACE (INSERT OR REPLACE, UPSERT's conflict, UPDATE OR REPLACE)
-- deletes the row it replaces without firing a delete trigger: every insert and update trigger
-- below therefore also checks the row it would replace. The host never inserts a run that is there
-- already (it reads first, `NOT EXISTS`), so these triggers refuse only what nothing should do, and
-- no host step can fail on them for ever.

-- A template. Not personal: every staff account reads it. Written by people holding
-- checklists:write; an AI's write waits for a person (the operation's review), so a template
-- staff are asked to follow is always one a person approved.
CREATE TABLE core_checklist (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- What it is for (a line for whoever picks it).
  purpose TEXT CHECK (purpose IS NULL OR length(purpose) <= 500),
  -- Only an active template may be picked; one made inactive keeps the runs it gave.
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  -- Bumped by every change of its name or steps; a run keeps the version it copied.
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX core_checklist_name ON core_checklist (active, name);

-- A template's steps as they are now, in order (position from 0). Replaced whole by a change of
-- the template; runs already made keep their own copy.
CREATE TABLE core_checklist_step (
  checklist_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 49),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 300),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  -- Asks for a note: a tick of it as done needs one.
  asks_note INTEGER NOT NULL DEFAULT 0 CHECK (asks_note IN (0, 1)),
  PRIMARY KEY (checklist_id, position)
) WITHOUT ROWID;

-- A run: one template, as it was, attached to one record (a shift). One per record, ever.
CREATE TABLE core_checklist_run (
  id TEXT PRIMARY KEY NOT NULL,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  checklist_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  -- The template's name and steps as they were when the run was made: a JSON array of
  -- { "text", "required", "note" }. Never changed.
  name TEXT NOT NULL,
  steps TEXT NOT NULL CHECK (json_valid(steps) AND json_type(steps) = 'array'
    AND json_array_length(steps) BETWEEN 1 AND 50),
  -- Whose run it is: the record's person, kept current by the host while it is open (a shift
  -- reassigned moves to its new person; the ticks keep who made them), fixed when it closes.
  account_id TEXT,
  -- When it may be ticked (unix seconds): the record's opening and closing times, kept current by
  -- the host while it is open. Ticks are taken until `closes` and the grace after it.
  opens INTEGER NOT NULL,
  closes INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'done', 'missed', 'cancelled')),
  made_at TEXT NOT NULL,
  -- The record left its live states (cancelled, the Trash, removed) after the run opened: when,
  -- and by whom when that was someone who rosters (or the host). Set by the host's record writes;
  -- cleared if it comes back. At the close, a record ended by someone who does not roster is
  -- missed, not cancelled.
  ended_at TEXT,
  ended_by TEXT,
  -- Closed: when; by whom (the person, someone who rosters for them, whoever cancelled it, or
  -- null: the host); and, marked done for someone, why.
  closed_at TEXT,
  closed_by TEXT,
  closed_why TEXT CHECK (closed_why IS NULL OR length(closed_why) <= 500),
  -- Missed: the positions of the required steps nobody ticked, as a JSON array.
  missed_steps TEXT,
  UNIQUE (object_type, record_id)
);

-- The open runs by their close (the minute cron's read), a person's runs, a template's.
CREATE INDEX core_checklist_run_open ON core_checklist_run (closes) WHERE state = 'open';
CREATE INDEX core_checklist_run_opens ON core_checklist_run (opens);
CREATE INDEX core_checklist_run_account ON core_checklist_run (account_id, opens);
CREATE INDEX core_checklist_run_template ON core_checklist_run (checklist_id, opens);

-- Ticks of a run's steps (position from 0, as in the run's steps). **A tick is never changed or
-- removed**: a later tick of the same step (by the person, or by someone who rosters for them) is a
-- new row, and the latest counts; a clear is a `cleared` tick. So every tick anyone made stays,
-- the earlier ones readable as history by those who roster and by their authors.
CREATE TABLE core_checklist_tick (
  -- Time-ordered (a ULID): with `ticked_at`, the latest of a step is the last.
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 49),
  -- done; not done, with why; or cleared (the step counts as not ticked again).
  state TEXT NOT NULL CHECK (state IN ('done', 'not_done', 'cleared')),
  why TEXT CHECK (why IS NULL OR length(why) BETWEEN 1 AND 500),
  -- What the person wrote on the step. Private: its author and those who roster only.
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  -- Who ticked it, and whose run it was for. On someone's behalf: someone who rosters ticked it
  -- for the run's person, with why; never shown or counted as the person's own tick.
  ticked_by TEXT NOT NULL,
  ticked_for TEXT NOT NULL,
  on_behalf INTEGER NOT NULL CHECK (on_behalf IN (0, 1)),
  on_behalf_why TEXT CHECK (on_behalf_why IS NULL OR length(on_behalf_why) BETWEEN 1 AND 500),
  ticked_at TEXT NOT NULL,
  CHECK (state != 'not_done' OR why IS NOT NULL),
  CHECK ((on_behalf = 0 AND ticked_by = ticked_for AND on_behalf_why IS NULL)
    OR (on_behalf = 1 AND ticked_by != ticked_for AND on_behalf_why IS NOT NULL))
);

-- A run's ticks, step by step, latest last.
CREATE INDEX core_checklist_tick_run ON core_checklist_tick (run_id, position, ticked_at, id);

-- A correction: a note someone who rosters adds beside a closed run. Never changed or removed.
CREATE TABLE core_checklist_note (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  written_by TEXT NOT NULL,
  written_at TEXT NOT NULL
);

CREATE INDEX core_checklist_note_run ON core_checklist_note (run_id, written_at);

-- A run is inserted once, open, and never over another (a REPLACE would delete a closed run, or an
-- open one's ticks' run, without a delete trigger).
CREATE TRIGGER core_checklist_run_insert
BEFORE INSERT ON core_checklist_run
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_fixed')
  WHERE NEW.state != 'open' OR NEW.closed_at IS NOT NULL OR NEW.closed_by IS NOT NULL
    OR NEW.missed_steps IS NOT NULL
    OR EXISTS (SELECT 1 FROM core_checklist_run r WHERE r.id = NEW.id
      OR (r.object_type = NEW.object_type AND r.record_id = NEW.record_id));
END;

-- A closed run never changes. An open one keeps what it is (its record, template and steps); the
-- host moves its person and times, marks who ended its record, and closes it: done only with
-- every required step's latest tick done or not done.
CREATE TRIGGER core_checklist_run_update
BEFORE UPDATE ON core_checklist_run
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_closed') WHERE OLD.state != 'open';
  SELECT RAISE(ABORT, 'core_checklist_fixed')
  WHERE NEW.id IS NOT OLD.id OR NEW.object_type IS NOT OLD.object_type
    OR NEW.record_id IS NOT OLD.record_id OR NEW.checklist_id IS NOT OLD.checklist_id
    OR NEW.version IS NOT OLD.version OR NEW.name IS NOT OLD.name OR NEW.steps IS NOT OLD.steps
    OR NEW.made_at IS NOT OLD.made_at
    OR (NEW.state = 'open' AND (NEW.closed_at IS NOT NULL OR NEW.closed_by IS NOT NULL
      OR NEW.missed_steps IS NOT NULL))
    OR (NEW.state != 'open' AND NEW.closed_at IS NULL);
  SELECT RAISE(ABORT, 'core_checklist_incomplete')
  WHERE NEW.state = 'done' AND EXISTS (
    SELECT 1 FROM json_each(NEW.steps) s
    WHERE json_extract(s.value, '$.required') = 1
      AND coalesce((SELECT t.state FROM core_checklist_tick t
        WHERE t.run_id = NEW.id AND t.position = s.key
        ORDER BY t.ticked_at DESC, t.id DESC LIMIT 1), 'cleared') = 'cleared');
END;

-- A run is never removed once closed or ticked.
CREATE TRIGGER core_checklist_run_delete
BEFORE DELETE ON core_checklist_run
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_closed')
  WHERE OLD.state != 'open'
    OR EXISTS (SELECT 1 FROM core_checklist_tick t WHERE t.run_id = OLD.id);
END;

-- A tick is added to an open run's step only, never over another tick (a REPLACE of its id); a
-- step that asks for a note is not ticked done without one.
CREATE TRIGGER core_checklist_tick_insert
BEFORE INSERT ON core_checklist_tick
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_closed')
  WHERE NOT EXISTS (SELECT 1 FROM core_checklist_run r WHERE r.id = NEW.run_id
    AND r.state = 'open');
  SELECT RAISE(ABORT, 'core_checklist_fixed')
  WHERE EXISTS (SELECT 1 FROM core_checklist_tick t WHERE t.id = NEW.id)
    OR NEW.position >= (SELECT json_array_length(r.steps) FROM core_checklist_run r
      WHERE r.id = NEW.run_id);
  -- At most 50 ticks of one step of one run: the history every read carries stays bounded.
  SELECT RAISE(ABORT, 'core_checklist_too_many_ticks')
  WHERE (SELECT count(*) FROM core_checklist_tick t WHERE t.run_id = NEW.run_id
    AND t.position = NEW.position) >= 50;
  SELECT RAISE(ABORT, 'core_checklist_note_needed')
  WHERE NEW.state = 'done' AND (NEW.note IS NULL OR trim(NEW.note) = '')
    AND (SELECT json_extract(r.steps, '$[' || NEW.position || '].note') FROM core_checklist_run r
      WHERE r.id = NEW.run_id) = 1;
END;

-- A tick is never changed or removed, on an open run or a closed one.
CREATE TRIGGER core_checklist_tick_update
BEFORE UPDATE ON core_checklist_tick
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_fixed');
END;

CREATE TRIGGER core_checklist_tick_delete
BEFORE DELETE ON core_checklist_tick
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_fixed');
END;

-- A correction is added beside a closed run, and never changed, replaced or removed.
CREATE TRIGGER core_checklist_note_insert
BEFORE INSERT ON core_checklist_note
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_fixed')
  WHERE EXISTS (SELECT 1 FROM core_checklist_note n WHERE n.id = NEW.id)
    OR NOT EXISTS (SELECT 1 FROM core_checklist_run r WHERE r.id = NEW.run_id
      AND r.state != 'open');
END;

CREATE TRIGGER core_checklist_note_update
BEFORE UPDATE ON core_checklist_note
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_fixed');
END;

CREATE TRIGGER core_checklist_note_delete
BEFORE DELETE ON core_checklist_note
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_fixed');
END;
