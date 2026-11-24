-- Migration 0950: adjustments on orders (stage 34 step 1, ADR 0690).
--
-- An adjustment is money off an order, kept by the host: on one line, or on the whole order and
-- spread over its lines in proportion. Each line keeps its price (`line_total`) and its share of
-- the adjustments (`line_discount`); its net is the difference. The order's `total` is what is
-- owed after adjustments and `discount` is their sum, so everything downstream that reads the
-- total (the checkout, the amount-match rule, deposits, refunds) reads the net already.
--
-- Step 1 writes only `staff` adjustments (order.adjust, ADR 0691); `code`, `automatic` and
-- `referral` are the discount behaviour's and the referrals' (later steps).

ALTER TABLE core_order ADD COLUMN discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0);
ALTER TABLE core_order_line ADD COLUMN line_discount INTEGER NOT NULL DEFAULT 0
  CHECK (line_discount >= 0 AND line_discount <= line_total);

-- The version check covers the discount too.
DROP TRIGGER core_order_stale;
CREATE TRIGGER core_order_stale
BEFORE UPDATE OF state, paid, refunded, total, discount, deposit, balance_due_at, tax_amount, tax_refunded
ON core_order
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'core_order_stale');
END;

-- One adjustment. Never changed once written, except: a pending order's adjustment taken off is
-- marked removed (once), and an erase blanks a staff reason. Amounts are positive minor units.
CREATE TABLE core_order_adjustment (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES core_order(id),
  -- The line it is on; null: the whole order, spread over its lines in proportion.
  line_id TEXT REFERENCES core_order_line(id),
  kind TEXT NOT NULL CHECK (kind IN ('code', 'automatic', 'staff', 'referral')),
  -- The discount record it came from (the discount behaviour, a later step).
  source_object TEXT,
  source_id TEXT,
  -- A staff adjustment: the person who gave it and why.
  given_by TEXT,
  reason TEXT,
  -- Asked as a percentage (of the line, or of each line of the order): kept for what was asked.
  percent REAL CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
  amount INTEGER NOT NULL CHECK (amount > 0),
  -- The pending action it waited in, when it was over the limit or asked by an AI.
  approval TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT,
  removed_by TEXT,
  CHECK (kind <> 'staff' OR given_by IS NOT NULL),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX core_order_adjustment_order_idx ON core_order_adjustment (order_id, created_at);

CREATE TRIGGER core_order_adjustment_fixed
BEFORE UPDATE ON core_order_adjustment
WHEN NEW.id IS NOT OLD.id OR NEW.order_id IS NOT OLD.order_id OR NEW.line_id IS NOT OLD.line_id
  OR NEW.kind IS NOT OLD.kind OR NEW.source_object IS NOT OLD.source_object
  OR NEW.source_id IS NOT OLD.source_id OR NEW.given_by IS NOT OLD.given_by
  OR NEW.percent IS NOT OLD.percent OR NEW.amount IS NOT OLD.amount
  OR NEW.approval IS NOT OLD.approval OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS NOT OLD.removed_at)
  OR (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'core_order_adjustment_fixed');
END;

CREATE TRIGGER core_order_adjustment_kept
BEFORE DELETE ON core_order_adjustment
BEGIN
  SELECT RAISE(ABORT, 'core_order_adjustment_kept');
END;

-- An adjustment is added to or taken off a pending order only.
CREATE TRIGGER core_order_adjustment_pending
BEFORE INSERT ON core_order_adjustment
WHEN (SELECT state FROM core_order WHERE id = NEW.order_id) IS NOT 'pending'
BEGIN
  SELECT RAISE(ABORT, 'core_order_adjustment_pending');
END;

DROP VIEW rec_order;
CREATE VIEW rec_order AS
SELECT
  id, person_id, email, currency, total, paid, total - paid AS balance, refunded, state, pay,
  deposit, balance_due_at, expires_at, placed_as, paid_at, cancelled_at, refunded_at, created_at,
  updated_at, tax_amount, tax_refunded, tax_country,
  (paid - refunded) - (tax_amount - tax_refunded) AS net,
  subscription_id, period_start, period_end, period_flag,
  discount
FROM core_order;

DROP VIEW rec_order_line;
CREATE VIEW rec_order_line AS
SELECT
  l.id, l.order_id, o.person_id, l.position, l.object_type, l.record_id, l.title, l.quantity,
  l.unit_price, l.line_total, l.created_at, l.tax_amount, l.tax_code,
  l.line_discount, l.line_total - l.line_discount AS line_net
FROM core_order_line l
JOIN core_order o ON o.id = l.order_id;

-- Adjustments for reports: what each discount or person took off, and on which order.
CREATE VIEW rec_order_adjustment AS
SELECT
  a.id, a.order_id, o.person_id, a.line_id, a.kind, a.source_object, a.source_id, a.given_by,
  a.reason, a.percent, a.amount, a.approval, a.created_at, a.removed_at, a.removed_by,
  o.state AS order_state, o.currency
FROM core_order_adjustment a
JOIN core_order o ON o.id = a.order_id;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '950'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 950;
