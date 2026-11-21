-- The import door (ADR 0470): `cos content import` and `record.import`.
--
-- A picture's SHA-256, so an upload of a file the library already has returns that item instead
-- of storing it twice (a re-run of an import uploads nothing). Older items have none until they
-- are uploaded again.
ALTER TABLE core_media ADD COLUMN sha256 TEXT;
CREATE INDEX core_media_sha256_idx ON core_media (sha256) WHERE deleted_at IS NULL AND sha256 IS NOT NULL;

-- What an import made, by the key the import gave it: the record, and the values the import last
-- wrote, as the record operations return them, so a re-run creates nothing twice, updates a
-- record only while it still holds exactly what the import wrote, and reports a record a person
-- has changed since as a conflict instead of overwriting it. Only record.import writes here.
CREATE TABLE core_import_key (
  object_type TEXT NOT NULL,
  import_key TEXT NOT NULL CHECK (length(import_key) BETWEEN 1 AND 200),
  record_id TEXT NOT NULL,
  -- JSON: field name → the value the import wrote.
  written TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  imported_by TEXT NOT NULL,
  PRIMARY KEY (object_type, import_key)
);
CREATE INDEX core_import_key_record_idx ON core_import_key (object_type, record_id);
