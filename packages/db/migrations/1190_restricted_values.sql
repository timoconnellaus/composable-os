-- Migration 1190: restricted fields (stage 54 step 2, ADR 0811).
--
-- A pack may declare a text field `restricted: "<pack>:<word>"`, naming one of its restricted
-- permissions (ADR 0625). Its value is kept here, never in the object's x_* table: so it is in no
-- rec_* view, and so in no `query.sql`, dashboard, export, search entry, embedding, summary or
-- timeline. The record's customer (its author) writes it through the visibility seam and reads
-- their own; staff read it only through `record.readRestricted`, from a tool of the pack that
-- names the permission, called by a person themselves, every read audited with no value.
--
-- Keyed by the record (its object's registry name and id) and the field's registry name, with no
-- foreign key, as core_value_mark is. Deleted with the record's author when they are erased or
-- purged, scrubbed of an erased subject's terms like other free text, and dropped with its field or
-- object (extension.dropHidden).
CREATE TABLE core_restricted_value (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 4000),
  written_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id, field)
) WITHOUT ROWID;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1190'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1190;
