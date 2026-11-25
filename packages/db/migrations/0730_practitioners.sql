-- Migration 0730: practitioner accounts (stage 43 step 3, ADR 0581).
--
-- A practitioner is an outside person the business invites (a physiotherapist, a dietitian): a
-- fourth kind of caller beside staff, customers and the public. They sign in through a third
-- Better Auth configuration (packages/auth/src/practitioner-auth.ts) with its own tables, cookie
-- and key, so a practitioner session is never in core_session or core_customer_session, and a
-- staff or customer session is never in core_practitioner_session. A practitioner is never a
-- core_user and never a core_customer, and holds no role.
--
-- One address may hold a staff account, a customer account and a practitioner account at once
-- (decision 16): the three tables are apart and nothing joins them.
--
-- Column names are snake_case; packages/auth maps Better Auth's camelCase fields onto them. No
-- table here stores a client address: the session has no column for it, as a customer's has none.

CREATE TABLE core_practitioner (
  -- prc_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  -- The practitioner's own Person in the host: their name and contact, as staff see them. One
  -- account per Person. Erasing the Person deletes the account and, through it, its sessions
  -- (as for a customer account, migration 0401); stage 43 step 5 keeps the row for authored work.
  person_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  -- The sign-in address, lower-cased and trimmed. One practitioner account per address.
  email TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND email <> ''),
  -- Always 1: Better Auth reads it, and treats an unverified user as one with access to revoke.
  -- A practitioner account has no password and no other way in: the emailed code is the only one,
  -- and it proves the address at every sign-in.
  email_verified INTEGER NOT NULL DEFAULT 1 CHECK (email_verified = 1),
  -- The name the invite gave, which the practitioner sees as theirs.
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  -- A label ("Physiotherapist"); nothing is limited by it.
  discipline TEXT NOT NULL CHECK (length(trim(discipline)) BETWEEN 1 AND 80),
  -- The outside business they work for, an Organisation in the host. Optional.
  practice_id TEXT REFERENCES core_organisation (id) ON DELETE SET NULL,
  -- 'invited' until the first sign-in, then 'active'. 'ended': cannot sign in, every session is
  -- deleted in the batch that ends it, and a session left anyway resolves to no one.
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'ended')),
  invited_by TEXT NOT NULL,
  invited_at TEXT NOT NULL,
  activated_at TEXT,
  ended_at TEXT,
  ended_by TEXT,
  ended_reason TEXT CHECK (ended_reason IS NULL OR length(ended_reason) <= 500),
  last_sign_in_at TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL,
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CHECK (status <> 'active' OR activated_at IS NOT NULL),
  CHECK (status <> 'invited' OR activated_at IS NULL)
);
CREATE UNIQUE INDEX core_practitioner_person_uq ON core_practitioner (person_id);
CREATE INDEX core_practitioner_status_idx ON core_practitioner (status, invited_at);

CREATE TABLE core_practitioner_session (
  id TEXT PRIMARY KEY NOT NULL,
  practitioner_id TEXT NOT NULL REFERENCES core_practitioner (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX core_practitioner_session_practitioner_idx
  ON core_practitioner_session (practitioner_id);

-- One-time sign-in codes, stored hashed. The identifier names the address the code was sent to.
CREATE TABLE core_practitioner_verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX core_practitioner_verification_identifier_idx
  ON core_practitioner_verification (identifier);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '730'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 730;
