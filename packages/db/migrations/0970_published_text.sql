-- Stage 38 step 1 (ADR 0700): the published-text index. What `content.search` finds is the words
-- of each record's current published version, never its working copy.
--
-- One row per section of a published record: the words before the first heading of a text
-- field (section 0, where the record's title is indexed too), then one row per heading, with the
-- heading's anchor (made by the SDK's `headingAnchors` from its text and place, never stored
-- elsewhere). Written only by packages/core/src/content/published-text.ts, in the batch of every
-- publish (a person's, an approved request's, the minute cron's) and unpublish, so the index is
-- the current version or nothing. An object's declaration changing (a field the public reads,
-- the object becoming public) is caught up by the minute cron (`content.reindex`), which also
-- fills the index for what was published before this migration.
--
-- Not a `rec_*` view: dashboards and query.sql never read it. Every read goes through the
-- visibility seam (the search joins the reader's source), so a deleted record, a record the
-- public may not read and a record whose `public.when` fails are not found, whatever is here.
CREATE TABLE core_published_text (
  id INTEGER PRIMARY KEY,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The version the words are from.
  version INTEGER NOT NULL,
  -- The content field the section is in (the record's title: its title field).
  field TEXT NOT NULL,
  -- The section's place in the field: 0 before the first heading, then 1, 2, ... per heading.
  section INTEGER NOT NULL CHECK (section >= 0),
  -- The heading's anchor; NULL for section 0.
  anchor TEXT,
  -- The heading's words (section 0: the record's title).
  heading TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  UNIQUE (object_type, record_id, field, section)
);

CREATE VIRTUAL TABLE core_published_text_fts USING fts5(
  heading,
  body,
  content = 'core_published_text',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TRIGGER core_published_text_ai AFTER INSERT ON core_published_text
BEGIN
  INSERT INTO core_published_text_fts (rowid, heading, body) VALUES (NEW.id, NEW.heading, NEW.body);
END;

CREATE TRIGGER core_published_text_ad AFTER DELETE ON core_published_text
BEGIN
  INSERT INTO core_published_text_fts (core_published_text_fts, rowid, heading, body)
  VALUES ('delete', OLD.id, OLD.heading, OLD.body);
END;

CREATE TRIGGER core_published_text_au AFTER UPDATE ON core_published_text
BEGIN
  INSERT INTO core_published_text_fts (core_published_text_fts, rowid, heading, body)
  VALUES ('delete', OLD.id, OLD.heading, OLD.body);
  INSERT INTO core_published_text_fts (rowid, heading, body) VALUES (NEW.id, NEW.heading, NEW.body);
END;
