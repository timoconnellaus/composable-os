-- The host's sign-in mail (ADR 0456): email-send's sign-in kind, made known so a human admin can
-- let it apply without review before any code is asked for. It is auto-approvable and not
-- auto-approved: sign-in by code says it is not set up until an admin turns it on
-- (outbound.setAutoApprove). Choosing the host's mail connection makes its vendor's kind known
-- too (customer.settings.update), so a deployment on another vendor gets its own.
INSERT INTO core_outbound_kind
  (tag, vendor, label, auto_approvable, auto_approve, first_seen_at, updated_at)
VALUES ('email.signin', 'email-send', 'Send sign-in codes', 1, 0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT (tag) DO UPDATE SET auto_approvable = 1;
