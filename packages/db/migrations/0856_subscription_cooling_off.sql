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

-- 2. A cooling off asked for (`subscription.coolOff`), one per subscription (ADR 0647's rule):
--
--   asked    open: a valid ask (inside the window) was made at `asked_at`; it stays open until
--            `deadline_at` (asked_at + the approval expiry, 7 days). Asking again retries the
--            provider (`call_outcome`, `ask_count`) and never moves either. While it is open and
--            before its deadline, any end of the subscription is its end
--   ended    the subscription ended while it was open (or staff finished a lapsed one,
--            `finished`): what is owed was written once, by the bounds kept here (`owed_from`,
--            `owed_to`); later events add nothing
--   lapsed   its deadline passed with no end, the gatekeeper action for it was rejected or
--            expired, the end came before the ask or after the deadline, or the member had used
--            theirs: nothing owed as cooled off, admins told; staff may finish it
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
  state TEXT NOT NULL CHECK (state IN ('asked', 'ended', 'lapsed')),
  -- What came of the latest call: sent, pending (at the gatekeeper), unknown, refused, or null
  -- (the Worker stopped between the commit and the call).
  call_outcome TEXT
    CHECK (call_outcome IS NULL OR call_outcome IN ('sent', 'pending', 'unknown', 'refused')),
  -- The valid ask (inside the window) and its fixed deadline; the latest ask (a retry).
  asked_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  last_asked_at TEXT NOT NULL,
  -- Each ask by a person is a new request to the provider (its idempotency key carries this
  -- count); the sweep's retry of one keeps it.
  ask_count INTEGER NOT NULL DEFAULT 1 CHECK (ask_count >= 1),
  -- The host's pending approval of the cancel, while one waits at the gatekeeper.
  pending_action_id TEXT,
  -- When the provider ended it (its read), once `ended` or `lapsed`.
  ended_at TEXT,
  -- Ended by staff finishing a lapsed one; the bounds what is owed was written by.
  finished INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
  owed_from TEXT,
  owed_to TEXT,
  -- Why it lapsed: its deadline, the action turned down, the end's time, or used before.
  lapsed_because TEXT
    CHECK (lapsed_because IS NULL OR lapsed_because IN ('deadline', 'action', 'end_time', 'used')),
  -- When admins were told it is stuck or lapsed: the member is told so only then.
  told_at TEXT,
  -- Bookings ahead still to release (1), how many were, and how often the follow-up failed.
  release_left INTEGER NOT NULL DEFAULT 0 CHECK (release_left IN (0, 1)),
  released_count INTEGER NOT NULL DEFAULT 0 CHECK (released_count >= 0),
  release_stopped INTEGER NOT NULL DEFAULT 0 CHECK (release_stopped IN (0, 1)),
  release_failures INTEGER NOT NULL DEFAULT 0 CHECK (release_failures >= 0),
  -- The member's one summary email of what was cancelled with the membership.
  mail_state TEXT CHECK (mail_state IS NULL
    OR mail_state IN ('due', 'sending', 'sent', 'pending', 'failed')),
  mail_claimed_at TEXT,
  mail_tries INTEGER NOT NULL DEFAULT 0 CHECK (mail_tries >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX core_subscription_cool_off_holder_idx
  ON core_subscription_cool_off (holder_person_id, state);

-- The minute cron: open ones (their answer, their deadline), oldest first.
CREATE INDEX core_subscription_cool_off_open_idx
  ON core_subscription_cool_off (state, updated_at) WHERE state = 'asked';

-- The follow-ups: bookings still to release, and the summary email due or stuck.
CREATE INDEX core_subscription_cool_off_release_idx
  ON core_subscription_cool_off (release_left) WHERE release_left = 1;
CREATE INDEX core_subscription_cool_off_mail_idx
  ON core_subscription_cool_off (mail_state) WHERE mail_state IN ('due', 'sending');

-- 3. One row per subscription for good: an INSERT OR REPLACE over an existing row (which would
--    pass the update triggers by, recursive triggers being off) is refused like a second insert.
CREATE TRIGGER core_subscription_cool_off_one
BEFORE INSERT ON core_subscription_cool_off
WHEN EXISTS (SELECT 1 FROM core_subscription_cool_off WHERE subscription_id = NEW.subscription_id)
BEGIN
  SELECT RAISE(ABORT, 'core_cool_off_exists');
END;

-- 4. Once per member, ever (the owner's decision of 2026-11-24): one ended (or finished) counts;
--    an open, refused or lapsed one does not. The host checks it before it writes an end, so this
--    only catches two ends racing (the loser's batch fails and is applied again, and then lapses
--    as used). A move into `ended` only: a merge moving rows to the survivor (an update of the
--    holder) and an erase (the holder set null) are never refused.
CREATE TRIGGER core_subscription_cool_off_once
BEFORE UPDATE OF state ON core_subscription_cool_off
WHEN NEW.holder_person_id IS NOT NULL AND NEW.state = 'ended' AND OLD.state != 'ended'
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM core_subscription_cool_off
      WHERE holder_person_id = NEW.holder_person_id AND state = 'ended'
        AND subscription_id != NEW.subscription_id)
    THEN RAISE(ABORT, 'core_cool_off_used') END;
END;

-- An ended cooling off is final; a lapsed one only becomes ended (staff finishing it).
CREATE TRIGGER core_subscription_cool_off_final
BEFORE UPDATE OF state ON core_subscription_cool_off
WHEN (OLD.state = 'ended' AND NEW.state != 'ended')
  OR (OLD.state = 'lapsed' AND NEW.state NOT IN ('lapsed', 'ended'))
BEGIN
  SELECT RAISE(ABORT, 'core_cool_off_final');
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '856'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 856;
