-- Migration 0951: an order's price and its payment page never cross (stage 34 step 1, review of
-- PR #380; ADR 0690).
--
-- A checkout is opened for the amount the host read, then the provider is asked for a page, then
-- the checkout is recorded. A discount given in between would leave a page for the old price,
-- which the verified payment would not match. The database refuses both orders of that race:

-- The total of an order whose payment page is open does not change (a discount given after the
-- page was recorded).
CREATE TRIGGER core_order_total_checkout_open
BEFORE UPDATE OF total ON core_order
WHEN NEW.total IS NOT OLD.total
  AND EXISTS (SELECT 1 FROM core_order_checkout WHERE order_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'core_order_checkout_open');
END;

-- A page for the whole price or the deposit is recorded only for what the order costs now (a
-- discount given while the page was being opened).
CREATE TRIGGER core_order_checkout_amount
BEFORE INSERT ON core_order_checkout
WHEN (NEW.kind = 'full'
    AND NEW.amount IS NOT (SELECT total FROM core_order WHERE id = NEW.order_id))
  OR (NEW.kind = 'deposit'
    AND NEW.amount IS NOT (SELECT CASE WHEN deposit < total THEN deposit END
      FROM core_order WHERE id = NEW.order_id))
BEGIN
  SELECT RAISE(ABORT, 'core_order_checkout_stale');
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '951'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 951;
