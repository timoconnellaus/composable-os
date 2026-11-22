-- Migration 0580: what a subscription grants (stage 32b, build step 6, ADR 0510).
--
-- A plan whose `sellable.recurring` declares `grants` (a membership plan) gives its subscription's
-- holder one record of the granted object (a membership), made by the host in the batch of the
-- verified provider event that first reports the subscription running, and kept in step with it in
-- every later event's batch. This row is how the host finds that record again, whatever the
-- extension called its fields; the primary key on the subscription means two events applied at
-- once cannot grant twice (the second batch fails whole, and the provider delivers it again).
CREATE TABLE core_subscription_grant (
  subscription_id TEXT PRIMARY KEY NOT NULL REFERENCES core_subscription (id) ON DELETE CASCADE,
  -- The granted object's registry name (`<extension>.<object>`) and the record.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX core_subscription_grant_record_idx
  ON core_subscription_grant (object_type, record_id);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '580'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 580;
