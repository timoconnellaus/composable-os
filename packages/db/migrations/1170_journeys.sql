-- Migration 1170: journeys, their versions, entries and step log (stage 53 step 3, ADR 0800).
--
-- A journey is a named set of steps the host takes for one Person at a time (a welcome series, a
-- nudge when someone stops coming). Staff with `journeys:manage` (and the assistant for them) write
-- its working copy, `draft`: the entry rule, conditions, exits, re-entry rule, the reply-to and the
-- steps with their words, as one JSON document the host checks. A person with `journeys:publish`
-- publishes it as a numbered version, which nobody can change or delete afterwards; only a
-- published version is ever run (the engine and sending are stage 53 step 4).
--
-- None of these tables is a record: no rec_* view reads them, so query.sql, dashboards, exports,
-- search and the assistant's bulk reads never see them. Entries and the step log name a Person and
-- are reached by erase; the step log keeps no words.
CREATE TABLE core_journey (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Fixed when the journey is made: a promotional journey's sends need a recorded yes (stage 30).
  kind TEXT NOT NULL CHECK (kind IN ('service', 'promotional')),
  -- draft: never live; live: entering and running people; paused: entries wait; archived: final.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused', 'archived')),
  -- Who gets a task step assigned to "the owner" (a staff user), or nobody yet.
  owner_id TEXT,
  -- The working copy (JSON): what the editor changes, and what a publish snapshots.
  draft TEXT NOT NULL,
  -- Bumped by every save of the working copy: a publish names the one it was made from.
  draft_rev INTEGER NOT NULL DEFAULT 0,
  draft_updated_at TEXT NOT NULL,
  draft_updated_by TEXT NOT NULL,
  -- The actor of the last save (human, assistant, mcp, …, or host for a starter).
  draft_updated_via TEXT NOT NULL DEFAULT 'human',
  -- 1 when an AI actor wrote the working copy since the last publish: the publish dialog says
  -- "drafted by the assistant", and the version keeps it.
  draft_ai INTEGER NOT NULL DEFAULT 0 CHECK (draft_ai IN (0, 1)),
  -- The newest published version: new entries start on it.
  current_version_id TEXT,
  -- A starter the host seeded (welcome, not_seen, win_back, trial_ended), or null.
  starter TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status_at TEXT,
  status_by TEXT
);
CREATE INDEX core_journey_status_idx ON core_journey (status);

-- Published steps and words, kept for good. Entries point at the one they started on.
CREATE TABLE core_journey_version (
  id TEXT PRIMARY KEY,
  journey_id TEXT NOT NULL REFERENCES core_journey (id),
  number INTEGER NOT NULL CHECK (number >= 1),
  -- The working copy at draft_rev, as stored: the checked document.
  definition TEXT NOT NULL,
  -- The plain-words summary the publisher was shown.
  summary TEXT NOT NULL,
  -- SHA-256 (hex) of the canonical JSON of the kind and the definition.
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  draft_rev INTEGER NOT NULL,
  -- Who wrote the working copy since the last publish: a person, or (in part) the assistant.
  drafted_by TEXT NOT NULL CHECK (drafted_by IN ('person', 'assistant')),
  published_at TEXT NOT NULL,
  -- The staff account of the person who published it, or who approved an AI's request (ADR 0480).
  published_by TEXT NOT NULL,
  -- An AI's request: the account it acted for, and the actor. Both null for a person's own publish.
  requested_by TEXT,
  requested_via TEXT,
  UNIQUE (journey_id, number)
);

-- Nobody changes or deletes a published version, by an operation or a later statement. D1 runs
-- with recursive triggers off, so an INSERT OR REPLACE fires no delete trigger: the insert
-- trigger refuses an existing id too.
CREATE TRIGGER core_journey_version_no_update
BEFORE UPDATE ON core_journey_version
BEGIN
  SELECT RAISE(ABORT, 'core_journey_version_immutable');
END;

