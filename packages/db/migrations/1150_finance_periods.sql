-- Migration 1150: finance periods, the close and the book entries (stage 52 step 1, ADRs 0790 and
-- 0791). The business closes each calendar month (local, in the organisation's zone): one batch
-- writes a version of the period `closing`, its book entries and their lines, its report rows and
-- every source it counted, then `closed`. A closed version never changes; reopening it (a
-- person, with why) keeps it as it was, and closing again writes the next version.
--
-- The close never refuses a money event: nothing here guards an order, a payment or a refund.
-- What arrives later for a closed month is counted in the first open month, in a `late` entry
-- naming the month it belongs to; `core_finance_counted` keeps every source a close counted, so a
-- source is counted once across every period.
--
-- All of it is the business's figures: core tables in no rec_* view, so no dashboard, query.sql,
-- export.csv or the assistant's record reads reach them. They are read only through the finance
-- operations, by an account holding `finance:read`.
--
-- D1 runs with recursive triggers off, so the rows an INSERT OR REPLACE or an UPDATE OR REPLACE
-- deletes fire no delete trigger: each table's BEFORE INSERT also refuses replacing a row it
-- protects, and its BEFORE UPDATE refuses every change it does not allow (a replace is one).

-- One version of one month (ADR 0790). `month` is `YYYY-MM`; the dates are local in `zone` (the
-- organisation's when it was closed, kept whatever the zone is since); `starts` and `ends` are
-- the instants of its first and last days' local midnights (half-open), unix seconds.
CREATE TABLE core_finance_period (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  zone TEXT NOT NULL,
  starts INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN ('closing', 'closed', 'reopened')),
  closed_by TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  -- How many entries, lines and report rows the version holds (checked when it is closed).
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  reopened_by TEXT,
  reopened_at TEXT,
  reopen_reason TEXT CHECK (reopen_reason IS NULL OR length(reopen_reason) BETWEEN 1 AND 500),
  CHECK (end_date >= start_date),
  CHECK (ends > starts),
  CHECK ((state = 'reopened') = (reopened_by IS NOT NULL AND reopened_at IS NOT NULL
    AND reopen_reason IS NOT NULL)),
  UNIQUE (month, version)
);

-- At most one version of a month is closed (or being closed) at a time.
CREATE UNIQUE INDEX core_finance_period_held ON core_finance_period (month)
  WHERE state IN ('closing', 'closed');
CREATE INDEX core_finance_period_state ON core_finance_period (state, month);

-- One book entry of a version (ADR 0791): a day summary, a payout, what is held for customers at
-- the month's end, or something that arrived late for a closed month. `entry_key` is the same in
-- every version (`day:2026-04-03`, `payout:<id>`, `held:2026-04`, `late:2026-04@2026-05-06`);
-- `fingerprint` is a hash of its lines, so a reader sees whether a later version changed it.
-- An entry carries no names.
CREATE TABLE core_finance_entry (
  period_id TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('day', 'payout', 'held', 'late')),
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  belongs_to TEXT CHECK (belongs_to IS NULL OR belongs_to GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  fingerprint TEXT NOT NULL,
  CHECK ((kind = 'late') = (belongs_to IS NOT NULL)),
  PRIMARY KEY (period_id, entry_key)
) WITHOUT ROWID;

CREATE UNIQUE INDEX core_finance_entry_n ON core_finance_entry (period_id, n);

-- One line of an entry: a heading in the host's words (never an account code), a side and an
-- amount in minor units; the tax code and country where it is tax, the method where it is money in
-- or out, the category where it is a sale. An entry's debits equal its credits.
CREATE TABLE core_finance_entry_line (
  period_id TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 1),
  heading TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  tax_code TEXT,
  tax_country TEXT,
  method TEXT,
  category TEXT,
  PRIMARY KEY (period_id, entry_key, n)
) WITHOUT ROWID;

-- A report's rows as they were closed (ADR 0790): `data` is the row (amounts, dates, order ids),
-- never a name. Rows that name who owes or who was refunded keep the person apart, so an erase
-- replaces the name with "Erased person" and clears the email, in every version, and changes
-- nothing else.
CREATE TABLE core_finance_row (
  period_id TEXT NOT NULL,
  report TEXT NOT NULL CHECK (report IN ('sales', 'tax', 'refunds', 'payouts', 'owed', 'held',
    'unearned', 'members')),
  n INTEGER NOT NULL CHECK (n >= 1),
  person_id TEXT,
  name TEXT,
  email TEXT,
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (period_id, report, n)
) WITHOUT ROWID;

