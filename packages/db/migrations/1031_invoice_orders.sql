-- Migration 1031: an invoice is an order; what a credit note takes off; the refunds it owes
-- (stage 35 steps 3 to 5, ADRs 0731, 0733 and 0735).
--
-- Issuing an invoice starts one order in the same batch (invoice.issue): its lines as the host
-- priced them, its staff discounts as stage 34 adjustments, its tax from the document. The order
-- names its invoice (`invoice_id`) and is due, not expiring: it has no `expires_at`, and its due
-- date is the invoice's (`balance_due_at`). Its money is moved only through the invoice's own
-- operations (the operations refuse the rest; the triggers below hold its price for any writer).
--
-- A credit note reduces what is owed first (`credited` on the order: balance = total - paid -
-- credited), then gives back what was paid: one row here per payment it gives money back on, a
-- provider's through the existing refund approval, a recorded one owed until a person records it
-- paid back.

-- The invoice an order was started by (null for every other order), fixed once written.
ALTER TABLE core_order ADD COLUMN invoice_id TEXT REFERENCES core_invoice (id);
-- What credit notes took off what was still owed (never what was paid: that is refunded).
ALTER TABLE core_order ADD COLUMN credited INTEGER NOT NULL DEFAULT 0 CHECK (credited >= 0);

-- One order per invoice.
CREATE UNIQUE INDEX core_order_invoice_id_uq ON core_order (invoice_id) WHERE invoice_id IS NOT NULL;
-- An unpaid invoice's order is overdue once its due date has passed (order.overdue).
CREATE INDEX core_order_invoice_due_idx ON core_order (balance_due_at)
  WHERE state = 'pending' AND invoice_id IS NOT NULL;

-- An invoice's order is made only in the batch that issues it, after the invoice took its number
-- and named the order: a draft deleted or changed meanwhile, or issued twice, makes no order.
CREATE TRIGGER core_order_invoice_new
BEFORE INSERT ON core_order
WHEN NEW.invoice_id IS NOT NULL AND (NEW.expires_at IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM core_invoice i
  WHERE i.id = NEW.invoice_id AND i.order_id = NEW.id AND i.state = 'issued'
    AND i.total = NEW.total AND i.currency = NEW.currency))
BEGIN
  SELECT RAISE(ABORT, 'core_order_invoice');
END;

-- The invoice is the order's for good; its price is the invoice's; a credit is never taken back,
-- is only an invoice's, and never takes more than is owed.
CREATE TRIGGER core_order_invoice_fixed
BEFORE UPDATE OF invoice_id, total, discount, credited, paid, expires_at, currency ON core_order
WHEN NEW.invoice_id IS NOT OLD.invoice_id
  OR (OLD.invoice_id IS NOT NULL AND (NEW.total IS NOT OLD.total
    OR NEW.discount IS NOT OLD.discount OR NEW.expires_at IS NOT NULL
    OR NEW.currency IS NOT OLD.currency))
  OR NEW.credited < OLD.credited
  OR (NEW.credited > 0 AND NEW.invoice_id IS NULL)
  OR NEW.paid + NEW.credited > NEW.total
BEGIN
  SELECT RAISE(ABORT, 'core_order_invoice');
END;

