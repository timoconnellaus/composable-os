-- Migration 0531: one free trial per Person per plan object (stage 32a, build step 3, ADR 0489).
--
-- A trial is given only to a holder whose identity is proved (a signed-in customer starting their
-- own subscription, or staff starting one for a Person): a guest who only typed an address never
-- gets one, so nobody can spend someone else's trial or learn whether they had one.
--
-- Each checkout the host opens with a trial holds the holder's trial for that plan object while
-- the provider's page can still be completed (`held_until`). The trial is used once the provider
-- confirms a subscription with a trial on it (`used_at`, in the verified event's batch). A hold
-- that lapses unused gives the trial back. The trigger refuses a second hold while one is live or
-- the trial is used, so two starts at once give one trial: the second start's whole batch fails.
CREATE TABLE core_subscription_trial (
  -- The checkout that holds it (core_subscription_checkout.id, the subscription's id to be).
  checkout_id TEXT PRIMARY KEY NOT NULL
    REFERENCES core_subscription_checkout (id) ON DELETE CASCADE,
  holder_person_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  -- The plan object the trial is for: one trial per Person across every record of it.
  plan_object TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  -- The provider's page, so the same holder starting again while it is open gets the same page.
  url TEXT NOT NULL,
  -- Until when the page can still be completed and its confirmation arrive.
  held_until TEXT NOT NULL,
  -- When the provider confirmed a subscription with this trial: from then on it is used for good.
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX core_subscription_trial_holder_idx
  ON core_subscription_trial (holder_person_id, plan_object);

CREATE TRIGGER core_subscription_trial_one
BEFORE INSERT ON core_subscription_trial
WHEN EXISTS (
  SELECT 1 FROM core_subscription_trial t
  WHERE t.holder_person_id = NEW.holder_person_id
    AND t.plan_object = NEW.plan_object
    AND (t.used_at IS NOT NULL OR t.held_until > NEW.created_at)
)
BEGIN
  SELECT RAISE(ABORT, 'core_subscription_trial_taken');
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '531'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 531;
