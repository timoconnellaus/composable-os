-- Migration 0532: continuation offers (stage 32a, build step 4, ADRs 0491 and 0492).
--
-- A company moving its subscribers from another platform imports, for each one, an offer: an
-- address (and the one live Person who has it), a plan object and record, and the date the person
-- has already paid up to. The person signs in as that address and subscribes again, free until
-- the date, then charged by the provider. An offer is taken once (the provider's verified event
-- that makes the subscription marks it), expires on its date, and can be withdrawn by staff.
--
-- While a provider page opened from an offer can still be completed, the offer holds it
-- (`checkout_id`). The trigger refuses holding a page for an offer that already holds one, has
-- been taken or was withdrawn: of two takes at once, the second one's whole batch fails, so its
-- page is never handed out. A hold is released (`checkout_id` back to null) only once the
-- provider says the page expired uncompleted, as a trial's is (ADR 0489).
CREATE TABLE core_subscription_offer (
  -- sof_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  -- The plan: any record of an object that declares `sellable.recurring`.
  plan_object TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  -- The address the offer is for. Taking it needs a customer signed in as this address.
  email TEXT NOT NULL CHECK (email = lower(trim(email)) AND email <> ''),
  -- The one live Person who had the address when it was imported (people come in first; an
  -- import never creates one). A merge repoints it. Null after the person is erased.
  person_id TEXT REFERENCES core_person (id) ON DELETE SET NULL,
  -- Free until this moment (the date the person has paid up to elsewhere); charged from then.
  free_until TEXT NOT NULL,
  -- The other platform's reference for the old subscription, as the source gave it.
  reference TEXT,
  imported_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The provider page that holds it while it can be completed (core_subscription_checkout.id).
  checkout_id TEXT,
  checkout_ref TEXT,
  checkout_url TEXT,
  held_until TEXT,
  -- The subscription that took it, once the provider confirmed it. Final.
  subscription_id TEXT,
  taken_at TEXT,
  -- Taken with too little time left for free time at the provider (under 48 hours): charged at
  -- once, never given the plan's trial instead.
  charged_from_start INTEGER NOT NULL DEFAULT 0 CHECK (charged_from_start IN (0, 1)),
  withdrawn_at TEXT,
  withdrawn_by TEXT,
  withdraw_reason TEXT,
  -- A withdrawn offer staff replaced with a fresh one (`reissue`): the new offer's id.
  reissued_as TEXT,
  -- Bumped by exactly one on every change (below): a write made from an older read fails.
  version INTEGER NOT NULL DEFAULT 0
);
-- One offer per address per plan object, the import's key; a withdrawn one stays as it was, and
-- staff may reissue the address a fresh offer beside it.
CREATE UNIQUE INDEX core_subscription_offer_key_uq ON core_subscription_offer (plan_object, email)
  WHERE withdrawn_at IS NULL;
CREATE INDEX core_subscription_offer_person_idx ON core_subscription_offer (person_id, plan_object);

CREATE TRIGGER core_subscription_offer_one_page
BEFORE UPDATE OF checkout_id ON core_subscription_offer
WHEN NEW.checkout_id IS NOT NULL
  AND (OLD.checkout_id IS NOT NULL OR OLD.subscription_id IS NOT NULL OR OLD.withdrawn_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'core_subscription_offer_held');
END;

-- A write made from an older read of the offer fails, and its whole batch (as a subscription's,
-- migration 0530): an import, a withdrawal or a take that read the offer before another change
-- to it commits nothing, and is told to try again.
CREATE TRIGGER core_subscription_offer_stale
BEFORE UPDATE ON core_subscription_offer
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'core_subscription_offer_stale');
END;

-- A checkout opened from an offer names it, so the provider's confirmation marks the offer taken.
ALTER TABLE core_subscription_checkout ADD COLUMN offer_id TEXT;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '532'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 532;
