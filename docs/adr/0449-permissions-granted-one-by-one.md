# ADR 0449: Permissions granted one by one

Status: accepted, 2026-11-21 (stage 41, at review of steps 1 to 3). Builds on ADRs
[0003](0003-operations-registry.md), [0402](0402-staff-and-customers.md),
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md),
[0436](0436-pack-roles-and-the-door-role.md) and
[0446](0446-publishable-without-its-public-half.md). Ahead of stage 14a's roles and teams
([ADR 0245](0245-roles-teams-and-identity-seams.md)), which build on it.

## Context
A staff account's permissions came only from its role (`admin`, `member`, `viewer`). Publishing a
program needs `records:publish` and refunding an order `orders:refund`, and both were admins
only. A gym's coaches are members, not admins, and must publish their programs; a front-desk
manager may need to refund without being able to change users, policy or extensions. Making them
admins would give them everything.

## Decision

**A human admin grants a staff account named permissions, on top of its role**
(`user.setPermissions { id, permissions }`, `users:manage`, `actors: ["human"]`, not on MCP;
`user.grantablePermissions` lists what can be granted). The list is set whole; an empty list takes
everything away. Stored as a JSON list in `core_user.granted_permissions` (migration 0471), shown
by `user.list` as `permissions` and in `rec_user`. Audited as a change to the user with the list
before and after.

**Only grantable permissions.** The core list is `GRANTABLE_PERMISSIONS`
(`packages/core/src/principals.ts`): `records:publish` and `orders:refund`. Nothing that changes
identity, policy, users or extensions can be granted. A pack adds the permissions of its own tools
it declares `grantable` (`grantable: ["<pack>:<word>"]` in the manifest, checked as a role's
permissions are: a permission one of its tools declares; only a shipped pack or the org's own
extension, `outside_audience` for a runtime one). A pack tool's grant counts only while the
installed manifest still declares it grantable (`packPermissionGrantable` on the tool's
operation), and a stored core permission no longer on the list counts for nothing.

**Read from the account on every call, in the pack role's statement.** The pipeline's read of
`pack_role` (ADR 0436) now selects `granted_permissions` from the same `core_user` row
(`loadStaffRights`), so it costs no extra statement and no extra row read: the staff baseline did
not change. What the adapter put in `ActingUser` is not trusted: a grant counts from the next call
after it is made, and a revoked one stops counting on the next call.

**Additive to the role; replaced by a pack role.** `staffMayCall(user, rights, op, input)`
(`pack-roles.ts`), the one check the pipeline makes for a staff account: a pack role, if held, is
all the account may do (ADR 0436 stands; grants count for nothing then); otherwise the role's
permissions or a grant of `op.permission`, or for a pack's tool a grant of its own grantable
permission. A handler that checks a permission itself (approving a refund) asks
`holdsPermission(ctx.user, ctx.permissionGrants, …)`.

**Never for an AI actor where the operation is a person's.** A grant is judged beside, not
instead of, an operation's `actors`, an MCP token's scopes and the gate. `record.publish` is
`actors: ["human"]`, so a member granted `records:publish` publishes from the app, and the
assistant or an MCP client acting as that member is still refused. An MCP token's permissions are
its user's role intersected with its scopes, so a grant does not widen a token either.

## Stage 14a
Stage 14a's roles, teams and scopes build on this and do not replace it: a grant is the
smallest unit (one account, one named permission), which a composed role or a team will hand out
in sets. The pack role and grants move into whatever stage 14a stores per account, read in the
same one statement, through the same `staffMayCall`.

## Proof (`packages/core/test/permission-grants.test.ts`, `apps/runner/test/programs.test.ts`)
- A member granted `records:publish` publishes; without it they are refused with the permission
  named; after it is revoked, the next call is refused. In the real host, a coach who is a member
  publishes a program and assigns it once granted, and is refused again after.
- The assistant and an MCP client (with a token naming every scope) acting as that member are
  refused.
- Granting is refused to a member and to an MCP actor; `users:manage`, `policy:manage`,
  `records:erase` and an unknown name are refused; before and after are in the audit log.
- Registry-wide: for a viewer and a member, and each grantable permission (and a pack tool
  permission declared grantable, and one not), every operation of the core registry and the
  fixture pack's tools is judged with and without the grant: a grant never closes anything, and
  what it opens is exactly the operations that name that permission. A grant does nothing while a
  pack role is held.

## Consequences
- `user.list` and the staff contract show `permissions` on every user.
- The admin UI has no screen for grants yet; it is `user.setPermissions` from a person.

## Amendment, 2026-11-21 (stage 41, step 4)
Grants are on screen in Settings > Users (the permissions dialog that came with staff invites,
ADR 0455). `user.me` gives a signed-in staff account its own role, grants and permissions, so a screen
offers an action only to an account that holds it. The host still decides every call.
