-- Migration 0402: erase requests (stage 22 step 7, ADR 0402).
--
-- A customer who deletes their account (me.deleteAccount) is disabled and signed out at once, and
-- an erase request names their Person for staff to action by a due date: erase the person
-- (person.erase closes it as 'erased') or decline with a reason (eraseRequest.decline). A request
-- past its due date notifies admins at most once a day (last_notified_at).
--
-- Erasing the Person deletes their requests with everything else about them: only the audit trail
-- remains. No client address is stored.
CREATE TABLE core_erase_request (
  -- erq_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  -- The account that asked, while it exists.
  customer_id TEXT REFERENCES core_customer (id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'erased', 'declined')),
  -- Why staff declined (a record the org must keep). Emailed to the person.
  decline_reason TEXT,
  closed_at TEXT,
  -- The staff user who closed it.
  closed_by TEXT,
  -- When admins were last told the request is overdue.
  last_notified_at TEXT,
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK (status <> 'declined' OR decline_reason IS NOT NULL)
);
-- One open request per Person.
CREATE UNIQUE INDEX core_erase_request_open_uq ON core_erase_request (person_id) WHERE status = 'open';
CREATE INDEX core_erase_request_due_idx ON core_erase_request (status, due_at);
CREATE INDEX core_erase_request_customer_idx ON core_erase_request (customer_id);

UPDATE core_meta SET value = '402' WHERE key = 'schema_version';
