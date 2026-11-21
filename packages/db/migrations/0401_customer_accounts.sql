-- Migration 0401: customer accounts (stage 22 step 4, ADR 0402).
--
-- A customer is a Person who can sign in. Customers sign in through a second Better Auth
-- configuration (packages/auth/src/customer-auth.ts) with its own tables, cookie and secret, so a
-- customer session is never in core_session and a staff session never in core_customer_session.
-- A customer is never a core_user row and never holds a role.
--
-- Column names are snake_case; packages/auth maps Better Auth's camelCase fields onto them.
-- No table here stores a client address: Better Auth's ip_address and user_agent session columns
-- are left out on purpose, and the customer configuration strips both before a session is written.

CREATE TABLE core_customer (
  -- cus_… (ids.ts).
  id TEXT PRIMARY KEY NOT NULL,
  -- The Person the account is linked to. Null until the first sign-in links it, and while the
  -- address matches several people (link_state 'needs_merge'). One account per Person.
  -- Erasing the Person deletes the account (and, through it, its sessions).
  person_id TEXT REFERENCES core_person (id) ON DELETE CASCADE,
  -- The verified sign-in address, lower-cased and trimmed.
  email TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND email <> ''),
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  -- 'disabled': cannot sign in, and an existing session resolves to no customer.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- 'needs_merge': the address matched several people at sign-in; staff merge them first.
  link_state TEXT NOT NULL DEFAULT 'linked' CHECK (link_state IN ('linked', 'needs_merge')),
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL,
  last_sign_in_at TEXT
);
CREATE UNIQUE INDEX core_customer_person_uq ON core_customer (person_id) WHERE person_id IS NOT NULL;

CREATE TABLE core_customer_session (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL REFERENCES core_customer (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX core_customer_session_customer_idx ON core_customer_session (customer_id);

-- One-time sign-in codes, stored hashed. The identifier names the address the code was sent to.
CREATE TABLE core_customer_verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX core_customer_verification_identifier_idx ON core_customer_verification (identifier);

-- Addresses staff invited (customer.invite). With sign-up `invite_only`, a code is sent only to an
-- invited address or one that already has an account.
CREATE TABLE core_customer_invite (
  email TEXT PRIMARY KEY NOT NULL CHECK (email = lower(trim(email)) AND email <> ''),
  invited_by TEXT NOT NULL,
  invited_at TEXT NOT NULL
);

UPDATE core_meta SET value = '401' WHERE key = 'schema_version';
