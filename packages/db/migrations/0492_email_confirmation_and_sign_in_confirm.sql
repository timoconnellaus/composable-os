-- ADR 0457: a staff member confirms their own address, and the native sign-in page asks before it
-- hands a code to an app.
--
-- core_email_confirmation: one pending confirmation per account. The code (six digits, sent as the
-- host's sign-in mail to the account's own address) is stored as a hash, bound to the address it
-- was sent to: if the account's address is no longer that one, the code confirms nothing. It
-- lives five minutes and allows three tries; confirming deletes it.
CREATE TABLE core_email_confirmation (
  user_id TEXT PRIMARY KEY REFERENCES core_user (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- core_native_sign_in_confirm: the one-time token on /native/staff-sign-in's confirm page. It is
-- bound to the signed-in account and to the request's redirect address, challenge and state;
-- only its hash is stored, it lives five minutes, and the confirming POST deletes it, right or
-- wrong. Only then is a handoff code (core_native_handoff) issued.
CREATE TABLE core_native_sign_in_confirm (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES core_user (id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX core_native_sign_in_confirm_expires ON core_native_sign_in_confirm (expires_at);
