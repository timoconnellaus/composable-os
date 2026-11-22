# ADR 0436: Pack roles, and the door role

Status: accepted, 2026-11-21 (stage 27, build steps 2 and 3). Builds on ADRs
[0003](0003-operations-registry.md), [0402](0402-staff-and-customers.md) and
[0414](0414-pack-tools-run-as-the-customer.md). Ahead of stage 14a's roles and teams
([ADR 0245](0245-roles-teams-and-identity-seams.md)), which it does not replace.

## Context
The stage 27 interview decided that coaches at Ghetto's door use staff accounts with a door-only
role: check tickets in and see the event's ticket list, nothing else. One fixed role, built in
this stage, declared by the Ticketing pack and enforced by the host on every operation.

A staff account's permissions came only from its role, `admin`, `member` or `viewer`
(`principals.ts`), and every one of those reads every record: `viewer` holds `records:read`,
which opens `person.list`, `order.list`, `query.sql`, search and every extension's records. There
was no way for an account to hold less than that. Tools had a fixed permission
(`records:write`, or `records:read` for a read tool), so nothing could name "the check-in tool"
as something to give. And an account is built from its `core_user` row in a dozen places (the
app's session, MCP, the assistant, routines, run-as, approvals, notification delivery), each with
`{ id, email, name, role }`.

## Decision

**A pack declares fixed roles** (`roles` in its manifest, `RoleSpec` in the SDK):
`{ label, description, permissions, read }`.
- `permissions` are permissions its own tools declare. A tool gains `permission:
  "<extension>:<word>"` (`ticketing:checkin`). The check refuses a role permission no tool of
  the extension declares, a permission named for another extension, and a permission on a tool
  not open to staff.
- `read` names objects of the extension itself (`ticketing.event`). A role cannot reach past the
  extension that declares it.
- Only a shipped pack or an org's own extension may declare a role or a tool permission. A
  runtime extension is refused by `extension.check` and install (`outside_audience`, as for
  audiences, customers and `sellable`): identity and access are not something code written in
  the app may declare. `cos ext check` prints each role and what it holds.

**An account holds at most one pack role**, in `core_user.pack_role` (migration 0451), named
`<extension>.<role>` (`ticketing.door`).

**While it is held, the role is all the account may do.** The operations pipeline, for every
staff call:
1. reads the account's `pack_role` and its pack's installed manifest, in one statement
   (`loadPackRole`, `packages/core/src/pack-roles.ts`), whatever the adapter put in `ActingUser`.
   It runs beside the field registry's own read, so it adds no round trip;
2. right after the audience check, and before an invalid input is answered or anything is acted
   on, refuses any operation the role could not allow (`forbidden`, audited): only tools whose
   `packPermission` the role lists, and `record.get` and `record.list`, can pass;
3. where the role check was, replaces the account's role with the pack role: a tool passes when
   the role holds its permission, and `record.get` or `record.list` when the input's `object` is
   one the role reads. The account's own role grants nothing. An MCP token's scopes still apply
   on top.
A role whose pack is not installed, active and shipped, or that the manifest no longer declares,
holds nothing: the account may do nothing until an admin removes it.

Everyone else is unchanged: an admin or member calls a tool with a permission as they called any
tool (`records:write`, or `records:read` for a read tool), so declaring a permission never takes
anything away from anyone.

**Giving and removing it is a human admin's** (`user.setPackRole { id, role | null }`,
`users:manage`, `actors: ["human"]`, not on MCP; `user.packRoles` lists what the installed packs
declare). It is audited as a change to the user, with the role before and after. Giving one sets
the account's `role` to `viewer` in the same write, so code that reads `role` alone (the app's
shell, notification recipients, `grantableScopes`) sees the least it could. An admin cannot be
given one (demote first), the write never touches an admin row, and `user.updateRole` refuses
while one is held.

**The door role** (Ticketing): `permissions: ["ticketing:checkin"]` (the tools `checkIn` and
`undoCheckIn`), `read: ["ticketing.event", "ticketing.tickettype", "ticketing.ticket"]`. Its
holder checks tickets in, undoes a check-in, and lists and opens events, ticket types and
tickets. Nothing else: not `salesSummary`, not people, orders, leads, search, `query.sql`,
dashboards, settings or the approval queue.