CREATE TRIGGER core_journey_version_no_delete
BEFORE DELETE ON core_journey_version
BEGIN
  SELECT RAISE(ABORT, 'core_journey_version_immutable');
END;

-- A version is made only from the working copy as it is at commit (the rev the person reviewed),
-- of a journey that is not archived, numbered next, holding exactly the copy, saying truly whether
-- an AI wrote it, and published by a staff account (never the adjudicator, which is not one).
CREATE TRIGGER core_journey_version_from_draft
BEFORE INSERT ON core_journey_version
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_journey_version v WHERE v.id = NEW.id)
      THEN RAISE(ABORT, 'core_journey_version_immutable')
    WHEN NOT EXISTS (
      SELECT 1 FROM core_journey j
      WHERE j.id = NEW.journey_id AND j.draft_rev = NEW.draft_rev AND j.status != 'archived'
        AND j.draft = NEW.definition
        AND (NEW.drafted_by = 'assistant') = (j.draft_ai = 1)
    )
      THEN RAISE(ABORT, 'core_journey_draft_changed')
    WHEN NEW.number != 1 + COALESCE(
      (SELECT MAX(v.number) FROM core_journey_version v WHERE v.journey_id = NEW.journey_id), 0)
      THEN RAISE(ABORT, 'core_journey_draft_changed')
    WHEN NOT EXISTS (SELECT 1 FROM core_user u WHERE u.id = NEW.published_by)
      THEN RAISE(ABORT, 'core_journey_publisher')
  END;
END;

-- A new journey starts as a draft with nothing published, and never over an existing id.
CREATE TRIGGER core_journey_new
BEFORE INSERT ON core_journey
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_journey j WHERE j.id = NEW.id)
      THEN RAISE(ABORT, 'core_journey_fixed')
    WHEN NEW.status != 'draft' OR NEW.current_version_id IS NOT NULL OR NEW.draft_rev != 0
      THEN RAISE(ABORT, 'core_journey_new')
  END;
END;

-- The working copy's rev moves by exactly one per save (compare-and-set), and any change to the
-- copy moves it, raw writes included: a reviewed rev never covers different content.
CREATE TRIGGER core_journey_draft_rev
BEFORE UPDATE OF draft_rev ON core_journey
WHEN NEW.draft_rev != OLD.draft_rev + 1
BEGIN
  SELECT RAISE(ABORT, 'core_journey_draft_changed');
END;

CREATE TRIGGER core_journey_draft_changes
BEFORE UPDATE OF draft, draft_updated_at, draft_updated_by, draft_updated_via, draft_ai
  ON core_journey
WHEN (NEW.draft IS NOT OLD.draft OR NEW.draft_updated_at IS NOT OLD.draft_updated_at
    OR NEW.draft_updated_by IS NOT OLD.draft_updated_by
    OR NEW.draft_updated_via IS NOT OLD.draft_updated_via OR NEW.draft_ai IS NOT OLD.draft_ai)
  AND NEW.draft_rev IS NOT OLD.draft_rev + 1
BEGIN
  SELECT RAISE(ABORT, 'core_journey_draft_changed');
END;

-- A journey keeps its id and kind.
CREATE TRIGGER core_journey_fixed
BEFORE UPDATE OF id, kind ON core_journey
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'core_journey_fixed');
END;

-- Live or paused only with a published version; never back to draft; archived is final.
CREATE TRIGGER core_journey_status
BEFORE UPDATE OF status ON core_journey
WHEN NEW.status IS NOT OLD.status
BEGIN
  SELECT CASE
    WHEN OLD.status = 'archived' OR NEW.status = 'draft'
      THEN RAISE(ABORT, 'core_journey_status')
    WHEN NEW.status IN ('live', 'paused') AND NEW.current_version_id IS NULL
      THEN RAISE(ABORT, 'core_journey_status')
  END;
END;

