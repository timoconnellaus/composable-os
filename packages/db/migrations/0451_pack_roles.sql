-- Stage 27, the door role (ADR 0436): a staff account may hold one fixed role a pack declares,
-- such as Ticketing's door role (`ticketing.door`: check tickets in, read events, ticket types and
-- tickets, and nothing else).
--
-- `pack_role` names the role as `<extension id>.<role>`. While it is set, the account may do
-- exactly what the role lists, whatever its `role` says: the operations pipeline reads this
-- column on every call by a staff account and refuses everything else. The role's definition is
-- in the installed extension's manifest; if the extension is not installed and active, the
-- account may do nothing. Only `user.setPackRole` (a human admin) writes it, and it sets `role`
-- to `viewer` in the same write, so code that reads `role` alone sees the least it could.
ALTER TABLE core_user ADD COLUMN pack_role TEXT;

-- The list of users shows the role an account holds.
DROP VIEW rec_user;
CREATE VIEW rec_user AS
SELECT u.id, u.name, u.email, u.role, u.pack_role, u.image, u.created_at
FROM core_user u
WHERE u.kind = 'human' AND u.support_grant_id IS NULL;
