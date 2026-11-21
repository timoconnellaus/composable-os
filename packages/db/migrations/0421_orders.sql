-- Migration 0421: orders, order lines and the payments applied to them (stage 25, ADR 0426).
--
-- An Order is a base record in core: what someone is buying, priced by the host from the records
-- being bought, in the deployment's one currency. Every amount is an integer in the currency's
-- minor unit (cents), so nothing here is ever rounded twice.
--
-- An order's state is a fixed machine declared in core (fields/order.ts) and held by the
-- transition engine (ADR 0425): pending -> paid -> refunded; pending -> cancelled; pending ->
-- expired; expired -> paid (a late payment staff honour); and, for an order paid by deposit,
-- pending -> part_paid -> paid and part_paid -> cancelled. paid, part_paid, refunded and expired
-- are moves only platform code makes. The CHECK below is the list of states, not the rule: the
-- engine is the rule, and its history is in core_transition_history (object_type 'order').
--
-- Nothing here holds a card number, and no column could: paying happens on the provider's page.

CREATE TABLE core_order (
  -- ord_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  -- Whose order it is. Null when the address it was placed with matched several people (staff
  -- merge them), and after the person is erased: the order stays, as an amount with no one on it.
  person_id TEXT REFERENCES core_person (id) ON DELETE SET NULL,
  -- The address the order was placed with, lower-cased and trimmed. Null after an erase.
  email TEXT CHECK (email IS NULL OR (email = lower(trim(email)) AND email <> '')),
  -- ISO 4217, the deployment's currency when the order was started.
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  total INTEGER NOT NULL CHECK (total >= 0),
  -- The sum of the verified payments applied. Only applyVerifiedPayment raises it.
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid >= 0),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'part_paid', 'paid', 'cancelled', 'expired', 'refunded')),
  -- How the buyer chose to pay: all at once, or a deposit now and the balance by a date.
  pay TEXT NOT NULL DEFAULT 'full' CHECK (pay IN ('full', 'deposit')),
  -- pay = 'deposit': what is due first, and when the balance is due. Both from the records bought.
  deposit INTEGER CHECK (deposit IS NULL OR deposit > 0),
  balance_due_at TEXT,
  -- When an order nothing has been paid on expires (the minute cron moves it). Not read once
  -- anything is paid: a part-paid order has a balance due date instead.
  expires_at TEXT,
  -- Who started it: a signed-in customer, the public (a guest) or staff.
  placed_as TEXT NOT NULL CHECK (placed_as IN ('customer', 'public', 'staff')),
  -- The provider's own reference for the order (set by checkout), for finding it from a webhook.
  provider TEXT,
  provider_ref TEXT,
  -- A guest's way back to this one order: the SHA-256 of a random token the buyer is given once.
  -- access_until is null while the order is open (pending or part paid) and set when it closes.
  access_hash TEXT,
  access_until TEXT,
  paid_at TEXT,
  cancelled_at TEXT,
  refunded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Counts the order's updates. Platform code reads the order, decides, and writes version + 1;
  -- core_order_stale (below) fails a write made from an older read, and its whole batch.
  version INTEGER NOT NULL DEFAULT 0,
  CHECK (paid <= total),
  CHECK (pay = 'full' OR (deposit IS NOT NULL AND balance_due_at IS NOT NULL))
);
CREATE INDEX core_order_person_idx ON core_order (person_id, created_at);
CREATE INDEX core_order_email_idx ON core_order (email) WHERE email IS NOT NULL;
-- The expiry sweep and the overdue list read one state each, in date order.
CREATE INDEX core_order_expiry_idx ON core_order (expires_at) WHERE state = 'pending';
CREATE INDEX core_order_balance_due_idx ON core_order (balance_due_at) WHERE state = 'part_paid';
CREATE UNIQUE INDEX core_order_provider_ref_uq ON core_order (provider, provider_ref)
  WHERE provider_ref IS NOT NULL;
CREATE UNIQUE INDEX core_order_access_uq ON core_order (access_hash) WHERE access_hash IS NOT NULL;

-- Two payments for one order at the same moment must not both be judged against the same read
-- (the second would be lost, or the order left part paid with nothing owing). Every update of an
-- order's money or state says which version it read; a stale one is refused and can be retried.
CREATE TRIGGER core_order_stale
BEFORE UPDATE OF state, paid, total, deposit, balance_due_at ON core_order
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'core_order_stale');
END;

CREATE TABLE core_order_line (
  -- orl_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES core_order (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  -- What is bought: any record whose object is sellable (the object's registry name and the id).
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The record's title when the order was started, so a line reads the same after a rename.
  title TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  -- Read from the record by the host when the order was started. Never from a caller.
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  line_total INTEGER NOT NULL CHECK (line_total = unit_price * quantity),
  created_at TEXT NOT NULL,
  UNIQUE (order_id, position)
);
CREATE INDEX core_order_line_record_idx ON core_order_line (object_type, record_id);

-- A verified payment the provider reported for an order, once per provider event. The primary
-- key is what makes a redelivered webhook change nothing: a second insert of the same event
-- fails its batch. Only applyVerifiedPayment writes here (orders/payments.ts).
CREATE TABLE core_order_payment (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES core_order (id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  -- applied: it was added to the order. mismatch: the amount or currency was not one the order
  -- could be charged, so nothing moved. late: the order was already closed, so nothing moved.
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'mismatch', 'late')),
  -- The provider's reference for the payment itself (for a refund), when it gave one.
  payment_ref TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
) WITHOUT ROWID;
CREATE INDEX core_order_payment_order_idx ON core_order_payment (order_id, received_at);

-- What list operations and the visibility seam read. The guest token's hash and the provider's
-- reference are not record fields and are not in the view.
CREATE VIEW rec_order AS
SELECT
  id, person_id, email, currency, total, paid, total - paid AS balance, state, pay, deposit,
  balance_due_at, expires_at, placed_as, paid_at, cancelled_at, refunded_at, created_at, updated_at
FROM core_order;

-- A line carries its order's person, so the seam shows a customer the lines of their own orders.
CREATE VIEW rec_order_line AS
SELECT
  l.id, l.order_id, o.person_id, l.position, l.object_type, l.record_id, l.title, l.quantity,
  l.unit_price, l.line_total, l.created_at
FROM core_order_line l
JOIN core_order o ON o.id = l.order_id;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '421'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 421;