-- The current version is one of its own and only ever a newer one.
CREATE TRIGGER core_journey_current
BEFORE UPDATE OF current_version_id ON core_journey
WHEN NEW.current_version_id IS NOT OLD.current_version_id
BEGIN
  SELECT RAISE(ABORT, 'core_journey_current')
  WHERE NEW.current_version_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM core_journey_version v
    WHERE v.id = NEW.current_version_id AND v.journey_id = NEW.id
      AND v.number > COALESCE(
        (SELECT o.number FROM core_journey_version o WHERE o.id = OLD.current_version_id), 0)
  );
END;

-- An archived journey stays as it was.
CREATE TRIGGER core_journey_archived
BEFORE UPDATE ON core_journey
WHEN OLD.status = 'archived'
BEGIN
  SELECT RAISE(ABORT, 'core_journey_status');
END;

-- Journeys are the business's words, kept with their versions: archived, never deleted.
CREATE TRIGGER core_journey_no_delete
BEFORE DELETE ON core_journey
BEGIN
  SELECT RAISE(ABORT, 'core_journey_fixed');
END;

-- One Person on one journey. `step` is the id of the step it is at (in its version's steps);
-- `next_at` is when the engine next looks at it (step 4's minute tick reads it by the index).
CREATE TABLE core_journey_entry (
  id TEXT PRIMARY KEY,
  journey_id TEXT NOT NULL REFERENCES core_journey (id),
  version_id TEXT NOT NULL REFERENCES core_journey_version (id),
  person_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'waiting', 'held', 'finished', 'stopped')),
  step TEXT NOT NULL,
  next_at TEXT,
  entered_at TEXT NOT NULL,
  -- How: a signal, the daily scan, a birthday, or a person adding them (`journey.enter`).
  entered_by TEXT NOT NULL CHECK (entered_by IN ('signal', 'scan', 'birthday', 'person')),
  -- The staff account that added them, for a manual entry.
  entered_by_user TEXT,
  -- The standing of what put them on it: a person, the host, or an AI no person approved. The
  -- send decision (step 4) holds every message of an `ai` entry for a person.
  cause_standing TEXT NOT NULL CHECK (cause_standing IN ('person', 'host', 'ai')),
  -- The record whose signal entered them (a membership), or null.
  cause_record TEXT,
  ended_at TEXT,
  stopped_by TEXT,
  stop_reason TEXT,
  CHECK ((state IN ('finished', 'stopped')) = (ended_at IS NOT NULL))
);
-- One live entry per Person per journey.
CREATE UNIQUE INDEX core_journey_entry_live_idx ON core_journey_entry (journey_id, person_id)
  WHERE state IN ('active', 'waiting', 'held');
-- The tick: due entries by state and time, in batches.
CREATE INDEX core_journey_entry_due_idx ON core_journey_entry (state, next_at);
CREATE INDEX core_journey_entry_person_idx ON core_journey_entry (person_id, journey_id);
-- A journey's entries by state, newest first: its counts and its list of entries, finished and
-- stopped ones included, without reading every entry ever made.
CREATE INDEX core_journey_entry_journey_idx ON core_journey_entry (journey_id, state, entered_at);

-- An entry is made only on a live journey, on that journey's own version, and never over an
-- existing id: D1 runs with recursive triggers off, so the row an INSERT OR REPLACE deletes fires
-- no trigger, and a REPLACE could otherwise bring back a stopped entry with another standing.
CREATE TRIGGER core_journey_entry_new
BEFORE INSERT ON core_journey_entry
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM core_journey_entry e WHERE e.id = NEW.id)
      THEN RAISE(ABORT, 'core_journey_entry_fixed')
    WHEN NEW.state IN ('finished', 'stopped') OR NOT EXISTS (
      SELECT 1 FROM core_journey j JOIN core_journey_version v ON v.journey_id = j.id
      WHERE j.id = NEW.journey_id AND v.id = NEW.version_id AND j.status = 'live'
    )
      THEN RAISE(ABORT, 'core_journey_not_live')
  END;
