-- Migration 1050: conversations and their messages (stage 36 step 1, ADR 0740).
--
-- A conversation is a core record (core_conversation): one exchange with one person on one
-- channel, with its status and who has it. Its messages and its staff notes are activities that
-- point at it (core_activity.conversation_id): a message is an `email` or a `chat` activity on the
-- person's timeline, a note a `note` activity on the conversation only. Search, embeddings,
-- summaries, the Trash and erase already work on activities.
--
-- A private conversation (private_at set) is read only by admins and whoever has it: its
-- messages and notes leave the SQL views and search for everyone, as a private activity does
-- (migration 0111), and the operations show them to admins and the assignee only.

CREATE TABLE core_conversation (
  id TEXT PRIMARY KEY NOT NULL,
  -- Null while the sender matches no Person ("unknown sender"). Erase and the Trash purge delete
  -- a Person's conversations with their messages first; the cascade is the backstop.
  person_id TEXT REFERENCES core_person (id) ON DELETE CASCADE,
  -- An unknown sender's address as it arrived, and its SHA-256 (lower-cased) to find their
  -- conversation again. Both are cleared when staff link the conversation to a Person.
  sender_address TEXT,
  sender_hash TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'chat')),
  -- The inbox address an email came to (null for chat).
  inbox_address TEXT,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'closed')),
  -- The staff account that has it (a core_user id), or null: unassigned.
  assignee_id TEXT,
  -- One of the admin's categories (Settings → Inbox, a later step).
  category TEXT,
  -- What it is about: any record (object name and id), or null.
  about_object TEXT,
  about_id TEXT,
  -- Private: who marked it and when. Null: every staff account that reads the inbox sees it.
  private_at TEXT,
  private_by TEXT,
  -- The sender check failed: matched to the Person all the same, and marked.
  sender_unverified INTEGER NOT NULL DEFAULT 0 CHECK (sender_unverified IN (0, 1)),
  opened_at TEXT NOT NULL,
  last_inbound_at TEXT,
  last_reply_at TEXT,
  first_reply_at TEXT,
  reply_due_at TEXT,
  snoozed_until TEXT,
  closed_at TEXT,
  closed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Every update sets version to the one it read plus one: a write from an older read fails.
  version INTEGER NOT NULL DEFAULT 0,
  CHECK ((about_object IS NULL) = (about_id IS NULL)),
  -- Only an email can come from an unknown sender: chat is from signed-in customers.
  CHECK (person_id IS NOT NULL OR channel = 'email')
);
-- The inbox's hot reads: by status and due time, by assignee, and a person's conversations.
CREATE INDEX core_conversation_status_due_idx ON core_conversation (status, reply_due_at);
CREATE INDEX core_conversation_assignee_idx ON core_conversation (assignee_id, status);
CREATE INDEX core_conversation_person_idx ON core_conversation (person_id, last_inbound_at)
  WHERE person_id IS NOT NULL;
-- The inbox's order (most recent first): a page walks it and stops at its limit.
CREATE INDEX core_conversation_activity_idx
  ON core_conversation (coalesce(last_inbound_at, opened_at), id);
CREATE INDEX core_conversation_sender_idx ON core_conversation (sender_hash)
  WHERE sender_hash IS NOT NULL;
CREATE INDEX core_conversation_about_idx ON core_conversation (about_object, about_id)
  WHERE about_id IS NOT NULL;

-- A take or an assignment made from an older read (someone took it a moment before) fails, and
-- its whole batch.
CREATE TRIGGER core_conversation_stale
BEFORE UPDATE ON core_conversation
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'core_conversation_stale');
END;

-- core_activity gains the type `chat` and the column conversation_id. SQLite cannot change a
-- CHECK, so the table is rebuilt with its rows. Dropping it would delete its links by cascade
-- (D1 enforces foreign keys), so they are kept aside and put back. Its triggers go with it and
-- are made again below. A DROP TABLE fires no trigger, so no search row and no stored body is
-- touched. The views that read it are dropped first (a rename checks every view) and made again:
-- rec_activity as its base view, which the schema reconciler extends with extension fields on
-- activities the next time it runs (as after migrations 0111 and 0380).
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
  -- The conversation a message or a staff note belongs to (stage 36). Null for everything else.
  conversation_id TEXT
);
INSERT INTO core_activity_new (
  id, type, subject, body, payload, occurred_at, author_user_id, author_actor, created_at,
  updated_at, deleted_at, deleted_by, external_key, thread_key, private_to, body_ref, disclosure
)
SELECT
  id, type, subject, body, payload, occurred_at, author_user_id, author_actor, created_at,
  updated_at, deleted_at, deleted_by, external_key, thread_key, private_to, body_ref, disclosure
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
CREATE INDEX core_activity_conversation_idx ON core_activity (conversation_id, occurred_at, id)
  WHERE conversation_id IS NOT NULL;

-- Private activities, and the messages and notes of a private conversation, stay out of SQL
-- views and search; the operations show them to those who may read them.
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
WHERE activity.deleted_at IS NULL AND activity.private_to IS NULL
  AND (activity.conversation_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM core_conversation c
    WHERE c.id = activity.conversation_id AND c.private_at IS NOT NULL));
CREATE VIEW rec_activity AS SELECT b.* FROM core_base_activities b;

CREATE VIEW rec_activity_link AS
SELECT l.activity_id, l.object_type, l.record_id
FROM core_activity_links l
JOIN core_activity a ON a.id = l.activity_id AND a.deleted_at IS NULL AND a.private_to IS NULL
WHERE a.conversation_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM core_conversation c WHERE c.id = a.conversation_id AND c.private_at IS NOT NULL);

CREATE TRIGGER core_activity_search_ai AFTER INSERT ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a WHERE a.id = NEW.id AND a.deleted_at IS NULL AND a.private_to IS NULL
    AND (a.conversation_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM core_conversation c
      WHERE c.id = a.conversation_id AND c.private_at IS NOT NULL));
END;

CREATE TRIGGER core_activity_search_au AFTER UPDATE OF subject, body, deleted_at, private_to
  ON core_activity
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity' AND record_id = NEW.id;
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a WHERE a.id = NEW.id AND a.deleted_at IS NULL AND a.private_to IS NULL
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

-- Marking a conversation private takes its messages and notes out of search, and unmarking puts the
-- live ones back.
CREATE TRIGGER core_conversation_private_search AFTER UPDATE OF private_at ON core_conversation
WHEN (OLD.private_at IS NULL) <> (NEW.private_at IS NULL)
BEGIN
  DELETE FROM core_search_docs WHERE object_type = 'activity'
    AND record_id IN (SELECT id FROM core_activity WHERE conversation_id = NEW.id);
  INSERT INTO core_search_docs (object_type, record_id, title, body)
  SELECT 'activity', a.id, coalesce(a.subject, ''), coalesce(a.body, '')
  FROM core_activity a
  WHERE NEW.private_at IS NULL AND a.conversation_id = NEW.id AND a.deleted_at IS NULL
    AND a.private_to IS NULL;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1050'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1050;
