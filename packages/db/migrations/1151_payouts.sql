-- Migration 1151: payouts read from the payment provider (stage 52 step 4, ADR 0793).
--
-- A payout is money the provider sent from the business's balance to its bank; its lines are the
-- payments, refunds, disputes, adjustments and fees it settled. The host reads them once a day
-- through the payments gatekeeper (read only: nothing moves, and the bank account a payout went
-- to is never read) and keeps them here as the provider reported them, so the Payouts report and
-- each month's payout entries (ADR 0791) can tie what landed in the bank to what was sold.
--
-- What the provider reported is never rewritten. A payout is recorded once, when it has arrived
-- (`paid`) and every one of its lines has been read; its lines are written while it is read (a
-- payout of many lines can take several runs) and never once it is recorded. A payout that fails
-- after it arrived (the bank returned it) is a correction of its own (`core_payout_failure`),
-- never an edit. Reading the same payouts again records nothing again: everything is keyed by the
-- provider's own ids.
--
-- All of it is the business's figures: core tables in no rec_* view, so no dashboard, query.sql,
-- export.csv or the assistant's record reads reach them; they are read only through the finance
-- operations, by an account holding `finance:read`. Nothing here names a person.
--
-- D1 runs with recursive triggers off, so each table's BEFORE INSERT also refuses a REPLACE or an
-- upsert onto a row it holds, and its BEFORE UPDATE every change (an UPDATE OR REPLACE is one).

-- One payout, as the provider reported it once it arrived. `amount` is what reached the bank;
-- `line_count` and `lines_net` (its lines' amounts less their fees) are checked against its lines
-- when it is recorded; a difference between `amount` and `lines_net` is the provider's, shown and
-- told, never adjusted. `itemised` 0: a payout made by hand at the provider, with no lines.
CREATE TABLE core_payout (
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  arrival_date TEXT NOT NULL
    CHECK (arrival_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  status TEXT NOT NULL CHECK (status = 'paid'),
  itemised INTEGER NOT NULL CHECK (itemised IN (0, 1)),
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  lines_net INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (provider, ref)
) WITHOUT ROWID;

CREATE INDEX core_payout_arrival ON core_payout (arrival_date);

-- One line of a payout: `amount` into the balance (positive) or out of it (negative), before the
-- provider's `fee` (positive: charged). `payment_ref` is the payment it is for, as the host stores
-- it on core_order_payment; `refund_ref` a refund's own reference (core_order_refund's
-- provider_refund_ref). A line is the provider's movement: it is in one payout only.
CREATE TABLE core_payout_line (
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  payout_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'dispute', 'adjustment', 'fee')),
  amount INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  currency TEXT NOT NULL,
  payment_ref TEXT,
  refund_ref TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (provider, ref)
) WITHOUT ROWID;

CREATE INDEX core_payout_line_payout ON core_payout_line (provider, payout_ref);
CREATE INDEX core_payout_line_payment ON core_payout_line (provider, payment_ref)
  WHERE payment_ref IS NOT NULL;
CREATE INDEX core_payout_line_refund ON core_payout_line (provider, refund_ref)
  WHERE refund_ref IS NOT NULL;

-- A recorded payout the provider later reported failed (the bank returned it; its money went back
-- to the balance, to be paid out again). `date` is the business's day the host saw it, the day it
-- is counted on.
CREATE TABLE core_payout_failure (
  provider TEXT NOT NULL,
  payout_ref TEXT NOT NULL,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, payout_ref)
) WITHOUT ROWID;

CREATE INDEX core_payout_failure_date ON core_payout_failure (date);

-- Where the daily read is (one row per provider): the pass in progress (from which arrival day,
-- the provider's page cursor, the payout whose lines are being read, as the provider reported
-- it), the business's day the pass started and whether it finished, whether the connection may
-- read payouts at all, and `next_at`, the instant the next run is due (the next day's pass, the
-- rest of a backlog, or a retry after the provider failed): a quiet minute reads this row by its
-- key and nothing else. The one table here that changes; it holds no figure. `version` keeps two
-- runs at once from moving it back.
CREATE TABLE core_payout_sync (
  provider TEXT PRIMARY KEY NOT NULL,
  pass_date TEXT NOT NULL,
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  since TEXT NOT NULL,
  cursor TEXT,
  reading TEXT CHECK (reading IS NULL OR json_valid(reading)),
  line_cursor TEXT,
  state TEXT NOT NULL CHECK (state IN ('ok', 'unavailable', 'failing')),
  reason TEXT,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  next_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL
);

