-- Migration 0770 (issue #258, ADR 0600): before ADR 0600 a permission granted to an account that
-- holds a pack role counted for nothing (ADR 0449), yet `user.setPermissions`, `user.setPackRole`
-- and the invites kept such grants stored. ADR 0600 makes a pack role's grants count, so a stored,
-- inert grant would come alive on upgrade with no admin's act (a viewer once granted
-- `memberships:passes`, later made a coach, would give passes again). This clears them: they
-- counted for nothing until now, so nothing anyone relied on is lost. An admin re-ticks what they
-- want on Settings > Users.
--
-- One audit row says how many accounts and pending invites were cleared (written only when there
-- were any), and each account's change is recorded on it as a change to the user, the list before
-- and after, as `user.setPermissions` records one.
INSERT INTO core_audit
  (id, at, operation, risk, actor, user_id, origin, input, result, gate_decision, outcome, error,
   pending_action_id)
SELECT
  'aud_migration0770',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration.clearFixedRoleGrants',
  'write',
  'automation',
  NULL,
  json('{"surface":"system"}'),
  json('{"migration":770}'),
  json_object(
    'accounts', (SELECT count(*) FROM core_user
                 WHERE pack_role IS NOT NULL AND granted_permissions IS NOT NULL),
    'invites', (SELECT count(*) FROM core_user_invite
                WHERE pack_role IS NOT NULL AND granted_permissions IS NOT NULL),
    'note', 'Permissions stored on accounts with a fixed role counted for nothing before ADR 0600 and were cleared; re-tick any you want on Settings > Users.'
  ),
  'auto',
  'ok',
  NULL,
  NULL
WHERE EXISTS (SELECT 1 FROM core_user WHERE pack_role IS NOT NULL AND granted_permissions IS NOT NULL)
   OR EXISTS (SELECT 1 FROM core_user_invite
              WHERE pack_role IS NOT NULL AND granted_permissions IS NOT NULL);

INSERT INTO core_audit_changes (audit_id, object_type, record_id, action, diff, at)
SELECT
  'aud_migration0770',
  'user',
  id,
  'update',
  json_object(
    'permissions',
    json_object(
      'before',
      CASE WHEN json_valid(granted_permissions) THEN json(granted_permissions) ELSE json('[]') END,
      'after',
      json('[]')
    )
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM core_user
WHERE pack_role IS NOT NULL AND granted_permissions IS NOT NULL;

UPDATE core_user
SET granted_permissions = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE pack_role IS NOT NULL AND granted_permissions IS NOT NULL;

UPDATE core_user_invite
SET granted_permissions = NULL
WHERE pack_role IS NOT NULL AND granted_permissions IS NOT NULL;
