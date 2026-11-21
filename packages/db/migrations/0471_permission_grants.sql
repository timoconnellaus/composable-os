-- Stage 41, permissions granted one by one (ADR 0449): a human admin grants a staff account
-- named permissions on top of its role, from a fixed list (`records:publish`, `orders:refund`)
-- and the tool permissions installed packs declare grantable. A coach who is a member publishes
-- programs.
--
-- `granted_permissions` is a JSON list of permission names, or null for none. The operations
-- pipeline reads it on every staff call, in the statement that reads `pack_role`, and a
-- permission there counts only if it is still grantable. While a pack role is held, it is all the
-- account may do and grants count for nothing (ADR 0436). Only `user.setPermissions` (a human
-- admin) writes it.
ALTER TABLE core_user ADD COLUMN granted_permissions TEXT;

-- The list of users shows what an account was granted.
DROP VIEW rec_user;
CREATE VIEW rec_user AS
SELECT u.id, u.name, u.email, u.role, u.pack_role, u.granted_permissions, u.image, u.created_at
FROM core_user u
WHERE u.kind = 'human' AND u.support_grant_id IS NULL;
