-- Registry migration 0793: imported secrets only for a client imported as one, and a secret
-- generation only the registry writes (stage 66 step 6, ADR 0616; the second review of PR #513,
-- S4 and M5).
--
-- 1. `registry_clients.imported`: set when the client is added (`cos client import` of an
--    existing single-client deployment, stage 66 step 7) and never changed. Only such a client's
--    `imported` rows in `registry_secrets` are ever written or honoured, so pinning a known auth
--    secret on an existing client is not possible after the fact: base-mode HPKE has no sender
--    authentication, so the seal alone would not stop it. The client drops its overrides by
--    removing those rows (`dropImportedSecrets`), after which its secrets are derived.
-- 2. `secret_generation` is the registry's own: an INSERT that supplies one is refused, so a
--    removed client id can never be added back with the generation (and so the secrets) it had.

ALTER TABLE registry_clients ADD COLUMN imported INTEGER NOT NULL DEFAULT 0
  CHECK (imported IN (0, 1));

CREATE TRIGGER registry_clients_imported_fixed
BEFORE UPDATE OF imported ON registry_clients
WHEN NEW.imported <> OLD.imported
BEGIN
  SELECT RAISE(ABORT, 'whether a client was imported is set when it is added, never changed');
END;

CREATE TRIGGER registry_clients_secret_generation_ours
BEFORE INSERT ON registry_clients
WHEN NEW.secret_generation IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a client''s secret generation is written by the registry, never supplied');
END;

CREATE TRIGGER registry_secrets_imported_insert
BEFORE INSERT ON registry_secrets
WHEN NEW.kind = 'imported'
  AND NOT EXISTS (SELECT 1 FROM registry_clients WHERE id = NEW.client AND imported = 1)
BEGIN
  SELECT RAISE(ABORT, 'imported secrets are only for a client added as imported');
END;

CREATE TRIGGER registry_secrets_imported_update
BEFORE UPDATE ON registry_secrets
WHEN NEW.kind = 'imported'
  AND NOT EXISTS (SELECT 1 FROM registry_clients WHERE id = NEW.client AND imported = 1)
BEGIN
  SELECT RAISE(ABORT, 'imported secrets are only for a client added as imported');
END;
