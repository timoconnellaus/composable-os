-- Migration 0856: cooling off (stage 44 step 7, decision 11, ADR 0647).
--
-- A business may set a cooling-off period (whole days, 0 off): a new member may end their
-- membership within it for a full refund of what they paid, which still waits for a person with
-- `orders:refund` like every refund (ADR 0429). The days are the business's setting, declared by
-- the pack that sells the plan (`sellable.recurring.coolingOff`); the platform says nothing of
-- what any law requires.
--
-- 1. The days in force when the subscription was started (`subscription.start`), kept on its
--    checkout: they are the subscription's days for good. A setting changed later, shorter or
--    longer, applies only to subscriptions started after it. Null: started before this migration
--    (0 days), or a plan that has no cooling off.
ALTER TABLE core_subscription_checkout ADD COLUMN cooling_off_days INTEGER
  CHECK (cooling_off_days IS NULL OR cooling_off_days >= 0);

-- 2. A cooling off asked for (`subscription.coolOff`), one per subscription: written in the
--    operation's batch before the payment provider is asked to end the subscription now (the call
--    is made after the commit, so a retry finds this row and asks again rather than starting
--    over). In the batch of the provider's verified event that shows the subscription ended, the
--    host writes a refund owed (core_sellable_refund_due) for every paid order of the
--    subscription, in full, and marks this row `ended`; an order paid on it later is owed back
--    the same way.
--
--   asked     the provider was (or is about to be) asked to end it now; `call_outcome` says
--             what came of the call: sent, pending (an approval at the gatekeeper), unknown (it
--             may or may not have reached the provider), or null (the Worker stopped between the
--             commit and the call). A null or unknown one is resolved by the minute cron's sweep
--             (it reads the provider, and asks again while the window is open)
--   refused   the provider refused the call: nothing ended. Asked again by the member while the
--             window is open, after it by staff only
--   ended     the provider ended it, within a short time of the last ask: the refunds are owed,
--             for what was paid up to the window's end and between that ask and the end
--   lapsed    it ended some other way (an ordinary cancel, failed payments, months later):
--             nothing is owed as cooled off, and admins are told
--
-- No address, name or free text: the holder is held only so a person cools off once (below), and
-- goes with them on erase (the foreign key) or to the survivor on a merge.
CREATE TABLE core_subscription_cool_off (
  subscription_id TEXT PRIMARY KEY NOT NULL
    REFERENCES core_subscription (id) ON DELETE CASCADE,
  holder_person_id TEXT REFERENCES core_person (id) ON DELETE SET NULL,
  -- Who asked: the payer themselves (a member, a guardian paying for a child) or staff.
  asked_by TEXT NOT NULL CHECK (asked_by IN ('payer', 'staff')),
  -- The staff account that asked (never a customer's id).
  asked_by_user TEXT,
  -- The days that applied and the moment the window closed (the end of the last local day).
  days INTEGER NOT NULL CHECK (days > 0),
  window_ends_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('asked', 'refused', 'ended', 'lapsed')),
  call_outcome TEXT CHECK (call_outcome IS NULL OR call_outcome IN ('sent', 'pending', 'unknown')),
  -- The first ask (inside the window), and the latest (a retry, or staff finishing it).
  asked_at TEXT NOT NULL,
  last_asked_at TEXT NOT NULL,
  -- When the provider ended it (its read), once `ended` or `lapsed`.
  ended_at TEXT,
  -- When admins were told it is stuck (refused, unanswered): the member's screen says so only then.
  told_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX core_subscription_cool_off_holder_idx
  ON core_subscription_cool_off (holder_person_id);

-- The minute cron's sweep: asks whose answer was lost or never made, oldest first.
CREATE INDEX core_subscription_cool_off_sweep_idx
  ON core_subscription_cool_off (state, told_at, updated_at);

-- 3. Once per person (the coordinator's conservative reading of a spec that is silent on it):
--    a holder who has cooled off one membership here cannot cool off another (subscribe, use the
--    classes, cool off, repeat). Held by the database for every writer: a second row for the same
--    holder, or a refused one asked again, aborts the batch while another counts. Insert and a
--    move out of `refused` only: a merge moving rows to the survivor (an update of the holder)
--    and an erase (the holder set null) are never refused, so nobody is made un-mergeable or
--    un-erasable.
CREATE TRIGGER core_subscription_cool_off_once
BEFORE INSERT ON core_subscription_cool_off
WHEN NEW.holder_person_id IS NOT NULL AND NEW.state = 'asked'
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM core_subscription_cool_off
      WHERE holder_person_id = NEW.holder_person_id AND state IN ('asked', 'ended')
        AND subscription_id != NEW.subscription_id)
    THEN RAISE(ABORT, 'core_cool_off_used') END;
END;

CREATE TRIGGER core_subscription_cool_off_once_again
BEFORE UPDATE OF state ON core_subscription_cool_off
WHEN NEW.holder_person_id IS NOT NULL AND OLD.state = 'refused' AND NEW.state = 'asked'
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM core_subscription_cool_off
      WHERE holder_person_id = NEW.holder_person_id AND state IN ('asked', 'ended')
        AND subscription_id != NEW.subscription_id)
    THEN RAISE(ABORT, 'core_cool_off_used') END;
END;

-- An ended or lapsed cooling off is final.
CREATE TRIGGER core_subscription_cool_off_final
BEFORE UPDATE OF state ON core_subscription_cool_off
WHEN OLD.state IN ('ended', 'lapsed') AND NEW.state != OLD.state
BEGIN
  SELECT RAISE(ABORT, 'core_cool_off_final');
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '856'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 856;
