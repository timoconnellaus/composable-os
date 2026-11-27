-- Migration 1490: the screen version store (stage 75 step 3, ADR 0961).
--
-- A version is the built output of a client's screens: its files, each named by the SHA-256 of
-- its bytes, and a manifest. It is in the client's own database (so a client's export carries it)
-- and its files are in the client's part of the files binding (BLOBS, `clients/<client>/` on a
-- many-client host), under `screens/`. A version gets in three steps: begun (`open`), its files
-- put one by one (each checked against its hash on arrival), then sealed with its manifest. A
-- sealed version is never changed; these triggers hold that whatever writes the database.
--
-- core_screen_blob: one row per file the client holds, by hash, so identical files across
--   versions are stored once. `object_key` is where its bytes are (`screens/<sha256>/<version>`,
--   the version that first stored it): a file removed and put again gets a new key, so a removal
--   queued for the old key never deletes the new bytes.
-- core_screen_version: the version, open or sealed. Sealed, it holds its canonical manifest, its
--   hash and what the manifest says, and nothing about it changes again. Its `kind` is what it is
--   the built output of: only `web` (a client's web app) for now. Retention, the bound on open
--   uploads and listing are per kind, so another kind of built output,
--   if one is ever wanted, adds a value to the CHECK in a migration and gets its own published pointer.
-- core_screen_version_file: a sealed version's files, exactly its manifest's: written at seal,
--   while the version is still open, and never changed.
-- core_screen_version_upload: which files an open version has been sent, for its bounds and so
--   the sweep leaves them while it is open.
-- core_screen_version_hold: a sealed version that must be kept whatever its age (step 4: the
--   published version, and one published in the last 90 days). Removed only once `until` passes.
-- core_screen_day: what one day added, per client: versions begun and bytes newly stored. The
--   bounds below are checked in the writes themselves, so calls at once cannot pass them.
--
-- The bounds (SCREEN_VERSION_LIMITS in @composable-os/sdk, and store.ts; screen-versions.test.ts
-- checks each one here): 1000 files and 52428800 bytes (50 MB) sent to one version; 3 open
-- versions of a kind; 50 versions begun and 262144000 bytes (250 MB) newly stored a day.

CREATE TABLE core_screen_blob (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  -- `screens/<its sha256>/<the scv_ id of the version that stored it>`: nothing else, so a row
  -- (an imported one too, which no trigger sees) never points at another object of the client's.
  object_key TEXT NOT NULL UNIQUE CHECK (
    substr(object_key, 1, 73) = 'screens/' || sha256 || '/'
    AND length(object_key) = 103
    AND substr(object_key, 74, 4) = 'scv_'
    AND substr(object_key, 78) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  stored_at TEXT NOT NULL,
  last_put_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE core_screen_version (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('web')),
  state TEXT NOT NULL CHECK (state IN ('open', 'sealed')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  -- Open: when an unsealed upload is abandoned and swept. Sealed: null.
  expires_at TEXT,
  sealed_at TEXT,
  sealed_by TEXT,
  manifest TEXT CHECK (manifest IS NULL OR json_valid(manifest)),
  manifest_sha256 TEXT,
  entry TEXT,
  contract TEXT,
  build_tool TEXT,
  file_count INTEGER,
  total_bytes INTEGER,
  CHECK (
    (state = 'open' AND expires_at IS NOT NULL AND sealed_at IS NULL AND manifest IS NULL)
    OR (state = 'sealed' AND expires_at IS NULL AND sealed_at IS NOT NULL
      AND sealed_by IS NOT NULL AND manifest IS NOT NULL AND manifest_sha256 IS NOT NULL
      AND entry IS NOT NULL AND contract IS NOT NULL AND build_tool IS NOT NULL
      AND file_count IS NOT NULL AND total_bytes IS NOT NULL)
  )
);

CREATE INDEX core_screen_version_kind ON core_screen_version (kind, state, sealed_at);

CREATE TABLE core_screen_version_file (
  version_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  content_type TEXT NOT NULL,
  PRIMARY KEY (version_id, path)
) WITHOUT ROWID;

-- Two paths one disk would take for the same file (macOS folds case) are never one version's.
CREATE UNIQUE INDEX core_screen_version_file_folded ON core_screen_version_file (version_id, lower(path));
CREATE INDEX core_screen_version_file_sha ON core_screen_version_file (sha256);

CREATE TABLE core_screen_version_upload (
  version_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  received_at TEXT NOT NULL,
  PRIMARY KEY (version_id, sha256)
) WITHOUT ROWID;

CREATE INDEX core_screen_version_upload_sha ON core_screen_version_upload (sha256);

CREATE INDEX core_screen_blob_stored ON core_screen_blob (stored_at);

CREATE TABLE core_screen_day (
  day TEXT PRIMARY KEY,
  versions INTEGER NOT NULL DEFAULT 0 CHECK (versions >= 0),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0)
) WITHOUT ROWID;

CREATE TABLE core_screen_version_hold (
  version_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- Kept until then; null: kept until the hold is changed.
  until TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (version_id, reason)
) WITHOUT ROWID;

-- A version starts open; nothing is stored sealed in one step, and nothing takes the place of a
-- version (INSERT OR REPLACE fires no delete trigger: recursive_triggers is off). At most 3 of a
-- kind are open at once and 50 are begun a day, counted here so calls at once cannot pass them.
CREATE TRIGGER core_screen_version_insert
BEFORE INSERT ON core_screen_version
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_open_first')
  WHERE NEW.state != 'open' OR EXISTS (SELECT 1 FROM core_screen_version v WHERE v.id = NEW.id);
  SELECT RAISE(ABORT, 'core_screen_version_too_many_open')
  WHERE (SELECT count(*) FROM core_screen_version v
         WHERE v.kind = NEW.kind AND v.state = 'open' AND v.expires_at > NEW.created_at) >= 3;
  SELECT RAISE(ABORT, 'core_screen_version_day_full')
  WHERE coalesce((SELECT d.versions FROM core_screen_day d WHERE d.day = substr(NEW.created_at, 1, 10)), 0) >= 50;
END;

CREATE TRIGGER core_screen_version_counted
AFTER INSERT ON core_screen_version
BEGIN
  INSERT INTO core_screen_day (day, versions) VALUES (substr(NEW.created_at, 1, 10), 1)
  ON CONFLICT (day) DO UPDATE SET versions = versions + 1;
END;

-- Sealed, a version never changes.
CREATE TRIGGER core_screen_version_sealed_fixed
BEFORE UPDATE ON core_screen_version
WHEN OLD.state = 'sealed' OR NEW.id != OLD.id OR NEW.kind != OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_sealed');
END;

-- The seal says what its files are: their count, their bytes, and the entry among them.
CREATE TRIGGER core_screen_version_seal
BEFORE UPDATE ON core_screen_version
WHEN OLD.state = 'open' AND NEW.state = 'sealed'
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_seal_mismatch')
  WHERE NEW.file_count != (SELECT count(*) FROM core_screen_version_file f WHERE f.version_id = NEW.id)
    OR NEW.total_bytes != (SELECT coalesce(sum(f.size), 0) FROM core_screen_version_file f WHERE f.version_id = NEW.id)
    OR NOT EXISTS (SELECT 1 FROM core_screen_version_file f WHERE f.version_id = NEW.id AND f.path = NEW.entry);
END;

-- A sealed version is removed only by the retention rule: never one of the last ten sealed of its
-- kind, and never one held (the published version, one published in the last 90 days).
CREATE TRIGGER core_screen_version_delete
BEFORE DELETE ON core_screen_version
WHEN OLD.state = 'sealed'
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_kept')
  WHERE EXISTS (SELECT 1 FROM core_screen_version_hold h WHERE h.version_id = OLD.id)
    OR (SELECT count(*) FROM core_screen_version v
        WHERE v.state = 'sealed' AND v.kind = OLD.kind
          AND (v.sealed_at > OLD.sealed_at OR (v.sealed_at = OLD.sealed_at AND v.id > OLD.id))) < 10;
END;

-- A file joins only an open version, and only as a file the client holds, at its size.
CREATE TRIGGER core_screen_version_file_insert
BEFORE INSERT ON core_screen_version_file
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_file_refused')
  WHERE NOT EXISTS (SELECT 1 FROM core_screen_version v WHERE v.id = NEW.version_id AND v.state = 'open')
    OR NOT EXISTS (SELECT 1 FROM core_screen_blob b WHERE b.sha256 = NEW.sha256 AND b.size = NEW.size);
END;

CREATE TRIGGER core_screen_version_file_update
BEFORE UPDATE ON core_screen_version_file
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_sealed');
END;

-- Its files go only once the version itself has gone.
CREATE TRIGGER core_screen_version_file_delete
BEFORE DELETE ON core_screen_version_file
WHEN EXISTS (SELECT 1 FROM core_screen_version v WHERE v.id = OLD.version_id)
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_sealed');
END;

-- A file held already is never replaced (INSERT OR REPLACE would skip the delete trigger and
-- change a sealed version's bytes): the insert is ignored, which also keeps a put's ON CONFLICT DO
-- NOTHING for two puts of one new file. A new file counts towards the day's 250 MB.
CREATE TRIGGER core_screen_blob_insert
BEFORE INSERT ON core_screen_blob
BEGIN
  SELECT RAISE(IGNORE)
  WHERE EXISTS (SELECT 1 FROM core_screen_blob b WHERE b.sha256 = NEW.sha256 OR b.object_key = NEW.object_key);
  SELECT RAISE(ABORT, 'core_screen_day_full')
  WHERE coalesce((SELECT d.bytes FROM core_screen_day d WHERE d.day = substr(NEW.stored_at, 1, 10)), 0)
    + NEW.size > 262144000;
END;

CREATE TRIGGER core_screen_blob_counted
AFTER INSERT ON core_screen_blob
BEGIN
  INSERT INTO core_screen_day (day, bytes) VALUES (substr(NEW.stored_at, 1, 10), NEW.size)
  ON CONFLICT (day) DO UPDATE SET bytes = bytes + NEW.size;
END;

-- A file's hash, size and place never change; it goes only when no version names it.
CREATE TRIGGER core_screen_blob_update
BEFORE UPDATE ON core_screen_blob
WHEN NEW.sha256 != OLD.sha256 OR NEW.size != OLD.size OR NEW.object_key != OLD.object_key
BEGIN
  SELECT RAISE(ABORT, 'core_screen_blob_fixed');
END;

CREATE TRIGGER core_screen_blob_delete
BEFORE DELETE ON core_screen_blob
WHEN EXISTS (SELECT 1 FROM core_screen_version_file f WHERE f.sha256 = OLD.sha256)
BEGIN
  SELECT RAISE(ABORT, 'core_screen_blob_in_use');
END;

-- Only an open version is sent files, at most 1000 of them and 50 MB together, counted here so
-- puts at once cannot pass them (a file sent again is no more). Only a sealed one is held.
CREATE TRIGGER core_screen_version_upload_insert
BEFORE INSERT ON core_screen_version_upload
WHEN NOT EXISTS (SELECT 1 FROM core_screen_version_upload u
                 WHERE u.version_id = NEW.version_id AND u.sha256 = NEW.sha256)
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_not_open')
  WHERE NOT EXISTS (SELECT 1 FROM core_screen_version v WHERE v.id = NEW.version_id AND v.state = 'open');
  SELECT RAISE(ABORT, 'core_screen_version_too_many_files')
  WHERE (SELECT count(*) FROM core_screen_version_upload u WHERE u.version_id = NEW.version_id) >= 1000;
  SELECT RAISE(ABORT, 'core_screen_version_too_large')
  WHERE (SELECT coalesce(sum(u.size), 0) FROM core_screen_version_upload u WHERE u.version_id = NEW.version_id)
    + NEW.size > 52428800;
END;

CREATE TRIGGER core_screen_version_hold_insert
BEFORE INSERT ON core_screen_version_hold
WHEN NOT EXISTS (SELECT 1 FROM core_screen_version v WHERE v.id = NEW.version_id AND v.state = 'sealed')
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_not_sealed');
END;