-- An invoice's order's tax is what its payments carried and its refunds gave back (each its share
-- of the document's tax, ADR 0731): never written on its own. The payment or refund row is written
-- before the order in the same batch (orders/payments.ts, refunds.ts, events.ts).
CREATE TRIGGER core_order_invoice_tax
BEFORE UPDATE OF tax_amount, tax_refunded ON core_order
WHEN OLD.invoice_id IS NOT NULL AND (
  -- What the applied payments carried, less what those a reversal undid carried.
  NEW.tax_amount IS NOT (SELECT coalesce(sum(p.tax_amount), 0) FROM core_order_payment p
    WHERE p.order_id = NEW.id AND p.outcome = 'applied'
      AND NOT EXISTS (SELECT 1 FROM core_order_payment q
        WHERE q.order_id = p.order_id AND q.reverses = p.event_id))
  OR NEW.tax_refunded IS NOT (SELECT coalesce(sum(r.tax_amount), 0) FROM core_order_refund r
    WHERE r.order_id = NEW.id AND r.status = 'confirmed'))
BEGIN
  SELECT RAISE(ABORT, 'core_order_invoice');
END;

-- An invoice's order is never deleted (retention, stage 35 step 11, is specified later), and never
-- replaced: an INSERT OR REPLACE deletes the row it replaces without firing a delete trigger (D1
-- runs with recursive triggers off), so an insert over an invoice's order is refused.
CREATE TRIGGER core_order_invoice_kept
BEFORE DELETE ON core_order
WHEN OLD.invoice_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'core_order_invoice');
END;

CREATE TRIGGER core_order_invoice_replaced
BEFORE INSERT ON core_order
WHEN EXISTS (SELECT 1 FROM core_order o WHERE o.id = NEW.id AND o.invoice_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'core_order_invoice');
END;

-- Only an invoice's order is unpaid again by its reversals (ADR 0733): no other order moves from
-- paid or part paid back to pending, whoever writes it.
CREATE TRIGGER core_order_unpaid_again
BEFORE UPDATE OF state ON core_order
WHEN NEW.state = 'pending' AND OLD.state IN ('paid', 'part_paid') AND OLD.invoice_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'core_order_invoice');
END;

-- An invoice's order's lines say what the invoice says: no price, quantity, discount or tax
-- changes, none deleted, and none added once the order exists (its lines are written in the
-- batch that starts it, before its first history row).
CREATE TRIGGER core_order_line_invoice_fixed
BEFORE UPDATE OF unit_price, quantity, line_total, line_discount, object_type, record_id,
  tax_amount, order_id
ON core_order_line
WHEN (SELECT invoice_id FROM core_order WHERE id = OLD.order_id) IS NOT NULL
  OR (SELECT invoice_id FROM core_order WHERE id = NEW.order_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'core_order_invoice');
END;

CREATE TRIGGER core_order_line_invoice_kept
BEFORE DELETE ON core_order_line
WHEN (SELECT invoice_id FROM core_order WHERE id = OLD.order_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'core_order_invoice');
END;

CREATE TRIGGER core_order_line_invoice_new
BEFORE INSERT ON core_order_line
WHEN ((SELECT invoice_id FROM core_order WHERE id = NEW.order_id) IS NOT NULL
  AND EXISTS (SELECT 1 FROM core_transition_history h
    WHERE h.object_type = 'order' AND h.record_id = NEW.order_id))
  -- Nor over a line of one (a REPLACE, whatever order it names).
  OR EXISTS (SELECT 1 FROM core_order_line l JOIN core_order o ON o.id = l.order_id
    WHERE l.id = NEW.id AND o.invoice_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'core_order_invoice');
END;

-- The version check covers what is credited too.
DROP TRIGGER core_order_stale;
CREATE TRIGGER core_order_stale
BEFORE UPDATE OF state, paid, refunded, total, discount, deposit, balance_due_at, tax_amount,
  tax_refunded, credited
ON core_order
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'core_order_stale');
END;

-- The balance is what is still owed: what credit notes took off is not owed. An invoice's order's
-- tax, as staff and its customer read it, is the document's (what the invoice shows, beside its
-- lines' tax), never the figure its payments have carried so far: that one is the book's
-- (core_order.tax_amount, which `net` is still worked from).
DROP VIEW rec_order;
CREATE VIEW rec_order AS
SELECT
  o.id, o.person_id, o.email, o.currency, o.total, o.paid,
  o.total - o.paid - o.credited AS balance, o.refunded, o.state, o.pay, o.deposit,
  o.balance_due_at, o.expires_at, o.placed_as, o.paid_at, o.cancelled_at, o.refunded_at,
  o.created_at, o.updated_at,
  CASE WHEN o.invoice_id IS NULL THEN o.tax_amount
    ELSE coalesce((SELECT i.tax_total FROM core_invoice i WHERE i.id = o.invoice_id), 0)
  END AS tax_amount,
  o.tax_refunded, o.tax_country,
  (o.paid - o.refunded) - (o.tax_amount - o.tax_refunded) AS net,
  o.subscription_id, o.period_start, o.period_end, o.period_flag,
  o.discount, o.invoice_id, o.credited
