-- Migration 0441: the capacity read views (stage 26, ADR 0431), for query.sql and dashboards.
--
-- rec_capacity: one row per record with a capacity. `available` is the record's own places left
-- (null when unlimited); a record with a pool may have fewer, see `pool_available`.
-- rec_capacity_claim: every claim, held, confirmed or released, and what it was taken for.
CREATE VIEW rec_capacity AS
SELECT
  c.object_type,
  c.record_id,
  c.places,
  c.held,
  c.taken,
  CASE WHEN c.places IS NULL THEN NULL ELSE max(c.places - c.held - c.taken, 0) END AS available,
  c.pool_object_type,
  c.pool_record_id,
  CASE WHEN p.places IS NULL THEN NULL ELSE max(p.places - p.held - p.taken, 0) END
    AS pool_available,
  c.updated_at
FROM core_capacity c
LEFT JOIN core_capacity p
  ON p.object_type = c.pool_object_type AND p.record_id = c.pool_record_id;

CREATE VIEW rec_capacity_claim AS
SELECT
  id,
  object_type,
  record_id,
  pool_object_type,
  pool_record_id,
  quantity,
  state,
  for_type,
  for_id,
  created_at,
  updated_at,
  confirmed_at,
  released_at
FROM core_capacity_claim;

UPDATE core_meta SET value = '441' WHERE key = 'schema_version';
