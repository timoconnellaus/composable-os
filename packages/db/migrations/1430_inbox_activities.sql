-- Migration 1430: a conversation's messages and notes (stage 36 step 1, ADR 0740).
--
-- core_activity gains the type `chat` and the column conversation_id (core_conversation,
-- migration 1050). A private conversation's messages and notes leave the SQL views and search for
-- everyone, as a private activity does (migration 0111) and a note kept from the staff does
-- (migration 1230); the operations show them to admins and whoever has the conversation.
--
-- SQLite cannot change a CHECK, so the table is remade with its rows. The remake carries every
-- earlier change to core_activity forward (the note levels and kinds of migrations 1230 and 1232:
-- their columns, triggers, index and the `level = 'staff'` test in the views and search), so it
-- must sort after them: a fresh database applies migrations in number order, and a lower-numbered
-- remake would lose them, or have its own views and search triggers remade by them without the
-- private rule. A later remake of core_activity, its views or its search triggers carries this
-- one forward the same way and sorts after 1430.
--
-- Dropping the table would delete its links by cascade (D1 enforces foreign keys), so they are
-- kept aside and put back; core_activity_links is the only table that references it. Its
-- triggers go with it and are made again below. A DROP TABLE fires no trigger, so no search row
-- and no stored body is touched. The views that read it are dropped first (a rename checks every
-- view and trigger) and made again: rec_activity as its base view, which the schema reconciler
-- extends with extension fields on activities the next time it runs (as after migrations 0111,
-- 0380 and 1230).
DROP VIEW rec_activity;
DROP VIEW rec_activity_link;
DROP VIEW core_base_activities;

CREATE TABLE core_activity_links_keep AS SELECT * FROM core_activity_links;

CREATE TABLE core_activity_new (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('note', 'email', 'call', 'meeting', 'system', 'chat')),
  -- Short headline: an email subject, meeting title, or a system event summary.
  subject TEXT,
  -- Plain-text or Markdown body (notes, email text, call notes). Indexed for search.
  body TEXT,
  -- Typed per `type` (validated by the operation layer), e.g. email headers, call duration,
  -- or a system event's field changes.
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  occurred_at TEXT NOT NULL,
  -- The user the activity is attributed to (null for automation or system events).
  author_user_id TEXT REFERENCES core_user (id) ON DELETE SET NULL,
  -- Who caused it: human | assistant | mcp | automation | system.
  author_actor TEXT NOT NULL DEFAULT 'human'
    CHECK (author_actor IN ('human', 'assistant', 'mcp', 'automation', 'system')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT REFERENCES core_user (id) ON DELETE SET NULL,
  -- Migration 0111: 'email:<Message-ID>' or 'ical:<UID>' (unique); 'chat:<id>' for chat.
  external_key TEXT,
  thread_key TEXT,
  private_to TEXT,
  body_ref TEXT,
  disclosure TEXT CHECK (disclosure IS NULL OR disclosure IN ('full', 'metadata')),
  -- Migration 1230: a note's level, kind, sharing, sender, evidence and sections.
  level TEXT NOT NULL DEFAULT 'staff' CHECK (level IN ('staff', 'coaches', 'sensitive')),
  kind_id TEXT,
  shared_at TEXT,
  shared_by TEXT,
  from_customer TEXT,
  evidence INTEGER NOT NULL DEFAULT 0 CHECK (evidence IN (0, 1)),
  sections TEXT CHECK (sections IS NULL OR json_valid(sections)),
  -- The conversation a message or a staff note belongs to (stage 36). Null for everything else.
  conversation_id TEXT
);
INSERT INTO core_activity_new (
  id, type, subject, body, payload, occurred_at, author_user_id, author_actor, created_at,
  updated_at, deleted_at, deleted_by, external_key, thread_key, private_to, body_ref, disclosure,
  level, kind_id, shared_at, shared_by, from_customer, evidence, sections
)
SELECT
  id, type, subject, body, payload, occurred_at, author_user_id, author_actor, created_at,
  updated_at, deleted_at, deleted_by, external_key, thread_key, private_to, body_ref, disclosure,
  level, kind_id, shared_at, shared_by, from_customer, evidence, sections
FROM core_activity;
DROP TABLE core_activity;
ALTER TABLE core_activity_new RENAME TO core_activity;

INSERT INTO core_activity_links (activity_id, object_type, record_id)
SELECT activity_id, object_type, record_id FROM core_activity_links_keep;
DROP TABLE core_activity_links_keep;