FROM core_order o;

-- Adjustments gain a kind only the host writes on an invoice's order: `prepaid` (a final
-- invoice's "less deposit paid", stage 35 step 6 writes its lines), naming the invoice. SQLite cannot change a CHECK, so the table is remade with its rows; nothing
-- references it, its triggers and its view go with it and are made again as migration 0950 made
-- them. A later remake carries these kinds forward and sorts after 1031.
DROP VIEW rec_order_adjustment;
DROP TRIGGER core_order_adjustment_fixed;
DROP TRIGGER core_order_adjustment_kept;
DROP TRIGGER core_order_adjustment_pending;

CREATE TABLE core_order_adjustment_new (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES core_order(id),
  line_id TEXT REFERENCES core_order_line(id),
  kind TEXT NOT NULL CHECK (kind IN ('code', 'automatic', 'staff', 'referral', 'prepaid')),
  source_object TEXT,
  source_id TEXT,
  given_by TEXT,
  reason TEXT,
  percent REAL CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
  amount INTEGER NOT NULL CHECK (amount > 0),
  approval TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT,
  removed_by TEXT,
  CHECK (kind <> 'staff' OR given_by IS NOT NULL),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CHECK (kind NOT IN ('prepaid') OR (source_object = 'invoice' AND source_id IS NOT NULL))
);
INSERT INTO core_order_adjustment_new (
  id, order_id, line_id, kind, source_object, source_id, given_by, reason, percent, amount,
  approval, created_at, removed_at, removed_by
)
SELECT
  id, order_id, line_id, kind, source_object, source_id, given_by, reason, percent, amount,
  approval, created_at, removed_at, removed_by
FROM core_order_adjustment;
DROP TABLE core_order_adjustment;
ALTER TABLE core_order_adjustment_new RENAME TO core_order_adjustment;
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
  -- An invoice's adjustments are what the invoice says: never taken off.
  OR (NEW.removed_at IS NOT NULL
    AND (SELECT invoice_id FROM core_order WHERE id = OLD.order_id) IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'core_order_adjustment_fixed');
END;

CREATE TRIGGER core_order_adjustment_kept
BEFORE DELETE ON core_order_adjustment
BEGIN
  SELECT RAISE(ABORT, 'core_order_adjustment_kept');
END;

-- An adjustment is added to or taken off a pending order only; an invoice's only in the batch
-- that starts its order (before anything is paid on it), and `prepaid` only there.
CREATE TRIGGER core_order_adjustment_pending
BEFORE INSERT ON core_order_adjustment
WHEN (SELECT state FROM core_order WHERE id = NEW.order_id) IS NOT 'pending'
  OR (NEW.kind IN ('prepaid') AND NOT EXISTS (
    SELECT 1 FROM core_order o WHERE o.id = NEW.order_id AND o.invoice_id = NEW.source_id))
BEGIN
  SELECT RAISE(ABORT, 'core_order_adjustment_pending');
END;

-- Never over an existing adjustment (a REPLACE would delete it without the kept trigger firing).
CREATE TRIGGER core_order_adjustment_replaced
BEFORE INSERT ON core_order_adjustment
WHEN EXISTS (SELECT 1 FROM core_order_adjustment a WHERE a.id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'core_order_adjustment_kept');
END;

CREATE VIEW rec_order_adjustment AS
SELECT
  a.id, a.order_id, o.person_id, a.line_id, a.kind, a.source_object, a.source_id, a.given_by,
  a.reason, a.percent, a.amount, a.approval, a.created_at, a.removed_at, a.removed_by,
  o.state AS order_state, o.currency
