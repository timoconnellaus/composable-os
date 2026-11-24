-- Migration 1330: accounting sync's records (stage 61 step 2; the contract is ADR 0880). The host
-- sends its own money to the books a human admin connected: its settings, the mapping a person
-- chose from the books' own lists, the links between host objects and the books' records, the
-- outbox of entries to send, each money event to the entry it went in, and the bill-tos waiting
-- for a person to choose their contact.
--
-- New core tables only: no x_* table, no core_write_guard kind, in no rec_* view, so no member's
-- SQL, export, search or the assistant's record reads reach them. Read and written only through
-- the accounting.* operations (`accounting:manage`, a person) and, from stage 61 step 4, the host's
-- runner. No token or secret is held here: those stay in the gatekeeper (ADR 0151).

-- The one settings row (id 1). The connection and the books resource on it; the start date
-- (decision 6: nothing dated before it is ever sent; required before turning on); approval
-- (decision 4: `approved_days` days approved so far, sending is automatic once it reaches
-- `approve_until`); the settle delay in days; on or off. Set by a human admin
-- (accounting.settings.update); the runner counts approved days.
CREATE TABLE core_accounting_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  connection_id TEXT,
  resource TEXT,
  start_date TEXT CHECK (start_date IS NULL
    OR start_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  approved_days INTEGER NOT NULL DEFAULT 0 CHECK (approved_days >= 0),
  approve_until INTEGER NOT NULL DEFAULT 14 CHECK (approve_until BETWEEN 14 AND 365),
  settle_days INTEGER NOT NULL DEFAULT 2 CHECK (settle_days BETWEEN 1 AND 14),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- When the admins were told sending is automatic (once; cleared when approval is put back on).
  automatic_told_at TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((connection_id IS NULL) = (resource IS NULL)),
  -- On needs the books and a start date.
  CHECK (enabled = 0 OR (connection_id IS NOT NULL AND start_date IS NOT NULL))
);

-- The mapping (`accounting:manage`, a person): which of the books' accounts or tax rates each
-- kind of host money goes to, per connection (refs are the books' own). `host_key` is a category
-- key, a tax code, or a recorded-payment kind for `category`, `tax` and `method`; empty for the
-- single ones. `books_name` is the name as read from the books when chosen, for the log. A change
-- affects only entries not yet sent: a sent entry keeps its lines as sent.
CREATE TABLE core_accounting_map (
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('category', 'tax', 'fees', 'clearing', 'bank', 'method',
    'rounding', 'refunds', 'invoice_default')),
  host_key TEXT NOT NULL DEFAULT '' CHECK (length(host_key) <= 100),
  books_ref TEXT NOT NULL CHECK (length(books_ref) BETWEEN 1 AND 200),
  books_name TEXT NOT NULL CHECK (length(books_name) BETWEEN 1 AND 200),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  CHECK ((kind IN ('category', 'tax', 'method')) = (host_key != '')),
  PRIMARY KEY (connection_id, kind, host_key)
) WITHOUT ROWID;

