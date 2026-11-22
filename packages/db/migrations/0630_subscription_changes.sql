-- Migration 0630: plan changes and pauses of a subscription (stage 32b, ADRs 0530 and 0531).
--
-- A change the host asked the provider for: a plan change (an upgrade now, a downgrade from the
-- next period) or a pause (from now or a moment, until a moment). The provider runs it; this row is
-- what the host asked, so a verified read that shows it can be told from a change made at the
-- provider some other way, and so the member's terms follow the plan only from a read that shows
-- the change. Nothing here moves the subscription: its state is the provider's, mirrored.
--
--   requested  asked of the provider (written before the call is made, after the operation's
--              batch claims the subscription's one open change); not yet in a verified read
--   waiting    a downgrade the provider shows (its price is the new one), whose terms follow when
--              the next period starts (`effective_at`, the period end of the read that showed it)
--   applied    the member holds the new plan (a change), or the pause is running or over
--   lapsed     past `expires_at` and never shown by the provider (an upgrade's pending update
--              expires within 23 hours), or the provider refused the call outright
--   withdrawn  closed by staff (`subscription.change.withdraw`, `subscription.unpause` of a pause
--              not started), or a waiting downgrade the provider no longer shows (its price put back)
--
-- One definition of "open": state requested or waiting and `expires_at` still ahead. Every reader
-- (the host's TypeScript and this view) uses it; a row found past it is closed as lapsed.
CREATE TABLE core_subscription_change (
  -- sbc_… (ids.ts); the provider's idempotency key for the call.
  id TEXT PRIMARY KEY NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES core_subscription (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('upgrade', 'downgrade', 'pause')),
  state TEXT NOT NULL CHECK (state IN ('requested', 'waiting', 'applied', 'lapsed', 'withdrawn')),
  -- The plan held when it was asked, and the plan asked for (a change; null for a pause).
  from_plan_id TEXT NOT NULL,
  from_plan_title TEXT NOT NULL,
  from_amount INTEGER NOT NULL CHECK (from_amount > 0),
  to_plan_id TEXT,
  to_plan_title TEXT,
  to_amount INTEGER CHECK (to_amount IS NULL OR to_amount > 0),
  -- A pause's window: from (null: now) and until, as asked.
  pause_from TEXT,
  pause_until TEXT,
  -- When the member's terms follow a change: the period's end for a downgrade, the moment the
  -- provider showed it for an upgrade.
  effective_at TEXT,
  -- When an open change stops being trusted, never shown by the provider: a day after it was
  -- asked (a pause: a day after it was due to start), a week after a waiting downgrade's period end.
  expires_at TEXT NOT NULL,
  -- What came of the host's call to the provider: sent (applied at the gatekeeper), pending (waiting
  -- for approval), unknown (it may or may not have reached the provider: verified reads decide),
  -- refused (it did not). Null until the call returns.
  call_outcome TEXT CHECK (call_outcome IS NULL OR call_outcome IN ('sent', 'pending', 'unknown', 'refused')),
  call_error TEXT,
  -- The provider's page to confirm an upgrade's charge (3D Secure), while it waits.
  action_url TEXT,
  -- The call that ends or undoes it: ending a pause early, putting a withdrawn downgrade's price back.
  end_outcome TEXT CHECK (end_outcome IS NULL OR end_outcome IN ('sent', 'pending', 'unknown', 'refused')),
  end_error TEXT,
  end_at TEXT,
  reason TEXT NOT NULL,
  -- Who asked: `staff:<user id>` or `customer:<customer id>`.
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  applied_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'pause') = (to_plan_id IS NULL)),
  CHECK (kind <> 'pause' OR pause_until IS NOT NULL)
);
-- One open change per subscription: two asked at once, the second's whole batch fails, so the
-- provider is asked once.
CREATE UNIQUE INDEX core_subscription_change_open_uq ON core_subscription_change (subscription_id)
  WHERE state IN ('requested', 'waiting');
CREATE INDEX core_subscription_change_subscription_idx
  ON core_subscription_change (subscription_id, requested_at);

CREATE VIEW rec_subscription_change AS
SELECT
  id, subscription_id, kind, state, from_plan_id, from_plan_title, from_amount, to_plan_id,
  to_plan_title, to_amount, pause_from, pause_until, effective_at, expires_at, call_outcome,
  end_outcome, reason, requested_at,
  applied_at
FROM core_subscription_change;

-- The subscription as the seam reads it gains the change it shows: its open change (asked, or a
-- downgrade waiting for its period, or a pause not yet started), or the pause it is in while
-- paused. An upgrade asked over a day ago and never shown by the provider reads `lapsed`.
DROP VIEW rec_subscription;
CREATE VIEW rec_subscription AS
SELECT
  s.id, s.payer_person_id, s.holder_person_id, s.email, s.placed_as, s.plan_object, s.plan_id,
  s.plan_title, s.amount, s.currency, s.interval, s.tax_code IS NOT NULL AS taxed, s.state,
  s.provider, s.provider_ref, s.trial_end, s.current_period_start, s.current_period_end,
  s.cancel_at_period_end, s.cancel_at, s.canceled_at, s.ended_at, s.end_reason, s.action_url,
  s.failing_since, s.created_at, s.updated_at,
  c.id AS change_id,
  c.kind AS change_kind,
  CASE
    WHEN c.state IN ('requested', 'waiting')
      AND c.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 'lapsed'
    ELSE c.state
  END AS change_state,
  c.call_outcome AS change_call_outcome,
  c.action_url AS change_action_url,
  c.end_outcome AS change_end_outcome,
  c.to_plan_id AS change_to_plan_id,
  c.to_plan_title AS change_to_plan_title,
  c.to_amount AS change_to_amount,
  c.pause_from AS pause_from,
  c.pause_until AS pause_until,
  c.effective_at AS change_effective_at,
  c.requested_at AS change_requested_at
FROM core_subscription s
LEFT JOIN core_subscription_change c ON c.id = (
  SELECT x.id FROM core_subscription_change x
  WHERE x.subscription_id = s.id
    AND (x.state IN ('requested', 'waiting')
      OR (x.kind = 'pause' AND x.state = 'applied' AND s.state = 'paused'))
  ORDER BY x.state IN ('requested', 'waiting') DESC, x.requested_at DESC
  LIMIT 1
);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '630'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 630;