CREATE INDEX core_activity_occurred_idx ON core_activity (occurred_at, id);
CREATE INDEX core_activity_type_idx ON core_activity (type);
CREATE INDEX core_activity_deleted_idx ON core_activity (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE UNIQUE INDEX core_activity_external_key_idx ON core_activity (external_key)
  WHERE external_key IS NOT NULL;
CREATE INDEX core_activity_thread_idx ON core_activity (thread_key, occurred_at)
  WHERE thread_key IS NOT NULL;
CREATE INDEX core_activity_kept_idx ON core_activity (id) WHERE level != 'staff';
CREATE INDEX core_activity_conversation_idx ON core_activity (conversation_id, occurred_at, id)
  WHERE conversation_id IS NOT NULL;

-- Private activities, notes kept from the staff, and the messages and notes of a private
-- conversation stay out of SQL views and search; the operations show them to those who may read
-- them.
CREATE VIEW core_base_activities AS
SELECT
  activity.id,
  activity.type,
  activity.subject,
  activity.body,
  activity.payload,
  activity.occurred_at,
  activity.author_user_id,
  activity.author_actor,
  activity.created_at,
  activity.updated_at
FROM core_activity activity
WHERE activity.deleted_at IS NULL AND activity.private_to IS NULL AND activity.level = 'staff'
  AND (activity.conversation_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM core_conversation c
    WHERE c.id = activity.conversation_id AND c.private_at IS NOT NULL));
CREATE VIEW rec_activity AS SELECT b.* FROM core_base_activities b;

CREATE VIEW rec_activity_link AS
SELECT l.activity_id, l.object_type, l.record_id
FROM core_activity_links l
JOIN core_activity a ON a.id = l.activity_id AND a.deleted_at IS NULL AND a.private_to IS NULL
  AND a.level = 'staff'
WHERE a.conversation_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM core_conversation c WHERE c.id = a.conversation_id AND c.private_at IS NOT NULL);

CREATE TRIGGER core_activity_search_ai AFTER INSERT ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a
  WHERE a.id = NEW.id AND a.deleted_at IS NULL AND a.private_to IS NULL AND a.level = 'staff'
    AND (a.conversation_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM core_conversation c
      WHERE c.id = a.conversation_id AND c.private_at IS NOT NULL));
END;

CREATE TRIGGER core_activity_search_au AFTER UPDATE OF subject, body, deleted_at, private_to, level
  ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a
  WHERE a.id = NEW.id AND a.deleted_at IS NULL AND a.private_to IS NULL AND a.level = 'staff'
    AND (a.conversation_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM core_conversation c
      WHERE c.id = a.conversation_id AND c.private_at IS NOT NULL));
END;

CREATE TRIGGER core_activity_search_ad AFTER DELETE ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = OLD.id;
END;

-- Any activity that loses its body reference queues the body for deletion (migration 0330).
CREATE TRIGGER core_activity_body_ad AFTER DELETE ON core_activity
WHEN OLD.body_ref IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO core_blob_deletion (key, queued_at)
  VALUES (OLD.body_ref, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER core_activity_body_au AFTER UPDATE OF body_ref ON core_activity
WHEN OLD.body_ref IS NOT NULL AND (NEW.body_ref IS NULL OR NEW.body_ref <> OLD.body_ref)
BEGIN
  INSERT OR IGNORE INTO core_blob_deletion (key, queued_at)
  VALUES (OLD.body_ref, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Only a note is kept from the staff (migration 1230).
CREATE TRIGGER core_activity_level_note_insert
BEFORE INSERT ON core_activity
WHEN NEW.level != 'staff' AND NEW.type != 'note'
BEGIN
  SELECT RAISE(ABORT, 'core_activity_level_not_note');
END;

CREATE TRIGGER core_activity_level_note_update
BEFORE UPDATE OF level, type ON core_activity
WHEN NEW.level != 'staff' AND NEW.type != 'note'
BEGIN
  SELECT RAISE(ABORT, 'core_activity_level_not_note');
END;

-- A kind is only a note's, and a note is never below its kind's lowest level (migration 1232).
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

-- Marking a conversation private takes its messages and notes out of search, and unmarking puts
-- the live ones every staff account reads back.
CREATE TRIGGER core_conversation_private_search AFTER UPDATE OF private_at ON core_conversation
WHEN (OLD.private_at IS NULL) <> (NEW.private_at IS NULL)
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity'
    AND record_id IN (SELECT id FROM core_activity WHERE conversation_id = NEW.id);
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a
  WHERE NEW.private_at IS NULL AND a.conversation_id = NEW.id AND a.deleted_at IS NULL
    AND a.private_to IS NULL AND a.level = 'staff';
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1430'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1430;