-- A host object to the books' record it is: a Person or Organisation to a contact, an invoice or
-- credit note to a document, a payment to a payment, a payout or a day's summary to an entry.
-- Unique both ways per connection: one host object has one books record of its kind, and one
-- books record is one host object's.
CREATE TABLE core_accounting_link (
  connection_id TEXT NOT NULL,
  object TEXT NOT NULL CHECK (object IN ('person', 'organisation', 'invoice', 'credit_note',
    'payment', 'payout', 'summary')),
  object_id TEXT NOT NULL,
  books_kind TEXT NOT NULL CHECK (books_kind IN ('contact', 'document', 'payment', 'entry')),
  books_ref TEXT NOT NULL CHECK (length(books_ref) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  CHECK (books_kind = CASE
    WHEN object IN ('person', 'organisation') THEN 'contact'
    WHEN object IN ('invoice', 'credit_note') THEN 'document'
    WHEN object = 'payment' THEN 'payment'
    ELSE 'entry' END),
  PRIMARY KEY (connection_id, object, object_id),
  UNIQUE (connection_id, books_kind, books_ref)
) WITHOUT ROWID;

-- The outbox: one entry to send, built by host code from host records. `reference` is fixed
-- (`cos:<kind>:<source id>:<n>`), stored on the books' record so an uncertain outcome is resolved
-- by looking it up before anything is sent again; unique, so nothing is queued twice.
-- `carries_date` is the date it carries in the books (moved past a lock date, decision 7);
-- `belongs_date` the day its money belongs to. `lines` are the lines as sent (amounts in minor
-- units, mapping refs), kept so the log shows exactly what went; `detail` is what a contact or
-- document carried about the person it is for, which an erase may clear.
CREATE TABLE core_accounting_post (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'adjustment', 'transfer', 'contact', 'invoice',
    'credit_note', 'payment', 'refund', 'void')),
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 1 CHECK (n >= 1),
  reference TEXT NOT NULL UNIQUE CHECK (substr(reference, 1, 4) = 'cos:'
    AND length(reference) <= 100),
  carries_date TEXT NOT NULL CHECK (carries_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  belongs_date TEXT NOT NULL CHECK (belongs_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  -- The entry's total in minor units (the sum of its money in), for the log.
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
  CHECK (depends_on IS NULL OR depends_on != id),
  CHECK ((state = 'sent') = (books_ref IS NOT NULL AND sent_at IS NOT NULL)),
  CHECK ((state = 'skipped') = (skipped_by IS NOT NULL AND skipped_at IS NOT NULL
    AND skip_reason IS NOT NULL)),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);

-- What the runner picks up (by state and when), a day's batch and log, and what waits for a post.
CREATE INDEX core_accounting_post_state ON core_accounting_post (state, next_attempt_at);
CREATE INDEX core_accounting_post_day ON core_accounting_post (carries_date, kind);
CREATE INDEX core_accounting_post_depends ON core_accounting_post (depends_on)
  WHERE depends_on IS NOT NULL;

-- A sent entry is in the books: what it was, where it went and what it carried never change, it
-- stays sent, and it is never deleted. (A sent entry is put right by a new entry, never edited.)
-- A skipped one was never sent and is never sent after: it stays skipped. `detail` is left free
-- for an erase.
CREATE TRIGGER core_accounting_post_sent
BEFORE UPDATE ON core_accounting_post
WHEN OLD.state IN ('sent', 'skipped')
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_post_fixed')
  WHERE NEW.state IS NOT OLD.state OR NEW.id IS NOT OLD.id
    OR NEW.connection_id IS NOT OLD.connection_id OR NEW.kind IS NOT OLD.kind
    OR NEW.source_kind IS NOT OLD.source_kind OR NEW.source_id IS NOT OLD.source_id
    OR NEW.n IS NOT OLD.n OR NEW.reference IS NOT OLD.reference
    OR NEW.carries_date IS NOT OLD.carries_date OR NEW.belongs_date IS NOT OLD.belongs_date
    OR NEW.amount IS NOT OLD.amount OR NEW.lines IS NOT OLD.lines
    OR NEW.books_ref IS NOT OLD.books_ref OR NEW.sent_at IS NOT OLD.sent_at
    OR NEW.skipped_by IS NOT OLD.skipped_by OR NEW.skipped_at IS NOT OLD.skipped_at
    OR NEW.skip_reason IS NOT OLD.skip_reason;
END;

-- An entry is never deleted once it might be in the books (sent, being sent, or its outcome not
-- known) or was skipped (the log lists its money as not in the books). D1 runs with recursive
-- triggers off, so a REPLACE of such a row fires no delete trigger: the insert refuses one.
CREATE TRIGGER core_accounting_post_delete
BEFORE DELETE ON core_accounting_post
WHEN OLD.state IN ('sending', 'sent', 'unknown', 'skipped')
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_post_fixed');
END;

CREATE TRIGGER core_accounting_post_insert
BEFORE INSERT ON core_accounting_post
BEGIN
  SELECT RAISE(ABORT, 'core_accounting_post_fixed')
  WHERE EXISTS (SELECT 1 FROM core_accounting_post p WHERE p.id = NEW.id
    OR p.reference = NEW.reference);
END;

-- Each money event (a payment, a refund, a fee, a payout line, a document event) to the entry it
-- went in, unique by source: nothing is counted in two days, and order tables are not altered.
CREATE TABLE core_accounting_item (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  -- The day the event belongs to (its moment's local day), when it went into a later one.
  belongs_date TEXT NOT NULL CHECK (belongs_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id)
) WITHOUT ROWID;

CREATE INDEX core_accounting_item_post ON core_accounting_item (post_id);

-- A bill-to waiting for a person (decision 8): `unsure`, its candidates in the books (at most
-- 10: ref, name, email, tax number, archived), and the entry waiting on it; or `merged`, two
-- contacts in the books for one customer after a merge in the host, listed and never merged in
-- the books by the host. Decided once: a contact chosen, a new one, or dismissed.
CREATE TABLE core_accounting_match (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unsure', 'merged')),
  object TEXT NOT NULL CHECK (object IN ('person', 'organisation')),
  object_id TEXT NOT NULL,
  post_id TEXT,
  candidates TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidates)
    AND json_type(candidates) = 'array' AND json_array_length(candidates) <= 10),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'linked', 'created', 'dismissed')),
  chosen_ref TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((state = 'open') = (decided_by IS NULL AND decided_at IS NULL)),
  CHECK ((state = 'linked') = (chosen_ref IS NOT NULL))
);

-- One open question per bill-to and reason.
CREATE UNIQUE INDEX core_accounting_match_open ON core_accounting_match
  (connection_id, reason, object, object_id) WHERE state = 'open';
CREATE INDEX core_accounting_match_object ON core_accounting_match (object, object_id);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1330'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1330;