-- Recorded once, with exactly the lines read for it; never replaced, changed or removed.
CREATE TRIGGER core_payout_insert
BEFORE INSERT ON core_payout
BEGIN
  SELECT RAISE(ABORT, 'core_payout_fixed')
  WHERE EXISTS (SELECT 1 FROM core_payout p WHERE p.provider = NEW.provider AND p.ref = NEW.ref)
    OR NEW.line_count != (SELECT count(*) FROM core_payout_line l
      WHERE l.provider = NEW.provider AND l.payout_ref = NEW.ref)
    OR NEW.lines_net != (SELECT coalesce(sum(l.amount - l.fee), 0) FROM core_payout_line l
      WHERE l.provider = NEW.provider AND l.payout_ref = NEW.ref)
    OR (NEW.itemised = 0 AND NEW.line_count != 0);
END;

CREATE TRIGGER core_payout_update
BEFORE UPDATE ON core_payout
BEGIN
  SELECT RAISE(ABORT, 'core_payout_fixed');
END;

CREATE TRIGGER core_payout_delete
BEFORE DELETE ON core_payout
BEGIN
  SELECT RAISE(ABORT, 'core_payout_fixed');
END;

-- A line is written while its payout is being read, once; never after the payout is recorded.
CREATE TRIGGER core_payout_line_insert
BEFORE INSERT ON core_payout_line
BEGIN
  SELECT RAISE(ABORT, 'core_payout_fixed')
  WHERE EXISTS (SELECT 1 FROM core_payout_line l WHERE l.provider = NEW.provider AND l.ref = NEW.ref)
    OR EXISTS (SELECT 1 FROM core_payout p
      WHERE p.provider = NEW.provider AND p.ref = NEW.payout_ref);
END;

CREATE TRIGGER core_payout_line_update
BEFORE UPDATE ON core_payout_line
BEGIN
  SELECT RAISE(ABORT, 'core_payout_fixed');
END;

CREATE TRIGGER core_payout_line_delete
BEFORE DELETE ON core_payout_line
BEGIN
  SELECT RAISE(ABORT, 'core_payout_fixed');
END;

-- A failure is of a recorded payout, once; never changed or removed.
CREATE TRIGGER core_payout_failure_insert
BEFORE INSERT ON core_payout_failure
BEGIN
  SELECT RAISE(ABORT, 'core_payout_fixed')
  WHERE EXISTS (SELECT 1 FROM core_payout_failure f
      WHERE f.provider = NEW.provider AND f.payout_ref = NEW.payout_ref)
    OR NOT EXISTS (SELECT 1 FROM core_payout p
      WHERE p.provider = NEW.provider AND p.ref = NEW.payout_ref);
END;

CREATE TRIGGER core_payout_failure_update
BEFORE UPDATE ON core_payout_failure
BEGIN
  SELECT RAISE(ABORT, 'core_payout_fixed');
END;

CREATE TRIGGER core_payout_failure_delete
BEFORE DELETE ON core_payout_failure
BEGIN
  SELECT RAISE(ABORT, 'core_payout_fixed');
END;

-- Matching a payout's lines to what the host recorded: a provider payment by its reference, and
-- the provider's payments received in a span (what is not yet paid out). Indexes only: no column,
-- row or trigger of the order tables changes.
CREATE INDEX core_order_payment_ref_idx ON core_order_payment (provider, payment_ref)
  WHERE method = 'provider' AND payment_ref IS NOT NULL;
CREATE INDEX core_order_payment_provider_received_idx ON core_order_payment (received_at)
  WHERE method = 'provider';

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1151'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1151;
