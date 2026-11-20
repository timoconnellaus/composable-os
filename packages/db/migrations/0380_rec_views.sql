-- Migration 0380: the read views are named rec_<object> (stage 20, ADR 0400).
--
-- The extension contract no longer says `crm`: the views that query.sql, dashboards and extension
-- code read were `crm_<plural>` and are now `rec_<object>`, named like the object they read, as
-- extension objects' views already were (`rec_x_<ext>_<object>`):
--
--   crm_people          rec_person           crm_tasks           rec_task
--   crm_organisations   rec_organisation     crm_task_links      rec_task_link
--   crm_affiliations    rec_affiliation      crm_record_tags     rec_record_tag
--   crm_activities      rec_activity         crm_users           rec_user
--   crm_activity_links  rec_activity_link    crm_stage_history   rec_stage_history
--
-- The bodies are unchanged: each is the definition the view had (0007, 0020, 0100, 0111, 0221).
-- The four object views are `SELECT b.* FROM core_base_<x> b` here; the schema reconciler
-- regenerates them with the extension side tables joined, and names extension objects' views
-- rec_x_<ext>_<object>, the next time it runs.
--
-- No release was installed under the old names (ADR 0400), so nothing reads them afterwards.

DROP VIEW crm_people;
DROP VIEW crm_organisations;
DROP VIEW crm_affiliations;
DROP VIEW crm_activities;
DROP VIEW crm_activity_links;
DROP VIEW crm_tasks;
DROP VIEW crm_task_links;
DROP VIEW crm_record_tags;
DROP VIEW crm_users;
DROP VIEW crm_stage_history;

CREATE VIEW rec_user AS
SELECT u.id, u.name, u.email, u.role, u.image, u.created_at
FROM core_user u
WHERE u.kind = 'human' AND u.support_grant_id IS NULL;

CREATE VIEW rec_person AS SELECT b.* FROM core_base_people b;
CREATE VIEW rec_organisation AS SELECT b.* FROM core_base_organisations b;
CREATE VIEW rec_activity AS SELECT b.* FROM core_base_activities b;
CREATE VIEW rec_task AS SELECT b.* FROM core_base_tasks b;

CREATE VIEW rec_affiliation AS
SELECT
  affiliation.id,
  affiliation.person_id,
  affiliation.organisation_id,
  affiliation.title,
  affiliation.role,
  affiliation.started_on,
  affiliation.ended_on,
  affiliation.is_current,
  affiliation.is_primary,
  affiliation.created_at,
  affiliation.updated_at
FROM core_affiliation affiliation
JOIN core_person p ON p.id = affiliation.person_id AND p.deleted_at IS NULL
JOIN core_organisation o ON o.id = affiliation.organisation_id AND o.deleted_at IS NULL
WHERE affiliation.deleted_at IS NULL;

CREATE VIEW rec_activity_link AS
SELECT l.activity_id, l.object_type, l.record_id
FROM core_activity_links l
JOIN core_activity a ON a.id = l.activity_id AND a.deleted_at IS NULL AND a.private_to IS NULL;

CREATE VIEW rec_task_link AS
SELECT l.task_id, l.object_type, l.record_id
FROM core_task_links l
JOIN core_task t ON t.id = l.task_id AND t.deleted_at IS NULL;

CREATE VIEW rec_record_tag AS
SELECT rt.object_type, rt.record_id, tg.id AS tag_id, tg.name AS tag
FROM core_record_tags rt
JOIN core_tags tg ON tg.id = rt.tag_id;

CREATE VIEW rec_stage_history AS
SELECT
  id,
  object_type,
  record_id,
  stage_id,
  group_id,
  stage_type,
  entered_at,
  left_at,
  left_at IS NULL AS is_current,
  round(
    julianday(coalesce(left_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) - julianday(entered_at),
    4
  ) AS days_in_stage,
  entered_by
FROM core_stage_history;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '380'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 380;
