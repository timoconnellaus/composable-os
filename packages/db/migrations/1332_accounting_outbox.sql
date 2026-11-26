-- Migration 1332: the accounting outbox's runner (stage 61 step 4, ADR 0882). Columns and an index
-- on step 2's tables (migration 1330), no new table.
--
-- An entry is built by host code with its accounts as the mapping's keys, not the books' refs, so
-- a mapping changed before it is sent applies to it (the spec: a change affects only rows not yet
-- sent). The runner resolves them at the moment it claims the entry and keeps the exact call it
-- sent, which is what the log shows and never changes once the entry is in the books.

-- The call's fields besides its reference, currency and lines, as built (a summary's text, a
-- transfer's accounts and amount, a document's number and dates, money's document and account),
-- with the mapping's keys where the books' refs go.
ALTER TABLE core_accounting_post ADD COLUMN body TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(body) AND json_type(body) = 'object');

-- The exact call last sent (refs resolved, the date moved past a lock date, the text saying so),
-- written as the entry is claimed. Once the entry is sent it is what is in the books.
ALTER TABLE core_accounting_post ADD COLUMN request TEXT
  CHECK (request IS NULL OR (json_valid(request) AND json_type(request) = 'object'));

-- The runner's order: per books, each state's entries by the day they belong to, then as queued.
CREATE INDEX core_accounting_post_order ON core_accounting_post
  (connection_id, state, belongs_date, created_at, id);

-- A sent or skipped entry never changes (migration 1330), its body and the call it sent included.
DROP TRIGGER core_accounting_post_sent;
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
    OR NEW.created_at IS NOT OLD.created_at;
END;

-- An entry is claimed with the call it sends: one being sent always says what it sent.
CREATE TRIGGER core_accounting_post_claim
BEFORE UPDATE OF state ON core_accounting_post
WHEN NEW.state = 'sending' AND NEW.state IS NOT OLD.state
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_post_claim')
  WHERE NEW.request IS NULL OR OLD.state NOT IN ('queued', 'retrying');
END;

-- The daily pass (`daily_date`: the last day it built, in the organisation's zone), and what
-- blocks every send now (`blocked`: the connection is not active, or the books keep another
-- currency), kept so the admins are told once when it starts, not every minute.
ALTER TABLE core_accounting_settings ADD COLUMN daily_date TEXT CHECK (daily_date IS NULL
  OR daily_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]');
ALTER TABLE core_accounting_settings ADD COLUMN blocked TEXT
  CHECK (blocked IS NULL OR blocked IN ('connection', 'currency'));
ALTER TABLE core_accounting_settings ADD COLUMN blocked_at TEXT;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1332'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1332;
