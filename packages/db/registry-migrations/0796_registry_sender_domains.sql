-- Registry migration 0796: each client's own sender domains (stage 66, email sending per client;
-- ADR 0616, its note of 2026-11-27 "Email sending per client").
--
-- On a host of many clients the email-send gatekeeper sends a client's mail only from that
-- client's verified sender domains, never from the deployment's ALLOWED_SENDER_DOMAINS, which
-- would let one client send as another. They are here, apart from the client's settings, so that
-- the registry itself holds the rule that a domain belongs to at most one client: the domain is
-- the primary key, and a domain under or over another client's (`mail.gym-a.example` beside
-- `gym-a.example`) is refused by the triggers below. Each registry is one deployment's, so one
-- environment's (staging is a second deployment, ADR 0613): staging and live each hold their own
-- rows, so a domain belongs to at most one client per environment.
--
-- `verified` means the operator has checked that the domain is onboarded to Email Sending in the
-- deployment's Cloudflare account and its sending records are in place (Cloudflare adds them on
-- the zone, which must be on Cloudflare DNS in that account). Only a verified domain reaches a
-- client's environment (`COS_SENDER_DOMAINS`); an unverified one is held, never used. A domain is
-- written unverified and verified afterwards; unverifying it stops the client's sends from it at
-- the host's next stamp check.
--
-- The domain's shape is a hostname's (migration 0790); the code refuses what this cannot say and
-- reports it (`readRegistry`). Only the operator writes this table (`registry-senders.ts`).

CREATE TABLE registry_sender_domains (
  domain TEXT PRIMARY KEY CHECK (
    length(domain) BETWEEN 1 AND 253
    AND domain = lower(domain)
    AND domain GLOB '*?.?*'
    AND domain NOT GLOB '*[^a-z0-9.-]*'
    AND domain NOT GLOB '.*'
    AND domain NOT GLOB '*.'
    AND domain NOT GLOB '*..*'
    AND domain NOT GLOB '-*'
    AND domain NOT GLOB '*-'
    AND domain NOT GLOB '*.-*'
    AND domain NOT GLOB '*-.*'
    AND domain NOT GLOB '*.[0-9]'
    AND domain NOT GLOB '*.[0-9][0-9]'
    AND domain NOT GLOB '*.[0-9][0-9][0-9]'
  ),
  client TEXT NOT NULL REFERENCES registry_clients (id) ON DELETE CASCADE,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  -- When the operator last verified it; null while unverified.
  verified_at TEXT CHECK ((verified = 1) = (verified_at IS NOT NULL)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

CREATE INDEX registry_sender_domains_client ON registry_sender_domains (client);

-- A domain under or over another client's is refused: whoever holds a domain's DNS holds its
-- subdomains', so two clients never share one tree. (A domain holds only a-z, 0-9, `.` and `-`,
-- so LIKE has no wildcard to misread in it.)
CREATE TRIGGER registry_sender_domains_one_tree_insert
BEFORE INSERT ON registry_sender_domains
WHEN EXISTS (
  SELECT 1 FROM registry_sender_domains
  WHERE client <> NEW.client
    AND (NEW.domain LIKE '%.' || domain OR domain LIKE '%.' || NEW.domain)
)
BEGIN
  SELECT RAISE(ABORT, 'a sender domain under or over another client''s is refused');
END;

CREATE TRIGGER registry_sender_domains_one_tree_update
BEFORE UPDATE OF domain, client ON registry_sender_domains
WHEN EXISTS (
  SELECT 1 FROM registry_sender_domains
  WHERE client <> NEW.client
    AND domain <> OLD.domain
    AND (NEW.domain LIKE '%.' || domain OR domain LIKE '%.' || NEW.domain)
)
BEGIN
  SELECT RAISE(ABORT, 'a sender domain under or over another client''s is refused');
END;

CREATE TRIGGER registry_sender_domains_stamp_insert AFTER INSERT ON registry_sender_domains
BEGIN
  UPDATE registry_meta SET value = value + 1, nonce = lower(hex(randomblob(8)))
  WHERE key = 'version';
END;

CREATE TRIGGER registry_sender_domains_stamp_update AFTER UPDATE ON registry_sender_domains
BEGIN
  UPDATE registry_meta SET value = value + 1, nonce = lower(hex(randomblob(8)))
  WHERE key = 'version';
END;

CREATE TRIGGER registry_sender_domains_stamp_delete AFTER DELETE ON registry_sender_domains
BEGIN
  UPDATE registry_meta SET value = value + 1, nonce = lower(hex(randomblob(8)))
  WHERE key = 'version';
END;
