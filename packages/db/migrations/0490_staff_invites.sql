-- Staff invites, and native staff sign-in through the system browser (ADR 0455).
--
-- core_user_invite: a human admin invites a person by address, with the role, pack role
-- (ADR 0436) and grants (ADR 0449) the account will hold from the start. Accepting it is signing
-- in with a code emailed to that address (Better Auth), or the first request under Cloudflare
-- Access: either makes the account in one insert with what the invite says, after marking the
-- invite accepted. An invite holds no secret; the code is Better Auth's, stored hashed in
-- core_verification. One pending invite per address.
CREATE TABLE core_user_invite (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  pack_role TEXT,
  granted_permissions TEXT,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_user_id TEXT,
  revoked_at TEXT,
  revoked_by TEXT
);

CREATE UNIQUE INDEX core_user_invite_pending ON core_user_invite (email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX core_user_invite_created ON core_user_invite (created_at);

-- core_native_handoff: the one-time code /native/staff-sign-in hands a native app through the
-- system browser, for staff whose sign-in is browser-based (Google, Cloudflare Access). Only its
-- SHA-256 hash is stored. It is deleted when presented, right or wrong, and lives 60 seconds; it
-- is bound to the app's PKCE challenge (S256) and the redirect address it was sent to.
CREATE TABLE core_native_handoff (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
