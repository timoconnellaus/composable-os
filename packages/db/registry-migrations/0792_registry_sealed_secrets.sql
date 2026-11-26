-- Registry migration 0792: given secrets sealed to the host's public key, and a secret generation
-- per client (stage 66 step 6, ADR 0616).
--
-- 1. `registry_secrets` is rebuilt for HPKE (RFC 9180, base mode, DHKEM(X25519, HKDF-SHA256),
--    HKDF-SHA256, AES-256-GCM): the operator's command seals each value to the host's public key,
--    so only the host's environment, which holds the private key, can open it. A row holds the
--    encapsulated key (`enc`, 32 bytes) beside the ciphertext and the public key's id. Nothing has
--    ever written the table of migration 0790 (its writer is stage 66 step 7), so it is dropped
--    and made again rather than converted.
--    `kind` says how a row came: `given` (a secret the client supplies: only the names of
--    `GIVEN_SECRET_NAMES`) or `imported` (a derivable secret of a deployment imported as a client,
--    which overrides derivation for that client: only the names of `DERIVED_SECRETS`). The kind
--    is sealed into the value too, so a row cannot be relabelled.
-- 2. `registry_clients.secret_generation`: a random value written once when a client is added and
--    never changed, bound into every derived secret of the client, so a removed and re-added
--    client id never gets the secrets it had before.

DROP TRIGGER registry_secrets_stamp_insert;
DROP TRIGGER registry_secrets_stamp_update;
DROP TRIGGER registry_secrets_stamp_delete;
DROP TABLE registry_secrets;

CREATE TABLE registry_secrets (
  client TEXT NOT NULL REFERENCES registry_clients (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name GLOB '[A-Z]*' AND name NOT GLOB '*[^A-Z0-9_]*'),
  kind TEXT NOT NULL CHECK (kind IN ('given', 'imported')),
  -- HPKE's encapsulated key: the sender's ephemeral X25519 public key.
  enc BLOB NOT NULL CHECK (length(enc) = 32),
  -- The AES-256-GCM ciphertext with its 16-byte tag.
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) >= 17),
  -- Which public key it was sealed to: `k2-` and 16 hex characters of the key's SHA-256.
  key_id TEXT NOT NULL CHECK (
    length(key_id) = 19 AND key_id GLOB 'k2-*' AND substr(key_id, 4) NOT GLOB '*[^0-9a-f]*'
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client, name)
) WITHOUT ROWID;

CREATE TRIGGER registry_secrets_stamp_insert AFTER INSERT ON registry_secrets
BEGIN
  UPDATE registry_meta SET value = value + 1, nonce = lower(hex(randomblob(8)))
  WHERE key = 'version';
END;

CREATE TRIGGER registry_secrets_stamp_update AFTER UPDATE ON registry_secrets
BEGIN
  UPDATE registry_meta SET value = value + 1, nonce = lower(hex(randomblob(8)))
  WHERE key = 'version';
END;

CREATE TRIGGER registry_secrets_stamp_delete AFTER DELETE ON registry_secrets
BEGIN
  UPDATE registry_meta SET value = value + 1, nonce = lower(hex(randomblob(8)))
  WHERE key = 'version';
END;

ALTER TABLE registry_clients ADD COLUMN secret_generation TEXT CHECK (
  secret_generation IS NULL
  OR (length(secret_generation) = 32 AND secret_generation NOT GLOB '*[^0-9a-f]*')
);

UPDATE registry_clients SET secret_generation = lower(hex(randomblob(16)))
WHERE secret_generation IS NULL;

-- Written once, by the registry itself, when a client is added without one.
CREATE TRIGGER registry_clients_secret_generation AFTER INSERT ON registry_clients
WHEN NEW.secret_generation IS NULL
BEGIN
  UPDATE registry_clients SET secret_generation = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;

-- Never changed or cleared once written: changing it would end every session, card, PIN, app
-- code and desk enrolment of the client.
CREATE TRIGGER registry_clients_secret_generation_fixed
BEFORE UPDATE OF secret_generation ON registry_clients
WHEN OLD.secret_generation IS NOT NULL
  AND (NEW.secret_generation IS NULL OR NEW.secret_generation <> OLD.secret_generation)
BEGIN
  SELECT RAISE(ABORT, 'a client''s secret generation never changes');
END;
