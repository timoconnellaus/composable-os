-- Migration 0411: sessions for native apps on the HTTP surface (stage 23, ADR 0403, ADR 0419).
--
-- A phone or a TV exchanges its sign-in for an access token that lasts minutes and a refresh
-- token. Only SHA-256 hashes of the tokens are stored. Every refresh rotates both; the refresh
-- hashes already used are kept on the row, and presenting one again ends the session (the row is
-- deleted). A session unused for the period in the `device_session_idle_days` setting (90 days by
-- default) is ended when it is next presented.
--
-- A session is one audience's: staff (user_id) or a customer (customer_id), never both. Deleting
-- the user or the customer account deletes its sessions. No client address is stored.
CREATE TABLE core_device_session (
  -- dvs_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('staff', 'customer')),
  user_id TEXT REFERENCES core_user (id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES core_customer (id) ON DELETE CASCADE,
  -- What the app called the device ("Ada's iPhone"), so a person can tell their sessions apart.
  device_name TEXT NOT NULL,
  access_hash TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_hash TEXT NOT NULL,
  -- JSON array of refresh hashes this session has already rotated past.
  used_refresh_hashes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  CHECK ((audience = 'staff') = (user_id IS NOT NULL)),
  CHECK ((audience = 'customer') = (customer_id IS NOT NULL))
);
CREATE UNIQUE INDEX core_device_session_access_uq ON core_device_session (access_hash);
CREATE INDEX core_device_session_user_idx ON core_device_session (user_id);
CREATE INDEX core_device_session_customer_idx ON core_device_session (customer_id);

UPDATE core_meta SET value = '411' WHERE key = 'schema_version';
