-- Registry migration 0798: a sender domain renamed starts unverified (stage 66 step 7, the second
-- review of #526, N4).
--
-- Verifying is the operator's confirmation for one domain. Migration 0797 keeps it from passing to
-- another client; a change of the row's `domain` would carry it to a domain nobody confirmed (a
-- plain `UPDATE … SET domain`, an `UPDATE OR REPLACE` onto another client's domain, or an upsert's
-- `DO UPDATE SET domain`). Each is an UPDATE of `domain`, so one trigger refuses them all unless
-- the row is left unverified.

CREATE TRIGGER registry_sender_domains_rename
BEFORE UPDATE OF domain, verified ON registry_sender_domains
WHEN NEW.domain IS NOT OLD.domain AND NEW.verified <> 0
BEGIN
  SELECT RAISE(ABORT, 'a sender domain renamed starts unverified');
END;
