-- Migration 0530: subscriptions (stage 32a, ADRs 0485 to 0487).
--
-- The payment provider runs the schedule: it keeps the card, charges each period, retries and ends
-- the subscription. The host mirrors what the provider's verified events say (core_subscription),
-- and writes a paid order for every paid period (core_order's period columns). Nothing here
-- schedules or charges anything.

-- A subscription checkout the host opened: who it is for, the plan as priced then, and the trial.
-- The subscription itself exists only once the provider's verified event says it does; then
-- core_subscription is made with this row's id (the id the provider carries as metadata).
CREATE TABLE core_subscription_checkout (
  -- sbs_… (ids.ts): the subscription's id to be.
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  -- The provider's checkout reference (a Stripe Checkout Session id).
  ref TEXT NOT NULL,
  -- Who pays (the provider's customer is theirs) and who holds what it grants. The same Person
  -- in 32a; 32b lets them differ (a parent pays for a child, ADR 0487).
  payer_person_id TEXT REFERENCES core_person (id) ON DELETE SET NULL,
  holder_person_id TEXT REFERENCES core_person (id) ON DELETE SET NULL,
  email TEXT CHECK (email IS NULL OR (email = lower(trim(email)) AND email <> '')),
  placed_as TEXT NOT NULL CHECK (placed_as IN ('customer', 'public', 'staff')),
  -- The plan: any record of an object that declares `sellable.recurring`.
  plan_object TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_title TEXT NOT NULL,
  -- One period's price as the host read it from the plan, minor units, tax included.
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  interval TEXT NOT NULL CHECK (interval IN ('week', 'month', 'year')),
  -- The free first period asked for: days, or until a moment (a continuation). At most one.
  trial_days INTEGER CHECK (trial_days IS NULL OR trial_days > 0),
  trial_end TEXT,
  -- The product tax code sent, when tax was asked for (ADR 0479). Null: nothing about tax sent.
  tax_code TEXT,
  -- The provider's subscription it started, once its first verified event arrived.
  subscription_ref TEXT,
  created_at TEXT NOT NULL,
  CHECK (trial_days IS NULL OR trial_end IS NULL)
);
CREATE UNIQUE INDEX core_subscription_checkout_ref_uq ON core_subscription_checkout (provider, ref);
CREATE INDEX core_subscription_checkout_holder_idx
  ON core_subscription_checkout (holder_person_id, plan_object);

CREATE TABLE core_subscription (
  -- sbs_…: the checkout's id.
  id TEXT PRIMARY KEY NOT NULL,
  -- The Person who pays: the provider's customer is theirs; the portal, cancel and resume are
  -- theirs. Null after the person is erased.
  payer_person_id TEXT REFERENCES core_person (id) ON DELETE SET NULL,
  -- The Person who holds what it grants (access, 32b's allowances, the one-trial rule). The payer
  -- in 32a (ADR 0487).
  holder_person_id TEXT REFERENCES core_person (id) ON DELETE SET NULL,
  email TEXT CHECK (email IS NULL OR (email = lower(trim(email)) AND email <> '')),
  placed_as TEXT NOT NULL CHECK (placed_as IN ('customer', 'public', 'staff')),
  plan_object TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  -- The plan's title and price as they were at the start: a period is charged what was agreed.
  plan_title TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  interval TEXT NOT NULL CHECK (interval IN ('week', 'month', 'year')),
  tax_code TEXT,
  -- The provider's state, mirrored: every move is the host's, from a verified event.
  state TEXT NOT NULL DEFAULT 'incomplete'
    CHECK (state IN ('incomplete', 'expired', 'trialing', 'active', 'past_due', 'unpaid', 'paused', 'ended')),
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  customer_ref TEXT,
  trial_end TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  -- Set to end when the current period does (a flag on trialing or active, not a state).
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  -- A date it is set to end on that was set another way (the provider's dashboard or a schedule):
  -- the host's resume does not undo it (ADR 0485).
  cancel_at TEXT,
  canceled_at TEXT,
  ended_at TEXT,
  -- Why it ended or is ending, in the provider's words (cancellation_requested, payment_failed…).
  end_reason TEXT,
  -- The provider's page where the payer confirms a renewal (3D Secure), while one waits.
  action_url TEXT,
  -- When its renewal first failed, while it is failing.
  failing_since TEXT,
  -- The time of the provider read the row was last moved from: an older read changes nothing.
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX core_subscription_provider_ref_uq ON core_subscription (provider, provider_ref);
CREATE INDEX core_subscription_payer_idx ON core_subscription (payer_person_id, created_at);
CREATE INDEX core_subscription_holder_idx ON core_subscription (holder_person_id, plan_object, state);
CREATE INDEX core_subscription_failing_idx ON core_subscription (failing_since)
  WHERE state IN ('past_due', 'unpaid');

-- A write made from an older read of the subscription fails, and its whole batch (as orders).
CREATE TRIGGER core_subscription_stale
BEFORE UPDATE OF state, cancel_at_period_end, current_period_end, observed_at ON core_subscription
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'core_subscription_stale');
END;

CREATE VIEW rec_subscription AS
SELECT
  id, payer_person_id, holder_person_id, email, placed_as, plan_object, plan_id, plan_title,
  amount, currency, interval, tax_code IS NOT NULL AS taxed, state, provider, provider_ref,
  trial_end, current_period_start, current_period_end, cancel_at_period_end, cancel_at, canceled_at,
  ended_at, end_reason, action_url, failing_since, created_at, updated_at
FROM core_subscription;

-- An order per paid period (ADR 0486): the subscription it is for, the period it paid, and the
-- provider's invoice. Null on every other order.
ALTER TABLE core_order ADD COLUMN subscription_id TEXT REFERENCES core_subscription (id) ON DELETE SET NULL;
ALTER TABLE core_order ADD COLUMN period_start TEXT;
ALTER TABLE core_order ADD COLUMN period_end TEXT;
ALTER TABLE core_order ADD COLUMN invoice_ref TEXT;
-- A period paid other than as agreed, recorded for what was actually paid and flagged for staff:
-- less (a coupon, the customer's balance), more, or on terms (currency, interval, price) that are
-- not the subscription's. Null: paid as agreed.
ALTER TABLE core_order ADD COLUMN period_flag TEXT
  CHECK (period_flag IS NULL OR period_flag IN ('paid_less', 'paid_more', 'not_as_agreed'));
-- One order per invoice, whichever event or delivery reports it paid.
CREATE UNIQUE INDEX core_order_invoice_uq ON core_order (provider, invoice_ref)
  WHERE invoice_ref IS NOT NULL;
CREATE INDEX core_order_subscription_idx ON core_order (subscription_id, period_start)
  WHERE subscription_id IS NOT NULL;

-- The invoice a payment paid, so its refund is credited on that invoice.
ALTER TABLE core_order_payment ADD COLUMN invoice_ref TEXT;

-- A credit note's tax that arrived before its refund's confirmation waits on the refund asked
-- for (ADR 0486), and is applied when the confirmation comes.
ALTER TABLE core_order_refund ADD COLUMN reported_tax INTEGER CHECK (reported_tax IS NULL OR reported_tax >= 0);

-- core_payment_event gains the kind `subscription`: SQLite cannot change a CHECK, so the table is
-- rebuilt, its rows kept.
CREATE TABLE core_payment_event_new (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'subscription')),
  connection_id TEXT,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied_at TEXT,
  outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, event_id)
) WITHOUT ROWID;
INSERT INTO core_payment_event_new
  (provider, event_id, kind, connection_id, payload, received_at, applied_at, outcome, attempts)
SELECT provider, event_id, kind, connection_id, payload, received_at, applied_at, outcome, attempts
FROM core_payment_event;
DROP TABLE core_payment_event;
ALTER TABLE core_payment_event_new RENAME TO core_payment_event;
CREATE INDEX core_payment_event_unapplied_idx ON core_payment_event (received_at)
  WHERE applied_at IS NULL;

DROP VIEW rec_order;
CREATE VIEW rec_order AS
SELECT
  id, person_id, email, currency, total, paid, total - paid AS balance, refunded, state, pay,
  deposit, balance_due_at, expires_at, placed_as, paid_at, cancelled_at, refunded_at, created_at,
  updated_at, tax_amount, tax_refunded, tax_country,
  (paid - refunded) - (tax_amount - tax_refunded) AS net,
  subscription_id, period_start, period_end, period_flag
FROM core_order;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '530'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 530;
