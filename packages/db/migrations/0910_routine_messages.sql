-- Migration 0910: routine messages (stage 30, ADRs 0670 and 0676; grows ADR 0590's routine mail).
-- A row of core_routine_mail is now one message to one recipient on one channel: `email` (as
-- before), `text` or `push`. A kind the host declares itself (a host kind, ADR 0670) is asked for
-- by host code, not an automation: its rows have no automation or run, and `extension_id` is
-- `core`, an id no extension can take.
--
-- New columns:
-- - `channel`: `email`, `text` or `push`. Every row written before this is an email.
-- - `segments`, `cost_minor`: a text's segments and its cost, estimated then reported (the text
--   gatekeeper, a later step, fills the cost).
-- - `provider_ref`, `delivered_at`: the provider's id for the message, and when it reported it
--   delivered (texts; a push service's acceptance is `sent`).
-- - `wait_until`: quiet hours (ADR 0676). A text or push prepared during them waits, `waiting`
--   with no pending action, until this moment; then it is sent, or `expired` when `until_at`
--   has passed.
-- - `until_at`: the kind's moment for this record (`until`, a class's start): a text or push not
--   sent by then is dropped, its email having gone.
--
-- New states: `delivered` (the provider said so), `stopped` (the person's choice or a STOP),
-- `expired` (its moment passed while it waited), `over_limit` (the month's text limit),
-- `no_channel` (no address, no textable number, no device).
--
-- For a text or push, `recipient` holds the number or device while the row waits and is cleared
-- once it is decided, like the words; `recipient_key` (a hash for a text) is what the caps count.
-- `subject` is a push's title and `body` its line, or a text's whole words.
--
-- SQLite cannot change a CHECK, so the table is remade with its rows and indexes.
CREATE TABLE core_routine_mail_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  record_object TEXT NOT NULL,
  record_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'text', 'push')),
  recipient TEXT NOT NULL,
  recipient_rule TEXT NOT NULL CHECK (recipient_rule IN ('person', 'guardian', 'order')),
  recipient_person_id TEXT,
  recipient_key TEXT NOT NULL,
  about_person_id TEXT,
  -- Null for a host kind's row: host code asked for it, not an automation.
  automation_id TEXT,
  run_id TEXT,
  trigger_type TEXT NOT NULL,
  triggered_by TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  routine INTEGER NOT NULL CHECK (routine IN (0, 1)),
  ordinary INTEGER NOT NULL DEFAULT 0 CHECK (ordinary IN (0, 1)),
  claimed_at TEXT,
  held_reason TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('off', 'ready', 'sending', 'sent', 'delivered', 'waiting', 'denied',
      'failed', 'stopped', 'expired', 'over_limit', 'no_channel')),
  connection_id TEXT,
  subject TEXT,
  body TEXT,
  calendar TEXT,
  related TEXT,
  sources TEXT,
  pending_action_id TEXT,
  error TEXT,
  segments INTEGER,
  cost_minor INTEGER,
  provider_ref TEXT,
  delivered_at TEXT,
  wait_until TEXT,
  until_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO core_routine_mail_new (id, kind, message, extension_id, record_object, record_id,
  channel, recipient, recipient_rule, recipient_person_id, recipient_key, about_person_id,
  automation_id, run_id, trigger_type, triggered_by, idempotency_key, routine, ordinary,
  claimed_at, held_reason, status, connection_id, subject, body, calendar, related, sources,
  pending_action_id, error, created_at, updated_at)
SELECT id, kind, message, extension_id, record_object, record_id, 'email', recipient,
  recipient_rule, recipient_person_id, recipient_key, about_person_id, automation_id, run_id,
  trigger_type, triggered_by, idempotency_key, routine, ordinary, claimed_at, held_reason, status,
  connection_id, subject, body, calendar, related, sources, pending_action_id, error, created_at,
  updated_at
FROM core_routine_mail;
DROP TABLE core_routine_mail;
ALTER TABLE core_routine_mail_new RENAME TO core_routine_mail;

-- The indexes of migration 0750, again.
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
-- The end of quiet hours (ADR 0676): the rows waiting for it, soonest first.
CREATE INDEX core_routine_mail_wait_idx ON core_routine_mail (wait_until)
  WHERE status = 'waiting' AND wait_until IS NOT NULL;