CREATE INDEX core_finance_row_person ON core_finance_row (person_id) WHERE person_id IS NOT NULL;

-- Every source a version counted (a payment, a refund, a payout, …), by kind and id. A source
-- counted in one month's closed version is never counted in another's; a reopened month closed
-- again counts its own again.
CREATE TABLE core_finance_counted (
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  month TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id, period_id)
) WITHOUT ROWID;

CREATE INDEX core_finance_counted_period ON core_finance_counted (period_id);

-- The close's guard (ADR 0790): the close reads what its figures came from, then guards each value
-- in its own batch; a write in between fails the close whole (`core_finance_changed`, answered
-- `finance_changed`). Nothing is stored.
CREATE TABLE core_finance_guard (
  expected INTEGER NOT NULL,
  actual INTEGER NOT NULL
);

CREATE TRIGGER core_finance_guard_check
BEFORE INSERT ON core_finance_guard
BEGIN
  SELECT CASE
    WHEN NEW.actual != NEW.expected THEN RAISE(ABORT, 'core_finance_changed')
    ELSE RAISE(IGNORE)
  END;
END;

-- A version is made `closing`, with a number no other version of its month holds and instants
-- that overlap no other month's closed version; never replaced.
CREATE TRIGGER core_finance_period_insert
BEFORE INSERT ON core_finance_period
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed')
  WHERE NEW.state != 'closing' OR NEW.reopened_by IS NOT NULL
    OR EXISTS (SELECT 1 FROM core_finance_period p WHERE p.id = NEW.id);
  -- Two closes of one month at once: the second finds the first's version (it is held).
  SELECT RAISE(ABORT, 'core_finance_period_held')
  WHERE EXISTS (SELECT 1 FROM core_finance_period p
    WHERE p.month = NEW.month AND (p.version = NEW.version OR p.state IN ('closing', 'closed')));
  SELECT RAISE(ABORT, 'core_finance_period_overlap')
  WHERE EXISTS (SELECT 1 FROM core_finance_period p WHERE p.month != NEW.month
    AND p.state IN ('closing', 'closed') AND p.starts < NEW.ends AND p.ends > NEW.starts);
END;

-- Only `closing` to `closed` (with its counts), and `closed` to `reopened` with who, when and why;
-- nothing else ever changes, and a reopened version never changes again.
CREATE TRIGGER core_finance_period_update
BEFORE UPDATE ON core_finance_period
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed')
  WHERE NEW.id IS NOT OLD.id OR NEW.month IS NOT OLD.month
    OR NEW.start_date IS NOT OLD.start_date OR NEW.end_date IS NOT OLD.end_date
    OR NEW.zone IS NOT OLD.zone OR NEW.starts IS NOT OLD.starts OR NEW.ends IS NOT OLD.ends
    OR NEW.version IS NOT OLD.version OR NEW.closed_by IS NOT OLD.closed_by
    OR NEW.closed_at IS NOT OLD.closed_at
    OR NOT ((OLD.state = 'closing' AND NEW.state = 'closed' AND NEW.reopened_by IS NULL)
      OR (OLD.state = 'closed' AND NEW.state = 'reopened' AND NEW.entry_count IS OLD.entry_count
        AND NEW.line_count IS OLD.line_count AND NEW.row_count IS OLD.row_count));
  -- Closed with exactly what was written into it.
  SELECT RAISE(ABORT, 'core_finance_period_fixed')
  WHERE OLD.state = 'closing' AND (
    NEW.entry_count != (SELECT count(*) FROM core_finance_entry e WHERE e.period_id = NEW.id)
    OR NEW.line_count != (SELECT count(*) FROM core_finance_entry_line l WHERE l.period_id = NEW.id)
    OR NEW.row_count != (SELECT count(*) FROM core_finance_row r WHERE r.period_id = NEW.id));
END;

CREATE TRIGGER core_finance_period_delete
BEFORE DELETE ON core_finance_period
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed');
END;

