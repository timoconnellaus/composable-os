-- Migration 0410: idempotency keys for the HTTP surface (stage 23, ADR 0403, ADR 0416).
--
-- Every write over POST /api/v1/op/<name> carries an Idempotency-Key. A key is the caller's own:
-- its scope is the principal (`staff:<user id>`, `customer:<account id>`, or `public`).
--
-- core_idempotency_key is the record of a write that committed: it is inserted in the write's own
-- D1 batch, so the key and the write commit together or not at all, and a second batch for the
-- same key fails on the primary key and applies nothing. It holds the operation, a hash of the
-- input and the response the caller was sent. A response computed after the commit (an
-- operation that reads its output back) is filled in just after it.
--
-- core_idempotency_claim marks a key whose call is running, so the same key sent twice at once
-- runs the handler once: the second call waits for the first's response. A claim is removed when
-- its call ends; one left by a Worker that died is taken over after a minute.
--
-- Both are purged by the daily maintenance cron 24 hours after they were made. No client address
-- is stored.
CREATE TABLE core_idempotency_key (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  -- SHA-256 of the operation name and the input as sent, in hex.
  input_hash TEXT NOT NULL,
  -- The claim that committed it, so its own call can fill in a late response.
  claim TEXT NOT NULL,
  -- The HTTP status and JSON body the caller was sent; NULL until a late response is filled in.
  status INTEGER,
  response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
) WITHOUT ROWID;
CREATE INDEX core_idempotency_key_created_idx ON core_idempotency_key (created_at);

CREATE TABLE core_idempotency_claim (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  claim TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
) WITHOUT ROWID;
CREATE INDEX core_idempotency_claim_claimed_idx ON core_idempotency_claim (claimed_at);

UPDATE core_meta SET value = '410' WHERE key = 'schema_version';
