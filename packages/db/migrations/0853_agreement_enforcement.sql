-- Migration 0853: a guest's acceptances settle with what they paid for, and go with what they
-- did not (stage 44 step 3, ADR 0644). (0852 is reserved for another build's core_write_guard
-- remake; nothing here touches that table.)
--
-- A visitor buying without an account carries their acceptances in the buying call: the host
-- records them with the order (or the subscription checkout) and no Person (migration 0851's
-- insert trigger requires it). They become a Person's only when the purchase is real, and never
-- by the address alone, which anyone may type:
--   - an order: once something has been paid on it and it has a Person. That is the verified
--     payment's batch (the payment sets `paid`; a guest's drop-in gets its Person there too), or
--     `order.setPerson`'s when the address matched several People;
--   - a subscription checkout: once the provider's verified event made its subscription (the
--     host sets `subscription_ref` in that batch). Participant documents go to the holder, payer
--     documents to the payer (for a guest the same Person).
-- An order that closes with nothing paid (expired, or cancelled) deletes its guest acceptances,
-- their signatures and answers in the same statement: no contract was made, and they are nobody's
-- personal data to keep. Triggers, so every writer and every path does it in the batch that makes
-- it true, whatever order the host queues its statements in. Migration 0851's acceptance
-- triggers still judge each update and delete: a Person only from the order or the checkout, a
-- delete only of a guest's with no Person.

CREATE TRIGGER core_agreement_guest_settle_order
AFTER UPDATE OF paid, person_id ON core_order
WHEN NEW.person_id IS NOT NULL AND NEW.paid > 0
BEGIN
  UPDATE core_agreement_acceptance SET person_id = NEW.person_id
  WHERE order_id = NEW.id AND by = 'guest' AND person_id IS NULL AND erased_at IS NULL;
END;

CREATE TRIGGER core_agreement_guest_unpaid
AFTER UPDATE OF state ON core_order
WHEN NEW.state IN ('expired', 'cancelled') AND NEW.paid = 0
BEGIN
  DELETE FROM core_agreement_answer WHERE acceptance_id IN (
    SELECT id FROM core_agreement_acceptance
    WHERE order_id = NEW.id AND by = 'guest' AND person_id IS NULL AND erased_at IS NULL);
  DELETE FROM core_agreement_signature WHERE acceptance_id IN (
    SELECT id FROM core_agreement_acceptance
    WHERE order_id = NEW.id AND by = 'guest' AND person_id IS NULL AND erased_at IS NULL);
  DELETE FROM core_agreement_acceptance
  WHERE order_id = NEW.id AND by = 'guest' AND person_id IS NULL AND erased_at IS NULL;
END;

CREATE TRIGGER core_agreement_guest_settle_subscription
AFTER UPDATE OF subscription_ref ON core_subscription_checkout
WHEN NEW.subscription_ref IS NOT NULL
BEGIN
  UPDATE core_agreement_acceptance SET person_id = CASE (
      SELECT v.who FROM core_agreement_version v
      WHERE v.id = core_agreement_acceptance.version_id)
    WHEN 'payer' THEN NEW.payer_person_id ELSE NEW.holder_person_id END
  WHERE subscription_checkout = NEW.id AND by = 'guest' AND person_id IS NULL
    AND erased_at IS NULL;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '853'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 853;
