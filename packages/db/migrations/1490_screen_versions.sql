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

CREATE TABLE core_screen_blob (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  object_key TEXT NOT NULL UNIQUE,
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

CREATE TABLE core_screen_version_hold (
  version_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- Kept until then; null: kept until the hold is changed.
  until TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (version_id, reason)
) WITHOUT ROWID;

-- A version starts open; nothing is stored sealed in one step.
CREATE TRIGGER core_screen_version_insert
BEFORE INSERT ON core_screen_version
WHEN NEW.state != 'open'
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_open_first');
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
-- kind, and
-- never one held (the published version, one published in the last 90 days).
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

-- Only an open version is sent files; only a sealed one is held.
CREATE TRIGGER core_screen_version_upload_insert
BEFORE INSERT ON core_screen_version_upload
WHEN NOT EXISTS (SELECT 1 FROM core_screen_version v WHERE v.id = NEW.version_id AND v.state = 'open')
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_not_open');
END;

CREATE TRIGGER core_screen_version_hold_insert
BEFORE INSERT ON core_screen_version_hold
WHEN NOT EXISTS (SELECT 1 FROM core_screen_version v WHERE v.id = NEW.version_id AND v.state = 'sealed')
BEGIN
  SELECT RAISE(ABORT, 'core_screen_version_not_sealed');
END;