END;

-- An entry stays on its journey and Person, keeps how and why it entered, and moves only to a
-- newer version of its own journey (a publish that moves entries); a finished or stopped one
-- stays so.
CREATE TRIGGER core_journey_entry_fixed
BEFORE UPDATE ON core_journey_entry
WHEN NEW.id IS NOT OLD.id OR NEW.journey_id IS NOT OLD.journey_id
  OR NEW.person_id IS NOT OLD.person_id OR NEW.entered_at IS NOT OLD.entered_at
  OR NEW.entered_by IS NOT OLD.entered_by OR NEW.entered_by_user IS NOT OLD.entered_by_user
  OR NEW.cause_standing IS NOT OLD.cause_standing OR NEW.cause_record IS NOT OLD.cause_record
  OR OLD.state IN ('finished', 'stopped')
  OR (NEW.version_id IS NOT OLD.version_id AND NOT EXISTS (
    SELECT 1 FROM core_journey_version v
    WHERE v.id = NEW.version_id AND v.journey_id = OLD.journey_id
      AND v.number > (SELECT o.number FROM core_journey_version o WHERE o.id = OLD.version_id)
  ))
BEGIN
  SELECT RAISE(ABORT, 'core_journey_entry_fixed');
END;

-- What happened at each step of an entry. Words are never stored here: a sent message's row in
-- the routine messages log (stage 30) keeps what it keeps; this names it.
CREATE TABLE core_journey_step_log (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES core_journey_entry (id),
  step TEXT NOT NULL,
  at TEXT NOT NULL,
  what TEXT NOT NULL CHECK (what IN (
    'entered', 'sent', 'held', 'skipped', 'waited', 'branch', 'task', 'finished', 'stopped', 'moved'
  )),
  -- Why, the branch taken, the wait's end, the message or task id: JSON, never words.
  detail TEXT
);
CREATE INDEX core_journey_step_log_entry_idx ON core_journey_step_log (entry_id, at);

-- The log is added to, never rewritten (erase deletes it): no update, and no insert over an
-- existing id (a REPLACE is an insert).
CREATE TRIGGER core_journey_step_log_no_update
BEFORE UPDATE ON core_journey_step_log
BEGIN
  SELECT RAISE(ABORT, 'core_journey_step_log_fixed');
END;

CREATE TRIGGER core_journey_step_log_new
BEFORE INSERT ON core_journey_step_log
WHEN EXISTS (SELECT 1 FROM core_journey_step_log l WHERE l.id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'core_journey_step_log_fixed');
END;

-- The four starter journeys (decision 9), seeded as drafts: never live, and with no reply-to, so
-- none can be published until a person edits it, publishes it and sets it live. Their signals are
-- the ones Memberships and Bookings declare (stage 53 step 2, ADR 0802).
INSERT INTO core_journey (id, name, kind, draft, draft_updated_at, draft_updated_by,
  draft_updated_via, starter, created_at, created_by) VALUES
