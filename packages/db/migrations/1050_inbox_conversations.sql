-- Migration 1050: conversations (stage 36 step 1, ADR 0740). Their activities: migration 1430.
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

-- Its messages and notes, the type `chat` and the private rule on core_activity come in migration
-- 1430: they remake core_activity, which must come after the note levels and kinds (migrations
-- 1230 and 1232) that it carries forward.

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1050'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1050;
