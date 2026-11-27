-- Registry migration 0799: which Cloudflare for SaaS custom hostname a client's own domain is
-- (stage 66 step 8, ADR 0619, after its review).
--
-- A live fleet and a staging fleet may share one zone (`composableos.app` holds both
-- `<id>-admin.composableos.app` and `<id>-admin.staging.composableos.app`), so the zone's custom
-- hostnames are not one deployment's. A deployment's own is the one it created, and that is known
-- only by the id Cloudflare gave it (custom metadata, which could carry an owner, is Enterprise
-- only): `cos client hostname add` records the id here as soon as it has made the custom hostname,
-- and every later command (verify, remove, `cos client remove`) acts on a custom hostname only when
-- its id is the one recorded. A custom hostname already on the zone that this registry did not
-- make is never adopted or deleted by these commands.
--
-- Null: none made yet (or a row written before this migration, which made none either: until now
-- the column did not exist, and nothing was served from a client's own domain).

ALTER TABLE registry_hostnames ADD COLUMN custom_hostname_id TEXT
  CHECK (custom_hostname_id IS NULL OR (length(custom_hostname_id) BETWEEN 1 AND 64));
