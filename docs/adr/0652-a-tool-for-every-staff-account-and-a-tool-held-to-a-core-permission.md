# ADR 0652: A tool for every staff account, and a tool held to a core permission

Status: accepted, 2026-11-24 (with [ADR 0651](0651-checklists-on-their-own-a-schedule-a-run-a-day-and-who-may-do-it.md),
checklists on their own). Amends ADR [0436](0436-pack-roles-and-the-door-role.md) (what a pack role
reaches) and ADR [0660](0660-pack-screens-in-the-admin.md) (what a screen's gate tool may be), with
dated notes there. Builds on ADRs [0449](0449-permissions-granted-one-by-one.md),
[0600](0600-a-pack-role-and-its-grants-add-up.md) and [0625](0625-restricted-pack-permissions.md).
No migration.

## Context
A scheduled checklist names who may do it: everyone on staff, a role or a pack role, or a grant
(ADR 0651). The screens and the app reach the host through a pack's tools (ADR 0660, ADR 0451), and
a pack tool today is reached by an account with a pack role only when that role lists one of the
tool's permissions, which are the tool's own pack's (ADR 0436); a grant opens only what a pack
declares grantable (ADR 0600). So a cleaner's `rostering.team` account or a coach's could never
call Daily checklists' tools, though the checklist names their role; giving every such account a
grant by hand would make the template's "who" a second, disagreeing list.

The other half: how each day went is for those who manage checklists, who are the holders of the
core permission `checklists:write` (admins and those granted it). A pack tool's core permission is
always `records:read` or `records:write`, held by every member; a pack permission cannot be a core
one. The screen's gate ("could call these tools", ADR 0660) could not say "checklists:write", so the
history screen would be listed to every member and refuse them inside.

## Decision
Two declarations on a shipped pack's (or the org's own) tool, each refused for a runtime extension
by `cos ext check` and install, and ignored if one is in the database anyway:

- **`anyStaff: true`**: every staff account may call the tool, **pack roles included**, with no role
  or grant naming it. For a tool whose host operation decides who may do what by a rule of its own
  (Daily checklists' `today`, `day`, `tick`, `done`: the checklist's "who may do it", held by the host
  and the database). The contract requires it to be `humanOnly`, staff only, and to name no
  `permission` or `corePermission`. The operation carries `packAnyStaff`; `packRoleReaches` and
  `packRoleAllows` let any pack role call it; for an account without a pack role it is an ordinary
  tool (`records:read` or `records:write`, so a viewer reads but never writes). A pack role's
  today-limit travels with the call as with any call its role allows; these tools read no records
  of the role's pack.
- **`corePermission: "<area>:<word>"`**: the tool needs that core permission instead of
  `records:read` or `records:write` (Daily checklists' `history`: `checklists:write`). It must be one
  of the core permissions an admin grants one by one (`GRANTABLE_PERMISSIONS`); anything else, or a
  runtime extension's, holds the tool to `users:manage` (admins only: fail closed). Staff only, and
  not beside a pack `permission`, so no pack role ever reaches it.

The gate fingerprint of a pack's screens (ADR 0660) includes both when set, so the admin's build and
the host still agree on what a gate means; a pack that declares neither keeps its fingerprint.
`api/v1/roles.json` lists, for each carried pack role, every carried pack's `anyStaff` tools beside
its own, so a role client generated from it (`cos client generate`, ADR 0451) holds them: a cleaner's
app gets Today's checklists.

## Consequences
- A pack role reaches four more operations, `x.dailychecks.today`, `.day`, `.tick` and `.done`,
  wherever Daily checklists is installed, and nothing else new (the registry walk in
  `packages/core/test/screens.test.ts` and the roles file say so). What they answer is the host's:
  only the checklists the account may do.
- Today's checklists is listed in every writing staff account's navigation, including fixed-role
  shells (a door account too), and may say "Nothing is due for you today". The history is listed
  only for admins and those granted `checklists:write`.
- An `anyStaff` tool is a reviewed widening: a new one is a change to a shipped pack, read with
  the host operation it calls, which must hold its own rule of who may.

## Proof
`packages/core/test/any-staff-tools.test.ts` (the contract, a runtime extension refused, the
authority for each kind of account, failing closed); `packages/core/test/screens.test.ts` (the
registry walk, and who sees each Daily checklists screen); `packages/core/test/api-contract.test.ts`
(the roles file); `apps/runner/test/checklists-standalone.test.ts` (a cleaner's account through the
real pipeline).
