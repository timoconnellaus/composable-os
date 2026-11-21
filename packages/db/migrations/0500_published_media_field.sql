-- Stage 28 (ADR 0444, amended for issue #181): which field of a record's current version
-- references each media item. A picture is served to someone outside the org only when the field
-- that shows it is one they may read; a picture in a field the public does not read (a staff-only
-- image among the content) is not theirs, though the version is published.
--
-- The table is rebuilt with the field in its key, and filled from the current versions: every
-- `media` key in a version's content, under the top-level field it sits in
-- (`$.body.blocks[2].media` is the field `body`, `$.cover.media` is `cover`).
CREATE TABLE core_published_media_next (
  media_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field TEXT NOT NULL,
  PRIMARY KEY (media_id, object_type, record_id, field)
) WITHOUT ROWID;

INSERT OR IGNORE INTO core_published_media_next (media_id, object_type, record_id, field)
SELECT j.value, v.object_type, v.record_id,
  substr(substr(j.fullkey, 3), 1, instr(substr(j.fullkey, 3) || '.', '.') - 1)
FROM core_publish_version v, json_tree(v.content) j
WHERE v.current = 1 AND j.key = 'media' AND j.type = 'text' AND j.value LIKE 'med\_%' ESCAPE '\';

DROP TABLE core_published_media;
ALTER TABLE core_published_media_next RENAME TO core_published_media;
CREATE INDEX core_published_media_record_idx ON core_published_media (object_type, record_id);
