-- Migration 0422: checkouts, verified payment events, refunds and late payments (stage 25, the
-- gatekeeper half; ADR 0429).
--
-- The payments gatekeeper verifies the provider's webhook and hands each verified event to the
-- host's own adapter, which stores it here (core_payment_event) before anything reads it. The
-- operation that applies an event (order.applyPaymentEvent) takes only an event's key and reads the
-- event from this table: nothing a caller sends can stand in for the provider's word. Nothing here
-- holds a card number, and no column could: paying happens on the provider's own page.

-- A checkout the host opened on the provider's page for an order: what it was for and how much.
-- A webhook finds its order by the provider's reference here.
CREATE TABLE core_order_checkout (
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES core_order (id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  -- What the payment was to be: the whole price, the deposit, the whole balance or a part of it.
  kind TEXT NOT NULL CHECK (kind IN ('full', 'deposit', 'balance', 'part')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, ref)
) WITHOUT ROWID;
CREATE INDEX core_order_checkout_order_idx ON core_order_checkout (order_id, created_at);

-- A verified event as the gatekeeper delivered it: a payment or a refund the provider confirmed.
-- Written only by the host's adapter (recordPaymentEvent), never by an operation. `payload` holds
-- ids, amounts and the currency: never a person's details, never card data.
CREATE TABLE core_payment_event (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'refund')),
  connection_id TEXT,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  -- Set once order.applyPaymentEvent has applied it (whatever the outcome).
  applied_at TEXT,
  outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, event_id)
) WITHOUT ROWID;
-- The minute cron applies any event its first delivery did not.
CREATE INDEX core_payment_event_unapplied_idx ON core_payment_event (received_at)
  WHERE applied_at IS NULL;

-- A refund: asked for by staff (requested, with the outbound action a person approves) and then
-- confirmed by the provider's webhook (confirmed). A refund made at the provider directly arrives
-- confirmed with no request. An order's `refunded` is the sum of its confirmed refunds.
CREATE TABLE core_order_refund (
  -- rfd_… (ids.ts). Sent to the provider as the refund's metadata and idempotency key.
  id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES core_order (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  -- The provider's reference of the payment the money goes back to.
  payment_ref TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  -- Staff's words. Cleared when the order's person is erased.
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'confirmed')),
  -- The outbound action (core_pending_action) a person approves, for a requested refund.
  pending_action_id TEXT,
  requested_by TEXT,
  requested_at TEXT,
  provider_refund_ref TEXT,
  event_id TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX core_order_refund_order_idx ON core_order_refund (order_id, created_at);
-- A refund the provider reports twice (created, then updated) is counted once.
CREATE UNIQUE INDEX core_order_refund_provider_uq ON core_order_refund (provider, provider_refund_ref)
  WHERE provider_refund_ref IS NOT NULL;

-- What has gone back to the buyer, in minor units: the sum of the confirmed refunds.
ALTER TABLE core_order ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0 CHECK (refunded >= 0);
-- The confirmation email's own link to the order (the SHA-256 of a token minted when it is sent),
-- beside the token a guest was given at the start. Either opens this one order.
ALTER TABLE core_order ADD COLUMN email_link_hash TEXT;
CREATE UNIQUE INDEX core_order_email_link_uq ON core_order (email_link_hash)
  WHERE email_link_hash IS NOT NULL;

-- The version check covers what has been refunded too.
DROP TRIGGER core_order_stale;
CREATE TRIGGER core_order_stale
BEFORE UPDATE OF state, paid, refunded, total, deposit, balance_due_at ON core_order
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'core_order_stale');
END;

-- A late payment (outcome 'late') stays on the paid-late list until staff honour it or it is
-- refunded.
ALTER TABLE core_order_payment ADD COLUMN resolved TEXT
  CHECK (resolved IS NULL OR resolved IN ('honoured', 'refunded'));
ALTER TABLE core_order_payment ADD COLUMN resolved_at TEXT;
CREATE INDEX core_order_payment_late_idx ON core_order_payment (received_at)
  WHERE outcome = 'late' AND resolved IS NULL;

DROP VIEW rec_order;
CREATE VIEW rec_order AS
SELECT
  id, person_id, email, currency, total, paid, total - paid AS balance, refunded, state, pay,
  deposit, balance_due_at, expires_at, placed_as, paid_at, cancelled_at, refunded_at, created_at,
  updated_at
FROM core_order;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '422'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 422;
