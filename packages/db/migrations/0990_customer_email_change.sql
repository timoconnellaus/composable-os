-- Migration 0990: changing a customer account's sign-in address (stage 48, ADR 0712; block BF in
-- docs/parallel-work.md).
--
-- The member (or a staff admin for them) asks with the new address; the host emails a code to it;
-- the member enters the code, signed in to the same account, and only then does the account's
-- sign-in address change (with the Person's primary email, in one batch). One row per request.
--
-- - One open change per account: a newer request ends the open one as `replaced`, in the same
--   batch (the partial unique index refuses a second open row).
-- - The code is stored only as a hash. It lasts 15 minutes and allows 5 tries; the fifth wrong
--   one ends the change as `tries`.
-- - `old_email` is the address the change replaces. Erase reads a confirmed row's old address as
--   one of the Person's former sign-in addresses (issue #302) before the account and its rows go.
-- - `new_mailbox` is the new address with a `+tag` (and Gmail's dots) folded away (`mailboxKey`):
--   requests are counted per mailbox, as sign-in codes are (ADR 0459). Never an identity.
CREATE TABLE core_customer_email_change (
  -- ech_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  -- Erasing the account deletes its changes (erase reads them first).
  customer_id TEXT NOT NULL REFERENCES core_customer (id) ON DELETE CASCADE,
  new_email TEXT NOT NULL CHECK (new_email = lower(trim(new_email)) AND new_email <> ''),
  new_mailbox TEXT NOT NULL,
  old_email TEXT NOT NULL CHECK (old_email = lower(trim(old_email)) AND old_email <> ''),
  -- 'customer' (the member asked) or the staff user id (usr_…) of the admin who started it.
  started_by TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  tries_left INTEGER NOT NULL DEFAULT 5 CHECK (tries_left BETWEEN 0 AND 5),
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  -- When it ended without taking effect, and why: a newer request, staff cancelled it, five wrong
  -- codes, or the address proved to be in use at the business when the code was entered.
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('replaced', 'cancelled', 'tries', 'in_use')),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (confirmed_at IS NULL OR ended_at IS NULL),
  CHECK (new_email <> old_email)
);
CREATE UNIQUE INDEX core_customer_email_change_open_uq ON core_customer_email_change (customer_id)
  WHERE confirmed_at IS NULL AND ended_at IS NULL;
CREATE INDEX core_customer_email_change_customer_idx
  ON core_customer_email_change (customer_id, created_at);
CREATE INDEX core_customer_email_change_mailbox_idx
  ON core_customer_email_change (new_mailbox, created_at);
