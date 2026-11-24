-- Migration 0952: an order paid another way (stage 34 step 3, ADR 0694).
--
-- Until now every row of core_order_payment was the provider's verified payment, and that was the
-- one door into `paid` (ADR 0427). This adds the second: a payment the host applies itself
-- (`applyOtherPayment`, orders/payments.ts), for money a person says they received (`recorded`:
-- a bank transfer, cash, a cheque, a card machine) and, in later steps, value the host holds (a
-- gift voucher, a gift card or account credit). Each is a payment row with its `method`.
--
-- A row the host makes is named `host` with an event id the host makes, so the primary key still
-- means "applied once". A recorded payment entered in error is undone by a second row (its amount
-- the first's, negated, and `reverses` naming it), never by an edit or a delete; a recorded
-- payment's refund is a refund row of method `recorded`, paid back by a person.

ALTER TABLE core_order_payment ADD COLUMN method TEXT NOT NULL DEFAULT 'provider'
  CHECK (method IN ('provider', 'recorded', 'voucher', 'stored_value'));
-- A recorded payment: how it was paid, the person who says they received it, the day they did,
-- and the payer's reference (a bank reference, a cheque number). Blanked by an erase.
ALTER TABLE core_order_payment ADD COLUMN recorded_kind TEXT
  CHECK (recorded_kind IS NULL OR recorded_kind IN ('transfer', 'cash', 'cheque', 'card_machine', 'other'));
ALTER TABLE core_order_payment ADD COLUMN recorded_by TEXT;
ALTER TABLE core_order_payment ADD COLUMN received_on TEXT;
ALTER TABLE core_order_payment ADD COLUMN reference TEXT;
-- The value a `voucher` or `stored_value` row spent (stages 34 steps 7 and 8 write them).
ALTER TABLE core_order_payment ADD COLUMN voucher_id TEXT;
ALTER TABLE core_order_payment ADD COLUMN stored_value_id TEXT;
-- A reversal: the event id of the host's row it undoes, and why (staff's words, blanked by an
-- erase). Each row is reversed at most once.
ALTER TABLE core_order_payment ADD COLUMN reverses TEXT;
ALTER TABLE core_order_payment ADD COLUMN reason TEXT;
CREATE UNIQUE INDEX core_order_payment_reverses_uq ON core_order_payment (reverses)
  WHERE reverses IS NOT NULL;

-- What a payment row may be. Nothing a caller sends reaches these columns except through the
-- operations that call applyOtherPayment; this is the database's own floor under them.

