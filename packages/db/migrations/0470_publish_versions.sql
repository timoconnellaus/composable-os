-- Stage 41, `publishable` without its public half (ADR 0446): the published versions of a
-- record's content.
--
-- A publishable object's records are the working copy staff edit. Publishing one snapshots its
-- content fields (the object's `publishable.content`) into the next version here, in the batch
-- of `record.publish`, and makes it the current one: the version readers are given (an
-- assignment pins a program's). Editing the working copy changes no row here. Restoring copies a
-- version back into the working copy and changes no row here either.
--
-- At most one current version per record (the partial unique index). Two publishes racing each
-- other compute the same next number and the second fails its batch on the primary key, so no
-- version is ever written twice. Stage 28 adds unpublishing (current set to 0, the versions kept)
-- and public reads of the current version.
--
-- Only packages/core/src/records/publish.ts writes here.
CREATE TABLE core_publish_version (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- The content fields' values when it was published, as the record operations return them.
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  current INTEGER NOT NULL DEFAULT 0 CHECK (current IN (0, 1)),
  published_at TEXT NOT NULL,
  -- The staff user who published it.
  published_by TEXT,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  PRIMARY KEY (object_type, record_id, version)
);
CREATE UNIQUE INDEX core_publish_version_current_idx
  ON core_publish_version (object_type, record_id) WHERE current = 1;

-- For dashboards and query.sql: every version, without its content.
CREATE VIEW rec_publish_version AS
  SELECT object_type, record_id, version, current, bytes, published_at, published_by, note
  FROM core_publish_version;
