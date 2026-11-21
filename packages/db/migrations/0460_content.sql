-- Stage 28, Content (ADRs 0441 to 0443): the public half of `publishable`.
--
-- A scheduled publish. Scheduling takes the snapshot when a person schedules (it is what they
-- decided to publish), and the minute cron publishes it when `publish_at` passes, through the
-- operations pipeline (record.publishDue). At most one per record: scheduling again replaces it;
-- publishing now, unpublishing, or the cron publishing it removes it. Only
-- packages/core/src/records/publish.ts writes here.
CREATE TABLE core_publish_schedule (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  publish_at TEXT NOT NULL,
  -- The content fields' values when it was scheduled, as record.publish takes them.
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  -- The person who scheduled it: the cron publishes in their name.
  scheduled_by TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id)
);
CREATE INDEX core_publish_schedule_due_idx ON core_publish_schedule (publish_at);

-- An old address of a published record (ADR 0442). When the slug of a record that has been
-- published changes, its old slug points here to the record, and the public is told where it
-- now is. A record that takes a slug removes any redirect of that slug, so a live slug always
-- wins and a deleted record's slug can be used again.
CREATE TABLE core_slug_redirect (
  object_type TEXT NOT NULL,
  slug TEXT NOT NULL,
  record_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (object_type, slug)
);
CREATE INDEX core_slug_redirect_record_idx ON core_slug_redirect (object_type, record_id);

-- A preview link (ADR 0443): who may read one record's working copy without signing in, until
-- when. The link holds a random token; only its SHA-256 is kept. It names one record and is
-- refused for any other, and after `expires_at`.
CREATE TABLE core_preview_link (
  token_hash TEXT PRIMARY KEY NOT NULL,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX core_preview_link_expiry_idx ON core_preview_link (expires_at);

-- What the public reads of an object, by generation (ADR 0442): every committed change to a
-- record of a publishable object the public reads bumps its row in the change's own batch, so a
-- cached public read keyed by the generation is never served after a publish, an unpublish or a
-- slug change. `epoch` is random per deployment and object, so two deployments' caches never
-- share a key.
CREATE TABLE core_content_generation (
  object_type TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  epoch TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
