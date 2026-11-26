-- Migration 1332: the accounting outbox's runner (stage 61 step 4, ADR 0882). It remakes step 2's
-- core_accounting_post (migration 1330) with its rows, and adds columns to the settings row.
--
-- - **A reference is unique per books**, not across every connection: after a change of books the
--   same day is queued again for the new ones (`UNIQUE (connection_id, reference)`; SQLite cannot
--   drop a column's UNIQUE, hence the remake).
-- - **Built with the mapping's keys, sent with the books' refs.** `body` is the call's fields
--   besides its reference, currency and lines, as built; `request` is the exact call last sent,
--   written as the entry is claimed. A person's details (a contact's name, email, address and tax
--   number, a document's bill-to) are never in them: they stay in `detail`, which `body`,
--   `lines` and `request` name by key (`{ "detail": "name" }`), so an erase clears `detail` alone
--   (step 9) and the figures sent stay as they were.
-- - **What came of a send.** `applied_at`: the host knows the write was applied (the books may
--   not yet find its reference); such an entry is never queued or sent again. `lookups`: the
--   look-ups by reference that missed since it last became `unknown`; `unknowns`: how often it
--   became `unknown`; both bound how long an uncertain entry waits and how often it is tried
--   again. `pending_action_id`: an entry that waits in Approvals instead of going, and its action.
--
-- The settings triggers that read core_accounting_post are dropped first (a rename checks every
-- trigger) and made again. No other table references core_accounting_post, and it is in no view.

DROP TRIGGER core_accounting_settings_start;
DROP TRIGGER core_accounting_settings_start_replace;

CREATE TABLE core_accounting_post_new (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'adjustment', 'transfer', 'contact', 'invoice',
    'credit_note', 'payment', 'refund', 'void')),
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 1 CHECK (n >= 1),
  reference TEXT NOT NULL CHECK (substr(reference, 1, 4) = 'cos:' AND length(reference) <= 100),
  carries_date TEXT NOT NULL CHECK (carries_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  belongs_date TEXT NOT NULL CHECK (belongs_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  amount INTEGER NOT NULL DEFAULT 0,
  lines TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(lines) AND json_type(lines) = 'array'),
  detail TEXT CHECK (detail IS NULL OR json_valid(detail)),
  depends_on TEXT,
  state TEXT NOT NULL CHECK (state IN ('awaiting_approval', 'queued', 'sending', 'sent',
    'retrying', 'held', 'unknown', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  error_code TEXT,
  error_text TEXT CHECK (error_text IS NULL OR length(error_text) <= 1000),
  books_ref TEXT,
  sent_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  skipped_by TEXT,
  skipped_at TEXT,
  skip_reason TEXT CHECK (skip_reason IS NULL OR length(skip_reason) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(body) AND json_type(body) = 'object'),
  request TEXT CHECK (request IS NULL OR (json_valid(request) AND json_type(request) = 'object')),
  applied_at TEXT,
  lookups INTEGER NOT NULL DEFAULT 0 CHECK (lookups >= 0),
  unknowns INTEGER NOT NULL DEFAULT 0 CHECK (unknowns >= 0),
  pending_action_id TEXT,
  CHECK (depends_on IS NULL OR depends_on != id),
  CHECK ((state = 'sent') = (books_ref IS NOT NULL AND sent_at IS NOT NULL)),
  CHECK ((state = 'skipped') = (skipped_by IS NOT NULL AND skipped_at IS NOT NULL
    AND skip_reason IS NOT NULL)),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  UNIQUE (connection_id, reference)
);

INSERT INTO core_accounting_post_new (id, connection_id, kind, source_kind, source_id, n,
  reference, carries_date, belongs_date, amount, lines, detail, depends_on, state, attempts,
  next_attempt_at, error_code, error_text, books_ref, sent_at, approved_by, approved_at,
  skipped_by, skipped_at, skip_reason, created_at, updated_at)
SELECT id, connection_id, kind, source_kind, source_id, n, reference, carries_date, belongs_date,
  amount, lines, detail, depends_on, state, attempts, next_attempt_at, error_code, error_text,
  books_ref, sent_at, approved_by, approved_at, skipped_by, skipped_at, skip_reason, created_at,
  updated_at
FROM core_accounting_post;

DROP TABLE core_accounting_post;
ALTER TABLE core_accounting_post_new RENAME TO core_accounting_post;

-- What waits for a post, a day's batch and log.
CREATE INDEX core_accounting_post_day ON core_accounting_post (carries_date, kind);
CREATE INDEX core_accounting_post_depends ON core_accounting_post (depends_on)
  WHERE depends_on IS NOT NULL;
-- The runner's order, per books and state: by day, then as queued. `next_attempt_at` is in it so
-- an entry waiting for its dependency is passed over from the index alone.
CREATE INDEX core_accounting_post_order ON core_accounting_post
  (connection_id, state, belongs_date, created_at, id, next_attempt_at);
-- Whether anything is due, per books and state, by when.
CREATE INDEX core_accounting_post_due ON core_accounting_post
  (connection_id, state, next_attempt_at);

-- An entry is its reference: its id and reference never change, whatever its state. This also
-- refuses an UPDATE OR REPLACE that would take another entry's id or reference.
CREATE TRIGGER core_accounting_post_identity
BEFORE UPDATE OF id, reference, connection_id ON core_accounting_post
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_post_fixed')
  WHERE NEW.id IS NOT OLD.id OR NEW.reference IS NOT OLD.reference
    OR NEW.connection_id IS NOT OLD.connection_id;
END;

-- A sent entry is in the books, and a skipped one is never sent: nothing about either changes.
-- Only `detail` (a person's details) may be cleared, by an erase, and `updated_at` moves with it.
CREATE TRIGGER core_accounting_post_sent
BEFORE UPDATE ON core_accounting_post
WHEN OLD.state IN ('sent', 'skipped')
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_post_fixed')
  WHERE NEW.state IS NOT OLD.state OR NEW.connection_id IS NOT OLD.connection_id
    OR NEW.kind IS NOT OLD.kind OR NEW.source_kind IS NOT OLD.source_kind
    OR NEW.source_id IS NOT OLD.source_id OR NEW.n IS NOT OLD.n
    OR NEW.carries_date IS NOT OLD.carries_date OR NEW.belongs_date IS NOT OLD.belongs_date
    OR NEW.amount IS NOT OLD.amount OR NEW.lines IS NOT OLD.lines
    OR NEW.body IS NOT OLD.body OR NEW.request IS NOT OLD.request
    OR (NEW.detail IS NOT OLD.detail AND NEW.detail IS NOT NULL)
    OR NEW.depends_on IS NOT OLD.depends_on OR NEW.attempts IS NOT OLD.attempts
    OR NEW.next_attempt_at IS NOT OLD.next_attempt_at OR NEW.error_code IS NOT OLD.error_code
    OR NEW.error_text IS NOT OLD.error_text OR NEW.books_ref IS NOT OLD.books_ref
    OR NEW.sent_at IS NOT OLD.sent_at OR NEW.approved_by IS NOT OLD.approved_by
    OR NEW.approved_at IS NOT OLD.approved_at OR NEW.skipped_by IS NOT OLD.skipped_by
    OR NEW.skipped_at IS NOT OLD.skipped_at OR NEW.skip_reason IS NOT OLD.skip_reason
    OR NEW.applied_at IS NOT OLD.applied_at OR NEW.lookups IS NOT OLD.lookups
    OR NEW.unknowns IS NOT OLD.unknowns OR NEW.pending_action_id IS NOT OLD.pending_action_id
    OR NEW.created_at IS NOT OLD.created_at;
END;

-- An entry that may be in the books leaves its state only as its outcome allows: one being sent
-- becomes sent, retrying or held (refused: nothing written), or unknown; one whose outcome is not
-- known becomes sent (found by its reference), queued (not found, after the runner's look-ups),
-- or held (the look-ups ran out: a person decides).
CREATE TRIGGER core_accounting_post_outcome
BEFORE UPDATE OF state ON core_accounting_post
WHEN OLD.state IN ('sending', 'unknown') AND NEW.state IS NOT OLD.state
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_post_fixed')
  WHERE NOT ((OLD.state = 'sending' AND NEW.state IN ('sent', 'retrying', 'held', 'unknown'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('sent', 'queued', 'held')));
END;

-- An entry the host knows was applied is in the books: it is never queued, sent, retried or
-- skipped again, only found by its reference (sent) or held for a person, who looks again.
CREATE TRIGGER core_accounting_post_applied
BEFORE UPDATE ON core_accounting_post
WHEN OLD.applied_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_post_applied')
  WHERE NEW.applied_at IS NOT OLD.applied_at
    OR NEW.state IN ('queued', 'sending', 'retrying', 'skipped', 'awaiting_approval');
END;

-- An entry is claimed with the call it sends, from queued or retrying only.
CREATE TRIGGER core_accounting_post_claim
BEFORE UPDATE OF state ON core_accounting_post
WHEN NEW.state = 'sending' AND NEW.state IS NOT OLD.state
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_post_claim')
  WHERE NEW.request IS NULL OR OLD.state NOT IN ('queued', 'retrying');
END;

-- Never deleted once it might be in the books, or was skipped.
CREATE TRIGGER core_accounting_post_delete
BEFORE DELETE ON core_accounting_post
WHEN OLD.state IN ('sending', 'sent', 'unknown', 'skipped') OR OLD.applied_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_post_fixed');
END;

-- A REPLACE of an entry (an insert over its id, or over its reference in the same books) is
-- refused: it would delete the row without the delete trigger.
CREATE TRIGGER core_accounting_post_insert
BEFORE INSERT ON core_accounting_post
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_post_fixed')
  WHERE EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.id = NEW.id
    OR (p.connection_id = NEW.connection_id AND p.reference = NEW.reference));
END;

-- Migration 1330's start-date guards, made again over the remade table.
CREATE TRIGGER core_accounting_settings_start
BEFORE UPDATE OF start_date ON core_accounting_settings
WHEN NEW.start_date IS NOT OLD.start_date
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_start_fixed')
  WHERE EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.connection_id = NEW.connection_id
    AND (p.state IN ('sending', 'sent', 'unknown') OR p.applied_at IS NOT NULL));
END;

CREATE TRIGGER core_accounting_settings_start_replace
BEFORE INSERT ON core_accounting_settings
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_start_fixed')
  WHERE EXISTS (SELECT 1 FROM core_accounting_settings s WHERE s.id = NEW.id
      AND s.start_date IS NOT NEW.start_date)
    AND EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.connection_id = NEW.connection_id
      AND (p.state IN ('sending', 'sent', 'unknown') OR p.applied_at IS NOT NULL));
END;

-- The daily pass (`daily_date`: the last day it built, in the organisation's zone), and what
-- blocks every send now (`blocked`: the connection is not active, the books keep another
-- currency, or their lock date cannot be read), kept so the admins are told once when it starts.
ALTER TABLE core_accounting_settings ADD COLUMN daily_date TEXT CHECK (daily_date IS NULL
  OR daily_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]');
ALTER TABLE core_accounting_settings ADD COLUMN blocked TEXT
  CHECK (blocked IS NULL OR blocked IN ('connection', 'currency', 'lock'));
ALTER TABLE core_accounting_settings ADD COLUMN blocked_at TEXT;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1332'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1332;
