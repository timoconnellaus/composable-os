# ADR 0625: Restricted pack permissions, and the caller of a pack's tool

Status: accepted, 2026-11-23 (stage 45, build step 4). Amends ADRs
[0436](0436-pack-roles-and-the-door-role.md) (pack roles),
[0449](0449-permissions-granted-one-by-one.md) (grants) and
[0600](0600-a-pack-role-and-its-grants-add-up.md) (a pack role and its grants add up). Builds on
ADRs [0621](0621-the-staffed-behaviour-and-the-time-claim.md) to
[0624](0624-the-rosters-notices-uncovered-shifts-and-leaving.md). Ahead of stage 14a's roles and
teams ([ADR 0245](0245-roles-teams-and-identity-seams.md)), which build on it.

## Context
Every ordinary staff role held every pack tool. A tool's core permission is `records:write` (or
`records:read` for a read tool), which members hold; a tool's own pack permission (ADR 0436) only
added a way in, for a role or a grant. So there was no pack tool a member could not call. Stage 45
needs two: rostering other people (decision 16: "the owner and any admin", a separate permission
"so it can be given to someone else later", granted to nobody at first) and, in step 6, pay totals.
Without a way to hold a tool back, every member would roster everyone and read everyone's pay.

Step 3's operations also decided who may roster by `ctx.user.role === "admin"`, and acted for
`ctx.user`. Inside a pack tool's run, `ctx.user` is the extension's own account (a `member` of kind
`extension`, `apps/runner/src/executor/executor.ts`), not the person who called the tool: the step 3
tests built the context with the person as `ctx.user`, which the real runtime never does.

## Decision

**A pack declares tool permissions `restricted`** (`restricted: ["<pack>:<word>"]` in the manifest).
A tool every one of whose permissions is restricted (`packRestricted` on its operation) is held by:
- an **admin** (their role: admins hold everything);
- an account a human admin **granted** one of its permissions (declared `grantable` too), whatever
  its role, a pack role included (ADR 0600);
- **nobody else**: not a member or viewer through `records:write`/`records:read`, and never through
  a pack role (the contract refuses a role holding one).

`staffAuthority` (`packages/core/src/pack-roles.ts`) decides it on every staff call: for a
restricted tool, `role` only for an admin, else `grant` only for a grant of it. The refusal names
the permission. Judged on the tool's declaration whatever the extension's source, so a runtime
extension's tool naming one (refused by check and install) has no grantable permissions and is an
admin's only: it fails closed.

**Who may call one.** A restricted tool's operation is `actors: ["human", "assistant", "mcp"]` (or
`["human"]` when `humanOnly`): never an automation, and never another extension's code. So no run
lends its account's grant to another, and no grant is reached through code written in the app. An
assistant or MCP client acting for an account that holds it may call it as the tool allows: a read
is applied; a `personApproves` tool waits for a person; a `humanOnly` one is refused.

**The contract** (`validateManifest`): each restricted permission is the permission of one of the
pack's tools; no role holds it; a tool naming one names only restricted ones (any other would open
it to everyone holding the tool's core permission); such a tool is staff only. A runtime extension
may not declare `restricted` (`outside_audience`). `cos ext check` prints which permissions are
restricted.

**Who grants one.** As every grant (ADR 0449): a human admin, `user.setPermissions` (`users:manage`,
`actors: ["human"]`, not on MCP), audited with the list before and after. Never an assistant, an MCP
client, an automation or a member. **Never oneself**: an admin cannot add a restricted permission
to their own account (they hold it already, and would keep it once made a member);
`user.setPermissions` refuses it (`forbidden`, `rule: "self_grant"`). `user.grantablePermissions`
marks each one `restricted`. A fixed-role account may be granted one (a coach who also rosters), as
any pack permission (ADR 0600); never a core permission.

**Approving one** (the review of PR #284): an assistant's or MCP client's call of a restricted
tool that waits for a person (`personApproves`) is approved only by a person who holds the tool
themselves (`staffAuthority` for the approver, as ADR 0480 holds a publish to the approver's
permission); the requester's grant never stands in for the approver's, and is judged again when
the action applies.

**The caller of a pack's tool.** The runtime puts the tool's verified caller on the run, beside its
name and flags: `ctx.extension.tool.calledBy: { account, actor }` (the pipeline's staff account, or
the account an assistant or MCP client acts for; for an automation's or another extension's run,
that extension's account). Never from the input. An operation that is about "me" reads it
(`actingAccount`, `packages/core/src/staffing/rosterers.ts`): the staffing operations act for it,
record it (an offer's `made_by`, a take's `taken_by`, who set a qualification or someone's leave),
leave it out of the notices it causes, and refuse a run that was not called for a staff account
(`rule: "staff_caller"`).

## Why
- The smallest change that gives "admins, and whoever an admin chooses": a flag on a permission the
  pack already declares, decided in the one function every staff call passes.
- A restricted permission held through a role would be a role that rosters others, which stage
  45's decision 16 does not want; a grant names one account.
- Refusing automations and other extensions' code keeps a grant a person's: an extension's own
  account holds no grants, and a run started by an admin must not carry their authority into code
  that may have been written in the app.
- The caller on the run is what the pipeline verified; a tool's input is whatever the tool's code
  (or a model) chose.

## Proof
- `packages/core/test/restricted-permissions.test.ts`: registry-wide, restricting closes exactly
  the restricted tools for a member and a viewer and nothing else; an admin holds them; a grant
  opens them, for a pack role's account too, until the pack stops declaring it grantable; a role
  never; a runtime extension's tool is an admin's only; the contract's refusals; the rosterers and
  the roster's numbers (ADR 0626).
- `apps/runner/test/rostering.test.ts` (shipped packs, real runtime): a member and a viewer are
  refused every rosterers' tool, an admin holds them, a granted member holds them until the grant
  is taken away; an assistant and an MCP client acting for a granted member are refused the
  person's tools and their `assign` waits for a person; granting is refused to oneself, an
  assistant, MCP and a member; a coach may be granted it, never a core permission; another
  pack's tool cannot call it for an admin; a runtime extension may not declare it. The offer and the
  take record the people who called the tools, not the extension's account.

## Consequences
- The MCP surface and the admin's screens may still list a restricted tool to a member who
  cannot call it: the pipeline decides each call, so they only over-list.
- Stage 45's pay tools (step 6) declare `rostering:pay` restricted and `humanOnly`.
- Stage 14a's composed roles hand out sets of grants; the authority stays in `staffAuthority`.

## Amended 2026-11-24: restricted core permissions (stage 56, [ADR 0832](0832-the-notes-permissions.md))
A core permission can be restricted too. `notes:clients`, `notes:sensitive` and `notes:manage`
(`RESTRICTED_CORE_PERMISSIONS` in `principals.ts`) are listed `restricted` by
`user.grantablePermissions`, so the `self_grant` refusal holds for them; as every core permission,
they are never granted to a fixed role's account. They also give an AI actor nothing.
