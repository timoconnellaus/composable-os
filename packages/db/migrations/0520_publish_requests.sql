-- An AI actor asks for a publish (ADR 0480, stage 28 criterion 12): its request waits for a
-- person, and the version history says who asked and who approved.
--
-- A version published by approving a request keeps the person who approved it in `published_by`
-- (or `scheduled_by`), and the request beside it: `requested_by`, the staff user the AI actor
-- acted for, and `requested_via`, the actor (assistant, mcp, automation, extension). A person's
-- own publish leaves both empty. A scheduled publish carries them to the version the minute cron
-- publishes. Only packages/core/src/records/publish.ts writes either table.
ALTER TABLE core_publish_version ADD COLUMN requested_by TEXT;
ALTER TABLE core_publish_version ADD COLUMN requested_via TEXT
  CHECK (requested_via IS NULL OR requested_via IN ('human', 'assistant', 'mcp', 'automation', 'extension'));
ALTER TABLE core_publish_schedule ADD COLUMN requested_by TEXT;
ALTER TABLE core_publish_schedule ADD COLUMN requested_via TEXT
  CHECK (requested_via IS NULL OR requested_via IN ('human', 'assistant', 'mcp', 'automation', 'extension'));

DROP VIEW rec_publish_version;
CREATE VIEW rec_publish_version AS
  SELECT object_type, record_id, version, current, bytes, published_at, published_by, note,
    requested_by, requested_via
  FROM core_publish_version;
