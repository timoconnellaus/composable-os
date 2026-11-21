-- Stage 28, Media (ADR 0444): the media library, a base record.
--
-- A media item is one stored original in R2 (`key`, under `media/`), what the host found it to
-- be when it was uploaded (its type from its first bytes, never the name or the client's word;
-- its size and dimensions), its alt text and who uploaded it. Nothing executable is stored: the
-- upload takes only the raster image types it can recognise (no SVG).
--
-- Deleting one is a soft delete (Trash). The Trash purge deletes the row, and the trigger below
-- queues its R2 object on core_blob_deletion in the same batch: the existing blob deletion path
-- (ADR 0320) deletes it after the commit, and the 10-minute cron retries.
CREATE TABLE core_media (
  id TEXT PRIMARY KEY NOT NULL,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type TEXT NOT NULL CHECK (type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif')),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  width INTEGER,
  height INTEGER,
  alt TEXT CHECK (alt IS NULL OR length(alt) <= 500),
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE INDEX core_media_live_idx ON core_media (created_at) WHERE deleted_at IS NULL;
CREATE INDEX core_media_deleted_idx ON core_media (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TRIGGER core_media_object_ad AFTER DELETE ON core_media
BEGIN
  INSERT OR IGNORE INTO core_blob_deletion (key, queued_at)
  VALUES (OLD.key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- The live media items, as staff list them. Outsiders read none of it: a picture reaches the
-- public only through media.serve, for an item published content references.
CREATE VIEW rec_media AS
  SELECT id, key, name, type, bytes, width, height, alt, created_at, created_by, updated_at,
    updated_by
  FROM core_media WHERE deleted_at IS NULL;

-- Which media items each record's current version references (ADR 0444): written with the
-- version by records/publish.ts (a publish replaces a record's rows; an unpublish removes them),
-- so serving a picture to the public is an index read and never a scan of versions.
CREATE TABLE core_published_media (
  media_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (media_id, object_type, record_id)
) WITHOUT ROWID;
CREATE INDEX core_published_media_record_idx ON core_published_media (object_type, record_id);
