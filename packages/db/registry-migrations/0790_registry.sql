-- Registry migration 0790: the registry of a host that serves many clients (stage 66 step 3,
-- ADR 0613).
--
-- The registry is the host's own D1 database (the REGISTRY binding), apart from every client's
-- database: it holds no client's records, and no client's database holds anything of it. Only
-- the operator writes it, through `cos` with the account's token (stage 66 step 7). No operation,
-- extension, tool or assistant can read or write it: no client's environment has a way to it.
--
-- These migrations are the registry's own (packages/db/registry-migrations), beside the host's
-- (packages/db/migrations), recorded in `registry_migrations`. They never touch a client's
-- database, and the host's migrations never touch the registry.
--
-- A client id becomes a Durable Object name, part of a hostname and a key prefix, so its shape
-- is checked here as well as in code (`validateClientId`, which also refuses reserved words):
-- 3 to 30 characters, lowercase letters, digits and single hyphens, starting with a letter and
-- not ending with a hyphen.

CREATE TABLE registry_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) WITHOUT ROWID;

-- The version stamp: every write to a table below adds one (the triggers at the end), so a host
-- that holds registry rows in memory reads one row to know whether they are still current.
INSERT INTO registry_meta (key, value) VALUES ('version', 1);

-- One row per client on this deployment. `environment` says which of the client's environments
-- this deployment holds (staging is a second deployment, stage 66 decision 10). `schema_version`
-- is the client database's schema version as the operator's update last saw it: the host refuses
-- a request for a client whose recorded version is behind its code (`isSchemaBehind`).
CREATE TABLE registry_clients (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 3 AND 30
    AND id GLOB '[a-z]*'
    AND id NOT GLOB '*[^a-z0-9-]*'
    AND id NOT GLOB '*-'
    AND id NOT GLOB '*--*'
  ),
  environment TEXT NOT NULL CHECK (environment IN ('live', 'staging')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'moving')),
  tier TEXT NOT NULL CHECK (tier IN ('standard', 'bespoke')),
  -- The repository that may deploy this client (`owner/name`), for a bespoke client.
  repository TEXT CHECK (repository IS NULL OR repository GLOB '?*/?*'),
  -- Where the client's database is created the first time it is reached (a Durable Object
  -- location hint). Null: wherever the first request comes from.
  location_hint TEXT CHECK (
    location_hint IS NULL
    OR location_hint IN ('wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me')
  ),
  schema_version INTEGER CHECK (schema_version IS NULL OR schema_version >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

-- The hostnames a client is reached on, each exactly as a Host header names it once lowercased,
-- with no port and no trailing dot. The host looks a request's hostname up here, exactly: a
-- client is never derived from a hostname, and only a verified hostname reaches a client.
CREATE TABLE registry_hostnames (
  hostname TEXT PRIMARY KEY CHECK (
    length(hostname) BETWEEN 1 AND 253
    AND hostname = lower(hostname)
    AND hostname NOT GLOB '*[^a-z0-9.-]*'
    AND hostname NOT GLOB '.*'
    AND hostname NOT GLOB '*.'
    AND hostname NOT GLOB '*..*'
  ),
  client TEXT NOT NULL REFERENCES registry_clients (id) ON DELETE CASCADE,
  surface TEXT NOT NULL CHECK (surface IN ('staff', 'web', 'desk')),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

CREATE INDEX registry_hostnames_client ON registry_hostnames (client);

-- A client's deploy-time settings, by the env name they stand for (APPROVAL_FLOOR, COS_PACKS,
-- ...). Which names exist, and what a client without a row gets, is `CLIENT_SETTINGS` in
-- packages/db/src/registry.ts; a name that is not there never reaches a client's environment.
CREATE TABLE registry_settings (
  client TEXT NOT NULL REFERENCES registry_clients (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name GLOB '[A-Z]*' AND name NOT GLOB '*[^A-Z0-9_]*'),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client, name)
) WITHOUT ROWID;

-- A client's given secrets (its payment keys, its own sign-in provider, its own AI keys),
-- encrypted under a key only the host's environment holds (stage 66 decision 8). Written only by
-- `cos client secret set` and decrypted only into that client's environment: stage 66 step 6.
-- Auth secrets are derived, never stored here. Nothing reads this table yet.
CREATE TABLE registry_secrets (
  client TEXT NOT NULL REFERENCES registry_clients (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name GLOB '[A-Z]*' AND name NOT GLOB '*[^A-Z0-9_]*'),
  -- AES-GCM: the ciphertext with its tag, the 12-byte nonce, and which key encrypted it.
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL CHECK (length(iv) = 12),
  key_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client, name)
) WITHOUT ROWID;

CREATE TRIGGER registry_clients_stamp_insert AFTER INSERT ON registry_clients
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;

CREATE TRIGGER registry_clients_stamp_update AFTER UPDATE ON registry_clients
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;

CREATE TRIGGER registry_clients_stamp_delete AFTER DELETE ON registry_clients
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;

CREATE TRIGGER registry_hostnames_stamp_insert AFTER INSERT ON registry_hostnames
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;

CREATE TRIGGER registry_hostnames_stamp_update AFTER UPDATE ON registry_hostnames
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;

CREATE TRIGGER registry_hostnames_stamp_delete AFTER DELETE ON registry_hostnames
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;

CREATE TRIGGER registry_settings_stamp_insert AFTER INSERT ON registry_settings
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;

CREATE TRIGGER registry_settings_stamp_update AFTER UPDATE ON registry_settings
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;

CREATE TRIGGER registry_settings_stamp_delete AFTER DELETE ON registry_settings
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;

CREATE TRIGGER registry_secrets_stamp_insert AFTER INSERT ON registry_secrets
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;

CREATE TRIGGER registry_secrets_stamp_update AFTER UPDATE ON registry_secrets
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;

CREATE TRIGGER registry_secrets_stamp_delete AFTER DELETE ON registry_secrets
BEGIN
  UPDATE registry_meta SET value = value + 1 WHERE key = 'version';
END;