(
  'jny_starter_welcome', 'Welcome series', 'service',
  '{"entry":{"type":"signal","signal":"memberships.started"},"conditions":[],"exits":["memberships.ended"],"reentry":{"rule":"once"},"includeBulk":false,"replyTo":null,"steps":[{"id":"welcome","type":"send","channel":"email","subject":"Welcome to {business}","body":"Hi {firstName},\n\nWelcome to {business}. We are glad you joined.\n\nIf you have any questions, just reply to this email.\n\n{unsubscribe}"},{"id":"wait_3","type":"wait","days":3,"hours":0,"weekdaysOnly":false},{"id":"settling","type":"send","channel":"email","subject":"How is your first week going?","body":"Hi {firstName},\n\nHow are your first few days going? Reply and tell us if there is anything we can help with.\n\n{unsubscribe}"},{"id":"wait_7","type":"wait","days":7,"hours":0,"weekdaysOnly":false},{"id":"habit","type":"send","channel":"email","subject":"Making it a habit","body":"Hi {firstName},\n\nYou have been with us for ten days. Booking your next few sessions ahead is the easiest way to keep going.\n\n{unsubscribe}"},{"id":"end","type":"end"}]}',
  '2026-11-24T00:00:00.000Z', 'host', 'host', 'welcome', '2026-11-24T00:00:00.000Z', 'host'
),
(
  'jny_starter_not_seen', 'We have not seen you', 'service',
  '{"entry":{"type":"quiet","signal":"bookings.attended","days":14},"conditions":[{"test":"liveMembership","not":false}],"exits":["bookings.booked","bookings.attended"],"reentry":{"rule":"after","days":30},"includeBulk":false,"replyTo":null,"steps":[{"id":"nudge","type":"send","channel":"email","subject":"We have not seen you for a while","body":"Hi {firstName},\n\nWe have not seen you at {business} for two weeks. Your membership is still here for you, and we would love to see you back.\n\n{unsubscribe}"},{"id":"wait_7","type":"wait","days":7,"hours":0,"weekdaysOnly":false},{"id":"back","type":"branch","condition":{"test":"signalSinceEntry","signal":"bookings.attended","not":false},"goTo":"end","otherwise":"call"},{"id":"call","type":"task","title":"Call them: not seen for three weeks","assignee":"owner","dueDays":2},{"id":"end","type":"end"}]}',
  '2026-11-24T00:00:00.000Z', 'host', 'host', 'not_seen', '2026-11-24T00:00:00.000Z', 'host'
),
(
  'jny_starter_win_back', 'Win-back after a membership ends', 'promotional',
  '{"entry":{"type":"signal","signal":"memberships.ended"},"conditions":[],"exits":["memberships.started","memberships.passStarted"],"reentry":{"rule":"after","days":180},"includeBulk":false,"replyTo":null,"steps":[{"id":"wait_14","type":"wait","days":14,"hours":0,"weekdaysOnly":false},{"id":"miss_you","type":"send","channel":"email","subject":"We miss you at {business}","body":"Hi {firstName},\n\nIt has been a couple of weeks since your membership ended. If you would like to come back, we would be glad to have you.\n\n{unsubscribe}"},{"id":"wait_21","type":"wait","days":21,"hours":0,"weekdaysOnly":false},{"id":"last","type":"send","channel":"email","subject":"Still thinking about it?","body":"Hi {firstName},\n\nJust checking in one last time. Reply to this email if there is anything we could do better.\n\n{unsubscribe}"},{"id":"end","type":"end"}]}',
  '2026-11-24T00:00:00.000Z', 'host', 'host', 'win_back', '2026-11-24T00:00:00.000Z', 'host'
),
(
  'jny_starter_trial_ended', 'Trial ended without joining', 'promotional',
  '{"entry":{"type":"signal","signal":"memberships.trialEnded"},"conditions":[{"test":"liveMembership","not":true}],"exits":["memberships.started","memberships.passStarted"],"reentry":{"rule":"once"},"includeBulk":false,"replyTo":null,"steps":[{"id":"wait_1","type":"wait","days":1,"hours":0,"weekdaysOnly":false},{"id":"thanks","type":"send","channel":"email","subject":"Thanks for trying {business}","body":"Hi {firstName},\n\nThank you for trying {business}. We hope you enjoyed it. If you would like to keep going, we would love to have you as a member.\n\n{unsubscribe}"},{"id":"wait_5","type":"wait","days":5,"hours":0,"weekdaysOnly":false},{"id":"question","type":"send","channel":"email","subject":"Any questions about joining?","body":"Hi {firstName},\n\nIf anything is stopping you from joining, reply and let us know. We are happy to help.\n\n{unsubscribe}"},{"id":"end","type":"end"}]}',
  '2026-11-24T00:00:00.000Z', 'host', 'host', 'trial_ended', '2026-11-24T00:00:00.000Z', 'host'
);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1170'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1170;