-- Entries, lines, rows and counted sources are written only into a version being closed (in its
-- own batch), and never replaced, changed or removed.
CREATE TRIGGER core_finance_entry_insert
BEFORE INSERT ON core_finance_entry
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed')
  WHERE NOT EXISTS (SELECT 1 FROM core_finance_period p WHERE p.id = NEW.period_id
      AND p.state = 'closing')
    OR EXISTS (SELECT 1 FROM core_finance_entry e WHERE e.period_id = NEW.period_id
      AND (e.entry_key = NEW.entry_key OR e.n = NEW.n));
END;

CREATE TRIGGER core_finance_entry_update
BEFORE UPDATE ON core_finance_entry
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed');
END;

CREATE TRIGGER core_finance_entry_delete
BEFORE DELETE ON core_finance_entry
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed');
END;

CREATE TRIGGER core_finance_entry_line_insert
BEFORE INSERT ON core_finance_entry_line
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed')
  WHERE NOT EXISTS (SELECT 1 FROM core_finance_period p WHERE p.id = NEW.period_id
      AND p.state = 'closing')
    OR NOT EXISTS (SELECT 1 FROM core_finance_entry e WHERE e.period_id = NEW.period_id
      AND e.entry_key = NEW.entry_key)
    OR EXISTS (SELECT 1 FROM core_finance_entry_line l WHERE l.period_id = NEW.period_id
      AND l.entry_key = NEW.entry_key AND l.n = NEW.n);
END;

CREATE TRIGGER core_finance_entry_line_update
BEFORE UPDATE ON core_finance_entry_line
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed');
END;

CREATE TRIGGER core_finance_entry_line_delete
BEFORE DELETE ON core_finance_entry_line
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed');
END;

CREATE TRIGGER core_finance_row_insert
BEFORE INSERT ON core_finance_row
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed')
  WHERE NOT EXISTS (SELECT 1 FROM core_finance_period p WHERE p.id = NEW.period_id
      AND p.state = 'closing')
    OR EXISTS (SELECT 1 FROM core_finance_row r WHERE r.period_id = NEW.period_id
      AND r.report = NEW.report AND r.n = NEW.n);
END;

-- The one change a closed row takes: an erase of its person (ADR 0320), whose name becomes
-- "Erased person" and whose email is cleared. Its amounts, dates and order ids stay.
CREATE TRIGGER core_finance_row_update
BEFORE UPDATE ON core_finance_row
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed')
  WHERE NEW.period_id IS NOT OLD.period_id OR NEW.report IS NOT OLD.report OR NEW.n IS NOT OLD.n
    OR NEW.person_id IS NOT OLD.person_id OR NEW.data IS NOT OLD.data
    OR OLD.person_id IS NULL
    OR NEW.name IS NOT 'Erased person' OR NEW.email IS NOT NULL;
END;

CREATE TRIGGER core_finance_row_delete
BEFORE DELETE ON core_finance_row
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed');
END;

CREATE TRIGGER core_finance_counted_insert
BEFORE INSERT ON core_finance_counted
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed')
  WHERE NOT EXISTS (SELECT 1 FROM core_finance_period p WHERE p.id = NEW.period_id
      AND p.state = 'closing' AND p.month = NEW.month)
    OR EXISTS (SELECT 1 FROM core_finance_counted c WHERE c.source_kind = NEW.source_kind
      AND c.source_id = NEW.source_id AND c.period_id = NEW.period_id);
  -- Counted once: never in two months' closed versions.
  SELECT RAISE(ABORT, 'core_finance_counted_twice')
  WHERE EXISTS (SELECT 1 FROM core_finance_counted c
    JOIN core_finance_period p ON p.id = c.period_id
    WHERE c.source_kind = NEW.source_kind AND c.source_id = NEW.source_id
      AND c.month != NEW.month AND p.state = 'closed');
END;

CREATE TRIGGER core_finance_counted_update
BEFORE UPDATE ON core_finance_counted
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed');
END;

CREATE TRIGGER core_finance_counted_delete
BEFORE DELETE ON core_finance_counted
BEGIN
  SELECT RAISE(ABORT, 'core_finance_period_fixed');
END;

-- The month finance starts counting from, until an admin picks an earlier one (ADR 0790): the
-- month this migration ran, read in the organisation's zone. Kept as the instant.
INSERT OR IGNORE INTO core_settings (key, value, updated_at)
  VALUES ('finance_installed_at', json_quote(strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1150'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1150;
