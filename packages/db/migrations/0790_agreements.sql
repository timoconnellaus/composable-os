-- Migration 0790: agreement documents and their versions (stage 44 step 1, ADRs 0610 and 0611).
--
-- A document is something a business asks people to agree to (its terms, a waiver, health
-- questions, a parent's consent). Staff with `agreements:manage` (and the assistant for them)
-- write its working copy; a person publishes it as a numbered version, which nobody can change or
-- delete afterwards. A version takes effect now or at a set moment (the minute cron); the newest
-- in effect is current, and `agree_from` is the newest "first" or "agree again" version in effect:
-- acceptances of earlier versions stop counting (stage 44, step 2 on).
--
-- None of these tables is a record: no rec_* view reads them, so query.sql, dashboards, exports,
-- search and the assistant's bulk reads never see them. The business's text is not personal data;
-- nothing here names a member.
CREATE TABLE core_agreement_document (
  id TEXT PRIMARY KEY,
  -- Fixed when the document is made: only `health` changes how it works (stage 44).
  kind TEXT NOT NULL CHECK (kind IN ('terms', 'waiver', 'health', 'guardian', 'other')),
  -- draft: never published; live: published; retired: needed nowhere, final.
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'live', 'retired')),
  -- The working copy: what the editor changes, and what a publish snapshots.
  draft_title TEXT NOT NULL,
  draft_body TEXT,
  draft_tick_label TEXT,
  draft_questions TEXT,
  draft_how TEXT NOT NULL DEFAULT 'typed' CHECK (draft_how IN ('typed', 'drawn')),
  draft_who TEXT NOT NULL DEFAULT 'participant' CHECK (draft_who IN ('participant', 'payer')),
  draft_for TEXT NOT NULL DEFAULT 'everyone' CHECK (draft_for IN ('everyone', 'dependants')),
  draft_ask_again_months INTEGER CHECK (draft_ask_again_months BETWEEN 1 AND 120),
  -- Bumped by every save of the working copy: a publish names the one it was made from.
  draft_rev INTEGER NOT NULL DEFAULT 0,
  draft_updated_at TEXT NOT NULL,
  draft_updated_by TEXT NOT NULL,
  -- The version in effect now (empty until the first takes effect), and the version number from
  -- which acceptances count (0 until then).
  current_version_id TEXT,
  agree_from INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  retired_at TEXT,
  retired_by TEXT
);

-- Published wording, kept for good. Acceptances (step 2) will point at it.
CREATE TABLE core_agreement_version (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES core_agreement_document (id),
  number INTEGER NOT NULL CHECK (number >= 1),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tick_label TEXT NOT NULL,
  questions TEXT,
  how TEXT NOT NULL CHECK (how IN ('typed', 'drawn')),
  who TEXT NOT NULL CHECK (who IN ('participant', 'payer')),
  for_whom TEXT NOT NULL CHECK (for_whom IN ('everyone', 'dependants')),
  ask_again_months INTEGER,
  change TEXT NOT NULL CHECK (change IN ('first', 'small', 'agree_again')),
  effective_from TEXT NOT NULL,
  published_at TEXT NOT NULL,
  -- The staff user (a person: the operation is human-only) who published it.
  published_by TEXT NOT NULL,
  -- The working copy's draft_rev it was made from.
  draft_rev INTEGER NOT NULL,
  -- SHA-256 (hex) of the canonical JSON of what a person is shown.
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  CHECK ((number = 1) = (change = 'first')),
  UNIQUE (document_id, number)
);
CREATE INDEX core_agreement_version_due_idx ON core_agreement_version (effective_from);

-- Nobody changes or deletes a published version: not an operation, not host code, not a
-- migration's later statement. Refused in the database.
CREATE TRIGGER core_agreement_version_no_update
BEFORE UPDATE ON core_agreement_version
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_version_immutable');
END;

CREATE TRIGGER core_agreement_version_no_delete
BEFORE DELETE ON core_agreement_version
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_version_immutable');
END;

-- A version is made only from the working copy as it is at commit (the person reviewed that one),
-- of a document that is not retired, and numbered next.
CREATE TRIGGER core_agreement_version_from_draft
BEFORE INSERT ON core_agreement_version
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM core_agreement_document d
      WHERE d.id = NEW.document_id AND d.draft_rev = NEW.draft_rev AND d.state != 'retired'
    )
      THEN RAISE(ABORT, 'core_agreement_draft_changed')
    WHEN NEW.number != 1 + COALESCE(
      (SELECT MAX(v.number) FROM core_agreement_version v WHERE v.document_id = NEW.document_id), 0)
      THEN RAISE(ABORT, 'core_agreement_draft_changed')
  END;
END;

-- A document's current version is one of its own, and agree_from never goes back.
CREATE TRIGGER core_agreement_document_current
BEFORE UPDATE OF current_version_id, agree_from ON core_agreement_document
BEGIN
  SELECT CASE
    WHEN NEW.agree_from < OLD.agree_from
      THEN RAISE(ABORT, 'core_agreement_agree_from_back')
    WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM core_agreement_version v
      WHERE v.id = NEW.current_version_id AND v.document_id = NEW.id
    )
      THEN RAISE(ABORT, 'core_agreement_agree_from_back')
  END;
END;

-- A retired document stays retired, and its working copy stays as it was.
CREATE TRIGGER core_agreement_document_retired
BEFORE UPDATE ON core_agreement_document
WHEN OLD.state = 'retired'
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_retired');
END;

-- Documents are the business's text, kept with their versions: never deleted.
CREATE TRIGGER core_agreement_document_no_delete
BEFORE DELETE ON core_agreement_document
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_version_immutable');
END;

-- Where a document is needed: an agreement point an installed object declares (ADR 0611).
CREATE TABLE core_agreement_point (
  document_id TEXT NOT NULL REFERENCES core_agreement_document (id),
  point TEXT NOT NULL,
  attached_at TEXT NOT NULL,
  attached_by TEXT NOT NULL,
  PRIMARY KEY (document_id, point)
);
CREATE INDEX core_agreement_point_point_idx ON core_agreement_point (point);

-- Only a live document is attached.
CREATE TRIGGER core_agreement_point_live
BEFORE INSERT ON core_agreement_point
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_not_live')
  WHERE NOT EXISTS (
    SELECT 1 FROM core_agreement_document d WHERE d.id = NEW.document_id AND d.state = 'live'
  );
END;

-- One counter the host bumps in the batch of every change to what is due (every publish, a
-- version the cron makes current, attach, detach, retire). Step 2's guard reads it.
CREATE TABLE core_agreement_rev (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rev INTEGER NOT NULL DEFAULT 0
);
INSERT INTO core_agreement_rev (id, rev) VALUES (1, 0);

CREATE TRIGGER core_agreement_rev_forward
BEFORE UPDATE ON core_agreement_rev
WHEN NEW.rev <= OLD.rev OR NEW.id != OLD.id
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_rev_back');
END;

CREATE TRIGGER core_agreement_rev_no_delete
BEFORE DELETE ON core_agreement_rev
BEGIN
  SELECT RAISE(ABORT, 'core_agreement_rev_back');
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '790'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 790;
