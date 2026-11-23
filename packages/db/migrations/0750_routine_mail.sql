-- Migration 0750: routine mail (ADR 0590). One row per routine email the host was asked to send:
-- a kind a shipped pack declares (a booking's confirmation, a class reminder), about one record,
-- to one recipient the host chose from that record. The row is the audit of what was sent on its
-- own, and what the integration host reads to send it: `callAsHost` with purpose `routine-mail`
-- takes only a row's id and composes the email from the row, so nothing a caller passes becomes
-- the message or the recipient.
--
-- `routine`: 1 when it may go without a person (the pack turned on, the kind on, every value
-- checked, nothing about it an AI wrote that no person approved), 0 when it is not: `ordinary`
-- 1 while the pack's routine email is not turned on (decided as before routine mail, by the
-- policy), else held for a person (`held_reason`). The daily caps are counted when the
-- integration host claims a row (`claimed_at`), in one statement, so concurrent runs cannot race
-- past them: per mailbox (`recipient_key`, plus-tags and case folded) and for the organisation.
-- `status`: `off` (the kind is turned off: nothing sent, nothing queued); `ready` (to send);
-- `sending` (the integration host took it); `sent`; `waiting` (in Approvals for a person, with
-- `pending_action_id`); `denied` (the deploy floor refused it); `failed` (`error`).
--
-- `subject`, `body` and `calendar` are what is sent, kept until it is decided and then cleared
-- (the kind, the record and the recipient stay, for the admin's count and the audit). A person's
-- erase deletes their rows.
CREATE TABLE core_routine_mail (
  id TEXT PRIMARY KEY,
  -- `<extension>.<kind>`, and the kind's message.
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  record_object TEXT NOT NULL,
  record_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  -- How the host chose the recipient: `person` (the record's customer), `guardian` (a live
  -- guardian of that person, ADR 0540) or `order` (a paid order's own address, ADR 0560).
  recipient_rule TEXT NOT NULL CHECK (recipient_rule IN ('person', 'guardian', 'order')),
  recipient_person_id TEXT,
  -- The mailbox the recipient most likely reaches (ADR 0459's key), for the per-address cap.
  recipient_key TEXT NOT NULL,
  -- The Person the record is about (a child's booking: the child), so their erase removes the
  -- rows about them, those sent to their guardians included.
  about_person_id TEXT,
  automation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  -- The run's trigger type, and who made the change that started it (JSON `{ actor, userId,
  -- approved }`, or null for a schedule or a moment).
  trigger_type TEXT NOT NULL,
  triggered_by TEXT,
  -- The run its chain of retries began with, the kind, message, record and recipient: a retried
  -- step finds the row it made and sends nothing twice.
  idempotency_key TEXT NOT NULL UNIQUE,
  routine INTEGER NOT NULL CHECK (routine IN (0, 1)),
  ordinary INTEGER NOT NULL DEFAULT 0 CHECK (ordinary IN (0, 1)),
  claimed_at TEXT,
  held_reason TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('off', 'ready', 'sending', 'sent', 'waiting', 'denied', 'failed')),
  connection_id TEXT,
  subject TEXT,
  body TEXT,
  calendar TEXT,
  related TEXT,
  -- The values the email showed and who stood behind each (JSON `[{o, r, f, h}]`): approving a
  -- held email marks exactly these, as they were when it was prepared.
  sources TEXT,
  pending_action_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The daily cap per recipient, and the admin's counts per kind.
CREATE INDEX core_routine_mail_recipient_idx ON core_routine_mail (recipient_key, claimed_at);
CREATE INDEX core_routine_mail_claimed_idx ON core_routine_mail (claimed_at)
  WHERE claimed_at IS NOT NULL;
CREATE INDEX core_routine_mail_about_idx ON core_routine_mail (about_person_id)
  WHERE about_person_id IS NOT NULL;
CREATE INDEX core_routine_mail_record_idx ON core_routine_mail (record_object, record_id);
CREATE INDEX core_routine_mail_kind_idx ON core_routine_mail (kind, created_at);
CREATE INDEX core_routine_mail_created_idx ON core_routine_mail (created_at);
CREATE INDEX core_routine_mail_person_idx ON core_routine_mail (recipient_person_id)
  WHERE recipient_person_id IS NOT NULL;

-- Who stands behind each value (ADR 0590, the review's default deny): one row per record field,
-- written by the host in the batch of every write it records (the pipeline), with a SHA-256 of the
-- value written, so a mark never applies to a different value. `standing`: `person` (a human staff
-- account's own write, or a write a human approved), `customer` (the customer's own write),
-- `public` (an unauthenticated buyer), `default` (a declared default), `host` (the host's own
-- write with no source a person stands behind), `ai` (an AI's write, or one only the adjudicator
-- approved). A copy (a series' class, a title taken from a class type, a moved booking) carries
-- the weakest mark of its sources. `$created` is the record's creation.
CREATE TABLE core_value_mark (
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  standing TEXT NOT NULL
    CHECK (standing IN ('person', 'customer', 'public', 'default', 'host', 'ai')),
  by_id TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id, field)
) WITHOUT ROWID;
