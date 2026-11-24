# ADR 0794: `finance:read` and `finance:close`; what an AI may do with figures

Status: accepted, 2026-11-24 (stage 52, build step 1; decisions 2 and 7 of the spec). Amends ADR
[0449](0449-permissions-granted-one-by-one.md): two new grantable core permissions.

## Context
Decision 2: the owner and admins see the reports and download the files, plus anyone they choose
one by one (a manager, a bookkeeper), as refunds and pay already work. Decision 7: the assistant may
answer questions about these figures for someone allowed to see them, and never closes, reopens,
downloads or sends anything.

## Decision
- **`finance:read`**: see the finance months and reports, their entries, and download their files.
  **`finance:close`**: close and reopen a month. Both are core permissions (`principals.ts`),
  admins' by role and grantable one by one by a human admin (`user.setPermissions`), as
  `orders:refund` is. A member, a viewer and a pack-role account hold neither unless granted (a pack
  role counts no core grant, ADR 0600).
- **The settings** (`finance.settings.update`: the year's first month, an earlier first month,
  category labels) are `settings:manage`'s and a person's (`actors: ["human"]`); reading them is
  `finance:read`'s.
- **What an AI may do**: read figures, months and entries for an account that holds
  `finance:read` (the read operations take every actor). Closing, reopening and the settings are
  `actors: ["human"]`; downloading a file (`finance.export`, step 3) will be too. So an assistant,
  an MCP client or an automation is refused them whatever is granted.
- **Audit**: closing and reopening are audited as which month and version, never a figure; a
  reopen's reason is redacted. Reads of reports and downloads (step 3) are audited the same way.
- None of the finance operations is open to customers or the public (ADR 0402).

## Why
Money figures are as sensitive as pay; the same grant-by-grant model (ADR 0449) lets a business add
a bookkeeper without making them an admin, and the human-only acts keep the close a person's
decision.

## Proof
`packages/core/test/finance-periods.test.ts`: a member and a viewer refused every finance operation;
with `finance:read` granted a member reads and is refused the close; with `finance:close` granted,
closes; the settings stay a human admin's; an assistant and an MCP client read the months for an
admin and are refused close, reopen and the settings.

## Consequences
- An MCP connection's scopes (ADR 0021) carry `finance:read` only at the `admin` scope today; the
  `read` and `write` scopes do not, and a connection's permissions are its role's, not its grants'.
  Whether a bookkeeper's MCP client reads figures is for step 3 (the reports) to settle.

## Amended 2026-11-24 (review of PR #337)
The read operations take every actor, an automation acting for an account with `finance:read`
included (an extension's code is refused, holding no core grant). Step 1 reads states and versions
only; whether automations may read figures is for step 3 to decide with the report reads.