FROM core_order_adjustment a
JOIN core_order o ON o.id = a.order_id;

-- What a credit note gives back, per payment of the invoice's order, newest first (ADR 0735):
-- a provider's payment through the existing refund approval (`refund_id` names the refund asked
-- for, in the credit note's batch); a recorded payment owed until a person records it paid back
-- (order.recordRefund fills in `refund_id` and `paid_back_at`, once). A provider's refund a person
-- rejected, or that expired or failed, is asked for again for the same amount
-- (creditNote.askRefundAgain): `refund_id` names the new one and `attempt` moves on by one, only
-- while the old one was never confirmed. Never changed otherwise, never deleted.
CREATE TABLE core_credit_note_refund (
  -- cnr_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  credit_note_id TEXT NOT NULL REFERENCES core_credit_note (id),
  order_id TEXT NOT NULL REFERENCES core_order (id),
  provider TEXT NOT NULL,
  payment_ref TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('provider', 'recorded')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  refund_id TEXT,
  paid_back_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  created_at TEXT NOT NULL,
  CHECK (method = 'recorded' OR refund_id IS NOT NULL),
  CHECK ((paid_back_at IS NULL) OR (method = 'recorded' AND refund_id IS NOT NULL))
);
CREATE INDEX core_credit_note_refund_order_idx ON core_credit_note_refund (order_id, payment_ref);
CREATE INDEX core_credit_note_refund_note_idx ON core_credit_note_refund (credit_note_id);

-- Written in the batch that issues its credit note, never over another row.
CREATE TRIGGER core_credit_note_refund_new
BEFORE INSERT ON core_credit_note_refund
WHEN EXISTS (SELECT 1 FROM core_credit_note_refund r WHERE r.id = NEW.id)
  OR NOT EXISTS (
    SELECT 1 FROM core_credit_note n
    JOIN core_invoice i ON i.id = n.invoice_id
    WHERE n.id = NEW.credit_note_id AND n.state = 'issued' AND i.order_id = NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'core_credit_note_refund');
END;

CREATE TRIGGER core_credit_note_refund_fixed
BEFORE UPDATE ON core_credit_note_refund
WHEN NEW.id IS NOT OLD.id OR NEW.credit_note_id IS NOT OLD.credit_note_id
  OR NEW.order_id IS NOT OLD.order_id OR NEW.provider IS NOT OLD.provider
  OR NEW.payment_ref IS NOT OLD.payment_ref OR NEW.method IS NOT OLD.method
  OR NEW.amount IS NOT OLD.amount OR NEW.created_at IS NOT OLD.created_at
  OR OLD.paid_back_at IS NOT NULL OR NEW.refund_id IS NULL
  -- A recorded one: paid back, once.
  OR (OLD.method = 'recorded' AND (NEW.paid_back_at IS NULL OR NEW.attempt IS NOT OLD.attempt))
  -- A provider's: asked again, for the same amount, when the one before was never confirmed.
  OR (OLD.method = 'provider' AND (NEW.paid_back_at IS NOT NULL
    OR NEW.attempt IS NOT OLD.attempt + 1
    OR EXISTS (SELECT 1 FROM core_order_refund r WHERE r.id = OLD.refund_id
      AND r.status = 'confirmed')
    OR NOT EXISTS (SELECT 1 FROM core_order_refund r WHERE r.id = NEW.refund_id
      AND r.order_id = NEW.order_id AND r.payment_ref = NEW.payment_ref
      AND r.amount = NEW.amount)))
BEGIN
  SELECT RAISE(ABORT, 'core_credit_note_refund');
END;

CREATE TRIGGER core_credit_note_refund_kept
BEFORE DELETE ON core_credit_note_refund
BEGIN
  SELECT RAISE(ABORT, 'core_credit_note_refund');
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1031'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1031;