**Tools learn who started them** (`ctx.caller`, `StartedBy` in the SDK): `{ kind: "staff",
userId, name }`, `{ kind: "customer" }` or `{ kind: "public" }`, set by the host from the
pipeline's verified caller and never from the input. A tool's own operation calls still run as
the extension (or as the customer, ADR 0414); this is for recording who asked. A check-in stores
who scanned it (`usedBy`, and `usedByName` as it was then, because no extension may read users).
Absent in automations.

## Why
- The rule is in the one place every call passes. Reading the column there, and not trusting the
  adapter, means none of the dozen places that build an account from its row needed to change,
  and none of them can be the gap: an account built as `member` by an old path is still
  door-only.
- Refusing whatever the input means a door account learns nothing about any other operation,
  not even whether its input was valid, and it is what lets a test walk the whole registry with
  empty input.
- Naming permissions on tools, and objects to read, is the least that expresses "check in and see
  the list". Anything broader (scopes over core objects, several roles per account, roles an
  admin composes, teams) is stage 14a's; this is one fixed role and one extra read on the hot
  path, a primary-key read joined to one manifest by primary key.

## Proof (`apps/runner/test/ticketing.test.ts`, criterion 6b)
A door-only account is called with every operation in the registry (the core registry and every
installed extension's tools): every one but `x.ticketing.checkIn`, `x.ticketing.undoCheckIn`,
`record.get` and `record.list` answers `forbidden` (or `unknown_operation`, for one open to
customers or the public only), and `record.get` and `record.list` are refused on `person`,
`organisation`, `task`, `deals.deal` and `order`. The same account checks a ticket in and lists an
event's tickets. Loosened, the walk fails:
- with the pipeline skipping the pack role for reads (the account's `viewer` role applies), 108
  operations are let through (`person.list`, `user.list`, `policy.get`, `trash.list`, ...);
- with the object check dropped from `packRoleAllows`, `record.get` on a person is let through.
An account handed to the pipeline as `member`, or as an MCP caller, is still refused; giving and
removing the role is refused to MCP and to a member, refused for an admin and for a role no pack
declares, and audited; the role holds nothing while the pack is disabled.

## Consequences
- Stage 14a extends this seam, not a second one: its roles and scopes replace `pack_role` with
  something richer, and the pack roles become roles it can express.
- One read per staff call more than before, in parallel with one already made: rows read +1 on
  every staff call (the visibility baseline, `test/fixtures/visibility-staff-baseline.json`, was
  re-recorded for exactly that, and `user.list` now returns `packRole`). A door account's call
  also parses its pack's manifest.
- The MCP surface reads the account's pack role when it authenticates a request
  (`McpCaller.packRole`): the curated tools, `describe_operations` and the schema resource list
  only what the role could allow (`apps/app/test/mcp.test.ts`). The admin's navigation still
  filters by `role` alone: a door account that signs in to the admin sees a viewer's screens and
  is refused every call they make (an issue is filed). Its own screen is the staff app's door
  scanner (step 5).
- A door account reads the ticket's holder relation, so it sees holders' names on the ticket list.
  That is the list the door needs; nothing else about a person is reachable.

## Amendment, 2026-11-21 (stage 41, ADR 0449)
The pipeline's read of `pack_role` also reads the permissions a human admin granted the account
one by one (`granted_permissions`, same row, same statement: no extra row read). A pack role still
replaces everything: while one is held, grants count for nothing. A pack may declare some of its
tool permissions `grantable`. See [ADR 0449](0449-permissions-granted-one-by-one.md).

## Amendment, 2026-11-23 (stage 31a step 7, ADR 0553)
Bookings declares a second role, `bookings.coach` (the day's classes, a class's list and ticking
names). Spec 31 asked whether a coach who also scans event tickets can hold both: they cannot. An
account still holds one pack role; such a person uses an ordinary staff role, or one account per
role. Roles that combine remain stage 14a's.
A role may also declare `today: { <object>: <datetime path> }`: its holder reaches those objects'
records only on the organisation's local today, on the role's reads and inside its tools
([ADR 0553](0553-attendance-the-coach-role-moves-and-cancelling-a-class.md)). The coach role does.