-- The provider's rows are the provider's; the host's are never provider rows, and are applied.
CREATE TRIGGER core_order_payment_method
BEFORE INSERT ON core_order_payment
WHEN (NEW.method = 'provider') = (NEW.provider = 'host')
  OR (NEW.method <> 'provider' AND NEW.outcome <> 'applied')
  OR (NEW.method <> 'recorded'
    AND (NEW.recorded_kind IS NOT NULL OR NEW.recorded_by IS NOT NULL OR NEW.reverses IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'core_order_payment_method');
END;

-- A recorded payment names the person who received it, how and when.
CREATE TRIGGER core_order_payment_recorded
BEFORE INSERT ON core_order_payment
WHEN NEW.method = 'recorded'
  AND (NEW.recorded_by IS NULL OR NEW.recorded_kind IS NULL OR NEW.received_on IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'core_order_payment_recorded');
END;

-- A voucher or stored value row is made only beside its ledger entry in the same batch (the
-- voucher redeemed, the value spent). Neither ledger exists yet (stage 34 steps 7 and 8), so none
-- can be made: those steps replace this trigger with one that looks for the entry.
CREATE TRIGGER core_order_payment_ledger
BEFORE INSERT ON core_order_payment
WHEN NEW.method IN ('voucher', 'stored_value')
BEGIN
  SELECT RAISE(ABORT, 'core_order_payment_ledger');
END;

-- The host's own money in is positive; only a reversal is negative, and it undoes exactly one
-- applied recorded payment of the same order, with a reason.
CREATE TRIGGER core_order_payment_amount
BEFORE INSERT ON core_order_payment
WHEN NEW.provider = 'host' AND NEW.reverses IS NULL AND NEW.amount <= 0
BEGIN
  SELECT RAISE(ABORT, 'core_order_payment_amount');
END;

CREATE TRIGGER core_order_payment_reversal
BEFORE INSERT ON core_order_payment
WHEN NEW.reverses IS NOT NULL
  AND (NEW.reason IS NULL OR NOT EXISTS (
    SELECT 1 FROM core_order_payment p
    WHERE p.provider = 'host' AND p.event_id = NEW.reverses AND p.order_id = NEW.order_id
      AND p.method = 'recorded' AND p.outcome = 'applied' AND p.reverses IS NULL
      AND p.amount = -NEW.amount AND p.currency = NEW.currency))
BEGIN
  SELECT RAISE(ABORT, 'core_order_payment_reversal');
END;

-- The host's rows are kept as written: an erase may only blank the reference and the reason.
CREATE TRIGGER core_order_payment_host_fixed
BEFORE UPDATE ON core_order_payment
WHEN OLD.provider = 'host'
  AND (NEW.provider IS NOT OLD.provider OR NEW.event_id IS NOT OLD.event_id
    OR NEW.order_id IS NOT OLD.order_id OR NEW.amount IS NOT OLD.amount
    OR NEW.currency IS NOT OLD.currency OR NEW.outcome IS NOT OLD.outcome
    OR NEW.payment_ref IS NOT OLD.payment_ref OR NEW.method IS NOT OLD.method
    OR NEW.recorded_kind IS NOT OLD.recorded_kind OR NEW.recorded_by IS NOT OLD.recorded_by
    OR NEW.received_on IS NOT OLD.received_on OR NEW.voucher_id IS NOT OLD.voucher_id
    OR NEW.stored_value_id IS NOT OLD.stored_value_id OR NEW.reverses IS NOT OLD.reverses
    OR (NEW.reference IS NOT OLD.reference AND NEW.reference IS NOT NULL)
    OR (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'core_order_payment_fixed');
END;

-- Refunds by method (amends ADR 0429): what went back the way it came. A recorded payment's money
-- is paid back by a person, who records how; nothing is sent by the host.
ALTER TABLE core_order_refund ADD COLUMN method TEXT NOT NULL DEFAULT 'provider'
  CHECK (method IN ('provider', 'recorded', 'voucher', 'stored_value'));
ALTER TABLE core_order_refund ADD COLUMN recorded_kind TEXT
  CHECK (recorded_kind IS NULL OR recorded_kind IN ('transfer', 'cash', 'cheque', 'card_machine', 'other'));
ALTER TABLE core_order_refund ADD COLUMN reference TEXT;

CREATE TRIGGER core_order_refund_method
BEFORE INSERT ON core_order_refund
WHEN (NEW.method = 'provider') = (NEW.provider = 'host')
  OR (NEW.method <> 'recorded' AND NEW.recorded_kind IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'core_order_refund_method');
END;

-- Paid back by a person: confirmed as it is written, naming who, how, and the recorded payment.
CREATE TRIGGER core_order_refund_recorded
BEFORE INSERT ON core_order_refund
WHEN NEW.method = 'recorded'
  AND (NEW.status <> 'confirmed' OR NEW.requested_by IS NULL OR NEW.recorded_kind IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM core_order_payment p
      WHERE p.provider = 'host' AND p.event_id = NEW.payment_ref AND p.order_id = NEW.order_id
        AND p.method = 'recorded' AND p.reverses IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'core_order_refund_recorded');
END;

-- Value given back onto a voucher or stored value comes with those ledgers (steps 7 and 8).
CREATE TRIGGER core_order_refund_ledger
BEFORE INSERT ON core_order_refund
WHEN NEW.method IN ('voucher', 'stored_value')
BEGIN
  SELECT RAISE(ABORT, 'core_order_payment_ledger');
END;

-- Payments by method, for reports: money taken (the provider's and recorded), value redeemed
-- (vouchers and stored value, which is not new money), and reversals (negative, naming the row).
CREATE VIEW rec_order_payment AS
SELECT
  p.provider || ':' || p.event_id AS id, p.provider, p.event_id, p.order_id, o.person_id,
  p.method, p.recorded_kind, p.recorded_by, p.received_on, p.reference, p.voucher_id,
  p.stored_value_id, p.reverses, p.reason, p.amount, p.currency, p.outcome, p.resolved,
  p.tax_amount, p.received_at, o.state AS order_state
FROM core_order_payment p
JOIN core_order o ON o.id = p.order_id;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '952'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 952;
