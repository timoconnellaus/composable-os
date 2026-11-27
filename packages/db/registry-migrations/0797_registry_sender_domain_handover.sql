-- Registry migration 0797: a sender domain never passes to another client still verified (stage
-- 66 step 7; issue #529, F1).
--
-- Verifying a domain is the operator's confirmation that it is onboarded for sending, for the
-- client it was verified for. An `UPDATE … SET client`, an upsert that changes the client, or an
-- `INSERT OR REPLACE` that puts the domain under another client would hand that confirmation over
-- with it: the new client could send as the domain at once. So a change of client must leave the
-- domain unverified, and a domain another client holds cannot be written verified for this one.

CREATE TRIGGER registry_sender_domains_handover_update
BEFORE UPDATE OF client, verified ON registry_sender_domains
WHEN NEW.client IS NOT OLD.client AND NEW.verified <> 0
BEGIN
  SELECT RAISE(ABORT, 'a sender domain given to another client starts unverified');
END;

-- `INSERT OR REPLACE` deletes the old row without its DELETE triggers and inserts the new one: a
-- BEFORE INSERT trigger runs before the conflict is resolved, so this sees the row it would replace.
CREATE TRIGGER registry_sender_domains_handover_insert
BEFORE INSERT ON registry_sender_domains
WHEN NEW.verified <> 0
  AND EXISTS (
    SELECT 1 FROM registry_sender_domains WHERE domain = NEW.domain AND client <> NEW.client
  )
BEGIN
  SELECT RAISE(ABORT, 'a sender domain given to another client starts unverified');
END;
