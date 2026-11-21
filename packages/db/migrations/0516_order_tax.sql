-- Migration 0516: tax at checkout (stage 42 section 4, ADR 0479).
--
-- Prices are tax-inclusive. When a human admin turns tax on (core_settings `order_tax`) and the
-- object bought declares a product tax code (`sellable.tax`), the payments gatekeeper asks the
-- provider (Stripe Tax) to calculate tax inside each payment. What the provider says is stored
-- here, payment by payment, and never recalculated by the host. Totals do not change: tax is
-- inside them.

-- A checkout opened with tax: the lines its amount was made of, each with its code and place,
-- as sent to the provider (JSON). Null: opened without tax, exactly as before.
ALTER TABLE core_order_checkout ADD COLUMN tax_lines TEXT;

-- The provider's tax on one verified payment and the country it was charged for. Null: the
-- checkout was not taxed.
ALTER TABLE core_order_payment ADD COLUMN tax_amount INTEGER CHECK (tax_amount IS NULL OR tax_amount >= 0);
ALTER TABLE core_order_payment ADD COLUMN tax_country TEXT;

-- The order's running tax: the sum of its applied payments' tax, what of it the provider said
-- went back with refunds, and the country of the latest taxed payment.
ALTER TABLE core_order ADD COLUMN tax_amount INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount >= 0);
ALTER TABLE core_order ADD COLUMN tax_refunded INTEGER NOT NULL DEFAULT 0 CHECK (tax_refunded >= 0);
ALTER TABLE core_order ADD COLUMN tax_country TEXT;

-- A line's tax: the sum of the provider's tax on its share of each payment, and the code it was
-- last charged at.
ALTER TABLE core_order_line ADD COLUMN tax_amount INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount >= 0);
ALTER TABLE core_order_line ADD COLUMN tax_code TEXT;

-- The tax a refund gave back, when the provider's refund event says. Null: it did not say
-- (Stripe's Refund carries no tax figure; ADR 0479).
ALTER TABLE core_order_refund ADD COLUMN tax_amount INTEGER CHECK (tax_amount IS NULL OR tax_amount >= 0);

-- The version check covers the order's tax too.
DROP TRIGGER core_order_stale;
CREATE TRIGGER core_order_stale
BEFORE UPDATE OF state, paid, refunded, total, deposit, balance_due_at, tax_amount, tax_refunded
ON core_order
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'core_order_stale');
END;

-- `net`: what the company keeps, net of tax: paid less refunded, less the tax still held.
DROP VIEW rec_order;
CREATE VIEW rec_order AS
SELECT
  id, person_id, email, currency, total, paid, total - paid AS balance, refunded, state, pay,
  deposit, balance_due_at, expires_at, placed_as, paid_at, cancelled_at, refunded_at, created_at,
  updated_at, tax_amount, tax_refunded, tax_country,
  (paid - refunded) - (tax_amount - tax_refunded) AS net
FROM core_order;

DROP VIEW rec_order_line;
CREATE VIEW rec_order_line AS
SELECT
  l.id, l.order_id, o.person_id, l.position, l.object_type, l.record_id, l.title, l.quantity,
  l.unit_price, l.line_total, l.created_at, l.tax_amount, l.tax_code
FROM core_order_line l
JOIN core_order o ON o.id = l.order_id;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '516'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 516;
